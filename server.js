const express = require('express');
// Нативный fetch Node 18+ вместо node-fetch (старый node-fetch давал "Premature close"
// на новом рантайме Railway). Обёртка транслирует опцию timeout в AbortSignal,
// чтобы все существующие вызовы fetch(url, { timeout: N }) работали без правок.
const fetch = (url, opts) => {
  const o = Object.assign({}, opts || {});
  if (o.timeout && !o.signal) o.signal = AbortSignal.timeout(o.timeout);
  delete o.timeout;
  return globalThis.fetch(url, o);
};

// ============================================
// POSTGRES CACHE (опционально, с грациозной деградацией)
// ============================================
let pg = null;
let pgPool = null;
let pgReady = false;

try {
  pg = require('pg');
  const { Pool } = pg;
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    pgPool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    pgPool.on('error', (err) => console.log('⚠️ Postgres pool error:', err.message));
    pgReady = true;
    console.log('✓ Postgres инициализирован');
  }
} catch (err) {
  console.log('ℹ️ Postgres недоступен (работаем в in-memory режиме):', err.message);
}

// Инициализация таблицы кэша
async function initPgCache() {
  if (!pgPool) return;
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cache_updated ON cache(updated_at);
    `);
    console.log('✓ Таблица cache готова');
  } catch (err) {
    console.log('⚠️ Ошибка инициализации таблицы cache:', err.message);
  }
}

// Инициализация таблицы отчётов мастерской (Сократ)
async function initSocratesTables() {
  if (!pgPool) return;
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tg_reports (
        id BIGSERIAL PRIMARY KEY,
        update_id BIGINT UNIQUE,
        message_id BIGINT,
        chat_id BIGINT NOT NULL,
        author_id BIGINT,
        author_name TEXT,
        text TEXT,
        msg_date BIGINT,
        raw JSONB,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tgr_chat ON tg_reports(chat_id);
      CREATE INDEX IF NOT EXISTS idx_tgr_date ON tg_reports(msg_date);
      CREATE INDEX IF NOT EXISTS idx_tgr_author ON tg_reports(author_id);
    `);
    console.log('✓ Таблица tg_reports готова');
  } catch (err) {
    console.log('⚠️ Ошибка инициализации tg_reports:', err.message);
  }
}

