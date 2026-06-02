const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK = 'https://b24-99blai.bitrix24.ru/rest/1/uop89s51t0hivx0p';

// Кэш данных
let cache = {};
let lastUpdate = {};

async function fetchAll(method, dateFrom, dateTo, selectFields) {
  let results = [];
  let start = 0;
  let hasMore = true;

  while (hasMore) {
    let url = WEBHOOK + '/' + method + '.json';
    url += '?filter[>DATE_CREATE]=' + dateFrom;
    url += '&filter[<=DATE_CREATE]=' + dateTo;
    url += '&start=' + start;
    for (const s of selectFields) {
      url += '&select[]=' + s;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.result && Array.isArray(data.result)) {
      results = results.concat(data.result);
    }

    if (data.next && data.next > start) {
      start = data.next;
    } else {
      hasMore = false;
    }

    if (start > 100000) hasMore = false;
    
    // Пауза чтобы не перегружать API
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

// Endpoint для получения данных
app.get('/data', async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;
  
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo required' });
  }

  const cacheKey = dateFrom + '_' + dateTo;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;
  
  // Кэш на 1 час
  if (cache[cacheKey] && cacheAge < 3600000) {
    console.log('Returning cached data for', cacheKey);
    return res.json(cache[cacheKey]);
  }

  console.log('Fetching fresh data for', cacheKey);
  
  try {
    const [deals, leads] = await Promise.all([
      fetchAll('crm.deal.list', dateFrom, dateTo, [
        'ID', 'TITLE', 'STAGE_SEMANTIC_ID', 'SOURCE_ID',
        'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE',
        'CATEGORY_ID', 'ASSIGNED_BY_ID'
      ]),
      fetchAll('crm.lead.list', dateFrom, dateTo, [
        'ID', 'STATUS_ID', 'ASSIGNED_BY_ID', 'SOURCE_ID', 'DATE_CREATE'
      ])
    ]);

    const result = {
      deals,
      leads,
      dealsTotal: deals.length,
      leadsTotal: leads.length,
      updatedAt: new Date().toISOString()
    };

    cache[cacheKey] = result;
    lastUpdate[cacheKey] = Date.now();

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Принудительное обновление кэша
app.get('/refresh', async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;
  const cacheKey = dateFrom + '_' + dateTo;
  delete cache[cacheKey];
  delete lastUpdate[cacheKey];
  res.json({ message: 'Cache cleared for ' + cacheKey });
});

// Здоровье сервиса
app.get('/health', (req, res) => {
  res.json({ status: 'ok', cacheKeys: Object.keys(cache) });
});

app.listen(PORT, () => {
  console.log('Bitrix Cache Server running on port', PORT);
});
