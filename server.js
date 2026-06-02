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
    
    // Retry до 3 раз
    let data = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { timeout: 30000 });
        data = await response.json();
        break;
      } catch (err) {
        console.log('Retry', attempt + 1, 'for', method, 'start:', start);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    
    if (!data) {
      console.log('Failed after 3 attempts, stopping at start:', start);
      hasMore = false;
      break;
    }
    
    if (data.result && Array.isArray(data.result)) {
      results = results.concat(data.result);
    }
    
    if (data.next && data.next > start) {
      start = data.next;
    } else {
      hasMore = false;
    }
    
    if (start > 100000) hasMore = false;
    
    // Пауза между запросами
    await new Promise(r => setTimeout(r, 500));
  }
  
  return results;
}
