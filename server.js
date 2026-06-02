const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK = 'https://b24-99blai.bitrix24.ru/rest/1/uop89s51t0hivx0p';

let cache = {};
let lastUpdate = {};
let loading = {};

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

    let data = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { timeout: 20000 });
        data = await response.json();
        break;
      } catch (err) {
        console.log('Retry', attempt + 1, 'for', method, 'start:', start, err.message);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (!data) {
      console.log('Failed after 3 attempts at start:', start, '- stopping');
      break;
    }

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

app.get('/data', async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo required' });
  }

  const cacheKey = dateFrom + '_' + dateTo;
  const cacheAge = lastUpdate[cacheKey] ? Date.now() - lastUpdate[cacheKey] : Infinity;

  // Возвращаем кэш если свежий
  if (cache[cacheKey] && cacheAge < 3600000) {
    console.log('Cache hit for', cacheKey);
    return res.json(cache[cacheKey]);
  }

  // Если уже загружается — ждём
  if (loading[cacheKey]) {
    console.log('Already loading', cacheKey, '- waiting');
    let waited = 0;
    while (loading[cacheKey] && waited < 120000) {
      await new Promise(r => setTimeout(r, 2000));
      waited += 2000;
    }
    if (cache[cacheKey]) {
      return res.json(cache[cacheKey]);
    }
    return res.status(503).json({ error: 'Loading timeout' });
  }

  // Начинаем загрузку в фоне
  loading[cacheKey] = true;
  
  // Отвечаем сразу если есть старый кэш
  if (cache[cacheKey]) {
    res.json({ ...cache[cacheKey], loading: true });
    // Продолжаем обновление в фоне
    fetchAll('crm.deal.list', dateFrom, dateTo, ['ID','TITLE','STAGE_SEMANTIC_ID','SOURCE_ID','OPPORTUNITY','CURRENCY_ID','DATE_CREATE','CATEGORY_ID','ASSIGNED_BY_ID'])
      .then(deals => fetchAll('crm.lead.list', dateFrom, dateTo, ['ID','STATUS_ID','ASSIGNED_BY_ID','SOURCE_ID','DATE_CREATE'])
        .then(leads => {
          cache[cacheKey] = { deals, leads, dealsTotal: deals.length, leadsTotal: leads.length, updatedAt: new Date().toISOString() };
          lastUpdate[cacheKey] = Date.now();
          loading[cacheKey] = false;
        }))
      .catch(err => { loading[cacheKey] = false; });
    return;
  }

  console.log('Fresh load for', cacheKey);
  
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

app.get('/refresh', async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;
  const cacheKey = dateFrom + '_' + dateTo;
  delete cache[cacheKey];
  delete lastUpdate[cacheKey];
  res.json({ message: 'Cache cleared for ' + cacheKey });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', cacheKeys: Object.keys(cache), loading: Object.keys(loading).filter(k => loading[k]) });
});

app.listen(PORT, () => {
  console.log('Bitrix Cache Server running on port', PORT);
});
