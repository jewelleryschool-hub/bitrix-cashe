const express = require('express');
const fetch = require('node-fetch');

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

    // Загружаем сообщения независимо (не дожидаясь /messages)
    let msgCache = cache['messages_kash_500'];
    const msgCacheAge = lastUpdate['messages_kash_500'] ? Date.now() - lastUpdate['messages_kash_500'] : Infinity;
    
    if (!msgCache || msgCacheAge > 3600000) {
      // Кэш отсутствует или старше 1 часа — грузим свежие сообщения
      const chats = await fetchChats(WEBHOOK_KASH, 500);
      msgCache = { chats: chats };
    }
    
    let dayMessages = [];
    const dialogsByChat = {};
    if (msgCache && msgCache.chats) {
      msgCache.chats.forEach(chat => {
        const chatDayMsgs = [];
        (chat.messages || []).forEach(m => {
          if (m.date && m.date.substring(0, 10) === date) {
            dayMessages.push({
              chat: chat.title,
              author_id: m.author_id,
              text: (m.text || '').substring(0, 200),
              date: m.date,
              hour: parseInt(m.date.substring(11, 13))
            });
            chatDayMsgs.push({
              who: m.author_id === 20326 ? 'MANAGER' : 'CLIENT',
              text: (m.text || ''),
              time: m.date.substring(11, 16)
            });
          }
        });
        if (chatDayMsgs.length > 0) {
          chatDayMsgs.sort((a, b) => a.time.localeCompare(b.time));
          dialogsByChat[chat.title] = chatDayMsgs;
        }
      });
    }

    const fullDialogs = Object.entries(dialogsByChat)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 40)
      .map(function(pair) {
        const title = pair[0];
        const msgs = pair[1];
        const lines = msgs.map(function(m) {
          return '[' + m.time + '] ' + (m.who === 'MANAGER' ? 'МЕНЕДЖЕР' : 'КЛИЕНТ') + ': ' + m.text;
        });
        return { client: title, messages_count: msgs.length, dialog: lines.join(NL) };
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
    const managerDayMsgs = dayMessages.filter(m => m.author_id === 20326);
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
      messages: { total: dayMessages.length, manager: managerDayMsgs.length, client: dayMessages.filter(m => m.author_id !== 20326 && m.author_id !== 0).length, byHour: msgByHour, sample: managerDayMsgs.slice(0, 30), fullDialogs: fullDialogs },
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
// STARTUP
// ============================================
app.listen(PORT, async () => {
  console.log('Bitrix Cache Server running on port', PORT);
  if (pgReady) {
    await initPgCache();
    await pgLoadAllIntoMemory(cache);
    console.log('✓ Postgres кэш загружен в память');
  } else {
    console.log('ℹ️ Postgres выключен — работаем в памяти (кэш очистится при перезапуске)');
  }
});
