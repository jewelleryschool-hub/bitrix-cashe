const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK = 'https://b24-99blai.bitrix24.ru/rest/1/uop89s51t0hivx0p';
const WEBHOOK_KASH = 'https://b24-99blai.bitrix24.ru/rest/20326/yyse913stg6uxm80';

let cache = {};
let lastUpdate = {};
let loading = {};

async function fetchAll(method, dateFrom, dateTo, selectFields, webhook = WEBHOOK) {
  let results = [];
  let start = 0;
  let hasMore = true;

  while (hasMore) {
    let url = webhook + '/' + method + '.json';
    url += '?filter[>DATE_CREATE]=' + dateFrom;
    url += '&filter[<=DATE_CREATE]=' + dateTo;
    url += '&start=' + start;
    for (const s of selectFields) {
      url += '&select[]=' + s;
    }

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

    if (!data) { break; }

    if (data.result && Array.isArray(data.result)) {
      results = results.concat(data.result);
      console.log(method, 'loaded', results.length, 'of', data.total);
    }

    if (data.next && data.next > start) {
      start = data.next;
    } else {
      hasMore = false;
    }

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

    if (data.result.hasMore && data.next) {
      lastId = data.next;
    } else {
      hasMore = false;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

async function fetchChatMessages(webhook, chatId, limit = 100) {
  let url = webhook + '/im.dialog.messages.get.json?chat_id=' + chatId + '&limit=' + limit;
  
  try {
    const response = await fetch(url, { timeout: 15000 });
    const data = await response.json();
    if (data.result && data.result.messages) {
      return data.result.messages;
    }
  } catch (err) {
    console.log('Error fetching messages for chat', chatId, err.message);
  }
  return [];
}

// Endpoint для CRM данных
app.get('/data', async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo required' });
  }

  const cacheKey = dateFrom + '_' + dateTo;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;

  if (cache[cacheKey] && cacheAge < 3600000) {
    return res.json(cache[cacheKey]);
  }

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

  if (cache[cacheKey]) {
    res.json({ ...cache[cacheKey], loading: true });
    fetchAll('crm.deal.list', dateFrom, dateTo, ['ID','TITLE','STAGE_SEMANTIC_ID','SOURCE_ID','OPPORTUNITY','CURRENCY_ID','DATE_CREATE','CATEGORY_ID','ASSIGNED_BY_ID'])
      .then(deals => fetchAll('crm.lead.list', dateFrom, dateTo, ['ID','STATUS_ID','ASSIGNED_BY_ID','SOURCE_ID','DATE_CREATE'])
        .then(leads => {
          cache[cacheKey] = { deals, leads, dealsTotal: deals.length, leadsTotal: leads.length, updatedAt: new Date().toISOString() };
          lastUpdate[cacheKey] = Date.now();
          loading[cacheKey] = false;
        }))
      .catch(() => { loading[cacheKey] = false; });
    return;
  }

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

// Endpoint для переписок Кашинского
app.get('/messages', async (req, res) => {
  const limit = parseInt(req.query.limit || 500);
  const cacheKey = 'messages_kash_' + limit;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;

  if (cache[cacheKey] && cacheAge < 21600000) { // кэш 6 часов
    console.log('Cache hit for messages');
    return res.json(cache[cacheKey]);
  }

  if (loading[cacheKey]) {
    return res.json({ status: 'loading', message: 'Data is being loaded, try again in 1-2 minutes' });
  }

  loading[cacheKey] = true;
  console.log('Loading chats for Kashinskiy...');

  try {
    // Загружаем список чатов
    const chats = await fetchChats(WEBHOOK_KASH, limit);
    console.log('Total chats:', chats.length);

    // Статистика по месяцам
    const byMonth = {};
    const byStatus = { open: 0, closed: 0, inProgress: 0 };
    const sources = {};

    // Загружаем сообщения для каждого чата (первые 200 чатов)
    const chatsWithMessages = [];
    const chatsToProcess = chats.slice(0, 300);

    for (let i = 0; i < chatsToProcess.length; i++) {
      const chat = chatsToProcess[i];
      const chatId = chat.chat_id;
      
      // Статус чата
      const status = chat.lines ? chat.lines.status : 0;
      if (status === 40) byStatus.closed++;
      else if (status === 20 || status === 25) byStatus.inProgress++;
      else byStatus.open++;

      // По месяцам
      const dateStr = chat.chat && chat.chat.date_create ? chat.chat.date_create : (chat.message ? chat.message.date : null);
      if (dateStr) {
        const month = dateStr.substring(0, 7);
        if (!byMonth[month]) byMonth[month] = { total: 0, closed: 0, open: 0 };
        byMonth[month].total++;
        if (status === 40) byMonth[month].closed++;
        else byMonth[month].open++;
      }

      // Источник
      const entityId = chat.chat ? chat.chat.entity_id : '';
      if (entityId.includes('instagram')) sources['Instagram'] = (sources['Instagram'] || 0) + 1;
      else if (entityId.includes('whatsapp')) sources['WhatsApp'] = (sources['WhatsApp'] || 0) + 1;
      else sources['Other'] = (sources['Other'] || 0) + 1;

      // Загружаем сообщения
      const messages = await fetchChatMessages(WEBHOOK_KASH, chatId, 100);
      
      chatsWithMessages.push({
        id: chatId,
        title: chat.title,
        status: status,
        date_create: dateStr,
        entity_id: entityId,
        last_message: chat.message ? chat.message.text : '',
        messages_count: messages.length,
        messages: messages.slice(0, 20) // первые 10 сообщений для анализа
      });

      if (i % 20 === 0) console.log('Processed', i, 'of', chatsToProcess.length, 'chats');
      await new Promise(r => setTimeout(r, 200));
    }

    const result = {
      total_chats: chats.length,
      processed_chats: chatsWithMessages.length,
      byMonth,
      byStatus,
      sources,
      chats: chatsWithMessages,
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
  if (key) {
    delete cache[key];
    delete lastUpdate[key];
    res.json({ message: 'Cache cleared for ' + key });
  } else {
    cache = {};
    lastUpdate = {};
    res.json({ message: 'All cache cleared' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    cacheKeys: Object.keys(cache), 
    loading: Object.keys(loading).filter(k => loading[k]) 
  });
});

app.listen(PORT, () => {
  console.log('Bitrix Cache Server running on port', PORT);
});