// Инициализация таблицы разбора отчётов мастерской (Сократ, work_log)
async function initWorkLogTable() {
  if (!pgPool) return;
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS work_log (
        id BIGSERIAL PRIMARY KEY,
        tg_report_id BIGINT,
        work_date DATE,
        master TEXT,
        category TEXT,
        object TEXT,
        deal_id BIGINT,
        operation TEXT,
        business_unit TEXT,
        day_fraction REAL,
        confidence TEXT,
        clarify BOOLEAN DEFAULT false,
        clarify_question TEXT,
        raw_text TEXT,
        digest_date DATE,
        created_at BIGINT NOT NULL,
        UNIQUE(master, object, work_date, operation)
      );
      CREATE INDEX IF NOT EXISTS idx_wl_date ON work_log(work_date);
      CREATE INDEX IF NOT EXISTS idx_wl_master ON work_log(master);
      CREATE INDEX IF NOT EXISTS idx_wl_deal ON work_log(deal_id);
      CREATE INDEX IF NOT EXISTS idx_wl_digest ON work_log(digest_date);
    `);
    console.log('✓ Таблица work_log готова');
  } catch (err) {
    console.log('⚠️ Ошибка инициализации work_log:', err.message);
  }
}



// Хелперы для работы с Postgres кэшем
async function pgSetCache(key, value) {
  if (!pgPool) return;
  try {
    const now = Date.now();
    await pgPool.query(
      'INSERT INTO cache(key, value, updated_at) VALUES($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at',
      [key, JSON.stringify(value), now]
    );
  } catch (err) {
    console.log('⚠️ pgSetCache error:', key, err.message);
  }
}

async function pgGetCache(key) {
  if (!pgPool) return null;
  try {
    const result = await pgPool.query('SELECT value FROM cache WHERE key=$1', [key]);
    return result.rows[0] ? JSON.parse(result.rows[0].value) : null;
  } catch (err) {
    console.log('⚠️ pgGetCache error:', key, err.message);
    return null;
  }
}

async function pgDeleteCache(key) {
  if (!pgPool) return;
  try {
    await pgPool.query('DELETE FROM cache WHERE key=$1', [key]);
  } catch (err) {
    console.log('⚠️ pgDeleteCache error:', key, err.message);
  }
}

async function pgClearAllCache() {
  if (!pgPool) return;
  try {
    await pgPool.query('DELETE FROM cache');
    console.log('✓ Postgres кэш очищен');
  } catch (err) {
    console.log('⚠️ pgClearAllCache error:', err.message);
  }
}

async function pgLoadAllIntoMemory(cache) {
  if (!pgPool) return;
  try {
    const result = await pgPool.query('SELECT key, value FROM cache');
    let loaded = 0;
    for (const row of result.rows) {
      // digest-снапшоты не поднимаем: разбор всегда должен считаться заново
      if (row.key && row.key.indexOf('socrates_digest_') === 0) continue;
      try {
        cache[row.key] = JSON.parse(row.value);
        loaded++;
      } catch (e) {}
    }
    console.log(`✓ Загружено ${loaded} ключей из Postgres в память`);
  } catch (err) {
    console.log('⚠️ pgLoadAllIntoMemory error:', err.message);
  }
}

// ============================================
// EXPRESS APP
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK = 'https://b24-99blai.bitrix24.ru/rest/1/uop89s51t0hivx0p';
const WEBHOOK_KASH = 'https://b24-99blai.bitrix24.ru/rest/20326/yyse913stg6uxm80';
const NL = String.fromCharCode(10);

app.use(express.json({ limit: '10mb' }));

let cache = {};
let lastUpdate = {};
let loading = {};
let lastMessageIds = {};

// Обёртка для кэша: устанавливает в память И в Postgres
async function setCache(key, value) {
  cache[key] = value;
  await pgSetCache(key, value);
}

// ============================================
// BITRIX API HELPERS
// ============================================
async function fetchAll(method, dateFrom, dateTo, selectFields, webhook = WEBHOOK) {
  let results = [];
  let start = 0;
  let hasMore = true;
  while (hasMore) {
    let url = webhook + '/' + method + '.json';
    url += '?filter[>DATE_CREATE]=' + dateFrom;
    url += '&filter[<=DATE_CREATE]=' + dateTo;
    url += '&start=' + start;
    for (const s of selectFields) url += '&select[]=' + s;
    let data = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { timeout: 20000 });
        data = await response.json();
        break;
      } catch (err) {
        console.log('Retry', attempt + 1, 'for', method, 'start:', start);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!data) break;
    if (data.result && Array.isArray(data.result)) {
      results = results.concat(data.result);
      console.log(method, 'loaded', results.length, 'of', data.total);
    }
    if (data.next && data.next > start) start = data.next;
    else hasMore = false;
    if (start > 100000) hasMore = false;
    await new Promise(r => setTimeout(r, 400));
  }
  return results;
}

async function fetchChats(webhook, limit = 500) {
  let results = [];
  const seen = {};
  let lastId = 0;
  let hasMore = true;
  let guard = 0;
  while (hasMore && results.length < limit && guard < 40) {
    guard++;
    let url = webhook + '/im.recent.list.json?limit=50';
    if (lastId > 0) url += '&last_id=' + lastId;
    let data = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { timeout: 20000 });
        data = await response.json();
        break;
      } catch (err) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!data || !data.result || !data.result.items) break;
    const items = data.result.items;
    let added = 0;
    let maxId = lastId;
    for (const it of items) {
      const cid = it.chat ? it.chat.id : undefined;
      if (it.id && it.id > maxId) maxId = it.id;
      if (cid === undefined || cid === null) continue;
      if (seen[cid]) continue;
      seen[cid] = true;
      results.push(it);
      added++;
    }
    console.log('Chats page:', items.length, 'new:', added, 'total:', results.length);
    if (added === 0) { hasMore = false; break; }
    if (data.result.hasMore && data.next && data.next !== lastId) lastId = data.next;
    else if (data.result.hasMore && maxId > lastId) lastId = maxId;
    else hasMore = false;
    await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

async function fetchChatMessages(webhook, chatId, limit = 100) {
  let url = webhook + '/im.dialog.messages.get.json?chat_id=' + chatId + '&limit=' + limit;
  try {
    const response = await fetch(url, { timeout: 15000 });
    const data = await response.json();
    if (data.result && data.result.messages) return data.result.messages;
  } catch (err) {
    console.log('Error fetching messages for chat', chatId, err.message);
  }
  return [];
}

// ============================================
// ENDPOINTS
// ============================================
app.get('/data', async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo required' });
  const cacheKey = dateFrom + '_' + dateTo;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;
  if (cache[cacheKey] && cacheAge < 3600000) return res.json(cache[cacheKey]);
  if (loading[cacheKey]) {
    let waited = 0;
    while (loading[cacheKey] && waited < 120000) {
      await new Promise(r => setTimeout(r, 2000));
      waited += 2000;
    }
    if (cache[cacheKey]) return res.json(cache[cacheKey]);
    return res.status(503).json({ error: 'Loading timeout' });
  }
  loading[cacheKey] = true;
  try {
    const deals = await fetchAll('crm.deal.list', dateFrom, dateTo, ['ID','TITLE','STAGE_SEMANTIC_ID','SOURCE_ID','OPPORTUNITY','CURRENCY_ID','DATE_CREATE','CATEGORY_ID','ASSIGNED_BY_ID']);
    const leads = await fetchAll('crm.lead.list', dateFrom, dateTo, ['ID','STATUS_ID','ASSIGNED_BY_ID','SOURCE_ID','DATE_CREATE']);
    const result = { deals, leads, dealsTotal: deals.length, leadsTotal: leads.length, updatedAt: new Date().toISOString() };
    await setCache(cacheKey, result);
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

function detectSource(entityId) {
  const e = (entityId || '').toLowerCase();
  if (e.includes('whatsapp') || e.includes('wa_')) return 'WhatsApp';
  if (e.includes('instagram') || e.includes('insta')) return 'Instagram';
  if (e.includes('telegram') || e.includes('tg')) return 'Telegram';
  if (e.includes('vkontakte') || e.includes('vk_') || e.includes('vk|')) return 'VK';
  if (e.includes('facebook') || e.includes('fb')) return 'Facebook';
  if (e.includes('avito')) return 'Avito';
  if (e.includes('network') || e.includes('livechat') || e.includes('widget')) return 'Site widget';
  return 'Other/Unknown';
}

function detectLang(text) {
  const t = text || '';
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';
  if (/[\u0400-\u04FF]/.test(t)) return 'ru';
  if (/[\u00C0-\u017F]|\b(hola|gracias|curso|quiero)\b/i.test(t)) return 'es';
  if (/[a-z]/i.test(t)) return 'en';
  return 'unknown';
}

function crmStageFrom(entityData2) {
  const parts = (entityData2 || '').split('|');
  let dealId = 0, leadId = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'DEAL') dealId = parseInt(parts[i + 1]) || 0;
    if (parts[i] === 'LEAD') leadId = parseInt(parts[i + 1]) || 0;
  }
  if (dealId > 0) return 'deal';
  if (leadId > 0) return 'lead';
  return 'none';
}

function detectInteraction(name, message) {
  const n = (name || '').toLowerCase();
  if (n.includes('комментар') || n.includes('comment')) return 'comment';
  const txt = ((message && message.text) ? String(message.text) : '').trim();
  const low = txt.toLowerCase();
  if (low.includes('истори') || low.includes('story') || low.includes('отреагир') || low.includes('reacted')) return 'story_reaction';
  if (txt && txt.length <= 4 && !/[a-zа-я0-9]/i.test(txt)) return 'reaction';
  return 'dm';
}

app.get('/leads-stats', async (req, res) => {
  const limit = parseInt(req.query.limit || 500);
  const webhookParam = req.query.webhook;
  const webhook = webhookParam || WEBHOOK_KASH;
  const cacheKey = 'leads_stats_' + (webhookParam ? webhookParam.slice(-12) : 'kash') + '_' + limit;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;

  if (cache[cacheKey] && cacheAge < 21600000) return res.json(cache[cacheKey]);
  if (loading[cacheKey]) return res.json({ status: 'loading', message: 'Считаю статистику, попробуйте через 1-2 минуты' });
  loading[cacheKey] = true;

  try {
    const chats = await fetchChats(webhook, limit);

    const bySource = {};
    const byStatus = { new_unassigned: 0, in_progress: 0, closed: 0 };
    const byCrmStage = { lead: 0, deal: 0, none: 0 };
    const byMonth = {};
    const byLang = {};
    const sourceStatus = {};
    let skippedInternal = 0;

    for (const chat of chats) {
      const c = chat.chat || {};
      if (c.entity_type !== 'LINES' || !c.entity_id) { skippedInternal++; continue; }

      const source = detectSource(c.entity_id);
      const status = chat.lines ? chat.lines.status : 0;
      const stage = crmStageFrom(c.entity_data_2);
      const lastText = chat.message ? chat.message.text : '';
      const dateStr = c.date_create || (chat.message ? chat.message.date : null);

      bySource[source] = (bySource[source] || 0) + 1;
      byCrmStage[stage] = (byCrmStage[stage] || 0) + 1;

      let statusKey;
      if (status === 40) { byStatus.closed++; statusKey = 'closed'; }
      else if (status === 20 || status === 25) { byStatus.in_progress++; statusKey = 'in_progress'; }
      else { byStatus.new_unassigned++; statusKey = 'open'; }

      if (!sourceStatus[source]) sourceStatus[source] = { total: 0, open: 0, in_progress: 0, closed: 0, lead: 0, deal: 0 };
      sourceStatus[source].total++;
      if (statusKey === 'closed') sourceStatus[source].closed++;
      else if (statusKey === 'in_progress') sourceStatus[source].in_progress++;
      else sourceStatus[source].open++;
      if (stage === 'deal') sourceStatus[source].deal++;
      else if (stage === 'lead') sourceStatus[source].lead++;

      if (dateStr) {
        const month = dateStr.substring(0, 7);
        byMonth[month] = (byMonth[month] || 0) + 1;
      }

      const lang = detectLang(lastText);
      byLang[lang] = (byLang[lang] || 0) + 1;
    }

    const result = {
      total_chats: chats.length,
      lead_chats: chats.length - skippedInternal,
      skipped_internal: skippedInternal,
      bySource,
      byStatus,
      byCrmStage,
      byLang,
      byMonth,
      sourceConversion: sourceStatus,
      note: 'Только entity_type=LINES. status: open=новый/без ответа, in_progress=в работе, closed=закрыт.',
      updatedAt: new Date().toISOString()
    };

    await setCache(cacheKey, result);
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

app.get('/leads-debug', async (req, res) => {
  const limit = parseInt(req.query.limit || 500);
  const webhookParam = req.query.webhook;
  const webhook = webhookParam || WEBHOOK_KASH;
  const cacheKey = 'leads_debug_' + (webhookParam ? webhookParam.slice(-12) : 'kash') + '_' + limit;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;

  if (cache[cacheKey] && cacheAge < 21600000) return res.json(cache[cacheKey]);
  if (loading[cacheKey]) return res.json({ status: 'loading', message: 'Считаю, попробуйте через 1-2 минуты' });
  loading[cacheKey] = true;

  try {
    const chats = await fetchChats(webhook, limit);

    const byEntityType = {};
    const byEntityId = {};
    const byLineId = {};
    const byEntityIdSource = {};
    const byInteraction = {};
    const bySourceInteraction = {};
    const igMessageSamples = [];

    for (const chat of chats) {
      const c = chat.chat || {};
      const lines = chat.lines || {};
      const etype = c.entity_type || 'none';
      byEntityType[etype] = (byEntityType[etype] || 0) + 1;

      const eid = c.entity_id || '';
      byEntityId[eid] = (byEntityId[eid] || 0) + 1;
      if (!byEntityIdSource[eid]) byEntityIdSource[eid] = detectSource(eid);

      const parts = eid.split('|');
      const lineId = (lines.id !== undefined ? String(lines.id) : (parts[1] || 'unknown'));
      byLineId[lineId] = (byLineId[lineId] || 0) + 1;

      if (etype === 'LINES' && eid) {
        const source = detectSource(eid);
        const interaction = detectInteraction(c.name, chat.message);
        byInteraction[interaction] = (byInteraction[interaction] || 0) + 1;
        if (!bySourceInteraction[source]) bySourceInteraction[source] = {};
        bySourceInteraction[source][interaction] = (bySourceInteraction[source][interaction] || 0) + 1;
        if (source === 'Instagram' && igMessageSamples.length < 15) {
          igMessageSamples.push({ name: c.name, detected: interaction, message: chat.message || null });
        }
      }
    }

    const topEntityIds = Object.keys(byEntityId)
      .sort((a, b) => byEntityId[b] - byEntityId[a])
      .slice(0, 40)
      .map(eid => ({ entity_id: eid, count: byEntityId[eid], detected_as: byEntityIdSource[eid] }));

    const samples = chats.slice(0, 8).map(ch => ({ chat: ch.chat || null, lines: ch.lines || null }));

    const result = {
      total_chats: chats.length,
      byEntityType,
      byInteraction,
      bySourceInteraction,
      byLineId,
      distinct_entity_ids: Object.keys(byEntityId).length,
      topEntityIds,
      igMessageSamples,
      samples,
      note: 'byInteraction/bySourceInteraction: dm/comment/story_reaction/reaction. samples = сырые chat+lines.',
      updatedAt: new Date().toISOString()
    };

    await setCache(cacheKey, result);
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

const ROMEO_ID = 80100;
function authorRole(authorId, managerList, owner) {
  if (authorId === 0) return 'system';
  if (authorId === ROMEO_ID) return 'romeo';
  if ((Array.isArray(managerList) && managerList.indexOf(authorId) !== -1) || authorId === owner) return 'manager';
  return 'client';
}

app.get('/leads-list', async (req, res) => {
  const limit = parseInt(req.query.limit || 500);
  const webhookParam = req.query.webhook;
  const webhook = webhookParam || WEBHOOK_KASH;
  const cacheKey = 'leads_list_' + (webhookParam ? webhookParam.slice(-12) : 'kash') + '_' + limit;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;

  if (cache[cacheKey] && cacheAge < 1800000) return res.json(cache[cacheKey]);
  if (loading[cacheKey]) return res.json({ status: 'loading', message: 'Считаю список, попробуйте через 1-2 минуты' });
  loading[cacheKey] = true;

  try {
    const chats = await fetchChats(webhook, limit);
    const now = Date.now();
    const WINDOW_H = 24;
    const leads = [];

    for (const chat of chats) {
      const c = chat.chat || {};
      if (c.entity_type !== 'LINES' || !c.entity_id) continue;

      const source = detectSource(c.entity_id);
      const interaction = detectInteraction(c.name, chat.message);
      const m = chat.message || {};
      const role = authorRole(m.author_id, c.manager_list, c.owner);
      const lastDate = m.date ? new Date(m.date).getTime() : (c.date_create ? new Date(c.date_create).getTime() : now);
      const hoursSince = Math.round(((now - lastDate) / 3600000) * 10) / 10;
      const awaiting = (role === 'client');

      const hasWindow = (source === 'Instagram' || source === 'WhatsApp');
      let windowLeftH = null, windowState = 'na';
      if (hasWindow && awaiting) {
        windowLeftH = Math.round((WINDOW_H - hoursSince) * 10) / 10;
        windowState = windowLeftH <= 0 ? 'closed' : (windowLeftH <= 6 ? 'closing_soon' : 'open');
      } else if (hasWindow) {
        windowState = 'answered';
      }

      const txt = (m.text || '').replace(/\s+/g, ' ').trim();
      leads.push({
        name: c.name || '(без имени)',
        source,
        interaction,
        last_from: role,
        awaiting,
        hours_since_last: hoursSince,
        window_left_h: windowLeftH,
        window_state: windowState,
        session_status: chat.lines ? chat.lines.status : null,
        crm_stage: crmStageFrom(c.entity_data_2),
        last_text: txt.length > 90 ? txt.slice(0, 90) + '…' : txt
      });
    }

    const rank = { closed: 0, closing_soon: 1, open: 2, na: 3, answered: 4 };
    leads.sort((a, b) => {
      if (a.awaiting !== b.awaiting) return a.awaiting ? -1 : 1;
      const ra = rank[a.window_state], rb = rank[b.window_state];
      if (ra !== rb) return ra - rb;
      if (a.window_left_h !== null && b.window_left_h !== null) return a.window_left_h - b.window_left_h;
      return b.hours_since_last - a.hours_since_last;
    });

    const awaitingList = leads.filter(l => l.awaiting);
    const summary = {
      total_lines: leads.length,
      awaiting_total: awaitingList.length,
      awaiting_dm: awaitingList.filter(l => l.interaction === 'dm').length,
      window_closing_soon: awaitingList.filter(l => l.window_state === 'closing_soon').length,
      window_closed: awaitingList.filter(l => l.window_state === 'closed').length,
      by_source_awaiting: {}
    };
    for (const l of awaitingList) summary.by_source_awaiting[l.source] = (summary.by_source_awaiting[l.source] || 0) + 1;

    const result = {
      summary,
      leads,
      note: 'awaiting=ждёт ответа. window_state: open/closing_soon/closed для IG/WA; na/answered для остальных.',
      updatedAt: new Date().toISOString()
    };

    await setCache(cacheKey, result);
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

function ymd(d) { return d.toISOString().slice(0, 10); }

app.get('/channels', async (req, res) => {
  const days = parseInt(req.query.days || 90);
  const webhook = req.query.webhook || WEBHOOK;
  const cacheKey = 'channels_' + days;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;

  if (cache[cacheKey] && cacheAge < 21600000) return res.json(cache[cacheKey]);
  if (loading[cacheKey]) return res.json({ status: 'loading', message: 'Считаю каналы, попробуйте через 1-2 минуты' });
  loading[cacheKey] = true;

  try {
    const now = new Date();
    const dateFrom = ymd(new Date(now.getTime() - days * 86400000));
    const dateTo = ymd(now);

    const sourceMap = {};
    try {
      const r = await fetch(webhook + '/crm.status.list.json?filter[ENTITY_ID]=SOURCE', { timeout: 20000 });
      const j = await r.json();
      if (j.result) for (const s of j.result) sourceMap[s.STATUS_ID] = s.NAME;
    } catch (e) {}

    const leads = await fetchAll('crm.lead.list', dateFrom, dateTo, ['ID', 'SOURCE_ID', 'STATUS_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE'], webhook);
    const deals = await fetchAll('crm.deal.list', dateFrom, dateTo, ['ID', 'SOURCE_ID', 'STAGE_SEMANTIC_ID', 'DATE_CREATE'], webhook);

    const nameOf = id => sourceMap[id] || (id || 'UNKNOWN');
    const leadsBySource = {};
    const assignedBySource = {};
    for (const l of leads) {
      const s = nameOf(l.SOURCE_ID);
      leadsBySource[s] = (leadsBySource[s] || 0) + 1;
      if (!assignedBySource[s]) assignedBySource[s] = {};
      const a = String(l.ASSIGNED_BY_ID || '0');
      assignedBySource[s][a] = (assignedBySource[s][a] || 0) + 1;
    }
    const dealsBySource = {};
    for (const d of deals) {
      const s = nameOf(d.SOURCE_ID);
      dealsBySource[s] = (dealsBySource[s] || 0) + 1;
    }

    const conversion = {};
    const allSources = new Set(Object.keys(leadsBySource).concat(Object.keys(dealsBySource)));
    allSources.forEach(s => { conversion[s] = { leads: leadsBySource[s] || 0, deals: dealsBySource[s] || 0 }; });

    const result = {
      period_days: days,
      total_leads: leads.length,
      total_deals: deals.length,
      leadsBySource,
      dealsBySource,
      conversion,
      assignedBySource,
      note: 'Все каналы по CRM SOURCE_ID за период (админский вебхук). 20326 = Кашинский.',
      updatedAt: new Date().toISOString()
    };

    await setCache(cacheKey, result);
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

async function fetchListNoDate(method, webhook, extra) {
  let results = [];
  let start = 0;
  let more = true;
  let guard = 0;
  while (more && guard < 50) {
    guard++;
    let url = webhook + '/' + method + '.json?start=' + start;
    if (extra) url += extra;
    let data = null;
    for (let a = 0; a < 3; a++) {
      try { const r = await fetch(url, { timeout: 20000 }); data = await r.json(); break; }
      catch (e) { await new Promise(rr => setTimeout(rr, 1500)); }
    }
    if (!data || !data.result) break;
    const arr = Array.isArray(data.result) ? data.result : [];
    results = results.concat(arr);
    if (data.next && data.next > start) start = data.next; else more = false;
    await new Promise(rr => setTimeout(rr, 300));
  }
  return results;
}

app.get('/funnels', async (req, res) => {
  const days = parseInt(req.query.days || 90);
  const webhook = req.query.webhook || WEBHOOK;
  const cacheKey = 'funnels_' + days;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;

  if (cache[cacheKey] && cacheAge < 21600000) return res.json(cache[cacheKey]);
  if (loading[cacheKey]) return res.json({ status: 'loading', message: 'Считаю воронки, попробуйте через 1-2 минуты' });
  loading[cacheKey] = true;

  try {
    const now = new Date();
    const dateFrom = ymd(new Date(now.getTime() - days * 86400000));
    const dateTo = ymd(now);

    const statuses = await fetchListNoDate('crm.status.list', webhook);
    const leadStatusName = {};
    const dealStageName = {};
    for (const s of statuses) {
      if (s.ENTITY_ID === 'STATUS') leadStatusName[s.STATUS_ID] = s.NAME;
      else if (s.ENTITY_ID && s.ENTITY_ID.indexOf('DEAL_STAGE') === 0) dealStageName[s.STATUS_ID] = s.NAME;
    }

    const cats = await fetchListNoDate('crm.dealcategory.list', webhook);
    const catName = { '0': 'Основная' };
    for (const c of cats) catName[String(c.ID)] = c.NAME;

    const leads = await fetchAll('crm.lead.list', dateFrom, dateTo, ['ID', 'STATUS_ID', 'DATE_CREATE'], webhook);
    const leadFunnel = {};
    for (const l of leads) {
      const name = leadStatusName[l.STATUS_ID] || l.STATUS_ID || 'UNKNOWN';
      leadFunnel[name] = (leadFunnel[name] || 0) + 1;
    }
    const convertedLeads = leads.filter(l => l.STATUS_ID === 'CONVERTED').length;
    const junkLeads = leads.filter(l => l.STATUS_ID === 'JUNK').length;

    const deals = await fetchAll('crm.deal.list', dateFrom, dateTo, ['ID', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'OPPORTUNITY', 'DATE_CREATE'], webhook);
    const dealFunnels = {};
    let won = 0, lost = 0, inProgress = 0, wonSum = 0;
    for (const d of deals) {
      const cn = catName[String(d.CATEGORY_ID || 0)] || ('Воронка ' + d.CATEGORY_ID);
      if (!dealFunnels[cn]) dealFunnels[cn] = { total: 0, won: 0, lost: 0, in_progress: 0, stages: {} };
      const f = dealFunnels[cn];
      f.total++;
      const sn = dealStageName[d.STAGE_ID] || d.STAGE_ID || 'UNKNOWN';
      if (!f.stages[sn]) f.stages[sn] = { count: 0, sum: 0 };
      f.stages[sn].count++;
      f.stages[sn].sum += Number(d.OPPORTUNITY || 0);
      const sem = d.STAGE_SEMANTIC_ID;
      if (sem === 'S') { f.won++; won++; wonSum += Number(d.OPPORTUNITY || 0); }
      else if (sem === 'F') { f.lost++; lost++; }
      else { f.in_progress++; inProgress++; }
    }

    const result = {
      period_days: days,
      lead_funnel: {
        total_leads: leads.length,
        by_status: leadFunnel,
        converted: convertedLeads,
        junk: junkLeads,
        lead_to_deal_rate: leads.length ? (Math.round((deals.length / leads.length) * 1000) / 10) + '%' : null
      },
      deal_funnels: dealFunnels,
      deals_summary: {
        total_deals: deals.length,
        won: won, lost: lost, in_progress: inProgress,
        won_sum: wonSum,
        win_rate_closed: (won + lost) ? (Math.round((won / (won + lost)) * 1000) / 10) + '%' : null
      },
      note: 'Лиды по статусам и сделки по воронкам/стадиям за период.',
      updatedAt: new Date().toISOString()
    };

    await setCache(cacheKey, result);
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

app.get('/backlog-audit', async (req, res) => {
  const days = parseInt(req.query.days || 365);
  const webhook = req.query.webhook || WEBHOOK;
  try {
    const now = new Date();
    const dateFrom = ymd(new Date(now.getTime() - days * 86400000));
    const dateTo = ymd(now);

    const statuses = await fetchListNoDate('crm.status.list', webhook);
    const leadStatusName = {};
    const sourceName = {};
    for (const s of statuses) {
      if (s.ENTITY_ID === 'STATUS') leadStatusName[s.STATUS_ID] = s.NAME;
      else if (s.ENTITY_ID === 'SOURCE') sourceName[s.STATUS_ID] = s.NAME;
    }

    const leads = await fetchAll('crm.lead.list', dateFrom, dateTo,
      ['ID', 'STATUS_ID', 'SOURCE_ID', 'DATE_CREATE', 'DATE_MODIFY', 'ASSIGNED_BY_ID'], webhook);

    const isTerminal = (st) => st === 'CONVERTED' || st === 'JUNK';

    const ageBucket = (modify) => {
      const t = modify ? new Date(modify).getTime() : 0;
      if (!t) return '>30d';
      const h = (now.getTime() - t) / 3600000;
      if (h <= 24) return 'open_<24h';
      if (h <= 24 * 7) return '1-7d';
      if (h <= 24 * 30) return '7-30d';
      return '>30d';
    };

    const out = {
      total_leads_in_range: leads.length,
      backlog_total: 0,
      by_status: {},
      by_channel: {},
      by_age: { 'open_<24h': 0, '1-7d': 0, '7-30d': 0, '>30d': 0 },
      channel_x_age: {},
      salvageable_open_24h: 0,
      salvageable_by_channel: {},
      terminal_counts: { CONVERTED: 0, JUNK: 0 }
    };

    for (const l of leads) {
      const st = l.STATUS_ID;
      if (isTerminal(st)) { out.terminal_counts[st] = (out.terminal_counts[st] || 0) + 1; continue; }
      out.backlog_total++;

      const stName = leadStatusName[st] || st || 'UNKNOWN';
      const chName = sourceName[l.SOURCE_ID] || l.SOURCE_ID || 'UNKNOWN';
      const age = ageBucket(l.DATE_MODIFY);

      out.by_status[stName] = (out.by_status[stName] || 0) + 1;
      out.by_channel[chName] = (out.by_channel[chName] || 0) + 1;
      out.by_age[age] = (out.by_age[age] || 0) + 1;

      if (!out.channel_x_age[chName]) out.channel_x_age[chName] = { 'open_<24h': 0, '1-7d': 0, '7-30d': 0, '>30d': 0 };
      out.channel_x_age[chName][age]++;

      if (age === 'open_<24h') {
        out.salvageable_open_24h++;
        out.salvageable_by_channel[chName] = (out.salvageable_by_channel[chName] || 0) + 1;
      }
    }

    out.note = 'Бэклог = не в CONVERTED/JUNK. Возраст по DATE_MODIFY. Это аудит, ничего не отправлялось.';
    res.json(out);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/register-bot', async (req, res) => {
  const handler = req.query.handler;
  const name = req.query.name || 'Romeo';
  const webhook = req.query.webhook || WEBHOOK;
  const clientId = req.query.client_id || req.query.clientId;
  if (!handler) return res.status(400).json({ error: 'Передай ?handler=<URL вебхука n8n>' });
  if (!clientId) return res.status(400).json({ error: 'Нужен &client_id=<CLIENT_ID локального приложения>' });
  try {
    const body = {
      CODE: 'romeo',
      TYPE: 'O',
      OPENLINE: 'Y',
      CLIENT_ID: clientId,
      EVENT_MESSAGE_ADD: handler,
      EVENT_WELCOME_MESSAGE: handler,
      EVENT_BOT_DELETE: handler,
      PROPERTIES: {
        NAME: name,
        COLOR: 'AQUA',
        WORK_POSITION: 'Цифровой помощник школы'
      }
    };
    const r = await fetch(webhook + '/imbot.register.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    res.json({
      sent: body,
      bitrix_response: data,
      hint: 'result = ID бота Romeo (запиши его).'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// UPDATE-BOT — обновить регистрацию бота (добавлено)
// ============================================
app.get('/update-bot', async (req, res) => {
  const handler = req.query.handler || process.env.ROMEO_WEBHOOK_HANDLER;
  const botId = req.query.bot_id || process.env.ROMEO_BOT_ID || '80100';
  const webhook = req.query.webhook || WEBHOOK;
  
  if (!handler) {
    return res.status(400).json({ 
      error: 'Передай ?handler=<URL вебхука n8n> или установи env ROMEO_WEBHOOK_HANDLER',
      hint: 'Пример: /update-bot?handler=https://n8n.../webhook/romeo-openlines&bot_id=80198'
    });
  }

  try {
    const body = {
      CODE: 'romeo',
      ID: botId,
      EVENT_MESSAGE_ADD: handler,
      EVENT_WELCOME_MESSAGE: handler,
      EVENT_BOT_DELETE: handler,
      PROPERTIES: {
        NAME: 'Romeo'
      }
    };
    const r = await fetch(webhook + '/imbot.update.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    res.json({
      action: 'update-bot',
      sent: body,
      bitrix_response: data,
      status: data.error ? 'error' : 'updated'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/messages', async (req, res) => {
  const limit = parseInt(req.query.limit || 500);
  const cacheKey = 'messages_kash_' + limit;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;
  if (cache[cacheKey] && cacheAge < 21600000) return res.json(cache[cacheKey]);
  if (loading[cacheKey]) return res.json({ status: 'loading', message: 'Data is being loaded, try again in 1-2 minutes' });
  loading[cacheKey] = true;
  try {
    const chats = await fetchChats(WEBHOOK_KASH, limit);
    const byMonth = {};
    const byStatus = { open: 0, closed: 0, inProgress: 0 };
    const sources = {};
    const chatsWithMessages = [];
    const chatsToProcess = chats.slice(0, 500);
    for (let i = 0; i < chatsToProcess.length; i++) {
      const chat = chatsToProcess[i];
      const chatId = chat.chat_id;
      const status = chat.lines ? chat.lines.status : 0;
      if (status === 40) byStatus.closed++;
      else if (status === 20 || status === 25) byStatus.inProgress++;
      else byStatus.open++;
      const dateStr = chat.chat && chat.chat.date_create ? chat.chat.date_create : (chat.message ? chat.message.date : null);
      if (dateStr) {
        const month = dateStr.substring(0, 7);
        if (!byMonth[month]) byMonth[month] = { total: 0, closed: 0, open: 0 };
        byMonth[month].total++;
        if (status === 40) byMonth[month].closed++;
        else byMonth[month].open++;
      }
      const entityId = chat.chat ? chat.chat.entity_id : '';
      const entityIdStr = entityId || '';
      if (entityIdStr.includes('instagram')) sources['Instagram'] = (sources['Instagram'] || 0) + 1;
      else if (entityIdStr.includes('whatsapp')) sources['WhatsApp'] = (sources['WhatsApp'] || 0) + 1;
      else sources['Other'] = (sources['Other'] || 0) + 1;
      const messages = await fetchChatMessages(WEBHOOK_KASH, chatId, 100);
      chatsWithMessages.push({
        id: chatId, title: chat.title, status, date_create: dateStr,
        entity_id: entityId, last_message: chat.message ? chat.message.text : '',
        messages_count: messages.length, messages: messages.slice(0, 50)
      });
      if (i % 20 === 0) console.log('Processed', i, 'of', chatsToProcess.length, 'chats');
      await new Promise(r => setTimeout(r, 200));
    }
    const result = { total_chats: chats.length, processed_chats: chatsWithMessages.length, byMonth, byStatus, sources, chats: chatsWithMessages, updatedAt: new Date().toISOString() };
    await setCache(cacheKey, result);
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

app.get('/workday', async (req, res) => {
  const date = req.query.date || new Date().toISOString().substring(0, 10);
  const cacheKey = 'workday_kash_' + date;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;
  if (cache[cacheKey] && cacheAge < 1800000) {
    console.log('Cache hit for workday', date);
    return res.json(cache[cacheKey]);
  }
  if (loading[cacheKey]) {
    return res.json({ status: 'loading', message: 'Try again in 1 minute' });
  }
  loading[cacheKey] = true;
  console.log('Loading workday for', date);
  try {
    const dateFrom = date + 'T00:00:00+03:00';
    const dateTo = date + 'T23:59:59+03:00';

    let allTasks = [];
    let taskStart = 0;
    let hasMoreTasks = true;
    while (hasMoreTasks && allTasks.length < 600) {
      let url = WEBHOOK + '/tasks.task.list.json';
      url += '?filter[RESPONSIBLE_ID]=20326';
      url += '&order[CLOSED_DATE]=desc';
      url += '&select[]=ID&select[]=TITLE&select[]=STATUS&select[]=DEADLINE&select[]=CREATED_DATE&select[]=CLOSED_DATE&select[]=CHANGED_DATE';
      url += '&start=' + taskStart;
      try {
        const r = await fetch(url, { timeout: 15000 });
        const d = await r.json();
        if (d.result && d.result.tasks) allTasks = allTasks.concat(d.result.tasks);
        const nextVal = d.next ? parseInt(d.next) : null;
        if (nextVal && nextVal > taskStart) taskStart = nextVal;
        else hasMoreTasks = false;
      } catch (e) { hasMoreTasks = false; }
      await new Promise(r => setTimeout(r, 300));
    }
    const tasks = allTasks.filter(t => {
      const closed = t.closedDate ? t.closedDate.substring(0,10) : '';
      const created = t.createdDate ? t.createdDate.substring(0,10) : '';
      const changed = t.changedDate ? t.changedDate.substring(0,10) : '';
      const deadline = t.deadline ? t.deadline.substring(0,10) : '';
      return closed === date || created === date || changed === date || deadline === date;
    });

    let allActivities = [];
    let actStart = 0;
    let hasMoreAct = true;
    while (hasMoreAct && allActivities.length < 1000) {
      let url = WEBHOOK + '/crm.activity.list.json';
      url += '?filter[RESPONSIBLE_ID]=20326';
      url += '&order[CREATED]=desc';
      url += '&select[]=ID&select[]=TYPE_ID&select[]=SUBJECT&select[]=CREATED&select[]=COMPLETED&select[]=DEADLINE';
      url += '&start=' + actStart;
      try {
        const r = await fetch(url, { timeout: 15000 });
        const d = await r.json();
        if (d.result && Array.isArray(d.result)) {
          allActivities = allActivities.concat(d.result);
          const oldest = d.result[d.result.length - 1];
          if (oldest && oldest.CREATED && oldest.CREATED.substring(0,10) < date) hasMoreAct = false;
        }
        const nextVal = d.next ? parseInt(d.next) : null;
        if (hasMoreAct && nextVal && nextVal > actStart) actStart = nextVal;
        else hasMoreAct = false;
      } catch (e) { hasMoreAct = false; }
      await new Promise(r => setTimeout(r, 300));
    }
    const activities = allActivities.filter(a => (a.CREATED || '').substring(0,10) === date);

    // Грузим сообщения как в исходном рабочем /messages (та же логика полей),
    // но независимо — чтобы не нужно было звать /messages вручную. Кэш — в Postgres.
    const MGR_ID = 20326;
    let msgCache = cache['messages_kash_500'];
    const msgCacheAge = lastUpdate['messages_kash_500'] ? Date.now() - lastUpdate['messages_kash_500'] : Infinity;

    if (!msgCache || msgCacheAge > 3600000) {
      const chats = await fetchChats(WEBHOOK_KASH, 500);
      const chatsWithMessages = [];
      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const chatId = chat.chat_id || (chat.chat && chat.chat.id); // как в исходнике, с запасным вариантом
        if (!chatId) continue;
        const messages = await fetchChatMessages(WEBHOOK_KASH, chatId, 100);
        chatsWithMessages.push({ id: chatId, title: chat.title, messages: messages.slice(0, 50) });
        if (i % 50 === 0) console.log('Messages:', i + 1, '/', chats.length);
        await new Promise(r => setTimeout(r, 100));
      }
      msgCache = { chats: chatsWithMessages };
      await setCache('messages_kash_500', msgCache);
      lastUpdate['messages_kash_500'] = Date.now();
    }

    // классификатор автора сообщения
    const ROMEO_IDS = [80198, 80100, 80098];
    const classify = function (aid) {
      const n = Number(aid);
      if (n === MGR_ID) return 'MANAGER';
      if (ROMEO_IDS.indexOf(n) !== -1) return 'ROMEO';
      if (n === 0) return 'SYSTEM';
      return 'CLIENT';
    };

    let dayMessages = [];
    const dialogsByChat = {};
    if (msgCache && msgCache.chats) {
      msgCache.chats.forEach(chat => {
        const chatDayMsgs = [];
        (chat.messages || []).forEach(m => {
          if (m.date && m.date.substring(0, 10) === date) {
            const who = classify(m.author_id);
            dayMessages.push({
              chat: chat.title,
              author_id: Number(m.author_id),
              who: who,
              text: (m.text || '').substring(0, 200),
              date: m.date,
              hour: parseInt(m.date.substring(11, 13))
            });
            chatDayMsgs.push({
              who: who,
              text: (m.text || ''),
              time: m.date.substring(11, 16),
              ts: Number(m.id) || 0
            });
          }
        });
        if (chatDayMsgs.length > 0) {
          chatDayMsgs.sort((a, b) => a.ts - b.ts); // верный хронологический порядок по id сообщения
          dialogsByChat[chat.id || chat.title] = { title: chat.title, id: chat.id, msgs: chatDayMsgs };
        }
      });
    }

    // --- КЛАССИФИКАЦИЯ ЧАТОВ ЗА ДЕНЬ (по смыслу, не по шуму) ---
    const cats = { live_manager: [], romeo_handled: [], client_waiting: [], outbound_only: [], system_only: [] };
    Object.values(dialogsByChat).forEach(function (d) {
      const real = d.msgs.filter(m => m.who !== 'SYSTEM'); // живые реплики без системных автозаписей
      if (real.length === 0) { cats.system_only.push(d); return; } // только автозакрепление/переадресация — не диалог
      const last = real[real.length - 1];
      d.has_manager = real.some(m => m.who === 'MANAGER');
      d.has_romeo = real.some(m => m.who === 'ROMEO');
      d.last_who = last.who;
      if (last.who === 'CLIENT') cats.client_waiting.push(d);   // клиент написал последним — ЖДЁТ ответа (горячий/провал)
      else if (d.has_manager) cats.live_manager.push(d);        // менеджер реально вёл диалог
      else if (d.has_romeo) cats.romeo_handled.push(d);         // вёл только бот
      else cats.outbound_only.push(d);
    });

    // диалоги для показа — только живые (есть хоть одна несистемная реплика)
    const realDialogs = Object.values(dialogsByChat).filter(d => d.msgs.some(m => m.who !== 'SYSTEM'));
    const fullDialogs = realDialogs
      .sort((a, b) => b.msgs.length - a.msgs.length)
      .slice(0, 300)
      .map(function (entry) {
        const lines = entry.msgs.filter(m => m.who !== 'SYSTEM').map(function (m) {
          const tag = m.who === 'MANAGER' ? 'МЕНЕДЖЕР' : (m.who === 'ROMEO' ? 'ROMEO' : 'КЛИЕНТ');
          return '[' + m.time + '] ' + tag + ': ' + m.text;
        });
        return { client: entry.title, messages_count: lines.length, last_who: entry.last_who, dialog: lines.join(NL) };
      });

    // горячие без ответа — клиент написал последним, ответа нет
    const unanswered = cats.client_waiting.map(function (d) {
      const lastClient = d.msgs.filter(m => m.who === 'CLIENT').slice(-1)[0];
      return { client: d.title, time: lastClient ? lastClient.time : '', last_message: lastClient ? lastClient.text.substring(0, 300) : '' };
    });

    const tasksClosed = tasks.filter(t => t.closedDate && t.closedDate.substring(0,10) === date).length;
    const tasksCreated = tasks.filter(t => t.createdDate && t.createdDate.substring(0,10) === date).length;
    const tasksDeadline = tasks.filter(t => t.deadline && t.deadline.substring(0,10) === date).length;
    const tasksOverdue = tasks.filter(t => t.status !== '5' && t.deadline && new Date(t.deadline) < new Date()).length;
    const tasksOpen = tasks.filter(t => t.status !== '5').length;

    const activityByHour = {};
    activities.forEach(a => {
      const created = a.CREATED || '';
      if (created.length > 13) {
        const h = parseInt(created.substring(11, 13));
        activityByHour[h] = (activityByHour[h] || 0) + 1;
      }
    });

    const msgByHour = {};
    const managerDayMsgs = dayMessages.filter(m => m.who === 'MANAGER');
    const romeoDayMsgs = dayMessages.filter(m => m.who === 'ROMEO');
    const clientDayMsgs = dayMessages.filter(m => m.who === 'CLIENT');
    managerDayMsgs.forEach(m => { msgByHour[m.hour] = (msgByHour[m.hour] || 0) + 1; });

    const allTimes = [].concat(
      activities.map(a => a.CREATED),
      managerDayMsgs.map(m => m.date)
    ).filter(Boolean).sort();
    const firstActivity = allTimes[0] || null;
    const lastActivity = allTimes[allTimes.length - 1] || null;

    const result = {
      date,
      tasks: { total: tasks.length, closed: tasksClosed, created: tasksCreated, deadline: tasksDeadline, open: tasksOpen, overdue: tasksOverdue, list: tasks.slice(0, 50) },
      activities: { total: activities.length, completed: activities.filter(a => a.COMPLETED === 'Y').length, byHour: activityByHour, list: activities.slice(0, 50) },
      messages: {
        total: dayMessages.length,
        manager: managerDayMsgs.length,
        romeo: romeoDayMsgs.length,
        client: clientDayMsgs.length,
        system: dayMessages.filter(m => m.who === 'SYSTEM').length,
        byHour: msgByHour,
        sample: managerDayMsgs.slice(0, 30),
        fullDialogs: fullDialogs
      },
      dialogs: {
        total_real: realDialogs.length,        // живых диалогов (есть хоть одна несистемная реплика)
        live_manager: cats.live_manager.length, // вёл менеджер
        romeo_handled: cats.romeo_handled.length, // вёл только бот
        client_waiting: cats.client_waiting.length, // клиент ждёт ответа (ГОРЯЧИЕ/провалы)
        outbound_only: cats.outbound_only.length, // только исходящее, клиент не ответил
        system_only: cats.system_only.length,   // только автозакрепления/переадресации (НЕ диалоги)
        unanswered: unanswered                    // список горячих без ответа: кто, во сколько, последнее сообщение
      },
      timing: { first: firstActivity, last: lastActivity },
      updatedAt: new Date().toISOString()
    };
    await setCache(cacheKey, result);
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

// ПРОБА (read-only): как достать ВСЕ сессии открытых линий через админ-вебхук.
// Смотрим свежие активности CRM без фильтра по оператору — где провайдер открытых линий,
// кто ответственный, и есть ли привязка к чату/диалогу. Сравниваем с recent.list админа.
app.get('/probe-sessions', async (req, res) => {
  try {
    const out = {};

    // 1) свежие активности CRM (админ, без фильтра по оператору)
    const acts = [];
    let start = 0;
    for (let page = 0; page < 4 && acts.length < 80; page++) {
      let url = WEBHOOK + '/crm.activity.list.json?order[CREATED]=desc';
      ['ID', 'TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'PROVIDER_PARAMS', 'RESPONSIBLE_ID', 'AUTHOR_ID', 'OWNER_TYPE_ID', 'OWNER_ID', 'CREATED', 'SUBJECT', 'ASSOCIATED_ENTITY_ID', 'SETTINGS']
        .forEach(f => { url += '&select[]=' + f; });
      url += '&start=' + start;
      let d = null;
      try { const r = await fetch(url, { timeout: 15000 }); d = await r.json(); } catch (e) { out.activities_error = String(e.message || e); break; }
      if (d && Array.isArray(d.result)) acts.push(...d.result);
      const nextVal = d && d.next ? parseInt(d.next) : null;
      if (nextVal && nextVal > start) start = nextVal; else break;
      await new Promise(r2 => setTimeout(r2, 200));
    }

    const byProvider = {};
    acts.forEach(a => { const p = a.PROVIDER_ID || 'none'; byProvider[p] = (byProvider[p] || 0) + 1; });
    const samplesByProvider = {};
    acts.forEach(a => {
      const p = a.PROVIDER_ID || 'none';
      if (!samplesByProvider[p]) samplesByProvider[p] = [];
      if (samplesByProvider[p].length < 2) samplesByProvider[p].push(a); // по 2 сырых образца на провайдер
    });
    out.activities = { fetched: acts.length, byProvider, samplesByProvider };

    // 2) im.recent.list от АДМИНА — сравнить охват (per-user scope)
    try {
      const rr = await fetch(WEBHOOK + '/im.recent.list.json?limit=50', { timeout: 15000 });
      const rd = await rr.json();
      const items = (rd.result && rd.result.items) || [];
      const et = {};
      items.forEach(it => { const e = it.entity_type || 'none'; et[e] = (et[e] || 0) + 1; });
      out.admin_recent = { count: items.length, byEntityType: et, sample: items.slice(0, 2) };
    } catch (e) { out.admin_recent = { error: String(e.message || e) }; }

    // 3) на ОДНОЙ сессии открытой линии пробуем достать chat_id и прочитать сообщения
    const olSample = acts.find(a => a.PROVIDER_ID === 'IMOPENLINES_SESSION');
    const targetSid = req.query.sid || (olSample ? olSample.ASSOCIATED_ENTITY_ID : null);
    if (targetSid) {
      const probe = { session_id: targetSid };
      try {
        const r = await fetch(WEBHOOK + '/imopenlines.session.history.get.json?SESSION_ID=' + encodeURIComponent(targetSid), { timeout: 15000 });
        const h = await r.json();
        const result = h && h.result;
        if (result && result.message) {
          const users = result.users || {};
          probe.chatId = result.chatId;
          // карта пользователей с флагами — чтобы видеть, кто connector/bot
          probe.users = Object.keys(users).reduce(function (acc, id) {
            const u = users[id]; acc[id] = { name: u.name, connector: u.connector, bot: u.bot, type: u.type }; return acc;
          }, {});
          // каждое сообщение: senderid + флаги его юзера + текст — чтобы понять, как классифицировать
          probe.messages = Object.values(result.message)
            .sort(function (a, b) { return Number(a.id) - Number(b.id); })
            .map(function (m) {
              const u = users[m.senderid] || {};
              return { id: m.id, senderid: m.senderid, conn: u.connector, bot: u.bot, date: m.date, text: String(m.text || '').replace(/\s+/g, ' ').substring(0, 140) };
            });
        } else { probe.raw = h; }
      } catch (e) { probe.error = String(e.message || e); }
      out.session_probe = probe;
    }

    res.json(out);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// НОВЫЙ отчёт по работе менеджеров — на основе СЕССИЙ открытых линий (админ-вебхук).
// Видит ВСЕ линии всех операторов (не один recent.list). Разрез по каждому менеджеру.
// Источник: crm.activity.list (PROVIDER_ID=IMOPENLINES_SESSION) -> imopenlines.session.history.get.
// тяжёлый сбор отчёта — запускается в фоне (Битрикс отдаёт ~2 запроса/сек, 250 сессий = ~2 мин)
async function computeWorkday2(date, lookback, maxSessions) {
  const cacheKey = wd2Key(date, lookback);
  try {
    const OPS = { '10': 'Алтанец', '20326': 'Кашинский', '73320': 'Самарина' };
    const ROMEO_IDS = ['80198', '80100', '80098'];
    const lookbackStr = new Date(new Date(date + 'T00:00:00').getTime() - lookback * 86400000).toISOString().substring(0, 10);

    // 1) перечисляем сессии открытых линий за окно [date-lookback .. date]
    const sessions = {};
    let start = 0, guard = 0, stop = false;
    while (!stop && guard < 80 && Object.keys(sessions).length < maxSessions) {
      guard++;
      let url = WEBHOOK + '/crm.activity.list.json?order[CREATED]=desc&filter[PROVIDER_ID]=IMOPENLINES_SESSION';
      ['ID', 'PROVIDER_PARAMS', 'RESPONSIBLE_ID', 'AUTHOR_ID', 'OWNER_TYPE_ID', 'OWNER_ID', 'CREATED', 'SUBJECT', 'ASSOCIATED_ENTITY_ID']
        .forEach(f => { url += '&select[]=' + f; });
      url += '&start=' + start;
      let d = null;
      try { const r = await fetch(url, { timeout: 15000 }); d = await r.json(); } catch (e) { break; }
      if (!d || !Array.isArray(d.result)) break;
      for (const a of d.result) {
        const created = (a.CREATED || '').substring(0, 10);
        if (created < lookbackStr) { stop = true; break; }
        const sid = a.ASSOCIATED_ENTITY_ID;
        if (!sid || sessions[sid]) continue;
        sessions[sid] = { sessionId: sid, responsible: String(a.RESPONSIBLE_ID || ''), subject: a.SUBJECT || '', created: a.CREATED || '' };
      }
      const nextVal = d.next ? parseInt(d.next, 10) : null;
      if (!stop && nextVal && nextVal > start) start = nextVal; else stop = true;
      await new Promise(r => setTimeout(r, 120));
    }

    // снятие служебной обёртки коннектора из текста
    const strip = function (t) {
      t = String(t || '').replace(/\[\/?[A-Za-z][^\]]*\]/g, ' ');
      t = t.replace(/Ответ оператора\s*\([^)]*\)/gi, ' ');
      t = t.replace(/(?:Instagram business|Whatsapp|Telegram(?:bot)?)\b.*?to JAG\s*\(channel id[^)]*\)/gi, ' ');
      t = t.replace(/\bid\s+\d{6,}\b/gi, ' ');
      return t.replace(/\s+/g, ' ').trim();
    };

    // 2) по каждой сессии тянем историю и классифицируем авторов (параллельно, пачками — иначе таймаут)
    const sessIds = Object.keys(sessions);
    const opName = function (opId) {
      if (!opId) return null;
      const id = String(opId);
      if (OPS[id]) return OPS[id];
      if (ROMEO_IDS.indexOf(id) !== -1) return 'Ромео';
      return null;
    };
    const opEventTarget = function (raw) {
      if (/начал работу с диалогом/.test(raw)) { const m = raw.match(/\[USER=(\d+)/); return m ? m[1] : null; }
      if (/(переадресовал диалог на|Обращение направлено на|перенаправлено на)/.test(raw)) { const m = raw.match(/на\s*\[USER=(\d+)/); return m ? m[1] : null; }
      return null;
    };
    const processSession = async function (sid) {
      let hist = null;
      try {
        const r = await fetch(WEBHOOK + '/imopenlines.session.history.get.json?SESSION_ID=' + encodeURIComponent(sid), { timeout: 15000 });
        hist = await r.json();
      } catch (e) { sessions[sid].error = String(e.message || e); return; }
      const result = hist && hist.result;
      if (!result || !result.message) { sessions[sid].error = (hist && hist.error) || 'no messages'; return; }
      const users = result.users || {};
      const rawMsgs = Object.values(result.message).sort(function (a, b) { return Number(a.id) - Number(b.id); });
      let currentOp = String(sessions[sid].responsible || '') || null;
      const records = [];
      for (const m of rawMsgs) {
        const senderId = String(m.senderid || '0');
        const raw = String(m.text || '');
        if (senderId === '0') { const t = opEventTarget(raw); if (t) currentOp = t; continue; }
        const u = users[senderId] || {};
        const isOutboundEcho = /^\s*(?:\[[^\]]*\]\s*)?Ответ оператора/i.test(raw);
        let kind, opId = null;
        if (u.connector) {
          if (isOutboundEcho) { kind = 'OURSIDE'; opId = currentOp; }
          else { kind = 'CLIENT'; }
        } else if (u.bot || ROMEO_IDS.indexOf(senderId) !== -1) { kind = 'OURSIDE'; opId = senderId; currentOp = senderId; }
        else { kind = 'OURSIDE'; opId = senderId; currentOp = senderId; }
        const text = strip(raw);
        if (!text) continue;
        records.push({ id: Number(m.id) || 0, date: m.date || '', day: (m.date || '').substring(0, 10), kind: kind, opName: kind === 'OURSIDE' ? opName(opId) : null, text: text });
      }
      sessions[sid].chatId = result.chatId;
      sessions[sid].records = records;
    };
    const BATCH = 4;
    for (let i = 0; i < sessIds.length; i += BATCH) {
      await Promise.all(sessIds.slice(i, i + BATCH).map(processSession));
      await new Promise(function (r) { setTimeout(r, 700); }); // щадим лимит Битрикса (~2-3 запроса/сек), чтобы не ловить throttle
    }

    // 3) агрегируем по каждому менеджеру за целевую дату
    const managers = {};
    const ensure = function (name) { if (!managers[name]) managers[name] = { messages: 0, sessions_active: {}, sessions_assigned: 0, first_resp_minutes: [] }; return managers[name]; };
    ['Алтанец', 'Кашинский', 'Самарина', 'Ромео'].forEach(ensure);
    let unattributedReplies = 0;
    const unansweredDm = [];
    const unansweredComments = [];
    const altanetsGap = [];
    const managerThreads = {};
    const pushThread = function (nm, t) { if (!managerThreads[nm]) managerThreads[nm] = []; managerThreads[nm].push(t); };

    Object.values(sessions).forEach(function (s) {
      const recs = s.records || [];
      const respName = OPS[s.responsible] || (ROMEO_IDS.indexOf(s.responsible) !== -1 ? 'Ромео' : null);
      if (respName) ensure(respName).sessions_assigned++;

      // сообщения нашей стороны за дату, привязанные к менеджеру
      recs.filter(r => r.day === date && r.kind === 'OURSIDE').forEach(function (r) {
        if (r.opName) { const mgr = ensure(r.opName); mgr.messages++; mgr.sessions_active[s.sessionId] = true; }
        else unattributedReplies++;
      });

      // SLA: для сообщений клиента ЭТОГО дня — время до первого ответа в этот день
      let pendingClient = null;
      recs.forEach(function (r) {
        if (r.kind === 'CLIENT') { pendingClient = r; }
        else if (r.kind === 'OURSIDE') {
          if (pendingClient && pendingClient.day === date && r.day === date && r.opName && r.date && pendingClient.date) {
            const mins = (new Date(r.date) - new Date(pendingClient.date)) / 60000;
            if (mins >= 0) ensure(r.opName).first_resp_minutes.push(Math.round(mins));
          }
          pendingClient = null;
        }
      });

      // горячие без ответа: последняя реплика — от клиента
      if (recs.length) {
        const last = recs[recs.length - 1];
        if (last.kind === 'CLIENT') {
          const isComment = /\(комментарии\)/.test(s.subject) || /^Комментарий к посту/.test(last.text);
          const rec = { client: s.subject, session: s.sessionId, chatId: s.chatId || null, assigned: respName || s.responsible, time: last.date, last_message: last.text.substring(0, 200) };
          if (isComment) unansweredComments.push(rec); else unansweredDm.push(rec);
          if (!isComment && String(s.responsible) === '10') altanetsGap.push(rec);
        }
      }

      // переписки за день по менеджеру (для персональных отчётов)
      const dayRecs = recs.filter(r => r.day === date);
      if (dayRecs.length) {
        const repliers = {};
        dayRecs.forEach(function (r) { if (r.kind === 'OURSIDE' && r.opName) repliers[r.opName] = true; });
        const hasClientToday = dayRecs.some(r => r.kind === 'CLIENT');
        let firstRespMin = null, pend = null;
        dayRecs.forEach(function (r) {
          if (r.kind === 'CLIENT') { if (pend === null) pend = r; }
          else if (r.kind === 'OURSIDE') { if (pend && r.date && pend.date && firstRespMin === null) { const mm = (new Date(r.date) - new Date(pend.date)) / 60000; if (mm >= 0) firstRespMin = Math.round(mm); } pend = null; }
        });
        const lastRec = recs[recs.length - 1];
        const isComm = /\(комментарии\)/.test(s.subject) || /^Комментарий к посту/.test(lastRec.text || '');
        const thread = {
          session: s.sessionId, chatId: s.chatId || null, client: s.subject, channel: wd2Channel(s.subject),
          status: lastRec.kind === 'CLIENT' ? 'waiting_us' : 'waiting_client',
          is_comment: isComm,
          first_response_min: firstRespMin,
          client_msgs: dayRecs.filter(r => r.kind === 'CLIENT').length,
          our_msgs: dayRecs.filter(r => r.kind === 'OURSIDE').length,
          handled_by: Object.keys(repliers),
          messages: dayRecs.slice(-30).map(function (r) { return { who: r.kind === 'CLIENT' ? 'client' : (r.opName === 'Ромео' ? 'romeo' : 'manager'), op: r.opName || null, time: r.date, text: String(r.text || '').substring(0, 350) }; })
        };
        const owners = {};
        Object.keys(repliers).forEach(function (n) { owners[n] = true; });
        if (respName && hasClientToday) owners[respName] = true;
        Object.keys(owners).forEach(function (n) { pushThread(n, thread); });
      }
    });

    const managersOut = {};
    Object.keys(managers).forEach(function (name) {
      const m = managers[name];
      const frm = m.first_resp_minutes;
      managersOut[name] = {
        messages_on_date: m.messages,
        sessions_active_on_date: Object.keys(m.sessions_active).length,
        sessions_assigned: m.sessions_assigned,
        avg_first_response_min: frm.length ? Math.round(frm.reduce((a, b) => a + b, 0) / frm.length) : null,
        responses_measured: frm.length
      };
    });

    unansweredDm.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    unansweredComments.sort((a, b) => String(b.time).localeCompare(String(a.time)));

    // персональные переписки: ждущие ответа — сверху, потом по свежести, ограничиваем объём
    const managerThreadsOut = {};
    Object.keys(managerThreads).forEach(function (n) {
      const arr = managerThreads[n].slice();
      arr.sort(function (a, b) {
        const ra = a.status === 'waiting_us' ? 0 : 1, rb = b.status === 'waiting_us' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        const ta = a.messages.length ? a.messages[a.messages.length - 1].time : '';
        const tb = b.messages.length ? b.messages[b.messages.length - 1].time : '';
        return String(tb).localeCompare(String(ta));
      });
      managerThreadsOut[n] = arr.slice(0, 60);
    });

    const result = {
      date, lookback_days: lookback,
      sessions_scanned: sessIds.length,
      managers: managersOut,
      unattributed_replies: unattributedReplies,   // наши ответы через коннектор, которых не удалось привязать к оператору
      unanswered_dm_count: unansweredDm.length,     // реальные личные диалоги без ответа (горячие лиды)
      unanswered_dm: unansweredDm.slice(0, 60),
      unanswered_comments_count: unansweredComments.length, // комментарии/реакции под постами (НЕ горячие лиды)
      unanswered_comments: unansweredComments.slice(0, 40),  // отвечать вручную в Instagram (Pact не шлёт ответы в комментарии)
      altanets_gap: altanetsGap.slice(0, 50),       // личные диалоги Алтанца (болеет) без ответа
      manager_threads: managerThreadsOut,           // переписки за день по каждому менеджеру (для персональных отчётов)
      updatedAt: new Date().toISOString()
    };
    cache[cacheKey] = result; lastUpdate[cacheKey] = Date.now();
    await setCache(cacheKey, result);
    return result;
  } catch (error) {
    throw error;
  }
}

app.get('/workday2', async (req, res) => {
  const date = req.query.date || new Date().toISOString().substring(0, 10);
  const lookback = Math.min(parseInt(req.query.lookback || '2', 10), 14);    // по умолчанию 2 дня — быстрее
  const maxSessions = Math.min(parseInt(req.query.max || '250', 10), 400);
  const cacheKey = wd2Key(date, lookback);
  const cached = cache[cacheKey];
  const age = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;
  if (cached && age < 1800000 && !req.query.fresh) return res.json(cached);
  // уже собирается в фоне
  if (loading[cacheKey]) return res.json({ status: 'building', message: 'Отчёт собирается, обнови через 1–2 мин', date: date });
  // запускаем фоновый сбор и НЕ ждём его (иначе таймаут прокси)
  loading[cacheKey] = true;
  computeWorkday2(date, lookback, maxSessions)
    .then(function () { loading[cacheKey] = false; })
    .catch(function (e) { loading[cacheKey] = false; cache[cacheKey + '_error'] = { error: String((e && e.message) || e), at: new Date().toISOString() }; });
  if (cached) return res.json(Object.assign({ status: 'rebuilding_in_background', note: 'Это прошлые данные; свежие соберутся через 1–2 мин — обнови.' }, cached));
  return res.json({ status: 'building', message: 'Отчёт собирается впервые (~1–2 мин, лимит Битрикса ~2 запроса/сек). Обнови через 1–2 минуты.', date: date, lookback: lookback });
});

// ===== ЧИТАЕМЫЙ ЕЖЕДНЕВНЫЙ ОТЧЁТ (HTML) =====
const WD2_MGR_ID = { 'Алтанец': '10', 'Кашинский': '20326', 'Самарина': '73320', 'Ромео': '80198' };
// секретные токены персональных ссылок (менеджер видит ТОЛЬКО свой отчёт, чужие — нет)
const MANAGER_TOKENS = { 'k7f3a9c2x': 'Кашинский', 's2b8e1d5q': 'Самарина', 'a1lt5n3cw': 'Алтанец', 'r4m0e9o1z': 'Ромео' };
function wd2Key(date, lookback) { return 'workday2_' + date + '_lb' + lookback; }
function wd2Esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function wd2Name(subj) { const m = String(subj || '').match(/"([^"]+)"/); return m ? m[1] : String(subj || ''); }
function wd2Time(t) { const s = String(t || ''); return s.length >= 16 ? (s.substring(11, 16) + ' · ' + s.substring(8, 10) + '.' + s.substring(5, 7)) : s; }
function wd2Channel(subj) {
  const s = String(subj || '');
  if (/ВКонтакте|VK/.test(s)) return 'VK';
  if (/Instagram/.test(s)) return 'Instagram';
  if (/Whatsapp|WhatsApp/i.test(s)) return 'WhatsApp';
  if (/Telegram/i.test(s)) return 'Telegram';
  return 'OL';
}
const WD2_CSS = '<style>' +
  ':root{--bg:#f6f7f9;--card:#fff;--line:#e8eaed;--txt:#1d2129;--mut:#8a9099;--red:#e5484d;--grn:#2da44e;--blue:#2563eb}' +
  '*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--txt);margin:0;padding:18px;line-height:1.45}' +
  '.wrap{max-width:900px;margin:0 auto}h1{font-size:20px;margin:0 0 2px}h2{font-size:15px;margin:24px 0 10px;color:var(--txt)}' +
  '.sub{color:var(--mut);font-size:13px;margin-bottom:14px}' +
  '.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 14px}' +
  '.toolbar a,.toolbar button{font:inherit;font-size:13px;text-decoration:none;color:var(--txt);background:var(--card);border:1px solid var(--line);padding:6px 12px;border-radius:8px;cursor:pointer}' +
  '.toolbar a.primary{background:var(--blue);color:#fff;border-color:var(--blue)}' +
  '.toolbar a.win.on{background:var(--txt);color:#fff;border-color:var(--txt)}' +
  '.winlbl{color:var(--mut);font-size:13px}' +
  'input[type=date]{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card)}' +
  'table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}' +
  'th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:14px}th{font-size:12px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.03em}' +
  'tr:last-child td{border-bottom:none}td.nm{font-weight:600}td.nm a{color:var(--blue);text-decoration:none}td.nm a:hover{text-decoration:underline}td.muted{color:var(--mut)}' +
  '.lead{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--mut);border-radius:9px;padding:10px 13px;margin-bottom:8px}' +
  '.lead.hot{border-left-color:var(--red)}.lead.cool{border-left-color:#c9ced6}.lead.cmt{border-left-color:#a855f7}' +
  '.cmtchip{background:#f3e8ff;color:#7e22ce}' +
  '.lead-h{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}' +
  '.lead-name{font-weight:600;font-size:14px}.lead-name a{color:var(--blue);text-decoration:none}.lead-name a:hover{text-decoration:underline}' +
  '.lead-meta{color:var(--mut);font-size:12px;white-space:nowrap}' +
  '.chip{background:#eef1f4;color:#5b6470;border-radius:5px;padding:1px 6px;font-size:11px}' +
  '.lead-msg{color:#3a3f47;font-size:13px;margin-top:4px}' +
  '.empty{color:var(--mut);background:var(--card);border:1px dashed var(--line);border-radius:9px;padding:14px;text-align:center}' +
  '.banner{background:#fff7e6;border:1px solid #ffe1a8;color:#7a5b00;padding:9px 12px;border-radius:8px;font-size:13px;margin-bottom:14px}' +
  '.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;flex:1;min-width:110px}' +
  '.kpi .n{font-size:22px;font-weight:700}.kpi .l{font-size:12px;color:var(--mut)}' +
  'footer{color:var(--mut);font-size:12px;margin-top:26px}a.back{color:var(--blue);text-decoration:none;font-size:13px}' +
  '</style>';
function wd2WinSelector(basePath, date, lb, lang) {
  const T = wd2L(lang);
  const sep = basePath.indexOf('?') !== -1 ? '&' : '?';
  const lq = lang === 'en' ? '&lang=en' : '';
  const b = function (n, label) { return '<a class="win' + (lb === n ? ' on' : '') + '" href="' + basePath + sep + 'date=' + date + '&lookback=' + n + lq + '">' + label + '</a>'; };
  return '<div class="toolbar"><span class="winlbl">' + T.win + '</span>' + b(2, T.w2) + b(7, T.w7) + b(14, T.w14) + '</div>';
}
function wd2LeadCard(r) {
  const link = r.chatId ? ('https://b24-99blai.bitrix24.ru/online/?IM_HISTORY=imol|' + r.chatId) : null;
  const nm = wd2Esc(wd2Name(r.client));
  const title = link ? ('<a href="' + link + '" target="_blank">' + nm + '</a>') : nm;
  const hot = String(r.last_message || '').length > 40;
  return '<div class="lead ' + (hot ? 'hot' : 'cool') + '">' +
    '<div class="lead-h"><span class="lead-name">' + title + '</span>' +
    '<span class="lead-meta"><span class="chip">' + wd2Channel(r.client) + '</span> ' + wd2Esc(r.assigned) + ' · ' + wd2Time(r.time) + '</span></div>' +
    '<div class="lead-msg">' + wd2Esc(r.last_message) + '</div></div>';
}
function wd2CommentCard(r) {
  const link = r.chatId ? ('https://b24-99blai.bitrix24.ru/online/?IM_HISTORY=imol|' + r.chatId) : null;
  const nm = wd2Esc(wd2Name(r.client));
  const title = link ? ('<a href="' + link + '" target="_blank">' + nm + '</a>') : nm;
  const msg = String(r.last_message || '').trim() ? wd2Esc(r.last_message) : '<span class="muted">(реакция / вложение)</span>';
  return '<div class="lead cmt">' +
    '<div class="lead-h"><span class="lead-name">' + title + '</span>' +
    '<span class="lead-meta"><span class="chip">' + wd2Channel(r.client) + '</span> <span class="chip cmtchip">комментарий</span> ' + wd2Time(r.time) + '</span></div>' +
    '<div class="lead-msg">' + msg + '</div></div>';
}
function renderWorkday2Html(d, rebuilding) {
  const lb = d.lookback_days;
  const order = ['Ромео', 'Кашинский', 'Самарина', 'Алтанец'];
  const names = order.filter(function (n) { return d.managers[n]; })
    .concat(Object.keys(d.managers).filter(function (n) { return order.indexOf(n) === -1; }));
  const rows = names.map(function (n) {
    const m = d.managers[n];
    const sla = m.avg_first_response_min == null ? '—' : (m.avg_first_response_min + ' мин');
    const mlink = '/report/manager?name=' + encodeURIComponent(n) + '&date=' + d.date + '&lookback=' + lb;
    return '<tr><td class="nm"><a href="' + mlink + '">' + wd2Esc(n) + '</a></td><td>' + m.messages_on_date + '</td><td>' + m.sessions_active_on_date + '</td><td>' + m.sessions_assigned + '</td><td>' + sla + '</td><td class="muted">' + m.responses_measured + '</td></tr>';
  }).join('');
  const dm = (d.unanswered_dm || []).map(wd2LeadCard).join('') || '<div class="empty">Нет диалогов, где клиент ждёт ответа 🎉</div>';
  const comments = (d.unanswered_comments || []).map(wd2CommentCard).join('') || '<div class="empty">Комментариев без ответа нет</div>';
  const gap = (d.altanets_gap || []).length
    ? '<h2>Висит на Алтанце (болеет) — перераздать</h2>' + (d.altanets_gap || []).map(wd2LeadCard).join('')
    : '';
  const banner = rebuilding ? '<div class="banner">Идёт пересчёт свежих данных в фоне — обнови страницу через минуту.</div>' : '';
  const today = new Date().toISOString().substring(0, 10);
  const yest = new Date(new Date(d.date + 'T00:00:00').getTime() - 86400000).toISOString().substring(0, 10);
  const tom = new Date(new Date(d.date + 'T00:00:00').getTime() + 86400000).toISOString().substring(0, 10);
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Отчёт ' + wd2Esc(d.date) + '</title>' + WD2_CSS + '</head><body><div class="wrap">' +
    '<h1>Ежедневный отчёт отдела продаж</h1>' +
    '<div class="sub">' + wd2Esc(d.date) + ' · сессий: ' + d.sessions_scanned + ' · окно ' + lb + ' дн. · обновлено ' + wd2Esc(String(d.updatedAt || '').substring(11, 16)) + ' UTC</div>' +
    banner +
    '<form class="toolbar" method="get" action="/report">' +
    '<a href="/report?date=' + yest + '&lookback=' + lb + '">← ' + yest + '</a>' +
    '<input type="date" name="date" value="' + wd2Esc(d.date) + '">' +
    '<input type="hidden" name="lookback" value="' + lb + '">' +
    '<button type="submit">Показать</button>' +
    (d.date < today ? '<a href="/report?date=' + tom + '&lookback=' + lb + '">' + tom + ' →</a>' : '') +
    '<a class="primary" href="/report?date=' + wd2Esc(d.date) + '&lookback=' + lb + '&fresh=1">↻ Свежий пересчёт</a>' +
    '</form>' +
    wd2WinSelector('/report', wd2Esc(d.date), lb) +
    '<div class="cards">' +
    '<div class="kpi"><div class="n">' + (d.unanswered_dm_count || 0) + '</div><div class="l">диалогов ждут ответа</div></div>' +
    '<div class="kpi"><div class="n">' + (d.unanswered_comments_count || 0) + '</div><div class="l">комментариев (не лиды)</div></div>' +
    '<div class="kpi"><div class="n">' + (d.unattributed_replies || 0) + '</div><div class="l">ответов без привязки</div></div>' +
    '</div>' +
    '<h2>По менеджерам</h2>' +
    '<div class="sub" style="margin-top:-4px">Кликни по имени — откроется отдельная страница менеджера.</div>' +
    '<table><thead><tr><th>Менеджер</th><th>Сообщений</th><th>Активных сессий</th><th>Назначено</th><th>Ср. первый ответ</th><th>Замеров</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<h2>Клиенты ждут ответа (' + (d.unanswered_dm_count || 0) + ')</h2>' +
    '<div class="sub" style="margin-top:-4px">Красная полоса — содержательное сообщение (вероятно горячий лид). Имя кликабельно → открывает чат в Битриксе.</div>' +
    dm +
    '<h2>Комментарии под постами (' + (d.unanswered_comments_count || 0) + ')</h2>' +
    '<div class="sub" style="margin-top:-4px">Отвечать <b>только вручную в приложении Instagram</b> — Pact не отправляет ответы в комментарии. Это <b>не</b> промахи Ромео.</div>' +
    comments +
    gap +
    '<footer>Источник: открытые линии Битрикс24. «Назначено» = сессии, стартовавшие за окно. SLA первого ответа — по сообщениям клиента за этот день.</footer>' +
    '</div></body></html>';
}
function renderManagerHtml(d, name) {
  const lb = d.lookback_days;
  const back = '/report?date=' + d.date + '&lookback=' + lb;
  const m = d.managers[name];
  if (!m) {
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + wd2Esc(name) + '</title>' + WD2_CSS + '</head><body><div class="wrap"><a class="back" href="' + back + '">← к отчёту</a><h1>' + wd2Esc(name) + '</h1><div class="empty">Нет данных за ' + wd2Esc(d.date) + ' (окно ' + lb + ' дн.).</div></div></body></html>';
  }
  const uid = WD2_MGR_ID[name];
  const profile = uid ? ('https://b24-99blai.bitrix24.ru/company/personal/user/' + uid + '/') : null;
  const waiting = (d.unanswered_dm || []).filter(function (r) { return String(r.assigned) === name; });
  const dm = waiting.map(wd2LeadCard).join('') || '<div class="empty">Никто не ждёт ответа 🎉</div>';
  const sla = m.avg_first_response_min == null ? '—' : (m.avg_first_response_min + ' мин');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + wd2Esc(name) + ' · ' + wd2Esc(d.date) + '</title>' + WD2_CSS + '</head><body><div class="wrap">' +
    '<a class="back" href="' + back + '">← ко всему отчёту</a>' +
    '<h1>' + wd2Esc(name) + '</h1>' +
    '<div class="sub">' + wd2Esc(d.date) + ' · окно ' + lb + ' дн.' + (profile ? ' · <a class="back" href="' + profile + '" target="_blank">профиль в Битриксе ↗</a>' : '') + '</div>' +
    wd2WinSelector('/report/manager?name=' + encodeURIComponent(name), wd2Esc(d.date), lb) +
    '<div class="cards">' +
    '<div class="kpi"><div class="n">' + m.messages_on_date + '</div><div class="l">сообщений за день</div></div>' +
    '<div class="kpi"><div class="n">' + m.sessions_active_on_date + '</div><div class="l">активных сессий</div></div>' +
    '<div class="kpi"><div class="n">' + m.sessions_assigned + '</div><div class="l">назначено за окно</div></div>' +
    '<div class="kpi"><div class="n">' + sla + '</div><div class="l">ср. первый ответ</div></div>' +
    '<div class="kpi"><div class="n">' + waiting.length + '</div><div class="l">ждут его ответа</div></div>' +
    '</div>' +
    '<h2>Клиенты ждут ответа от «' + wd2Esc(name) + '» (' + waiting.length + ')</h2>' +
    dm +
    '</div></body></html>';
}
const WD2_T = {
  ru: {
    htmlLang: 'ru', mreport: 'Отчёт менеджера: ', window: 'окно', days: 'дн.', updated: 'обновлено',
    priv: 'Это ваша персональная страница. Ссылка личная — по ней видно только ваши переписки.',
    show: 'Показать', refresh: '↻ Обновить', win: 'Окно:', w2: '2 дня', w7: 'неделя', w14: '2 недели',
    kMsgs: 'сообщений за день', kActive: 'активных переписок', kAssigned: 'назначено за окно', kSla: 'ср. первый ответ', kWaiting: 'ждут вашего ответа',
    needReply: 'Нужно ответить', clickName: 'Имя кликабельно → открывает чат в Битриксе.',
    reviewWaiting: 'Разбор переписок за день — ждут ответа', clickRow: 'Нажмите на строку, чтобы развернуть всю переписку.',
    reviewOther: 'Остальные переписки за день',
    emptyWaitingDm: 'Никто не ждёт ответа 🎉', emptyWaitingT: 'Нет открытых переписок, ждущих ответа', emptyDone: 'Других переписок за день нет',
    expert: 'Экспертный разбор дня', preparing: '🧠 Готовлю экспертный разбор переписок как РОП с 10-летним стажем… появится здесь сам через ~20–40 секунд.',
    bAwaitUs: 'ждёт ответа', bAwaitClient: 'ждём клиента', fNoReply: 'нет ответа', fSlow: 'медленно', slowUnit: 'м', fRomeo: 'вёл Ромео', fComment: 'комментарий',
    client: 'Клиент', romeo: 'Ромео', manager: 'Менеджер', attach: '(вложение / реакция)', noMsgs: 'нет сообщений за день',
    aNoKey: 'Экспертный разбор выключен: добавьте переменную <b>ANTHROPIC_API_KEY</b> в Variables на Railway и обновите страницу.',
    aErr: 'Не удалось сгенерировать разбор: ', aErrTail: '. Обновите страницу (↻).', aBy: 'Сгенерировано Claude'
  },
  en: {
    htmlLang: 'en', mreport: 'Manager report: ', window: 'window', days: 'days', updated: 'updated',
    priv: 'This is your personal page. The link is private — it shows only your conversations.',
    show: 'Show', refresh: '↻ Refresh', win: 'Window:', w2: '2 days', w7: 'week', w14: '2 weeks',
    kMsgs: 'messages today', kActive: 'active conversations', kAssigned: 'assigned in window', kSla: 'avg first reply', kWaiting: 'waiting for your reply',
    needReply: 'Need to reply', clickName: 'Click a name to open the chat in Bitrix.',
    reviewWaiting: 'Conversation review — awaiting reply', clickRow: 'Click a row to expand the full conversation.',
    reviewOther: 'Other conversations today',
    emptyWaitingDm: 'No one is waiting 🎉', emptyWaitingT: 'No open conversations awaiting a reply', emptyDone: 'No other conversations today',
    expert: 'Expert review of the day', preparing: '🧠 Preparing an expert review as a 10-year sales head… it will appear here automatically in ~20–40 seconds.',
    bAwaitUs: 'awaiting reply', bAwaitClient: 'awaiting client', fNoReply: 'no reply', fSlow: 'slow', slowUnit: 'm', fRomeo: 'handled by Romeo', fComment: 'comment',
    client: 'Client', romeo: 'Romeo', manager: 'Manager', attach: '(attachment / reaction)', noMsgs: 'no messages today',
    aNoKey: 'Expert review is off: add the <b>ANTHROPIC_API_KEY</b> variable in Railway Variables and refresh.',
    aErr: 'Could not generate the review: ', aErrTail: '. Refresh the page (↻).', aBy: 'Generated by Claude'
  }
};
const wd2L = function (lang) { return WD2_T[lang === 'en' ? 'en' : 'ru']; };
function wd2StatusBadge(st, lang) {
  const T = wd2L(lang);
  if (st === 'waiting_us') return '<span class="badge red">' + T.bAwaitUs + '</span>';
  if (st === 'waiting_client') return '<span class="badge grey">' + T.bAwaitClient + '</span>';
  return '<span class="badge grey">—</span>';
}
function wd2ThreadCard(t, lang) {
  const T = wd2L(lang);
  const link = t.chatId ? ('https://b24-99blai.bitrix24.ru/online/?IM_HISTORY=imol|' + t.chatId) : null;
  const nm = wd2Esc(wd2Name(t.client));
  const title = link ? ('<a href="' + link + '" target="_blank">' + nm + '</a>') : nm;
  const flags = [];
  if (t.client_msgs > 0 && t.our_msgs === 0) flags.push('<span class="flag red">' + T.fNoReply + '</span>');
  if (t.first_response_min != null && t.first_response_min > 30) flags.push('<span class="flag amber">' + T.fSlow + ' ' + t.first_response_min + T.slowUnit + '</span>');
  if (t.handled_by && t.handled_by.indexOf('Ромео') !== -1) flags.push('<span class="flag teal">' + T.fRomeo + '</span>');
  if (t.is_comment) flags.push('<span class="flag purp">' + T.fComment + '</span>');
  const bubbles = (t.messages || []).map(function (m) {
    const side = m.who === 'client' ? 'cl' : 'us';
    const who = m.who === 'client' ? T.client : (m.who === 'romeo' ? T.romeo : (m.op || T.manager));
    const txt = String(m.text || '').trim() ? wd2Esc(m.text) : '<span class="muted">' + T.attach + '</span>';
    return '<div class="bub ' + side + '"><div class="bw">' + txt + '</div><div class="bm">' + wd2Esc(who) + ' · ' + wd2Time(m.time) + '</div></div>';
  }).join('') || '<div class="muted">' + T.noMsgs + '</div>';
  return '<details class="conv"><summary>' +
    '<span class="cv-h">' + title + ' <span class="chip">' + wd2Esc(t.channel) + '</span></span>' +
    '<span class="cv-meta">' + wd2StatusBadge(t.status, lang) + ' ' + flags.join(' ') + ' <span class="muted">' + t.client_msgs + '↓ ' + t.our_msgs + '↑</span></span>' +
    '</summary><div class="thread">' + bubbles + '</div></details>';
}
const WD2_CSS2 = '<style>' +
  '.badge{font-size:11px;padding:2px 8px;border-radius:6px;font-weight:600;white-space:nowrap}' +
  '.badge.red{background:#fde8e8;color:#c81e1e}.badge.grey{background:#eef1f4;color:#5b6470}' +
  '.flag{font-size:11px;padding:1px 6px;border-radius:5px;white-space:nowrap}' +
  '.flag.red{background:#fde8e8;color:#c81e1e}.flag.amber{background:#fff4e0;color:#9a6700}.flag.teal{background:#e0f5f3;color:#0f766e}.flag.purp{background:#f3e8ff;color:#7e22ce}' +
  '.conv{background:var(--card);border:1px solid var(--line);border-radius:9px;margin-bottom:8px;overflow:hidden}' +
  '.conv summary{list-style:none;cursor:pointer;padding:10px 13px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center}' +
  '.conv summary::-webkit-details-marker{display:none}.conv[open] summary{border-bottom:1px solid var(--line)}' +
  '.cv-h{font-weight:600;font-size:14px}.cv-h a{color:var(--blue);text-decoration:none}' +
  '.cv-meta{font-size:12px;color:var(--mut);display:flex;align-items:center;gap:5px;flex-wrap:wrap}' +
  '.thread{padding:12px 13px;display:flex;flex-direction:column;gap:8px;background:#fbfcfd}' +
  '.bub{max-width:80%}.bub.cl{align-self:flex-start}.bub.us{align-self:flex-end}' +
  '.bw{padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-word}' +
  '.bub.cl .bw{background:#eef1f4;color:#1d2129;border-bottom-left-radius:3px}' +
  '.bub.us .bw{background:#2563eb;color:#fff;border-bottom-right-radius:3px}' +
  '.bm{font-size:11px;color:var(--mut);margin-top:2px}.bub.us .bm{text-align:right}' +
  '.priv{background:#eef6ff;border:1px solid #cfe2ff;color:#1e497a;padding:8px 12px;border-radius:8px;font-size:12px;margin-bottom:14px}' +
  '.exbox{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px}' +
  '.exbox.warn{background:#fff7e6;border-color:#ffe1a8;color:#7a5b00}' +
  '.exh{font-size:14px;margin:14px 0 6px}.exbox p{font-size:13.5px;margin:6px 0;line-height:1.5}.exbox p:first-child{margin-top:0}' +
  '.exl{margin:6px 0 6px 18px;padding:0}.exl li{font-size:13.5px;margin:3px 0;line-height:1.45}' +
  '.exmeta{color:var(--mut);font-size:11px;margin-top:12px}' +
  '.exwait{background:#f0f4ff;border:1px dashed #cfe0ff;color:#3a5a8a;border-radius:10px;padding:14px 16px;font-size:13px}' +
  '</style>';
function wd2MdToHtml(text) {
  const lines = String(text || '').split('\n');
  const inline = function (s) { return wd2Esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'); };
  let html = '', inList = false;
  const closeList = function () { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) { closeList(); html += '<h3 class="exh">' + inline(h[1]) + '</h3>'; continue; }
    const b = line.match(/^[-*•]\s+(.*)$/);
    if (b) { if (!inList) { html += '<ul class="exl">'; inList = true; } html += '<li>' + inline(b[1]) + '</li>'; continue; }
    closeList();
    html += '<p>' + inline(line) + '</p>';
  }
  closeList();
  return html;
}
function wd2RenderAnalysis(a, lang) {
  const T = wd2L(lang);
  if (!a) return '';
  if (a.error === 'NO_KEY') return '<div class="exbox warn">' + T.aNoKey + '</div>';
  if (a.error) return '<div class="exbox warn">' + T.aErr + wd2Esc(a.error) + T.aErrTail + '</div>';
  if (a.text) return '<div class="exbox">' + wd2MdToHtml(a.text) + '<div class="exmeta">' + T.aBy + (a.model ? ' (' + wd2Esc(a.model) + ')' : '') + '</div></div>';
  return '';
}
// генерация экспертного разбора переписок менеджера за день (фон, кэшируется; lang: ru|en)
async function computeManagerAnalysis(d, name, lang) {
  lang = lang === 'en' ? 'en' : 'ru';
  const analKey = 'wd2anal_' + d.date + '_lb' + d.lookback_days + '_' + name + '_' + lang;
  const key = process.env.ANTHROPIC_API_KEY;
  const save = function (r) { cache[analKey] = r; lastUpdate[analKey] = Date.now(); try { setCache(analKey, r); } catch (e) { } return r; };
  if (!key) return save({ error: 'NO_KEY' });
  const threads = (d.manager_threads && d.manager_threads[name]) || [];
  if (!threads.length) return save({ text: lang === 'en' ? 'No conversations on this day — nothing to review.' : 'За этот день переписок нет — разбирать нечего.' });
  const pick = threads.slice(0, 14);
  const stWaitUs = lang === 'en' ? 'awaiting our reply' : 'ждёт нашего ответа';
  const stWaitCl = lang === 'en' ? 'awaiting client' : 'ждём клиента';
  const transcript = pick.map(function (t, i) {
    const head = (lang === 'en' ? '### Dialog ' : '### Диалог ') + (i + 1) + ' — ' + wd2Name(t.client) + ' (' + t.channel + (t.is_comment ? (lang === 'en' ? ', comment' : ', комментарий') : '') + '), ' + (lang === 'en' ? 'status: ' : 'статус: ') +
      (t.status === 'waiting_us' ? stWaitUs : stWaitCl) + (t.first_response_min != null ? ((lang === 'en' ? ', first reply ' : ', первый ответ ') + t.first_response_min + (lang === 'en' ? ' min' : ' мин')) : '');
    const body = (t.messages || []).slice(-16).map(function (m) {
      const who = m.who === 'client' ? 'CLIENT' : (m.who === 'romeo' ? 'ROMEO(bot)' : (m.op || 'MANAGER'));
      return who + ': ' + (String(m.text || '').trim().substring(0, 300) || '(attachment)');
    }).join('\n');
    return head + '\n' + body;
  }).join('\n\n');
  const system = lang === 'en'
    ? 'You are a sales director with 10 years of experience in the premium expert segment: in-person and online jewellery training (stone setting, engraving, 3D modelling), order values from ₽86,000 to ₽1,400,000, audience — practising jewellers and enthusiasts worldwide. You review a manager\'s day based on their client conversations. Give an honest, specific expert review — no fluff, grounded in concrete lines from the dialogs. Answer in English. Structure: "## Day assessment" (one paragraph), "## Done well" (with examples), "## Mistakes and missed sales" (specific dialog → what went wrong → what should have been done), "## Recommendations for tomorrow" (3–5 bullet points). Do not invent facts not present in the conversations. If a dialog was handled by the Romeo bot and the manager did not step in on a hot lead, point it out.'
    : 'Ты — руководитель отдела продаж с 10-летним опытом в премиальном экспертном сегменте: офлайн- и онлайн-обучение ювелирному делу (закрепка камней, гравировка, 3D-моделирование), чеки от 86 000 ₽ до 1 400 000 ₽, аудитория — практикующие ювелиры и энтузиасты со всего мира. Ты разбираешь работу менеджера за день по его перепискам с клиентами. Дай честный, конкретный экспертный разбор — без воды и общих фраз, опираясь на конкретные реплики из диалогов. Отвечай по-русски. Структура: «## Оценка дня» (один абзац), «## Сделано правильно» (с примерами), «## Ошибки и упущенные продажи» (конкретный диалог → что не так → как надо было), «## Рекомендации на завтра» (3–5 пунктов списком). Не выдумывай фактов, которых нет в переписке. Если в диалоге вёл бот Ромео, а менеджер не подключился к горячему лиду — отметь это.';
  const user = (lang === 'en' ? 'Manager: ' : 'Менеджер: ') + name + (lang === 'en' ? '. Date: ' : '. Дата: ') + d.date + '.\n\n' + (lang === 'en' ? 'Conversations of the day:' : 'Переписки за день:') + '\n\n' + transcript;
  const model = process.env.ANALYSIS_MODEL || 'claude-opus-4-8';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model, max_tokens: 1600, system: system, messages: [{ role: 'user', content: user }] }),
      timeout: 120000
    });
    const data = await resp.json();
    let text = '';
    if (data && Array.isArray(data.content)) text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!text) return save({ error: (data && data.error && data.error.message) ? data.error.message : 'empty model response' });
    return save({ text: text, model: model, generatedAt: new Date().toISOString() });
  } catch (e) {
    return save({ error: String((e && e.message) || e) });
  }
}
function renderManagerFullHtml(d, name, token, lang) {
  lang = lang === 'en' ? 'en' : 'ru';
  const T = wd2L(lang);
  const lq = lang === 'en' ? '&lang=en' : '';
  const lb = d.lookback_days;
  const base = '/m/' + token;
  const m = d.managers[name] || { messages_on_date: 0, sessions_active_on_date: 0, sessions_assigned: 0, avg_first_response_min: null, responses_measured: 0 };
  const waiting = (d.unanswered_dm || []).filter(function (r) { return String(r.assigned) === name; });
  const threads = (d.manager_threads && d.manager_threads[name]) || [];
  const analKey = 'wd2anal_' + d.date + '_lb' + lb + '_' + name + '_' + lang;
  const analysis = cache[analKey];
  const analReady = !!(analysis && (analysis.text || analysis.error));
  const waitingT = threads.filter(function (t) { return t.status === 'waiting_us'; });
  const doneT = threads.filter(function (t) { return t.status !== 'waiting_us'; });
  const sla = m.avg_first_response_min == null ? '—' : (m.avg_first_response_min + (lang === 'en' ? ' min' : ' мин'));
  const today = new Date().toISOString().substring(0, 10);
  const yest = new Date(new Date(d.date + 'T00:00:00').getTime() - 86400000).toISOString().substring(0, 10);
  const tom = new Date(new Date(d.date + 'T00:00:00').getTime() + 86400000).toISOString().substring(0, 10);
  const dmCards = waiting.map(wd2LeadCard).join('') || '<div class="empty">' + T.emptyWaitingDm + '</div>';
  const waitCards = waitingT.map(function (t) { return wd2ThreadCard(t, lang); }).join('') || '<div class="empty">' + T.emptyWaitingT + '</div>';
  const doneCards = doneT.map(function (t) { return wd2ThreadCard(t, lang); }).join('') || '<div class="empty">' + T.emptyDone + '</div>';
  return '<!doctype html><html lang="' + T.htmlLang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + wd2Esc(name) + ' · ' + wd2Esc(d.date) + '</title>' + WD2_CSS + WD2_CSS2 + '</head><body><div class="wrap">' +
    '<h1>' + T.mreport + wd2Esc(name) + '</h1>' +
    '<div class="sub">' + wd2Esc(d.date) + ' · ' + T.window + ' ' + lb + ' ' + T.days + ' · ' + T.updated + ' ' + wd2Esc(String(d.updatedAt || '').substring(11, 16)) + ' UTC</div>' +
    '<div class="priv">' + T.priv + '</div>' +
    '<form class="toolbar" method="get" action="' + base + '">' +
    '<a href="' + base + '?date=' + yest + '&lookback=' + lb + lq + '">← ' + yest + '</a>' +
    '<input type="date" name="date" value="' + wd2Esc(d.date) + '">' +
    '<input type="hidden" name="lookback" value="' + lb + '">' +
    (lang === 'en' ? '<input type="hidden" name="lang" value="en">' : '') +
    '<button type="submit">' + T.show + '</button>' +
    (d.date < today ? '<a href="' + base + '?date=' + tom + '&lookback=' + lb + lq + '">' + tom + ' →</a>' : '') +
    '<a class="primary" href="' + base + '?date=' + wd2Esc(d.date) + '&lookback=' + lb + lq + '&fresh=1">' + T.refresh + '</a>' +
    '</form>' +
    wd2WinSelector(base, wd2Esc(d.date), lb, lang) +
    '<div class="cards">' +
    '<div class="kpi"><div class="n">' + m.messages_on_date + '</div><div class="l">' + T.kMsgs + '</div></div>' +
    '<div class="kpi"><div class="n">' + m.sessions_active_on_date + '</div><div class="l">' + T.kActive + '</div></div>' +
    '<div class="kpi"><div class="n">' + m.sessions_assigned + '</div><div class="l">' + T.kAssigned + '</div></div>' +
    '<div class="kpi"><div class="n">' + sla + '</div><div class="l">' + T.kSla + '</div></div>' +
    '<div class="kpi"><div class="n">' + waiting.length + '</div><div class="l">' + T.kWaiting + '</div></div>' +
    '</div>' +
    '<h2>' + T.needReply + ' (' + waiting.length + ')</h2>' +
    '<div class="sub" style="margin-top:-4px">' + T.clickName + '</div>' +
    dmCards +
    '<h2>' + T.reviewWaiting + ' (' + waitingT.length + ')</h2>' +
    '<div class="sub" style="margin-top:-4px">' + T.clickRow + '</div>' +
    waitCards +
    '<h2>' + T.reviewOther + ' (' + doneT.length + ')</h2>' +
    doneCards +
    '<h2>' + T.expert + '</h2>' +
    '<div id="exp">' + (analReady ? wd2RenderAnalysis(analysis, lang) : '<div class="exwait">' + T.preparing + '</div>') + '</div>' +
    (analReady ? '' : ('<script>(function(){var t=' + JSON.stringify(token) + ',dt=' + JSON.stringify(d.date) + ',lb=' + lb + ',lng=' + JSON.stringify(lang) + ';function p(){fetch("/m/"+t+"/analysis?date="+dt+"&lookback="+lb+"&lang="+lng).then(function(r){return r.json();}).then(function(j){if(j&&j.ready){var e=document.getElementById("exp");if(e)e.innerHTML=j.html;}else{setTimeout(p,8000);}}).catch(function(){setTimeout(p,8000);});}setTimeout(p,6000);})();</script>')) +
    '</div></body></html>';
}
function renderBuildingHtml(date) {
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="refresh" content="15"><title>Собираю отчёт…</title><style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#1d2129;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}' +
    '.box{max-width:420px;padding:24px}.sp{width:34px;height:34px;border:3px solid #e8eaed;border-top-color:#2563eb;border-radius:50%;margin:0 auto 16px;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}' +
    'h1{font-size:18px;margin:0 0 8px}p{color:#8a9099;font-size:14px;margin:0}</style></head><body><div class="box"><div class="sp"></div>' +
    '<h1>Собираю отчёт за ' + wd2Esc(date) + '…</h1><p>Это ~1–2 минуты (лимит Битрикса ~2 запроса/сек). Страница обновится сама.</p></div></body></html>';
}

function wd2EnsureBuild(date, lookback, maxSessions, wantFresh) {
  const cacheKey = wd2Key(date, lookback);
  const age = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;
  if ((!cache[cacheKey] || (wantFresh && age > 5000)) && !loading[cacheKey]) {
    loading[cacheKey] = true;
    computeWorkday2(date, lookback, maxSessions)
      .then(function () { loading[cacheKey] = false; })
      .catch(function (e) { loading[cacheKey] = false; cache[cacheKey + '_error'] = { error: String((e && e.message) || e), at: new Date().toISOString() }; });
  }
  return cacheKey;
}

app.get('/report', async (req, res) => {
  const date = req.query.date || new Date().toISOString().substring(0, 10);
  const lookback = Math.min(parseInt(req.query.lookback || '2', 10), 14);
  const maxSessions = Math.min(parseInt(req.query.max || '250', 10), 400);
  const wantFresh = !!req.query.fresh;
  const cacheKey = wd2EnsureBuild(date, lookback, maxSessions, wantFresh);
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (cache[cacheKey]) return res.send(renderWorkday2Html(cache[cacheKey], wantFresh || !!loading[cacheKey]));
  return res.send(renderBuildingHtml(date));
});

app.get('/report/manager', async (req, res) => {
  const name = String(req.query.name || '');
  const date = req.query.date || new Date().toISOString().substring(0, 10);
  const lookback = Math.min(parseInt(req.query.lookback || '2', 10), 14);
  const maxSessions = Math.min(parseInt(req.query.max || '250', 10), 400);
  const wantFresh = !!req.query.fresh;
  const cacheKey = wd2EnsureBuild(date, lookback, maxSessions, wantFresh);
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (cache[cacheKey]) return res.send(renderManagerHtml(cache[cacheKey], name));
  return res.send(renderBuildingHtml(date));
});

// ИЗОЛИРОВАННАЯ персональная ссылка менеджера — видно только его переписки, чужих нет
app.get('/m/:token', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  const name = MANAGER_TOKENS[req.params.token];
  if (!name) return res.status(404).send('<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="font-family:-apple-system,sans-serif;padding:40px;text-align:center;color:#555">Ссылка недействительна.</body></html>');
  const date = req.query.date || new Date().toISOString().substring(0, 10);
  const lookback = Math.min(parseInt(req.query.lookback || '2', 10), 14);
  const maxSessions = Math.min(parseInt(req.query.max || '250', 10), 400);
  const wantFresh = !!req.query.fresh;
  const lang = req.query.lang === 'en' ? 'en' : 'ru';
  const cacheKey = wd2EnsureBuild(date, lookback, maxSessions, wantFresh);
  const analKey = 'wd2anal_' + date + '_lb' + lookback + '_' + name + '_' + lang;
  if (wantFresh) { delete cache[analKey]; delete lastUpdate[analKey]; }
  if (cache[cacheKey]) {
    if (!cache[analKey] && !loading[analKey]) {
      loading[analKey] = true;
      computeManagerAnalysis(cache[cacheKey], name, lang).then(function () { loading[analKey] = false; }).catch(function () { loading[analKey] = false; });
    }
    return res.send(renderManagerFullHtml(cache[cacheKey], name, req.params.token, lang));
  }
  return res.send(renderBuildingHtml(date));
});

// JSON: готов ли экспертный разбор (страница менеджера сама опрашивает и подставляет без перезагрузки)
app.get('/m/:token/analysis', async (req, res) => {
  const name = MANAGER_TOKENS[req.params.token];
  if (!name) return res.status(404).json({ ready: false, error: 'bad token' });
  const date = req.query.date || new Date().toISOString().substring(0, 10);
  const lookback = Math.min(parseInt(req.query.lookback || '2', 10), 14);
  const maxSessions = Math.min(parseInt(req.query.max || '250', 10), 400);
  const lang = req.query.lang === 'en' ? 'en' : 'ru';
  const cacheKey = wd2EnsureBuild(date, lookback, maxSessions, false);
  const analKey = 'wd2anal_' + date + '_lb' + lookback + '_' + name + '_' + lang;
  const a = cache[analKey];
  if (a && (a.text || a.error)) return res.json({ ready: true, html: wd2RenderAnalysis(a, lang) });
  if (cache[cacheKey] && !loading[analKey]) {
    loading[analKey] = true;
    computeManagerAnalysis(cache[cacheKey], name, lang).then(function () { loading[analKey] = false; }).catch(function () { loading[analKey] = false; });
  }
  return res.json({ ready: false });
});

// read-only: сырая история одной сессии + поиск маркеров рекламы/сторис (для анализа Instagram-входов)
app.get('/probe-history', async (req, res) => {
  const sid = req.query.session;
  if (!sid) return res.status(400).json({ error: 'нужен ?session=<id> (например, из списка лидов в /report)' });
  try {
    const r = await fetch(WEBHOOK + '/imopenlines.session.history.get.json?SESSION_ID=' + encodeURIComponent(sid), { timeout: 15000 });
    const j = await r.json();
    const result = j && j.result;
    if (!result) return res.json({ session: sid, error: (j && j.error) || 'no result', raw: j });
    const msgs = Object.values(result.message || {}).sort(function (a, b) { return Number(a.id) - Number(b.id); });
    const allText = msgs.map(function (m) { return String(m.text || ''); }).join(' ');
    const markers = {
      ad: /реклам|ad_id|referral|click to message|из рекламы|перешёл по рекламе|\bad\b|\bref\b/i.test(allText),
      story: /стори|\bstory\b|reply_to|ответил[а]? на (вашу )?истор|ответ на истори|упомянул[а]? вас/i.test(allText)
    };
    res.json({
      session: sid,
      chatId: result.chatId,
      users: result.users || {},
      markers: markers,
      messages: msgs.map(function (m) { return { id: m.id, senderid: m.senderid, date: m.date, text: String(m.text || '').substring(0, 400) }; })
    });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// read-only: обзор последних Instagram-сессий — обёртка Pact на первом сообщении vs ответил ли Ромео
app.get('/probe-instagram', async (req, res) => {
  const maxN = Math.min(parseInt(req.query.max || '12', 10), 25);
  const ROMEO_IDS = ['80198', '80100', '80098'];
  const isRomeo = function (id) { return ROMEO_IDS.indexOf(String(id)) !== -1; };
  const opEventTarget = function (raw) {
    if (/начал работу с диалогом/.test(raw)) { const m = raw.match(/\[USER=(\d+)/); return m ? m[1] : null; }
    if (/(переадресовал диалог на|Обращение направлено на|перенаправлено на)/.test(raw)) { const m = raw.match(/на\s*\[USER=(\d+)/); return m ? m[1] : null; }
    return null;
  };
  try {
    const r0 = await fetch(WEBHOOK + '/crm.activity.list.json?order[CREATED]=DESC&filter[PROVIDER_ID]=IMOPENLINES_SESSION&select[]=ID&select[]=SUBJECT&select[]=CREATED&select[]=RESPONSIBLE_ID&select[]=ASSOCIATED_ENTITY_ID&select[]=PROVIDER_PARAMS&start=0', { timeout: 15000 });
    const j0 = await r0.json();
    const acts = (j0 && j0.result) || [];
    const ig = acts.filter(function (a) {
      const uc = (a.PROVIDER_PARAMS && a.PROVIDER_PARAMS.USER_CODE) || '';
      return /instagram/i.test(uc) || /Instagram/i.test(a.SUBJECT || '');
    }).slice(0, maxN);
    const out = [];
    for (const a of ig) {
      const sid = a.ASSOCIATED_ENTITY_ID;
      let hist = null;
      try {
        const rr = await fetch(WEBHOOK + '/imopenlines.session.history.get.json?SESSION_ID=' + encodeURIComponent(sid), { timeout: 15000 });
        hist = await rr.json();
      } catch (e) { out.push({ session: sid, subject: a.SUBJECT, error: String((e && e.message) || e) }); await new Promise(function (z) { setTimeout(z, 400); }); continue; }
      const result = hist && hist.result;
      if (!result || !result.message) { out.push({ session: sid, subject: a.SUBJECT, error: (hist && hist.error) || 'no messages' }); await new Promise(function (z) { setTimeout(z, 400); }); continue; }
      const users = result.users || {};
      const msgs = Object.values(result.message).sort(function (x, y) { return Number(x.id) - Number(y.id); });
      let currentOp = String(a.RESPONSIBLE_ID || '') || null;
      let routedRomeo = false, romeoReplied = false, fromPost = false;
      let firstClientMsg = null, firstEnveloped = false, firstResponder = null, clientCount = 0;
      for (const m of msgs) {
        const s = String(m.senderid || '0');
        const raw = String(m.text || '');
        if (s === '0') {
          if (/направлено на \[USER=80198/.test(raw)) routedRomeo = true;
          if (/исходный пост/.test(raw)) fromPost = true;
          const t = opEventTarget(raw); if (t) currentOp = t;
          continue;
        }
        const u = users[s] || {};
        const isOut = /^\s*(?:\[[^\]]*\]\s*)?Ответ оператора/i.test(raw);
        if (u.connector && !isOut) {
          clientCount++;
          if (firstClientMsg === null) {
            firstEnveloped = /to JAG \(channel id/i.test(raw) || /Instagram business .* id \d+ to JAG/i.test(raw);
            firstClientMsg = raw.replace(/^Instagram business.*?to JAG \(channel id[^)]*\)\s*/i, '').substring(0, 160);
          }
        } else {
          const opId = isOut ? currentOp : s;
          if (!isOut) currentOp = s;
          if (isRomeo(opId)) romeoReplied = true;
          if (!firstResponder) firstResponder = isRomeo(opId) ? 'Romeo' : 'human';
        }
      }
      out.push({
        session: sid,
        name: (a.SUBJECT || '').replace(/^Чат открытой линии - /, '').replace(/ \(.*$/, ''),
        created: a.CREATED,
        from_post: fromPost,
        routed_to_romeo: routedRomeo,
        first_msg_enveloped: firstEnveloped,
        first_client_msg: firstClientMsg,
        client_msgs: clientCount,
        romeo_replied: romeoReplied,
        first_responder: firstResponder,
        verdict: (routedRomeo && !romeoReplied && clientCount > 0) ? 'РОМЕО НЕ ОТВЕТИЛ' : (romeoReplied ? 'ромео ответил' : (clientCount === 0 ? 'нет входящих' : '—'))
      });
      await new Promise(function (z) { setTimeout(z, 400); });
    }
    res.json({ scanned_activities: acts.length, instagram_found: ig.length, sessions: out });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

app.get('/refresh', async (req, res) => {
  const key = req.query.key;
  if (key) { 
    delete cache[key]; 
    delete lastUpdate[key]; 
    await pgDeleteCache(key);
    res.json({ message: 'Cache cleared for ' + key }); 
  } else { 
    cache = {}; 
    lastUpdate = {}; 
    await pgClearAllCache();
    res.json({ message: 'All cache cleared' }); 
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    postgres: pgReady ? 'connected' : 'disabled',
    cacheKeys: Object.keys(cache).length, 
    loading: Object.keys(loading).filter(k => loading[k]).length
  });
});

app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 30000
    });
    const text = await response.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(text);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/last-message-id', (req, res) => {
  const chatId = req.query.chat_id;
  if (!chatId) return res.status(400).json({ error: 'chat_id required' });
  res.json({ chat_id: chatId, last_id: lastMessageIds[chatId] || 0 });
});

app.post('/last-message-id', (req, res) => {
  const { chat_id, message_id } = req.body;
  if (!chat_id || !message_id) return res.status(400).json({ error: 'chat_id and message_id required' });
  lastMessageIds[chat_id] = message_id;
  console.log('Last message ID saved:', chat_id, message_id);
  res.json({ ok: true, chat_id, message_id });
});

app.post('/claude', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(400).json({ error: 'x-api-key header required' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body),
      timeout: 180000
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.log('Claude proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ПЛАНИРОВЩИК НАПОМИНАНИЙ (follow-up на ~20 часах, пока открыто окно 24ч Meta)
// Безопасно: по умолчанию ВЫКЛ. NUDGE_MODE=send включает авто-отправку; режим dry — только показывает.
// ============================================
const ROMEO_BOT_ID = '80198';
const ROMEO_CLIENT_ID = 'local.6a255e256567a1.60218811';
const NUDGE_ROMEO_IDS = ['80198', '80100', '80098'];
const NUDGE_OPS = ['20326', '73320', '10'];

async function nudgeClaude(lang, transcript) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const system = 'Ты — Romeo, цифровой помощник International Jewellery School (премиальное обучение ювелирному делу). Клиент написал тебе и пропал, не ответив. Напиши ОДНО короткое, тёплое и НЕнавязчивое follow-up сообщение (1–2 предложения) на ' + (lang === 'ru' ? 'русском' : 'английском') + ' языке: мягко напомни о себе по сути его вопроса, без давления и без «вы всё ещё там?». В конце предложи как опцию написать в WhatsApp wa.me/79956000477 (там отвечаем персонально и можем прислать фото/видео работ) ИЛИ продолжить здесь. Верни ТОЛЬКО текст сообщения, без кавычек и пояснений.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANALYSIS_MODEL || 'claude-opus-4-8', max_tokens: 400, system: system, messages: [{ role: 'user', content: 'Переписка:\n' + transcript }] }),
      timeout: 60000
    });
    const data = await resp.json();
    if (data && Array.isArray(data.content)) { const t = data.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim(); if (t) return t; }
  } catch (e) { }
  return null;
}
async function nudgeText(lang, transcript) {
  if (process.env.NUDGE_CONTEXTUAL === '1') { const t = await nudgeClaude(lang, transcript); if (t) return t; }
  return lang === 'ru'
    ? 'Здравствуйте! Возвращаюсь к нашему диалогу — если будет удобно, с радостью помогу с выбором и подскажу детали. Можно написать нам в WhatsApp: wa.me/79956000477, там ответим персонально и при необходимости пришлём фото и видео работ. Или продолжим прямо здесь, как вам удобнее 🙂'
    : 'Hi! Just following up on our chat — happy to help you choose and share any details whenever it suits you. You can message us on WhatsApp: wa.me/79956000477, where we reply personally and can send photos and videos of our work. Or we can continue right here, whatever works best 🙂';
}

async function runNudgeSweep(mode) {
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const MIN_H = Number(process.env.NUDGE_MIN_HOURS || 19);
  const MAX_H = Number(process.env.NUDGE_MAX_HOURS || 23);
  const PER_RUN = Number(process.env.NUDGE_MAX_PER_RUN || 8);
  const now = Date.now();
  const report = { mode: mode, at: new Date().toISOString(), window_hours: [MIN_H, MAX_H], scanned: 0, eligible: [], sent: [], skipped: {} };
  const skip = function (k) { report.skipped[k] = (report.skipped[k] || 0) + 1; };
  let acts = [];
  try {
    const r0 = await fetch(WEBHOOK + '/crm.activity.list.json?order[CREATED]=DESC&filter[PROVIDER_ID]=IMOPENLINES_SESSION&select[]=ID&select[]=SUBJECT&select[]=CREATED&select[]=ASSOCIATED_ENTITY_ID&select[]=PROVIDER_PARAMS&start=0', { timeout: 15000 });
    const j0 = await r0.json();
    acts = (j0 && j0.result) || [];
  } catch (e) { report.error = 'activity: ' + String((e && e.message) || e); return report; }
  report.scanned = acts.length;
  let done = 0;
  for (const a of acts) {
    if (done >= PER_RUN) break;
    const sid = a.ASSOCIATED_ENTITY_ID;
    const subject = a.SUBJECT || '';
    if (/\(комментарии\)/i.test(subject)) { skip('comment'); continue; }
    if (cache['nudged_' + sid]) { skip('already_nudged'); continue; }
    let hist = null;
    try { const rr = await fetch(WEBHOOK + '/imopenlines.session.history.get.json?SESSION_ID=' + encodeURIComponent(sid), { timeout: 15000 }); hist = await rr.json(); }
    catch (e) { skip('hist_error'); await sleep(400); continue; }
    const result = hist && hist.result;
    if (!result || !result.message) { skip('no_messages'); await sleep(400); continue; }
    const users = result.users || {};
    const chatId = result.chatId;
    const msgs = Object.values(result.message).sort(function (x, y) { return Number(x.id) - Number(y.id); });
    let operatorPresent = false, hasRomeoMsg = false, hadClient = false, isComment = false;
    let lastClient = null, lastOurs = null, lang = 'en';
    const tail = [];
    for (const m of msgs) {
      const s = String(m.senderid || '0'); const raw = String(m.text || '');
      if (s === '0') continue;
      const u = users[s] || {};
      const isOut = /^\s*(?:\[[^\]]*\]\s*)?Ответ оператора/i.test(raw);
      const t = m.date ? new Date(m.date).getTime() : null;
      if (NUDGE_OPS.indexOf(s) !== -1) operatorPresent = true;
      if (NUDGE_ROMEO_IDS.indexOf(s) !== -1) hasRomeoMsg = true;
      if (/\(комментарии\)/i.test(raw) || /Комментарий к посту/i.test(raw)) isComment = true;
      const clean = raw.replace(/Ответ оператора\s*\([^)]*\)/gi, ' ').replace(/(?:Instagram business|Whatsapp|Telegram)\b.*?to JAG\s*\(channel id[^)]*\)/gi, ' ').replace(/\[\/?[A-Za-z][^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (u.connector && !isOut) { hadClient = true; if (t) lastClient = t; if (/[а-яё]/i.test(raw)) lang = 'ru'; if (clean) tail.push('КЛИЕНТ: ' + clean.substring(0, 200)); }
      else { if (t) lastOurs = t; if (clean) tail.push('МЫ: ' + clean.substring(0, 200)); }
    }
    if (isComment) { skip('comment'); await sleep(400); continue; }
    if (operatorPresent) { skip('operator_present'); await sleep(400); continue; }
    if (!hasRomeoMsg) { skip('not_romeo_handled'); await sleep(400); continue; }
    if (!hadClient || !lastClient) { skip('no_client_msg'); await sleep(400); continue; }
    if (!lastOurs) { skip('we_never_replied'); await sleep(400); continue; }
    if (lastClient > lastOurs) { skip('client_replied_last'); await sleep(400); continue; } // клиент ответил — не молчит
    const hSilent = (now - lastClient) / 3600000;
    if (hSilent < MIN_H || hSilent > MAX_H) { skip('out_of_window'); await sleep(400); continue; }
    const dialogId = 'chat' + (chatId || '');
    const name = subject.replace(/^Чат открытой линии - /, '').replace(/ \(.*$/, '');
    const transcript = tail.slice(-10).join('\n');
    if (mode === 'send') {
      const text = await nudgeText(lang, transcript);
      const item = { session: sid, name: name, lang: lang, hours_silent: Math.round(hSilent * 10) / 10, text: text };
      try {
        const sr = await fetch(WEBHOOK + '/imbot.message.add.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ BOT_ID: ROMEO_BOT_ID, CLIENT_ID: ROMEO_CLIENT_ID, DIALOG_ID: dialogId, MESSAGE: text }), timeout: 15000 });
        const sj = await sr.json();
        item.sent = !!(sj && sj.result); if (sj && sj.error) item.error = sj.error + ': ' + (sj.error_description || '');
      } catch (e) { item.error = String((e && e.message) || e); }
      cache['nudged_' + sid] = { at: new Date().toISOString(), text: text };
      try { await setCache('nudged_' + sid, cache['nudged_' + sid]); } catch (e) { }
      report.sent.push(item);
      done++;
    } else {
      report.eligible.push({ session: sid, name: name, lang: lang, hours_silent: Math.round(hSilent * 10) / 10, would_text: await nudgeText(lang, transcript) });
      done++;
    }
    await sleep(400);
  }
  return report;
}

// ручной запуск: dry — только показать; send — реально отправить (нужен &key=NUDGE_KEY)
app.get('/nudge-run', async (req, res) => {
  const mode = req.query.mode === 'send' ? 'send' : 'dry';
  if (mode === 'send') {
    if (!process.env.NUDGE_KEY || req.query.key !== process.env.NUDGE_KEY) return res.status(403).json({ error: 'send требует ?key=NUDGE_KEY' });
  }
  try { const r = await runNudgeSweep(mode); res.json(r); } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// авто-планировщик: каждые 30 мин, только если NUDGE_MODE=send
if (process.env.NUDGE_MODE === 'send') {
  setInterval(function () {
    runNudgeSweep('send').then(function (r) { if (r.sent && r.sent.length) console.log('🔔 nudge sent:', r.sent.length); }).catch(function (e) { console.log('nudge sweep error', e && e.message); });
  }, 30 * 60 * 1000);
  console.log('🔔 Nudge scheduler ON (every 30 min)');
}

// ============================================
// ФОТО-ОБРАЗЦЫ: probe Диска + тест-отправка (шаг 1–2 реализации отправки фото)
// Требует у вебхука право scope "disk". Read-only, кроме /photo-test (нужен ключ).
// ============================================
// просмотр Диска: без параметров — список хранилищ; ?path=образцы курсов/МикроПаве База — резолв по пути;
// ?folder=ID — содержимое папки; ?storage=ID — корень хранилища
app.get('/disk-probe', async (req, res) => {
  try {
    const map = function (x) { return { ID: x.ID, TYPE: x.TYPE, NAME: x.NAME, SIZE: x.SIZE, DOWNLOAD_URL: x.DOWNLOAD_URL || null, DETAIL_URL: x.DETAIL_URL || null }; };
    const children = async function (id) {
      const r = await fetch(WEBHOOK + '/disk.folder.getchildren.json?id=' + encodeURIComponent(id), { timeout: 15000 });
      const j = await r.json();
      return { items: (j.result || []), error: j.error, error_description: j.error_description };
    };
    const out = function (folderId, extra) {
      return children(folderId).then(function (c) {
        const items = c.items.map(map);
        return res.json(Object.assign({ folder: folderId, count: items.length, folders: items.filter(i => i.TYPE === 'folder'), files: items.filter(i => i.TYPE === 'file'), error: c.error, error_description: c.error_description }, extra || {}));
      });
    };

    if (req.query.path) {
      const segs = String(req.query.path).split('/').map(s => s.trim()).filter(Boolean);
      const sr = await fetch(WEBHOOK + '/disk.storage.getlist.json', { timeout: 15000 });
      const sj = await sr.json();
      if (sj.error) return res.json({ error: sj.error, error_description: sj.error_description, hint: 'возможно у вебхука нет права disk' });
      let storages = sj.result || [];
      storages = storages.filter(s => s.ENTITY_TYPE === 'common').concat(storages.filter(s => s.ENTITY_TYPE !== 'common'));
      const trail = [];
      for (const st of storages) {
        let curId = st.ROOT_OBJECT_ID, ok = true;
        for (const seg of segs) {
          const c = await children(curId);
          const hit = (c.items || []).find(k => k.TYPE === 'folder' && String(k.NAME).toLowerCase() === seg.toLowerCase());
          if (!hit) { ok = false; break; }
          curId = hit.ID;
        }
        if (ok) return out(curId, { resolved_path: req.query.path, storage: { ID: st.ID, NAME: st.NAME } });
        trail.push(st.NAME);
      }
      return res.json({ error: 'PATH_NOT_FOUND', tried_storages: trail, hint: 'проверь точное написание папок (регистр не важен, но пробелы/буквы важны) или используй ?storage=ID и кликай по folders[].ID' });
    }
    if (req.query.folder) return out(req.query.folder);
    if (req.query.storage) {
      const r = await fetch(WEBHOOK + '/disk.storage.getchildren.json?id=' + encodeURIComponent(req.query.storage), { timeout: 15000 });
      const j = await r.json();
      const items = (j.result || []).map(map);
      return res.json({ storage: req.query.storage, count: items.length, folders: items.filter(i => i.TYPE === 'folder'), files: items.filter(i => i.TYPE === 'file'), error: j.error, error_description: j.error_description });
    }
    const r = await fetch(WEBHOOK + '/disk.storage.getlist.json', { timeout: 15000 });
    const j = await r.json();
    const st = (j.result || []).map(function (s) { return { ID: s.ID, NAME: s.NAME, ENTITY_TYPE: s.ENTITY_TYPE, ENTITY_ID: s.ENTITY_ID, ROOT_OBJECT_ID: s.ROOT_OBJECT_ID }; });
    return res.json({ hint: 'дальше: /disk-probe?path=образцы курсов/МикроПаве База (проще всего) либо ?storage=<ID> / ?folder=<ID>', storages: st, error: j.error, error_description: j.error_description });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// тест-отправка картинки в диалог:
//   method=attach — ATTACH-блок бота (Pact игнорит, уходит только текст)
//   method=link   — ссылка текстом
//   method=file   — РЕАЛЬНОЕ вложение в чат (folder.get → copyto → commit), доходит как фото
// /photo-test?dialog=chatNNNN&file=<disk file id>&method=file&key=PHOTO_KEY
app.get('/photo-test', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY (задайте PHOTO_KEY в Variables)' });
  const dialog = req.query.dialog, fileId = req.query.file;
  const method = ['link', 'file'].indexOf(req.query.method) !== -1 ? req.query.method : 'attach';
  if (!dialog || !fileId) return res.status(400).json({ error: 'нужны ?dialog=chatNNNN&file=<disk file id>' });
  try {
    if (method === 'file') {
      const fgr = await fetch(WEBHOOK + '/im.disk.folder.get.json?DIALOG_ID=' + encodeURIComponent(dialog), { timeout: 15000 });
      const fgj = await fgr.json();
      const folderId = fgj.result && fgj.result.ID;
      if (!folderId) return res.json({ method: method, step: 'im.disk.folder.get', error: fgj.error || 'нет папки чата', error_description: fgj.error_description, raw: fgj });
      const cpr = await fetch(WEBHOOK + '/disk.file.copyto.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: fileId, targetFolderId: folderId }), timeout: 30000 });
      const cpj = await cpr.json();
      const newId = cpj.result && cpj.result.ID;
      if (!newId) return res.json({ method: method, step: 'disk.file.copyto', error: cpj.error || 'копирование не удалось', error_description: cpj.error_description, raw: cpj });
      const cmr = await fetch(WEBHOOK + '/im.disk.file.commit.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ DIALOG_ID: dialog, FILE_ID: newId, MESSAGE: '' }), timeout: 15000 });
      const cmj = await cmr.json();
      return res.json({ method: method, chat_folder: folderId, new_file_id: newId, commit_result: cmj.result, error: cmj.error, error_description: cmj.error_description, note: 'проверь в Instagram, пришло ли ФОТО как изображение' });
    }
    const fr = await fetch(WEBHOOK + '/disk.file.get.json?id=' + encodeURIComponent(fileId), { timeout: 15000 });
    const fj = await fr.json();
    const f = fj.result;
    if (!f) return res.json({ error: 'файл не найден', raw: fj });
    const url = f.DOWNLOAD_URL;
    const body = method === 'link'
      ? { BOT_ID: ROMEO_BOT_ID, CLIENT_ID: ROMEO_CLIENT_ID, DIALOG_ID: dialog, MESSAGE: url }
      : { BOT_ID: ROMEO_BOT_ID, CLIENT_ID: ROMEO_CLIENT_ID, DIALOG_ID: dialog, MESSAGE: f.NAME || ' ', ATTACH: [{ IMAGE: [{ NAME: f.NAME || 'photo', LINK: url, PREVIEW: url, WIDTH: 1000, HEIGHT: 1000 }] }] };
    const sr = await fetch(WEBHOOK + '/imbot.message.add.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 15000 });
    const sj = await sr.json();
    res.json({ method: method, dialog: dialog, file: { ID: f.ID, NAME: f.NAME, DOWNLOAD_URL: url }, send_result: sj.result, error: sj.error, error_description: sj.error_description, note: 'проверь в самом Instagram' });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// тест-отправка ТЕКСТА от бота: /text-test?dialog=chatNNNN&len=700&key=PHOTO_KEY  (или &msg=произвольный текст)
app.get('/text-test', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  const dialog = req.query.dialog;
  if (!dialog) return res.status(400).json({ error: 'нужен ?dialog=chatNNNN (+ len=ЧИСЛО или msg=текст)' });
  let msg = req.query.msg || 'тест';
  const len = parseInt(req.query.len || '0', 10);
  if (len > 0) { const head = 'Тест длины ' + len + ' символов. '; msg = head + 'абвгде '.repeat(Math.ceil((len - head.length) / 7)); msg = msg.substring(0, len); }
  try {
    const sr = await fetch(WEBHOOK + '/imbot.message.add.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ BOT_ID: ROMEO_BOT_ID, CLIENT_ID: ROMEO_CLIENT_ID, DIALOG_ID: dialog, MESSAGE: msg }), timeout: 15000 });
    const sj = await sr.json();
    res.json({ dialog: dialog, chars: msg.length, send_result: sj.result, error: sj.error, error_description: sj.error_description, note: 'проверь в Instagram, дошло ли это сообщение' });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});



// ============================================
// СОКРАТ: приём сообщений группы мастерской из Telegram
// Вебхук Telegram шлёт сюда каждое сообщение. Пишем сырьё в tg_reports.
// Защита: секретный заголовок Telegram + фильтр по chat_id группы.
// ============================================
const TG_SOCRATES_TOKEN = process.env.TG_SOCRATES_TOKEN || '';
const TG_SOCRATES_SECRET = process.env.TG_SOCRATES_SECRET || '';
const TG_SOCRATES_CHAT = process.env.TG_SOCRATES_CHAT || '-1004300239646';

app.post('/socrates/tg', async (req, res) => {
  // 1) проверка секрета Telegram (заголовок задаётся при setWebhook)
  if (TG_SOCRATES_SECRET) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== TG_SOCRATES_SECRET) {
      console.log('⚠️ socrates/tg: неверный секрет');
      return res.sendStatus(403);
    }
  }
  // Telegram ждёт быстрый 200, иначе ретраит — отвечаем сразу
  res.sendStatus(200);

  try {
    const upd = req.body || {};
    const msg = upd.message || upd.edited_message || upd.channel_post;
    if (!msg) return;

    const chatId = msg.chat && msg.chat.id;
    // 2) фильтр: принимаем только нашу группу
    if (String(chatId) !== String(TG_SOCRATES_CHAT)) {
      console.log('ℹ️ socrates/tg: чужой chat_id', chatId, '— игнор');
      return;
    }

    const text = msg.text || msg.caption || '';
    const from = msg.from || {};
    const authorName = [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username || '');

    if (!pgPool) { console.log('ℹ️ socrates/tg: Postgres выкл, сообщение не сохранено'); return; }

    await pgPool.query(
      `INSERT INTO tg_reports(update_id, message_id, chat_id, author_id, author_name, text, msg_date, raw, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(update_id) DO NOTHING`,
      [
        upd.update_id || null,
        msg.message_id || null,
        chatId,
        from.id || null,
        authorName,
        text,
        msg.date || null,
        JSON.stringify(msg),
        Date.now()
      ]
    );
    console.log('✓ tg_reports +1:', authorName, '|', text.slice(0, 60));
  } catch (err) {
    console.log('⚠️ socrates/tg error:', err.message);
  }
});

// Просмотр последних сохранённых отчётов (проверка, что приём работает)
// /socrates/reports?limit=30
app.get('/socrates/reports', async (req, res) => {
  if (!pgPool) return res.json({ error: 'postgres disabled' });
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 200);
  try {
    const r = await pgPool.query(
      'SELECT message_id, author_name, text, msg_date FROM tg_reports ORDER BY id DESC LIMIT $1',
      [limit]
    );
    res.json({
      count: r.rows.length,
      reports: r.rows.map(x => ({
        author: x.author_name,
        text: x.text,
        date: x.msg_date ? new Date(x.msg_date * 1000).toISOString() : null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// ============================================
// СОКРАТ: разбор отчётов мастерской через Claude (пакетно в 20:00 МСК)
// Читает сырьё из tg_reports за дату, матчит к живым сделкам C46/C48/PlakhovArt,
// раскладывает в work_log, помечает clarify для непонятных.
// ============================================
const SOCRATES_MASTER_MAP = {
  // каноничное имя -> { call: обращение, gender: род для окончаний, aliases: варианты написания }
  // это же — ростер мастеров, от которых ждём ежедневный отчёт (кроме выходных)
  'Степан Ершов': { call: 'Степан', gender: 'm', aliases: ['ershov', 'степан', 'ершов', 'stepan'] },
  'Олег Гиниборг': { call: 'Олег', gender: 'm', aliases: ['oleg', 'олег', 'гиниборг'] },
  'Игорь Деменцов': { call: 'Игорь', gender: 'm', aliases: ['игорь', 'деменцов', 'igor'] },
  'Витя Комисар': { call: 'Витя', gender: 'm', aliases: ['viktor', 'витя', 'виктор', 'комисар', 'komisar'] },
  'Кристина Спасская': { call: 'Кристина', gender: 'f', aliases: ['кристина', 'спасская', 'kristina'] },
  'Володя Плахов': { call: 'Володя', gender: 'm', aliases: ['володя', 'плахов', 'vladimir', 'volodya', 'plakhov'] }
};

// устойчивое сопоставление telegram-автора с мастером (без регистра, по подстроке алиаса)
function socratesMasterOf(author) {
  const a = String(author || '').toLowerCase().trim();
  if (!a) return null;
  for (const name of Object.keys(SOCRATES_MASTER_MAP)) {
    const m = SOCRATES_MASTER_MAP[name];
    for (const al of m.aliases) {
      if (a.indexOf(al) !== -1) return { name: name, call: m.call };
    }
  }
  return null;
}

// тянем открытые производственные сделки как контекст для матчинга
async function socratesLoadDeals() {
  const cats = [46, 48];
  const out = [];
  for (const cat of cats) {
    let start = 0, guard = 0;
    while (guard < 30) {
      guard++;
      const url = WEBHOOK + '/crm.deal.list.json?filter[CATEGORY_ID]=' + cat +
        '&filter[CLOSED]=N&select[]=ID&select[]=TITLE&select[]=STAGE_ID&start=' + start;
      let d = null;
      try { const r = await fetch(url, { timeout: 15000 }); d = await r.json(); } catch (e) { break; }
      if (!d || !Array.isArray(d.result)) break;
      for (const deal of d.result) {
        const m = String(deal.TITLE || '').match(/^#?\s*(\d{1,4})\b/);
        out.push({ id: deal.ID, num: m ? m[1] : null, title: (deal.TITLE || '').slice(0, 60), cat: cat });
      }
      if (d.next && d.next > start) start = d.next; else break;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return out;
}

// вычисление реальной даты работы по дню недели относительно даты сообщения
function socratesResolveDate(dayWord, msgDateStr) {
  const map = { 'пн': 1, 'вт': 2, 'ср': 3, 'чт': 4, 'пт': 5, 'сб': 6, 'вс': 0 };
  const w = String(dayWord || '').toLowerCase().slice(0, 2);
  if (!(w in map)) return msgDateStr.slice(0, 10);
  const msg = new Date(msgDateStr);
  const msgDow = msg.getUTCDay();
  const target = map[w];
  let diff = msgDow - target;
  if (diff < 0) diff += 7;            // ближайший прошедший этот день недели
  const d = new Date(msg.getTime() - diff * 86400000);
  return d.toISOString().slice(0, 10);
}

async function socratesClaudeParse(reports, deals, recentCtx) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'NO_KEY' };
  const dealCatalog = deals.filter(d => d.num).map(d => d.num + '|' + d.title).join('\n');
  const knownObjects = 'Ножи PlakhovArt: Адъютант, Гунгнир, Грач, Готика, Буля, Консул, Моисей. ' +
    'Худож. проекты: Нуво, Папоротник, Брошка титан, Кошка, Львица, Подсолнух.';
  const namesLine = 'Обращения к мастерам в вопросах: ' +
    Object.entries(SOCRATES_MASTER_MAP).map(([name, m]) => name + ' = ' + m.call).join(', ') +
    '. Автор в отчёте может быть написан ником или сокращённо (ERSHOV, Oleg, Viktor K) — соотнеси с мастером по смыслу.';
  const msgList = reports.map(r => r.id + ' :: ' + (r.author || '') + ' :: ' + (r.msg_date || '') + ' :: ' + (r.text || '').replace(/\n/g, ' / ')).join('\n');

  const system = 'Ты — аналитик производства ювелирной мастерской KARAKURKCHI-PLAKHOV. ' +
    'Разбираешь ежедневные отчёты мастеров из рабочего чата и раскладываешь их для учёта человеко-дней. ' +
    'ВХОД: строки формата "reportId :: автор :: датаISO :: текст" (перевод строки в тексте заменён на " / "). ' +
    'КОНТЕКСТ — открытые производственные сделки (формат "номер|название"):\n' + dealCatalog + '\n' + knownObjects + '\n' + namesLine + '\n\n' +
    'ПРАВИЛА:\n' +
    '1. Многострочный отчёт ("Ср: 221 / Чт: 221 / Пт: уборка") — ЭТО НЕСКОЛЬКО ЗАПИСЕЙ, по одной на день. Дата работы = реальная дата по дню недели, НЕ дата сообщения.\n' +
    '2. Категории: deal (заказ C46/C48 по номеру), plakhov (нож/худож.проект), teaching (курс/преподавание), orgwork (уборка/оргработа/битрикс/корпоратив/бытовые дела мастерской), absence (отпуск/болезнь/выходной), ignore (приветствия/реакции/болтовня БЕЗ описания занятости).\n' +
    '2а. ВАЖНО: если мастер описывает, чем занимался — это ВСЕГДА отчёт, даже если занятие бытовое ("праздновали день рождения, мыл посуду" = orgwork, операция "корпоратив"). День мастера не должен пропасть из учёта. ignore — только для сообщений вообще без занятости.\n' +
    '3. object: номер заказа ("221") или название ножа/проекта или курс. deal_num: номер сделки если это deal, иначе null.\n' +
    '4. operation: закрепка/монтировка/литьё/полировка/эскиз/выборка фона/уборка и т.п. Если не указана — null.\n' +
    '5. business_unit: school (преподавание), brand (заказы, ножи, худож.), common (оргработа, отпуск).\n' +
    '6. day_fraction: по умолчанию 1.0 (один объект = весь день). Если в ОДИН день у одного мастера НЕСКОЛЬКО объектов — day_fraction=null и clarify=true (спросить распределение). Разные дни — каждый 1.0.\n' +
    '6а. Проценты в отчёте — это доли дня: "70% замки, 30% приборка" = day_fraction 0.7 и 0.3. "Пол дня" = 0.5. Такие записи clarify=false — мастер уже распределил.\n' +
    '6а-1. ЧАСЫ = доли дня, ВСЕГДА считай из них сам, НЕ переспрашивай (clarify=false). Полный рабочий день = 8 часов. Доля операции = часы этой операции / 8, БЕЗ округления (5,5ч → 0.69, 6,5ч → 0.81, точное значение с двумя знаками). Примеры: "4 часа сборка, 3 часа закрепка 221" → 0.5 и 0.375. Если суммарно указано больше 8 часов (переработка, "из 12 часов") — считай доли от фактической суммы часов, чтобы в сумме дало ~1.0 (12ч: 2ч полировка=0.17, 10ч литьё=0.83). Если мастер написал "распредели сам" — тем более считай.\n' +
    '6а-1б. Если мастер дал часы по ГРУППАМ операций ("2 часа полировка на склад: 214,223,231; 10 часов обработка литья: 232,219,229"), раздели часы группы поровну между заказами внутри неё. НЕ переспрашивай — данных достаточно. Пример: 2ч на 4 заказа полировки = по 0.5ч = по 0.06 дня; 10ч на 4 заказа литья = по 2.5ч = по 0.31 дня.\n' +
    '6а-2. Обед НЕ считается в рабочее время и НЕ идёт в day_fraction. Дорога, "работал дома", "приезжал" — контекст, не отдельные объекты. ВАЖНО про Володю Плахова: он ездит учиться скульптуре самостоятельно — это его личное обучение, НЕ рабочее время и НЕ в учёт. "Уехал на обучение / на учёбу / на скульптуру" у Володи = день заканчивается там, эти часы НЕ считаются вообще. Учитывай только рабочие часы ДО отъезда. Неполный день (сумма рабочих часов меньше 8) НЕ округляй до 1.0 — оставляй точную долю (6,5ч = 0.81).\n' +
    '6а-3. ОРГВОПРОСЫ, не преподавание: "запись презентации курса", "звонки по курсу/по школе", "общение со студентами", "экскурсия для студентов", подготовка материалов для курса — это orgwork со стороной ШКОЛА (operation "оргработа школа"), НЕ teaching. teaching ставится ТОЛЬКО когда мастер реально ВЁЛ занятие/преподавал ("преподавание Подготовительного курса", "провёл занятие"). Оргработа МАСТЕРСКОЙ: уборка, битрикс, инструмент, выдача работ, встреча с клиентом, "отвёз родий/камни", логистика, закупки → orgwork с operation "оргработа мастерская". Указывай сторону в operation для раздельного учёта.\n' +
    '6а-4. НЕПОЛНЫЙ ДЕНЬ — это НОРМА, не повод переспрашивать. Если мастер указал часы и они не набирают 8 (например "2 часа встреча, 1 час экскурсия" = 3 часа), значит он столько и работал — посчитай доли из этих часов (2/8=0.25, 1/8=0.125), clarify=false, НЕ спрашивай "чем занимался остальной день". Мастер отчитался полностью — остаток дня он просто не работал. Переспрашивай про распределение ТОЛЬКО когда объектов несколько, а часы по ним НЕ указаны.\n' +
    '6а-5. ЗАГОТОВИТЕЛЬНЫЕ/ПОДГОТОВИТЕЛЬНЫЕ работы без номера заказа ("выпрямлял/точил штырьки", "заготовка проволоки", "подготовка инструмента", "сборка бормашин", "подготовка к курсу") — это orgwork мастерской, НЕ привязывай их к соседнему заказу. Если мастер написал "4 часа штырьки, 4 часа 258" — это 0.5 orgwork (штырьки) + 0.5 deal (258), считай раздельно.\n' +
    '6б. Короткое сообщение с одной операцией ("закрепка", "комплексно и обработка и закрепка...") — это ОТВЕТ на вчерашний вопрос об операции: отнеси его к последним дням работы этого мастера по его последнему ЗАКАЗУ. ОБЯЗАТЕЛЬНО проставь object = номер того заказа (посмотри, по какому заказу у этого мастера в эти дни висел незакрытый вопрос — обычно это заказ из его недавних отчётов). НЕ оставляй object пустым и НЕ относи к оргработе.\n' +
    '6б-1. ВАЖНО: ответ на вопрос НЕ создаёт новый рабочий день. Если мастер уточняет операцию по вчерашней работе, work_date = ДАТА ТОЙ работы (вчерашняя), а НЕ дата сообщения. И НЕ ставь ему за сегодня ещё один полный день f=1 за то же самое — сумма долей мастера за один день не может превышать 1.0. Если сегодня он уже отчитался о другой работе, ответ про вчера идёт отдельной записью на вчерашнюю дату.\n' +
    '6в. Сообщение-исправление или уточнение с ЯВНОЙ ДАТОЙ ("3.07 я не крепил, а прибирал", "2.07 замки, 3.07 приборка") относится к ЭТОЙ дате из текста, НЕ к дате сообщения. Даже если прислано через несколько дней — это правка того дня. work_date = дата из текста.\n' +
    '6г. Если мастер несколькими сообщениями за один день уточняет ОДИН и тот же рабочий день (сначала "215, скребу поры", потом "7 часов дома по 215") — это ОДНА работа, объедини в одну запись по заказу, не создавай две. Часы бери из более полного/позднего сообщения.\n' +
    '6г-1. СОСЕДНИЕ СООБЩЕНИЯ = ОДИН ОТЧЁТ. Некоторые мастера (особенно Витя) шлют отчёт двумя-тремя сообщениями подряд в течение нескольких минут: сначала номера заказов ("209, 214, 233, 231, 174."), следом операцию и часы ("6 часов заваривал полировал отгрузил на склад"). Склеивай такие сообщения одного автора, идущие подряд с разницей до ~10 минут, в ОДИН отчёт: номера из одного + операция/часы из другого. Не разбирай их изолированно и НЕ спрашивай номер, если он есть в соседнем сообщении.\n' +
    '6г-2. "ПРОДОЛЖЕНИЕ" = та же операция, что мастер делал по этому заказу в предыдущий рабочий день. Пример: пн "разделка #220", вт "разделка #220", ср "продолжение #220" → в среду тоже разделка, операция ясна из контекста, clarify=false. Смотри предыдущие дни этого мастера по этому заказу и подставляй операцию сам, не переспрашивай.\n' +
    '6г-3. Мастер может уточнить свой вчерашний отчёт на следующее утро ("8 часов титан первый" вчера → сегодня "Титан кольцо номер 142"). Это ОТВЕТ на вопрос, а не новая работа: проставь номер заказа во вчерашнюю запись, нового дня не создавай.\n' +
    '7. confidence: high (объект и операция ясны), medium (объект ясен, операция нет), low (объект неоднозначен).\n' +
    '8. clarify=true если: операция не указана для deal/plakhov; объект неоднозначен; несколько объектов в день. clarify_question — вопрос мастеру по-русски с обращением по имени.\n' +
    '8-РОД. Кристина Спасская — ЖЕНЩИНА, обращайся в женском роде: "что делала", "чем занималась", "подскажи, как распределила день". Остальные пятеро (Степан, Олег, Игорь, Витя, Володя) — мужчины. Не путай окончания, это режет слух.\n' +
    '8-ТОН. Сократ общается с мастерами как дружелюбный коллега, а не бюрократ. Тон тёплый, живой, на «ты», без канцелярита и сарказма. Уместная лёгкая шутка примерно в одном вопросе из трёх — но НЕ в каждом. ВОЗРАСТ важен для регистра: Витя — 60, к нему особенно уважительно, как к старшему мастеру; советское кино и добрый юмор с ним максимально к месту. Олег — 53, тоже уважительно, но можно чуть живее. К обоим без молодёжного панибратства; уместны лёгкие цитаты из советского кино («Бриллиантовая рука», «Кавказская пленница», «Операция Ы», «Иван Васильевич меняет профессию», «Джентльмены удачи»), если ложатся к месту — например "Витя, куй железо, не отходя от кассы: по 215 сегодня что было?" или "Олег, будь другом, расскажи, по 231 какой этап — а то я теряюсь в догадках". Не притягивай цитату силой, только когда естественно. Степан (~30) и Кристина (~35) — можно чуть свободнее и легче, современно. Игорь и Володя — нейтрально-дружески. Примеры хорошего тона: "Степан, а по 221 в среду-четверг что делал — закрепка, полировка? Подскажи, запишу точно". "Игорь, помоги разложить: 2 и 3 июля между Нуво и приборкой как поделить по времени?". Плохой тон: сухое "Не вижу отчёта. Предоставьте информацию".\n' +
    '9. Строки категории ignore не порождают записей work_log вообще.\n' +
    '9а. КРИТИЧНО: Роман Каракуркчи (Roman Karakurkchi) — ВЛАДЕЛЕЦ, НЕ мастер. Его сообщения это управление, пояснения, пересказ чужих отчётов «чтобы бот понял», напоминания — их ВСЕГДА ignore, НИКОГДА не создавай записей под именем Роман. Так же ignore любого автора, кого нет в ростере мастеров (Людмила Харламова и прочие). Отчёт считается только от самого мастера с его аккаунта.\n' +
    '10. Дедуп: если один мастер в один день по одному объекту — одна запись, даже если сырьё дублируется.\n' +
    '11. В clarify_question обращайся по ИМЕНИ из карты обращений (Степан, Олег...), не по фамилии и не по telegram-нику.\n' +
    '12. СКЛЕЙКА ВОПРОСОВ: если у одного мастера по одному объекту несколько дней без операции — сформулируй ОДИН общий вопрос на все дни ("Степан, по 221 в ср-чт что делал?") и продублируй этот же текст в clarify_question каждой из этих записей. Не задавай отдельный вопрос на каждый день.\n\n' +
    'ВЕРНИ СТРОГО JSON-массив, по объекту на КАЖДУЮ запись work_log (не на входное сообщение): ' +
    '{"tg_report_id":число, "work_date":"YYYY-MM-DD", "master":"имя", "category":"...", "object":"... или null", "deal_num":"... или null", "operation":"... или null", "business_unit":"...", "day_fraction":число или null, "confidence":"...", "clarify":true/false, "clarify_question":"... или null", "raw_text":"исходная строка"}. ' +
    'Только JSON, без пояснений и markdown.';

  const model = process.env.ANALYSIS_MODEL || 'claude-opus-4-8';
  const ctxBlock = recentCtx && recentCtx.length
    ? 'НЕДАВНИЕ РАБОТЫ МАСТЕРОВ (для контекста: "продолжение" = та же операция, что тут по этому заказу):\n' + recentCtx + '\n\n'
    : '';
  const body = JSON.stringify({ model: model, max_tokens: 4000, system: system, messages: [{ role: 'user', content: ctxBlock + 'Отчёты:\n' + msgList }] });
  // до 3 попыток: Opus на большом контексте иногда отдаёт "Premature close" — повторяем
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: body,
        timeout: 300000
      });
      const data = await resp.json();
      let text = '';
      if (data && Array.isArray(data.content)) text = data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!text) {
        lastErr = (data && data.error && data.error.message) || 'empty response';
        if (data && data.error) return { error: lastErr };
        continue;
      }
      text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(text);
      return { records: Array.isArray(parsed) ? parsed : [] };
    } catch (e) {
      lastErr = String((e && e.message) || e);
      console.log('⚠️ socratesClaudeParse попытка ' + attempt + ':', lastErr);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }
  return { error: lastErr || 'unknown' };
}

async function computeSocratesDigest(dateStr) {
  const digestKey = 'socrates_digest_' + dateStr;
  if (!pgPool) return { error: 'postgres disabled' };
  try {
    // Скользящее окно: с 22:00 МСК предыдущего дня до 22:00 МСК текущего.
    // Разбор идёт в 22:00, а ~29% мастеров пишут отчёт позже (22:03, 23:47, 00:05) —
    // при календарном окне они терялись и попадали в «молчуны». Теперь их отчёт
    // подхватывается следующим разбором, а реальная дата работы берётся из текста (правило 6в).
    const from = Math.floor(new Date(dateStr + 'T22:00:00+03:00').getTime() / 1000) - 86400;
    const to = Math.floor(new Date(dateStr + 'T22:00:00+03:00').getTime() / 1000);
    const r = await pgPool.query(
      'SELECT id, author_name AS author, text, msg_date FROM tg_reports WHERE msg_date >= $1 AND msg_date <= $2 ORDER BY id ASC',
      [from, to]
    );
    const reports = r.rows.map(x => ({
      id: x.id, author: x.author,
      msg_date: new Date(x.msg_date * 1000).toISOString(),
      text: x.text || ''
    }));
    // дедуп отредактированных сообщений: Telegram шлёт каждую правку как новое.
    // если один автор за короткое окно прислал похожие отчёты — оставляем последний.
    // отпечаток = ключевые слова + номера заказов, БЕЗ времени (мастера переотправляют,
    // меняя "19.50"→"20.00", это одно сообщение). Ловит правки, которые не совпадают по началу.
    const fingerprint = t => {
      let s = String(t || '').toLowerCase();
      // убираем время (9.50, 19.30, "с 10 до 20", "8 часов") чтобы правки времени не мешали
      s = s.replace(/\d{1,2}[.:]\d{2}/g, ' ').replace(/\bс\s*\d{1,2}\s*(до|-)\s*\d{1,2}/g, ' ')
           .replace(/\d+[.,]?\d*\s*час\w*/g, ' ').replace(/[^а-яёa-z0-9]+/g, ' ').trim();
      // берём номера заказов (2-4 цифры) + первые значимые слова
      const nums = (s.match(/\b\d{2,4}\b/g) || []).sort().join(',');
      const words = s.replace(/\b\d{2,4}\b/g, '').split(' ').filter(w => w.length > 3).slice(0, 4).sort().join(' ');
      return nums + '|' + words;
    };
    const normHead = fingerprint;
    const byAuthorHead = {};
    for (const rep of reports) {
      if (!rep.text || rep.text.length < 8) continue;
      const fp = normHead(rep.text);
      if (!fp || fp === '|') continue;
      const k = rep.author + '||' + fp;
      if (!byAuthorHead[k]) byAuthorHead[k] = [];
      byAuthorHead[k].push(rep);
    }
    const dropIds = {};
    for (const k of Object.keys(byAuthorHead)) {
      const grp = byAuthorHead[k];
      if (grp.length < 2) continue;
      grp.sort((a, b) => new Date(a.msg_date) - new Date(b.msg_date));
      // дубли только если в пределах 30 минут (иначе это работа в разные дни)
      const last = grp[grp.length - 1];
      const lastT = new Date(last.msg_date).getTime();
      for (const g of grp) {
        if (g.id === last.id) continue;
        if (Math.abs(new Date(g.msg_date).getTime() - lastT) <= 30 * 60000) dropIds[g.id] = true;
      }
    }
    const dedup = reports.filter(rep => !dropIds[rep.id])
      // в разбор идут ТОЛЬКО сообщения мастеров из ростера.
      // Роман (владелец), Людмила и прочие не-мастера отсекаются — это управление/пояснения, не отчёты
      .filter(rep => socratesMasterOf(rep.author) !== null);
    if (!reports.length) {
      const empty = { date: dateStr, reports: 0, records: [], clarifications: [], note: 'нет сообщений за эту дату' };
      cache[digestKey] = empty; lastUpdate[digestKey] = Date.now();
      return empty;
    }
    const deals = await socratesLoadDeals();
    // контекст: что мастера делали в предыдущие 7 дней — нужен для «продолжение #220»
    // (операция берётся из прошлого дня) и для привязки уточнений к заказу
    let recentCtx = '';
    try {
      const since = new Date(new Date(dateStr + 'T12:00:00Z').getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const rc = await pgPool.query(
        `SELECT work_date, master, category, object, operation FROM work_log
         WHERE work_date >= $1 AND work_date < $2 AND category IN ('deal','plakhov')
         ORDER BY work_date DESC LIMIT 40`, [since, dateStr]);
      recentCtx = rc.rows.map(x =>
        String(x.work_date).slice(0, 10) + ' ' + (x.master || '') + ': ' +
        (x.object || '?') + ' — ' + (x.operation || 'операция не указана')).join('\n');
    } catch (e) { console.log('⚠️ recentCtx:', e.message); }
    const parsed = await socratesClaudeParse(dedup, deals, recentCtx);
    if (parsed.error) { const e = { date: dateStr, error: parsed.error }; cache[digestKey] = e; lastUpdate[digestKey] = Date.now(); return e; }

    const dealByNum = {};
    for (const d of deals) if (d.num) dealByNum[d.num] = d.id;

    const records = parsed.records.filter(rec => rec.category !== 'ignore');
    // канонизация имён: как бы Claude ни назвал мастера (ERSHOV, Степан, Ершов) — в базу пишем одно имя
    for (const rec of records) {
      const cm = socratesMasterOf(rec.master);
      if (cm) rec.master = cm.name;
    }
    // валидация долей: сумма за один день у одного мастера не может превышать 1.0.
    // Бывает, когда ответ на вчерашний вопрос Claude записывает как новую работу с f=1
    // поверх реальной работы дня. Нормализуем пропорционально.
    const dayFrac = {};
    for (const rec of records) {
      if (rec.day_fraction === null || rec.day_fraction === undefined) continue;
      const k = (rec.master || '') + '|' + (rec.work_date || dateStr);
      dayFrac[k] = (dayFrac[k] || 0) + Number(rec.day_fraction);
    }
    for (const k of Object.keys(dayFrac)) {
      if (dayFrac[k] <= 1.01) continue;
      const coef = 1 / dayFrac[k];
      console.log('⚠️ Сократ: перебор долей ' + k + ' = ' + dayFrac[k].toFixed(2) + ', нормализую');
      for (const rec of records) {
        if (rec.day_fraction === null || rec.day_fraction === undefined) continue;
        if ((rec.master || '') + '|' + (rec.work_date || dateStr) !== k) continue;
        rec.day_fraction = Math.round(rec.day_fraction * coef * 100) / 100;
      }
    }
    let written = 0, merged = 0;
    for (const rec of records) {
      const dealId = rec.deal_num && dealByNum[rec.deal_num] ? dealByNum[rec.deal_num] : null;
      try {
        // 1) сначала пробуем ЗАКРЫТЬ существующую незавершённую запись
        // (тот же мастер+объект+день, где операция или доля ещё не определены) —
        // так ответы мастеров на вопросы Сократа обновляют старые строки, а не плодят дубли
        const upd = await pgPool.query(
          `UPDATE work_log SET
             operation = COALESCE($1, operation),
             day_fraction = COALESCE($2, day_fraction),
             confidence = $3, clarify = $4, clarify_question = $5
           WHERE master = $6 AND COALESCE(object,'') = COALESCE($7,'') AND work_date = $8
             AND (operation IS NULL OR day_fraction IS NULL)
           RETURNING id`,
          [rec.operation || null, rec.day_fraction === undefined ? null : rec.day_fraction,
           rec.confidence || null, !!rec.clarify, rec.clarify_question || null,
           rec.master || null, rec.object || null, rec.work_date || dateStr]
        );
        if (upd.rowCount > 0) { merged += upd.rowCount; continue; }
        // 1б) уточнение уже отчитанного дня: есть запись того же мастер+объект+день+категория
        // с иной формулировкой операции — обновляем её (берём более свежие операцию/долю),
        // а не плодим дубль. Защищает от повторной привязки исправлений за прошлые дни.
        if (rec.object) {
          const same = await pgPool.query(
            `SELECT id FROM work_log
             WHERE master=$1 AND COALESCE(object,'')=COALESCE($2,'') AND work_date=$3 AND category=$4
             ORDER BY created_at ASC LIMIT 1`,
            [rec.master || null, rec.object || null, rec.work_date || dateStr, rec.category || null]);
          if (same.rowCount > 0) {
            await pgPool.query(
              `UPDATE work_log SET operation=COALESCE($1,operation),
                 day_fraction=$2, confidence=$3, clarify=$4, clarify_question=$5 WHERE id=$6`,
              [rec.operation || null, rec.day_fraction === undefined ? 1.0 : rec.day_fraction,
               rec.confidence || null, !!rec.clarify, rec.clarify_question || null, same.rows[0].id]);
            merged++; continue;
          }
        }
        // 2) незакрытой записи нет — вставляем новую
        await pgPool.query(
          `INSERT INTO work_log(tg_report_id, work_date, master, category, object, deal_id, operation, business_unit, day_fraction, confidence, clarify, clarify_question, raw_text, digest_date, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT(master, object, work_date, operation) DO UPDATE SET
             day_fraction=EXCLUDED.day_fraction, confidence=EXCLUDED.confidence,
             clarify=EXCLUDED.clarify, clarify_question=EXCLUDED.clarify_question`,
          [rec.tg_report_id || null, rec.work_date || dateStr, rec.master || null, rec.category || null,
           rec.object || null, dealId, rec.operation || null, rec.business_unit || null,
           rec.day_fraction === undefined ? 1.0 : rec.day_fraction, rec.confidence || null,
           !!rec.clarify, rec.clarify_question || null, rec.raw_text || null, dateStr, Date.now()]
        );
        written++;
      } catch (e) { console.log('⚠️ work_log insert:', e.message); }
    }

    // вопросы: дедуп по тексту (склеенный вопрос дублируется в нескольких записях)
    const seenQ = {};
    const clarifications = [];
    for (const rec of records) {
      if (!rec.clarify || !rec.clarify_question) continue;
      const qkey = (rec.master || '') + '|' + rec.clarify_question;
      if (seenQ[qkey]) continue;
      seenQ[qkey] = true;
      clarifications.push({ master: rec.master, question: rec.clarify_question, object: rec.object });
    }

    // контроль "нет отчёта": в будни напоминаем молчунам из ростера, в сб/вс — не напоминаем
    // (но присланные в выходные отчёты разобраны выше как обычно)
    const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
    const isWeekend = (dow === 0 || dow === 6);
    const missing = [];
    if (!isWeekend) {
      const seenMasters = {};
      for (const r of reports) {
        const m = socratesMasterOf(r.author);
        if (m) seenMasters[m.name] = true;
      }
      for (const name of Object.keys(SOCRATES_MASTER_MAP)) {
        if (!seenMasters[name]) {
          const m = SOCRATES_MASTER_MAP[name];
          missing.push(name);
          const she = (m.gender === 'f');
          const nudges = [
            m.call + ', не вижу от тебя сводки за день — всё в порядке? Черкни пару слов, что было в работе',
            m.call + ', как прошёл день? Напиши, чем ' + (she ? 'занималась' : 'занимался') + ', чтобы я записал точно',
            m.call + ', жду от тебя весточку за сегодня, чтобы ничего не потерялось. Что ' + (she ? 'делала' : 'делал') + '?',
            m.call + ', подскажи, как сегодня время распределилось — хочу записать твою работу верно'
          ];
          const nq = nudges[Math.floor(Math.random() * nudges.length)];
          clarifications.push({ master: name, question: nq, object: null });
        }
      }
    }

    // переспрос: незакрытые вопросы прошлых дней (до 5 дней назад) повторяем, пока мастер не ответит
    try {
      const since = new Date(new Date(dateStr + 'T12:00:00Z').getTime() - 5 * 86400000).toISOString().slice(0, 10);
      // берём открытый вопрос ТОЛЬКО если по тому же мастеру и рабочему дню НЕТ ни одной
      // закрытой (clarify=false) записи — то есть мастер на этот день ещё не ответил ничем.
      // Это ловит ответы, пришедшие другим календарным днём.
      const open = await pgPool.query(
        `SELECT DISTINCT w.master, w.clarify_question FROM work_log w
         WHERE w.clarify = true AND w.clarify_question IS NOT NULL
           AND w.work_date >= $1 AND w.work_date < $2
           AND NOT EXISTS (
             SELECT 1 FROM work_log w2
             WHERE w2.master = w.master AND w2.work_date = w.work_date AND w2.clarify = false)
         LIMIT 8`, [since, dateStr]);
      const already = {};
      for (const c of clarifications) already[(c.master||'') + '|' + c.question] = true;
      for (const row of open.rows) {
        const key = (row.master||'') + '|' + row.clarify_question;
        if (already[key]) continue;
        already[key] = true;
        clarifications.push({ master: row.master, question: 'Напоминаю: ' + row.clarify_question, object: null });
      }
    } catch (e) { console.log('⚠️ переспрос:', e.message); }

    const result = {
      date: dateStr, is_weekend: isWeekend, reports: reports.length, parsed: records.length,
      written: written, merged: merged,
      missing_reports: missing,
      records: records, clarifications: clarifications, updatedAt: new Date().toISOString()
    };
    cache[digestKey] = result; lastUpdate[digestKey] = Date.now();
    return result;
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// отправка уточняющих вопросов в группу мастерской
// force=true (ручной &ask=1) — отправляет всегда; иначе только при SOCRATES_ASK=on (планировщик)
async function socratesSendQuestions(digest, force) {
  if (!force && process.env.SOCRATES_ASK !== 'on') return { sent: 0, reason: 'SOCRATES_ASK выключен' };
  if (!digest || !digest.clarifications || !digest.clarifications.length) return { sent: 0, reason: 'нет вопросов' };
  if (!TG_SOCRATES_TOKEN) return { sent: 0, reason: 'нет токена' };
  let sent = 0;
  for (const c of digest.clarifications) {
    const text = c.question;
    try {
      const url = 'https://api.telegram.org/bot' + TG_SOCRATES_TOKEN + '/sendMessage';
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_SOCRATES_CHAT, text: text }), timeout: 15000
      });
      const j = await r.json();
      if (j && j.ok) sent++;
    } catch (e) { console.log('⚠️ socrates ask:', e.message); }
    await new Promise(r => setTimeout(r, 500));
  }
  return { sent: sent };
}


// эндпоинт: запустить/показать разбор за дату. /socrates/digest?date=YYYY-MM-DD
// без date — за сегодня (МСК). &run=1 — принудительно пересчитать.
app.get('/socrates/digest', async (req, res) => {
  const mskNow = new Date(Date.now() + 3 * 3600000);
  const date = req.query.date || mskNow.toISOString().slice(0, 10);
  const digestKey = 'socrates_digest_' + date;
  // digest всегда считается заново (аналитика — свежесть важнее скорости).
  // ?cached=1 — отдать последний результат из памяти без пересчёта (быстрый просмотр)
  const result = (req.query.cached === '1' && cache[digestKey]) ? cache[digestKey] : await computeSocratesDigest(date);
  if (req.query.ask === '1' && result && !result.error) {
    result.ask_result = await socratesSendQuestions(result, true);
  }
  return res.json(result);
});

// эндпоинт: человеко-дни по объектам за период. /socrates/workload?days=30
app.get('/socrates/workload', async (req, res) => {
  if (!pgPool) return res.json({ error: 'postgres disabled' });
  const days = Math.min(parseInt(req.query.days || '30', 10), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  try {
    const byObject = await pgPool.query(
      `SELECT object, category, COUNT(DISTINCT master||work_date) AS person_days, SUM(day_fraction) AS total_fraction
       FROM work_log WHERE work_date >= $1 AND category IN ('deal','plakhov')
       GROUP BY object, category ORDER BY total_fraction DESC NULLS LAST LIMIT 100`, [since]);
    const byMaster = await pgPool.query(
      `SELECT master, category, SUM(day_fraction) AS days
       FROM work_log WHERE work_date >= $1 GROUP BY master, category ORDER BY master, days DESC`, [since]);
    const byUnit = await pgPool.query(
      `SELECT business_unit, SUM(day_fraction) AS days
       FROM work_log WHERE work_date >= $1 GROUP BY business_unit`, [since]);
    res.json({
      period_days: days, since: since,
      by_object: byObject.rows,
      by_master: byMaster.rows,
      by_business_unit: byUnit.rows,
      updatedAt: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// месячный отчёт: кто чем занимался. /socrates/month?month=YYYY-MM (&master=Степан — только один мастер)
app.get('/socrates/month', async (req, res) => {
  if (!pgPool) return res.json({ error: 'postgres disabled' });
  const month = req.query.month || new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7);
  const from = month + '-01';
  const [__y, __m] = month.split('-').map(Number);
  const to = new Date(Date.UTC(__y, __m, 0)).toISOString().slice(0, 10); // последний день месяца
  const masterFilter = req.query.master ? ' AND master ILIKE $3' : '';
  const params = req.query.master ? [from, to, '%' + req.query.master + '%'] : [from, to];
  try {
    const r = await pgPool.query(
      `SELECT master, category, object, operation,
              COUNT(*) AS entries, SUM(COALESCE(day_fraction, 0)) AS days,
              COUNT(*) FILTER (WHERE day_fraction IS NULL) AS unresolved
       FROM work_log
       WHERE work_date >= $1 AND work_date <= $2 AND category <> 'ignore'${masterFilter}
       GROUP BY master, category, object, operation
       ORDER BY master, days DESC NULLS LAST`, params);
    // группируем по мастеру: итог дней + раскладка занятий
    const byMaster = {};
    for (const row of r.rows) {
      const m = row.master || '(неизвестный)';
      if (!byMaster[m]) byMaster[m] = { total_days: 0, unresolved_entries: 0, activities: [] };
      byMaster[m].total_days += Number(row.days || 0);
      byMaster[m].unresolved_entries += Number(row.unresolved || 0);
      byMaster[m].activities.push({
        category: row.category,
        object: row.object,
        operation: row.operation,
        days: Number(row.days || 0),
        entries: Number(row.entries)
      });
    }
    for (const m of Object.keys(byMaster)) byMaster[m].total_days = Math.round(byMaster[m].total_days * 10) / 10;
    res.json({
      month: month,
      masters: byMaster,
      note: 'days — учтённые человеко-дни; unresolved_entries — записи без распределения дня (day_fraction null, ждут уточнения). ignore не входит.',
      updatedAt: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});


// онлайн-отчёт мастерской: /socrates/report?month=YYYY-MM (HTML, живые данные из work_log)
const SOC_MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
function socEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function socWorkdays(month){ // будних дней в месяце YYYY-MM
  const [y,m]=month.split('-').map(Number);
  let n=0; const d=new Date(Date.UTC(y,m-1,1));
  while(d.getUTCMonth()===m-1){ const w=d.getUTCDay(); if(w!==0&&w!==6)n++; d.setUTCDate(d.getUTCDate()+1); }
  return n;
}
app.get('/socrates/report', async (req, res) => {
  res.set('Content-Type','text/html; charset=utf-8');
  if (!pgPool) return res.send('Postgres отключён');
  const month = /^\d{4}-\d{2}$/.test(req.query.month||'') ? req.query.month : new Date(Date.now()+3*3600000).toISOString().slice(0,7);
  const [__ry, __rm] = month.split('-').map(Number);
  const from = month+'-01', to = new Date(Date.UTC(__ry, __rm, 0)).toISOString().slice(0,10);
  try {
    const r = await pgPool.query(
      `SELECT master, category, object, operation, work_date, day_fraction, clarify, clarify_question
       FROM work_log WHERE work_date >= $1 AND work_date <= $2 AND category <> 'ignore'
       ORDER BY master, work_date`, [from, to]);
    const rows = r.rows;
    const CATS = {deal:'Производство', plakhov:'Авторские', teaching:'Курс', orgwork:'Орг', absence:'Отсутствие'};
    const masters = {}; const objects = {}; const pending = [];
    const closedDays = {}; // мастер|день, где есть закрытая (отвеченная) запись
    for (const x of rows) {
      if (!x.clarify) closedDays[(x.master||'') + '|' + String(x.work_date).slice(0,10)] = true;
    }
    for (const x of rows) {
      const m = x.master || '(неизвестный)';
      if (!masters[m]) masters[m] = { days:{}, dates:new Set(), unresolved:0 };
      const f = x.day_fraction===null ? 0 : Number(x.day_fraction);
      masters[m].days[x.category] = (masters[m].days[x.category]||0) + f;
      masters[m].dates.add(String(x.work_date).slice(0,10));
      if (x.day_fraction===null) masters[m].unresolved++;
      if (x.category==='deal'||x.category==='plakhov') {
        const o = x.object || '(без объекта)';
        if (!objects[o]) objects[o] = { days:0, who:{} , cat:x.category };
        objects[o].days += f;
        objects[o].who[m] = (objects[o].who[m]||0) + f;
      }
      if (x.clarify && x.clarify_question && !closedDays[(x.master||'') + '|' + String(x.work_date).slice(0,10)]) pending.push({master:m, q:x.clarify_question, date:String(x.work_date).slice(0,10)});
    }
    const wd = socWorkdays(month);
    const [yy,mm]=month.split('-').map(Number);
    const prev = new Date(Date.UTC(yy,mm-2,1)).toISOString().slice(0,7);
    const next = new Date(Date.UTC(yy,mm,1)).toISOString().slice(0,7);
    const title = SOC_MONTHS[mm-1]+' '+yy;

    const mRows = Object.keys(masters).sort((a,b)=>masters[b].dates.size-masters[a].dates.size).map(m=>{
      const d=masters[m];
      const cells=['deal','plakhov','teaching','orgwork','absence'].map(c=>{
        const v=d.days[c]||0; return '<td class="n">'+(v?(Math.round(v*10)/10):'')+'</td>';
      }).join('');
      const unres = d.unresolved ? '<span class="warn">'+d.unresolved+' без долей</span>' : '';
      return '<tr><td class="nm">'+socEsc(m)+'</td>'+cells+'<td class="n tot">'+d.dates.size+'</td><td class="mut">'+unres+'</td></tr>';
    }).join('');

    const maxObj = Math.max(1, ...Object.values(objects).map(o=>o.days));
    const oRows = Object.keys(objects).sort((a,b)=>objects[b].days-objects[a].days).slice(0,20).map(o=>{
      const x=objects[o]; const w=Math.round((x.days/maxObj)*100);
      const who=Object.entries(x.who).map(([n,v])=>socEsc(n.split(' ')[0])+' '+(Math.round(v*10)/10)).join(', ');
      return '<div class="orow"><div class="on">'+socEsc(o)+'</div><div class="ob"><div class="obar" style="width:'+w+'%"></div></div><div class="od">'+(Math.round(x.days*10)/10)+'</div><div class="ow">'+who+'</div></div>';
    }).join('') || '<div class="mut">Нет производственных записей за месяц</div>';

    const pRows = pending.slice(0,15).map(p=>'<div class="prow"><b>'+socEsc(p.master.split(' ')[0])+'</b> · '+p.date+' — '+socEsc(p.q)+'</div>').join('')
      || '<div class="mut">Все записи месяца закрыты, уточнений не ждём</div>';

    res.send('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>Мастерская · '+socEsc(title)+'</title><style>'+
    'body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#F7F5F0;color:#23262B;margin:0;line-height:1.5}'+
    '.hero{background:#23262B;color:#F7F5F0;padding:34px 20px 28px}'+
    '.wrap{max-width:860px;margin:0 auto;padding:0 20px}'+
    'h1{font-family:Georgia,"Times New Roman",serif;font-size:26px;margin:0}'+
    '.hero .sub{color:#A8853B;font-size:16px;margin-top:4px;font-family:Georgia,serif}'+
    '.nav{margin-top:14px;font-size:13px}.nav a{color:#B9B4AA;text-decoration:none;margin-right:16px}.nav a:hover{color:#F7F5F0}'+
    'h2{font-family:Georgia,serif;font-size:19px;margin:30px 0 12px}'+
    'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E4E0D8}'+
    'th,td{padding:9px 10px;font-size:13.5px;border-bottom:1px solid #EFECE5;text-align:left}'+
    'th{color:#6E6A63;font-weight:600;font-size:11.5px}'+
    'td.n{text-align:center}td.tot{color:#A8853B;font-weight:700}td.nm{font-weight:600}td.mut{color:#6E6A63;font-size:11.5px}'+
    '.warn{color:#9a6700}'+
    '.orow{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #E4E0D8;border-top:none;padding:7px 10px}'+
    '.orow:first-of-type{border-top:1px solid #E4E0D8}'+
    '.on{width:170px;font-weight:600;font-size:13.5px;flex-shrink:0}'+
    '.ob{flex:1;background:#EFECE5;height:14px;max-width:240px}.obar{background:#A8853B;height:14px}'+
    '.od{width:36px;color:#A8853B;font-weight:700;font-size:13.5px}'+
    '.ow{color:#6E6A63;font-size:12px;flex:1}'+
    '.prow{background:#fff;border:1px solid #E4E0D8;border-top:none;padding:8px 10px;font-size:13px}.prow:first-of-type{border-top:1px solid #E4E0D8}'+
    '.mut{color:#6E6A63;font-size:13px}.foot{color:#8B867C;font-size:11.5px;margin:26px 0 40px}'+
    '</style></head><body>'+
    '<div class="hero"><div class="wrap"><h1>Мастерская KARAKURKCHI-PLAKHOV</h1><div class="sub">Итоги: '+socEsc(title)+'</div>'+
    '<div class="nav"><a href="/socrates/report?month='+prev+'">&#8592; '+prev+'</a><a href="/socrates/report?month='+next+'">'+next+' &#8594;</a></div></div></div>'+
    '<div class="wrap">'+
    '<h2>Загрузка мастеров</h2>'+
    '<table><tr><th>Мастер</th><th>Произв.</th><th>Авторские</th><th>Курс</th><th>Орг</th><th>Отсут.</th><th>Дней</th><th></th></tr>'+(mRows||'<tr><td colspan="8" class="mut">Нет данных за месяц</td></tr>')+'</table>'+
    '<h2>Изделия месяца</h2>'+oRows+
    '<h2>Открытые уточнения</h2>'+pRows+
    '<h2>Преподавание (курс)</h2>'+(Object.keys(masters).filter(m=>(masters[m].days.teaching||0)>0).sort((a,b)=>(masters[b].days.teaching||0)-(masters[a].days.teaching||0)).map(m=>'<div class="orow"><div class="on">'+socEsc(m)+'</div><div class="od">'+(Math.round((masters[m].days.teaching||0)*10)/10)+' дн</div></div>').join('')||'<div class="mut">Дней преподавания за месяц нет</div>')+
    '<div class="foot">Источник: ежедневные отчёты мастеров в Telegram, разбор Сократа. Рабочих дней в месяце: '+wd+'. Дни в таблице — сумма учтённых долей; «без долей» — записи, ждущие распределения от мастера.</div>'+
    '</div></body></html>');
  } catch (e) { res.send('Ошибка: '+socEsc(e.message)); }
});




// онлайн-расчёт ЗП: /socrates/salary?month=YYYY-MM&key=PHOTO_KEY (&wd=21 — рабочих дней вручную)
// ставки: env SOCRATES_SALARY = {"Имя":[оклад,надбавка],...} либо значения по умолчанию ниже
const SOC_SALARY_DEFAULT = {
  'Володя Плахов': [200000, 0],
  'Игорь Деменцов': [80000, 0],
  'Витя Комисар': [90000, 0],
  'Кристина Спасская': [160000, 0],
  'Степан Ершов': [180000, 40000],
  'Олег Гиниборг': [120000, 0]
};
const SOC_TEACH_K = 1.45;
app.get('/socrates/salary', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).send('Доступ по ключу: ?key=...');
  if (!pgPool) return res.send('Postgres отключён');
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7);
  const [sy, sm] = month.split('-').map(Number);
  const from = month + '-01';
  const to = new Date(Date.UTC(sy, sm, 0)).toISOString().slice(0, 10);
  let salary = SOC_SALARY_DEFAULT;
  try { if (process.env.SOCRATES_SALARY) salary = JSON.parse(process.env.SOCRATES_SALARY); } catch (e) {}
  const wd = parseInt(req.query.wd || '0', 10) || socWorkdays(month);
  try {
    const r = await pgPool.query(
      `SELECT master, category, SUM(COALESCE(day_fraction,0)) AS days
       FROM work_log WHERE work_date >= $1 AND work_date <= $2 AND category <> 'ignore'
       GROUP BY master, category`, [from, to]);
    const agg = {};
    for (const x of r.rows) {
      const m = x.master; if (!agg[m]) agg[m] = { total: 0, teach: 0, absent: 0 };
      const v = Number(x.days || 0);
      agg[m].total += v;
      if (x.category === 'teaching') agg[m].teach += v;
      if (x.category === 'absence') agg[m].absent += v;
    }
    const rnd = n => Math.round(n).toLocaleString('ru-RU');
    let total = 0;
    const rows = Object.keys(salary).map(m => {
      const base = salary[m][0], bonus = salary[m][1] || 0;
      const a = agg[m] || { total: 0, teach: 0, absent: 0 };
      const worked = Math.round((a.total - a.absent) * 100) / 100;   // все отработанные (без отсутствий)
      const teach = Math.round(a.teach * 100) / 100;                 // из них дни курса
      const prod = Math.round((worked - teach) * 100) / 100;          // производственные дни
      const rate = base / wd;                                         // дневная ставка от оклада
      const prodPay = Math.round(rate * prod);                        // оклад только за производство
      const teachPay = Math.round(rate * SOC_TEACH_K * teach);        // курс отдельно, по ставке ×1.45
      const pay = prodPay + teachPay + (worked > 0 ? bonus : 0);
      total += pay;
      const bonusCell = bonus ? '+' + rnd(bonus) : '';
      const teachCell = teach ? teach + ' <span class="mut">(' + rnd(teachPay) + ')</span>' : '';
      return '<tr><td class="nm">' + socEsc(m) + '</td><td class="n">' + rnd(base) + '</td><td class="n">' + prod + '</td><td class="n">' + teachCell + '</td><td class="n">' + rnd(prodPay + teachPay) + '</td><td class="n">' + bonusCell + '</td><td class="n pay">' + rnd(pay) + '</td></tr>';
    }).join('');
    const title = SOC_MONTHS[sm - 1] + ' ' + sy;
    res.send('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Расчёт ЗП · ' + socEsc(title) + '</title><style>' +
      'body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#F7F5F0;color:#23262B;margin:0;line-height:1.5}' +
      '.hero{background:#23262B;color:#F7F5F0;padding:30px 20px 24px}.wrap{max-width:900px;margin:0 auto;padding:0 20px}' +
      'h1{font-family:Georgia,serif;font-size:24px;margin:0}.hero .sub{color:#A8853B;font-size:15px;margin-top:4px;font-family:Georgia,serif}' +
      'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E4E0D8;margin-top:24px}' +
      'th,td{padding:10px;font-size:13.5px;border-bottom:1px solid #EFECE5;text-align:left}' +
      'th{color:#6E6A63;font-weight:600;font-size:11.5px}td.n{text-align:right}td.nm{font-weight:600}' +
      'td.pay{color:#A8853B;font-weight:700;font-size:14.5px}.mut{color:#6E6A63;font-size:11px;font-weight:400}' +
      'tr.tot td{border-top:2px solid #23262B;font-weight:700;font-size:14.5px}' +
      '.foot{color:#8B867C;font-size:11.5px;margin:22px 0 40px;line-height:1.6}' +
      '</style></head><body>' +
      '<div class="hero"><div class="wrap"><h1>Расчёт заработной платы мастерской</h1><div class="sub">' + socEsc(title) + ' · рабочих дней: ' + wd + '</div></div></div>' +
      '<div class="wrap">' +
      '<table><tr><th>Мастер</th><th style="text-align:right">Оклад</th><th style="text-align:right">Произв. дн</th><th style="text-align:right">Курс дн (оплата)</th><th style="text-align:right">За дни, руб</th><th style="text-align:right">Надбавка</th><th style="text-align:right">К выплате, руб</th></tr>' +
      rows +
      '<tr class="tot"><td>ИТОГО</td><td></td><td></td><td></td><td></td><td></td><td class="n">' + rnd(total) + '</td></tr></table>' +
      '<div class="foot">Формула: дневная ставка = оклад / ' + wd + ' раб. дн. Оплата за производственные дни = ставка x произв. дни. Курс оплачивается отдельно: ставка x ' + SOC_TEACH_K + ' x дни преподавания. Плюс надбавка. Дни отсутствия (отпуск, болезнь, нет отчёта) не оплачиваются. Источник дней — учёт Сократа (work_log) по ежедневным отчётам мастеров. Рабочих дней в месяце — производственный календарь РФ (укажите вручную: &amp;wd=21). Расчёт справочный и на период запуска ТЕСТОВЫЙ; основание выплат определяет руководитель.</div>' +
      '</div></body></html>');
  } catch (e) { res.send('Ошибка: ' + socEsc(e.message)); }
});

// удаление всех записей мастера: /socrates/drop-master?master=Роман&key=PHOTO_KEY
// отправка сообщения от имени Сократа в группу мастерской (объявления, анонсы)
// GET  /socrates/say?text=Привет&key=PHOTO_KEY   (текст в query, для коротких)
// POST /socrates/say?key=PHOTO_KEY  body: { text: "многострочный текст" }
async function socratesSay(text) {
  if (!TG_SOCRATES_TOKEN) return { ok: false, error: 'нет токена' };
  if (!text || !String(text).trim()) return { ok: false, error: 'пустой текст' };
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_SOCRATES_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_SOCRATES_CHAT, text: String(text), parse_mode: 'HTML' }),
      timeout: 15000
    });
    const j = await r.json();
    return j && j.ok ? { ok: true, message_id: j.result && j.result.message_id } : { ok: false, error: j && j.description };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
app.get('/socrates/say', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  const r = await socratesSay(req.query.text);
  res.json(r);
});
app.post('/socrates/say', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  const r = await socratesSay(req.body && req.body.text);
  res.json(r);
});

// только зачистка без пересборки: /socrates/cleanup?from=2026-07-01&to=2026-07-31&key=PHOTO_KEY
app.get('/socrates/cleanup', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  const from = req.query.from || '2026-07-01';
  const to = req.query.to || '2026-07-31';
  const cleaned = await socratesCleanupRange(from, to);
  res.json({ cleaned: cleaned, from: from, to: to });
});

// построчная выдача work_log для аудита: /socrates/rows?from=2026-07-01&to=2026-07-31&key=PHOTO_KEY
app.get('/socrates/rows', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  if (!pgPool) return res.json({ error: 'postgres disabled' });
  const from = req.query.from || '2026-07-01';
  const to = req.query.to || '2026-07-31';
  try {
    const r = await pgPool.query(
      `SELECT id, work_date, master, category, object, operation, day_fraction, confidence, clarify, digest_date
       FROM work_log WHERE work_date >= $1 AND work_date <= $2
       ORDER BY master, work_date, id`, [from, to]);
    res.json({ count: r.rowCount, rows: r.rows });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

app.get('/socrates/drop-master', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  if (!pgPool) return res.json({ error: 'postgres disabled' });
  const master = req.query.master;
  if (!master) return res.status(400).json({ error: 'нужен ?master=Имя' });
  try {
    const r = await pgPool.query('DELETE FROM work_log WHERE master = $1', [master]);
    res.json({ deleted: r.rowCount, master: master });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// слияние объектов в work_log: /socrates/merge-object?from=Стилет&to=Адъютант&key=PHOTO_KEY
app.get('/socrates/merge-object', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  if (!pgPool) return res.json({ error: 'postgres disabled' });
  const from = req.query.from, to = req.query.to;
  if (!from || !to) return res.status(400).json({ error: 'нужны ?from=Объект&to=Объект' });
  try {
    const r = await pgPool.query('UPDATE work_log SET object=$1 WHERE object=$2', [to, from]);
    res.json({ merged: r.rowCount, from: from, to: to, note: from + ' → ' + to });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// импорт исторических записей work_log (разовая загрузка истории WhatsApp)
// POST /socrates/import?key=PHOTO_KEY  body: { records: [{work_date,master,category,object,operation,business_unit,day_fraction,confidence,raw_text}] }
app.post('/socrates/import', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  if (!pgPool) return res.json({ error: 'postgres disabled' });
  const recs = (req.body && req.body.records) || [];
  if (!Array.isArray(recs) || !recs.length) return res.status(400).json({ error: 'body.records пуст' });
  let written = 0, skipped = 0;
  for (const rec of recs) {
    if (!rec.work_date || !rec.master || !rec.category) { skipped++; continue; }
    try {
      await pgPool.query(
        `INSERT INTO work_log(work_date, master, category, object, deal_id, operation, business_unit, day_fraction, confidence, clarify, clarify_question, raw_text, digest_date, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false,null,$10,$11,$12)
         ON CONFLICT(master, object, work_date, operation) DO NOTHING`,
        [rec.work_date, rec.master, rec.category, rec.object || null, rec.deal_id || null,
         rec.operation || null, rec.business_unit || null,
         rec.day_fraction === undefined || rec.day_fraction === null ? 1.0 : rec.day_fraction,
         rec.confidence || 'history', rec.raw_text || null, rec.work_date, Date.now()]
      );
      written++;
    } catch (e) { skipped++; }
  }
  res.json({ received: recs.length, written: written, skipped: skipped });
});

async function socratesCleanupRange(from, to) {
  let cleaned = 0;
  if (!pgPool) return 0;
  // финальная зачистка после пересборки: массовый разбор обрабатывает дни по
  // порядку, поэтому ответы, пришедшие позже вопроса, могли не слиться.
  // 1) удаляем незакрытые строки без операции, если по мастер+объект+день есть закрытая
  try {
    // 1) удаляем незакрытые пустые строки, если по мастер+объект есть закрытая запись
    // в окне ±4 дня (ответ мог прийти другим днём и одним сообщением за несколько дат)
    const c1 = await pgPool.query(
    `DELETE FROM work_log w
     WHERE w.digest_date >= $1 AND w.digest_date <= $2
       AND w.clarify = true AND w.operation IS NULL AND w.object IS NOT NULL
       AND EXISTS (SELECT 1 FROM work_log w2
       WHERE w2.master = w.master AND w2.object = w.object
         AND w2.clarify = false AND w2.operation IS NOT NULL
         AND ABS(w2.work_date - w.work_date) <= 4)`, [from, to]);
    cleaned += c1.rowCount;
    // 2) снимаем clarify с оставшихся, где по мастер+день есть закрытая запись
    const c2 = await pgPool.query(
    `UPDATE work_log w SET clarify = false, clarify_question = NULL
     WHERE w.digest_date >= $1 AND w.digest_date <= $2 AND w.clarify = true
       AND EXISTS (SELECT 1 FROM work_log w2
       WHERE w2.master = w.master AND w2.work_date = w.work_date AND w2.clarify = false)`, [from, to]);
    cleaned += c2.rowCount;
    // 3) снимаем clarify по мастер+объект в окне ±4 дня (ответ другим днём)
    const c3 = await pgPool.query(
    `UPDATE work_log w SET clarify = false, clarify_question = NULL
     WHERE w.digest_date >= $1 AND w.digest_date <= $2 AND w.clarify = true AND w.object IS NOT NULL
       AND EXISTS (SELECT 1 FROM work_log w2
       WHERE w2.master = w.master AND w2.object = w.object
         AND w2.clarify = false AND w2.operation IS NOT NULL
         AND ABS(w2.work_date - w.work_date) <= 4)`, [from, to]);
    cleaned += c3.rowCount;
    // 4) страховка: гасим вопрос по заказу, если у мастера есть закрытая deal-запись
    // в окне ±4 дня даже без проставленного объекта (ответ, потерявший номер)
    const c4 = await pgPool.query(
    `UPDATE work_log w SET clarify = false, clarify_question = NULL
     WHERE w.digest_date >= $1 AND w.digest_date <= $2 AND w.clarify = true
       AND w.category = 'deal'
       AND EXISTS (SELECT 1 FROM work_log w2
       WHERE w2.master = w.master AND w2.category = 'deal'
         AND w2.clarify = false AND w2.operation IS NOT NULL
         AND ABS(w2.work_date - w.work_date) <= 4)`, [from, to]);
    cleaned += c4.rowCount;
    // 5) СХЛОПЫВАНИЕ дублей: если по мастер+объект+день несколько deal/plakhov записей
    // с РАЗНОЙ формулировкой операции (напр. "закрепка" и "закрепка комплексно") —
    // это одна работа. Оставляем запись с самой длинной операцией (самой полной),
    // остальные за тот день удаляем. Так убирается двойной счёт человеко-дней.
    const c5 = await pgPool.query(
    `DELETE FROM work_log w
     WHERE w.digest_date >= $1 AND w.digest_date <= $2
       AND w.category IN ('deal','plakhov') AND w.object IS NOT NULL
       AND EXISTS (
       SELECT 1 FROM work_log w2
       WHERE w2.master = w.master AND w2.object = w.object AND w2.work_date = w.work_date
         AND w2.category = w.category AND w2.id <> w.id
         AND (LENGTH(COALESCE(w2.operation,'')) > LENGTH(COALESCE(w.operation,''))
          OR (LENGTH(COALESCE(w2.operation,'')) = LENGTH(COALESCE(w.operation,'')) AND w2.id > w.id)))`,
    [from, to]);
    cleaned += c5.rowCount;
    // 6) дубли orgwork/absence БЕЗ объекта по мастер+день: наслоения прогонов
    // («уборка», «оргработа школа» по 3 раза за один день). Оставляем одну строку
    // (с самой длинной операцией), остальные удаляем.
    const c6 = await pgPool.query(
    `DELETE FROM work_log w
     WHERE w.digest_date >= $1 AND w.digest_date <= $2
       AND w.category IN ('orgwork','absence') AND w.object IS NULL
       AND EXISTS (
       SELECT 1 FROM work_log w2
       WHERE w2.master = w.master AND w2.work_date = w.work_date
         AND w2.category = w.category AND w2.object IS NULL AND w2.id <> w.id
         AND (LENGTH(COALESCE(w2.operation,'')) > LENGTH(COALESCE(w.operation,''))
          OR (LENGTH(COALESCE(w2.operation,'')) = LENGTH(COALESCE(w.operation,'')) AND w2.id > w.id)))`,
    [from, to]);
    cleaned += c6.rowCount;
    // 7) жёсткая нормализация: сумма долей мастера за день не может превышать 1.0.
    // Переработки (>8ч) учитываются отдельным решением руководителя, базовый учёт — в днях.
    const over = await pgPool.query(
    `SELECT master, work_date, SUM(day_fraction) AS s FROM work_log
     WHERE work_date >= $1 AND work_date <= $2 AND day_fraction IS NOT NULL
     GROUP BY master, work_date HAVING SUM(day_fraction) > 1.001`, [from, to]);
    for (const o of over.rows) {
    const coef = 1.0 / Number(o.s);
    await pgPool.query(
      `UPDATE work_log SET day_fraction = ROUND((day_fraction * $1)::numeric, 3)
       WHERE master = $2 AND work_date = $3 AND day_fraction IS NOT NULL`,
      [coef, o.master, o.work_date]);
    cleaned++;
    }
  } catch (e) { console.log('⚠️ зачистка reparse:', e.message); }
  return cleaned;
}

// /socrates/reparse?from=2026-07-03&to=2026-07-06&key=PHOTO_KEY
app.get('/socrates/reparse', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  if (!pgPool) return res.json({ error: 'postgres disabled' });
  const from = req.query.from, to = req.query.to || req.query.from;
  if (!from) return res.status(400).json({ error: 'нужны ?from=YYYY-MM-DD (&to=YYYY-MM-DD)' });
  try {
    const del = await pgPool.query('DELETE FROM work_log WHERE digest_date >= $1 AND digest_date <= $2', [from, to]);
    const days = [];
    let d = new Date(from + 'T12:00:00Z');
    const end = new Date(to + 'T12:00:00Z');
    while (d <= end) { days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
    const results = [];
    for (const day of days) {
      delete cache['socrates_digest_' + day];
      const r = await computeSocratesDigest(day);
      results.push({ date: day, reports: r.reports || 0, written: r.written || 0, merged: r.merged || 0, error: r.error || null });
    }
    const cleaned = await socratesCleanupRange(from, to);
    res.json({ deleted: del.rowCount, cleaned: cleaned, days: results, note: 'work_log за диапазон пересобран последней логикой разбора' });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

let socratesLastRun = null;
if (process.env.SOCRATES_DIGEST === 'on') {
  setInterval(async function () {
    const utc = new Date();
    const h = utc.getUTCHours(), m = utc.getUTCMinutes();
    const todayMsk = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
    if (h === 19 && m < 5 && socratesLastRun !== todayMsk) {
      socratesLastRun = todayMsk;
      console.log('🕙 Сократ: разбор дня', todayMsk);
      try {
        const digest = await computeSocratesDigest(todayMsk);
        if (!digest.error) {
          const ask = await socratesSendQuestions(digest);
          console.log('✓ Сократ: записей', digest.written, '| вопросов отправлено', ask.sent || 0);
        } else {
          console.log('⚠️ Сократ digest error:', digest.error);
        }
      } catch (e) { console.log('⚠️ Сократ scheduler:', e.message); }
    }
  }, 60 * 1000);
  console.log('🕗 Сократ-планировщик ON (разбор в 22:00 МСК)');
}


app.get('/find-chat', async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  const lead = String(req.query.lead || '').trim();
  try {
    let acts = [];
    let listErr = null;
    if (lead) {
      const r0 = await fetch(WEBHOOK + '/crm.activity.list.json?order[CREATED]=DESC&filter[OWNER_TYPE_ID]=1&filter[OWNER_ID]=' + encodeURIComponent(lead) + '&filter[PROVIDER_ID]=IMOPENLINES_SESSION&select[]=ID&select[]=SUBJECT&select[]=CREATED&select[]=ASSOCIATED_ENTITY_ID', { timeout: 15000 });
      const j0 = await r0.json();
      acts = (j0.result || []); listErr = j0.error;
    } else {
      const r0 = await fetch(WEBHOOK + '/crm.activity.list.json?order[CREATED]=DESC&filter[PROVIDER_ID]=IMOPENLINES_SESSION&select[]=ID&select[]=SUBJECT&select[]=CREATED&select[]=ASSOCIATED_ENTITY_ID&start=0', { timeout: 15000 });
      const j0 = await r0.json();
      acts = (j0.result || []); listErr = j0.error;
      if (q) acts = acts.filter(a => String(a.SUBJECT || '').toLowerCase().indexOf(q) !== -1);
    }
    acts = acts.slice(0, 10);
    const out = [];
    for (const a of acts) {
      let chatId = null;
      try {
        const rr = await fetch(WEBHOOK + '/imopenlines.session.history.get.json?SESSION_ID=' + encodeURIComponent(a.ASSOCIATED_ENTITY_ID), { timeout: 15000 });
        const jj = await rr.json();
        chatId = jj.result && jj.result.chatId;
      } catch (e) { }
      out.push({ session: a.ASSOCIATED_ENTITY_ID, name: a.SUBJECT, created: a.CREATED, chatId: chatId, dialog: chatId ? ('chat' + chatId) : null });
      await new Promise(r => setTimeout(r, 300));
    }
    res.json({ query: q || null, lead: lead || null, count: out.length, dialogs: out, error: listErr });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// ============================================
// ОТПРАВКА ОБРАЗЦОВ КУРСА: курс → папка в «образцы курсов» → N картинок реальным вложением
// ============================================
const COURSE_SAMPLES_ROOT = '524530'; // папка «образцы курсов» на Общем диске
let courseFoldersCache = null, courseFoldersAt = 0;
async function getCourseFolders() {
  if (courseFoldersCache && (Date.now() - courseFoldersAt) < 600000) return courseFoldersCache;
  const r = await fetch(WEBHOOK + '/disk.folder.getchildren.json?id=' + COURSE_SAMPLES_ROOT, { timeout: 15000 });
  const j = await r.json();
  const folders = (j.result || []).filter(x => x.TYPE === 'folder').map(x => ({ id: x.ID, name: x.NAME }));
  if (folders.length) { courseFoldersCache = folders; courseFoldersAt = Date.now(); }
  return folders;
}
function normName(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/gi, ''); }
async function getChatFolderId(dialog) {
  const r = await fetch(WEBHOOK + '/im.disk.folder.get.json?DIALOG_ID=' + encodeURIComponent(dialog), { timeout: 15000 });
  const j = await r.json();
  return j.result && j.result.ID;
}
async function sendChatPhoto(dialog, fileId, chatFolderId, caption) {
  const cpr = await fetch(WEBHOOK + '/disk.file.copyto.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: fileId, targetFolderId: chatFolderId }), timeout: 30000 });
  const cpj = await cpr.json();
  const newId = cpj.result && cpj.result.ID;
  if (!newId) return { ok: false, step: 'copyto', error: (cpj.error || 'copy failed') + (cpj.error_description ? ': ' + cpj.error_description : '') };
  const body = { DIALOG_ID: dialog, FILE_ID: newId, MESSAGE: caption || '' };
  const cmr = await fetch(WEBHOOK + '/im.disk.file.commit.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 15000 });
  const cmj = await cmr.json();
  return { ok: !!(cmj.result), error: cmj.error ? (cmj.error + ': ' + (cmj.error_description || '')) : null };
}
// курс → папка → отправка картинок. course = имя папки (как в «образцы курсов»), n = сколько (макс 5)
async function sendCoursePhotos(dialog, course, n, caption) {
  const folders = await getCourseFolders();
  if (!folders.length) return { error: 'не удалось прочитать «образцы курсов» (право disk у вебхука?)' };
  const want = normName(course);
  const folder = folders.find(f => normName(f.name) === want)
    || folders.find(f => normName(f.name).indexOf(want) !== -1 || (want && want.indexOf(normName(f.name)) !== -1));
  if (!folder) return { error: 'папка курса не найдена', course: course, available: folders.map(f => f.name) };
  const lr = await fetch(WEBHOOK + '/disk.folder.getchildren.json?id=' + folder.id, { timeout: 15000 });
  const lj = await lr.json();
  const imgs = (lj.result || []).filter(x => x.TYPE === 'file' && /\.(jpe?g|png|webp)$/i.test(x.NAME || '')).slice(0, Math.min(n || 3, 5));
  if (!imgs.length) return { error: 'в папке нет картинок', folder: folder.name };
  const chatFolderId = await getChatFolderId(dialog);
  if (!chatFolderId) return { error: 'нет папки чата (im.disk.folder.get)' };
  const sent = [];
  for (let i = 0; i < imgs.length; i++) {
    const r = await sendChatPhoto(dialog, imgs[i].ID, chatFolderId, i === 0 ? (caption || '') : '');
    sent.push({ name: imgs[i].NAME, ok: r.ok, error: r.error });
    await new Promise(x => setTimeout(x, 800));
  }
  return { course: folder.name, dialog: dialog, sent: sent };
}
// ручной тест и точка вызова из n8n: /romeo-photos?dialog=chatNNNN&course=МикроПаве База&n=2&key=PHOTO_KEY
app.get('/romeo-photos', async (req, res) => {
  if (!process.env.PHOTO_KEY || req.query.key !== process.env.PHOTO_KEY) return res.status(403).json({ error: 'нужен ?key=PHOTO_KEY' });
  const dialog = req.query.dialog, course = req.query.course;
  const n = parseInt(req.query.n || '3', 10);
  if (!dialog || !course) return res.status(400).json({ error: 'нужны ?dialog=chatNNNN&course=<имя папки курса>' });
  try { const r = await sendCoursePhotos(dialog, course, n, req.query.caption || ''); res.json(r); }
  catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// ============================================
// STARTUP
// ============================================
app.listen(PORT, async () => {
  console.log('Bitrix Cache Server running on port', PORT);
  if (pgReady) {
    await initPgCache();
    await initSocratesTables();
    await initWorkLogTable();
    await pgLoadAllIntoMemory(cache);
    console.log('✓ Postgres кэш загружен в память');
  } else {
    console.log('ℹ️ Postgres выключен — работаем в памяти (кэш очистится при перезапуске)');
  }
});
