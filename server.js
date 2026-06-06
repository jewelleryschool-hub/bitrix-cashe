const express = require('express');
const fetch = require('node-fetch');

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
  let lastId = 0;
  let hasMore = true;
  while (hasMore && results.length < limit) {
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
    results = results.concat(data.result.items);
    console.log('Chats loaded:', results.length);
    if (data.result.hasMore && data.next) lastId = data.next;
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
    cache[cacheKey] = result;
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LEADS STATS — лёгкий агрегат по лидам (без полных переписок)
// Откуда приходят, статусы, по месяцам, язык. Компактный JSON.
// ============================================
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
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';      // арабский
  if (/[\u0400-\u04FF]/.test(t)) return 'ru';      // кириллица
  if (/[\u00C0-\u017F]|\b(hola|gracias|curso|quiero)\b/i.test(t)) return 'es'; // испанский признаки
  if (/[a-z]/i.test(t)) return 'en';               // латиница
  return 'unknown';
}

app.get('/leads-stats', async (req, res) => {
  const limit = parseInt(req.query.limit || 500);
  const webhookParam = req.query.webhook; // опционально другой вебхук
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
    const byMonth = {};
    const byLang = {};
    const sourceStatus = {}; // источник -> {open, closed} для конверсии

    for (const chat of chats) {
      const entityId = chat.chat ? chat.chat.entity_id : '';
      const source = detectSource(entityId);
      const status = chat.lines ? chat.lines.status : 0;
      const lastText = chat.message ? chat.message.text : '';
      const dateStr = (chat.chat && chat.chat.date_create) ? chat.chat.date_create : (chat.message ? chat.message.date : null);

      // источник
      bySource[source] = (bySource[source] || 0) + 1;

      // статус
      let statusKey;
      if (status === 40) { byStatus.closed++; statusKey = 'closed'; }
      else if (status === 20 || status === 25) { byStatus.in_progress++; statusKey = 'in_progress'; }
      else { byStatus.new_unassigned++; statusKey = 'open'; }

      // источник x статус (для конверсии по каналам)
      if (!sourceStatus[source]) sourceStatus[source] = { total: 0, closed: 0, open: 0, in_progress: 0 };
      sourceStatus[source].total++;
      if (statusKey === 'closed') sourceStatus[source].closed++;
      else if (statusKey === 'in_progress') sourceStatus[source].in_progress++;
      else sourceStatus[source].open++;

      // по месяцам
      if (dateStr) {
        const month = dateStr.substring(0, 7);
        byMonth[month] = (byMonth[month] || 0) + 1;
      }

      // язык по последнему сообщению
      const lang = detectLang(lastText);
      byLang[lang] = (byLang[lang] || 0) + 1;
    }

    const result = {
      total_chats: chats.length,
      bySource,
      byStatus,
      byLang,
      byMonth,
      sourceConversion: sourceStatus,
      note: 'Агрегат без текстов переписок. status: open=новый/без ответа, in_progress=в работе, closed=закрыт',
      updatedAt: new Date().toISOString()
    };

    cache[cacheKey] = result;
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LEADS DEBUG — диагностика внутриканального разделения (read-only)
// Показывает реальные entity_id, id линий, типы и сырые примеры.
// Нужен, чтобы увидеть подканалы и расшифровать Other/Unknown.
// ============================================
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
    const byEntityIdSource = {}; // полный entity_id -> к какому source его относит detectSource

    for (const chat of chats) {
      const c = chat.chat || {};
      const lines = chat.lines || {};
      const etype = c.entity_type || 'none';
      byEntityType[etype] = (byEntityType[etype] || 0) + 1;

      const eid = c.entity_id || '';
      byEntityId[eid] = (byEntityId[eid] || 0) + 1;
      if (!byEntityIdSource[eid]) byEntityIdSource[eid] = detectSource(eid);

      // id линии: сначала из lines.id, иначе из частей entity_id (livechat|6|... -> 6)
      const parts = eid.split('|');
      const lineId = (lines.id !== undefined ? String(lines.id) : (parts[1] || 'unknown'));
      byLineId[lineId] = (byLineId[lineId] || 0) + 1;
    }

    // топ реальных строк entity_id с тем, как detectSource их классифицирует
    const topEntityIds = Object.keys(byEntityId)
      .sort((a, b) => byEntityId[b] - byEntityId[a])
      .slice(0, 40)
      .map(eid => ({ entity_id: eid, count: byEntityId[eid], detected_as: byEntityIdSource[eid] }));

    // сырые примеры целиком — чтобы видеть ВСЕ доступные поля chat + lines
    const samples = chats.slice(0, 8).map(ch => ({ chat: ch.chat || null, lines: ch.lines || null }));

    const result = {
      total_chats: chats.length,
      byEntityType,
      byLineId,
      distinct_entity_ids: Object.keys(byEntityId).length,
      topEntityIds,
      samples,
      note: 'topEntityIds.detected_as показывает, как текущий detectSource классифицирует строку. byLineId = разбивка по id открытой линии (подканалы). samples = сырые объекты для просмотра всех полей.',
      updatedAt: new Date().toISOString()
    };

    cache[cacheKey] = result;
    lastUpdate[cacheKey] = Date.now();
    loading[cacheKey] = false;
    res.json(result);
  } catch (error) {
    loading[cacheKey] = false;
    res.status(500).json({ error: error.message });
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
    cache[cacheKey] = result;
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

    const msgCache = cache['messages_kash_500'];
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
    cache[cacheKey] = result;
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
  if (key) { delete cache[key]; delete lastUpdate[key]; res.json({ message: 'Cache cleared for ' + key }); }
  else { cache = {}; lastUpdate = {}; res.json({ message: 'All cache cleared' }); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', cacheKeys: Object.keys(cache), loading: Object.keys(loading).filter(k => loading[k]) });
});

app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
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

app.listen(PORT, () => {
  console.log('Bitrix Cache Server running on port', PORT);
});
