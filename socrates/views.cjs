'use strict';
const R=require('./rules.cjs');
const money=x=>Number(x).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
const n=x=>Math.round(Number(x)*10000)/10000;
const CATS={deal:'Производство',plakhov:'Авторские',orgwork:'Оргработа',teaching:'Преподавание',absence:'Отсутствие'};
function layout(title,body){return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+R.esc(title)+'</title><style>'+ 
 'body{font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f7f5f0;color:#23262b;margin:0}header{background:#23262b;color:#f7f5f0;padding:26px}main{max-width:1000px;margin:auto;padding:20px}h1,h2{font-family:Georgia,serif}h1{font-size:25px}h2{font-size:20px}table{width:100%;border-collapse:collapse;background:white;margin:15px 0}th,td{padding:10px;border-bottom:1px solid #e4e0d8;text-align:left;vertical-align:top}th{font-size:12px;color:#6e6a63}details{padding:12px;background:white;border:1px solid #e4e0d8}summary{cursor:pointer;font-weight:600}.n{text-align:right;white-space:nowrap}.warn{color:#9a6700}.money{color:#a8853b;font-weight:600}.mut{color:#6e6a63;font-size:12px}a{color:#a8853b}nav{display:flex;gap:20px}blockquote{font-size:12px;color:#6e6a63;margin:6px 0}section{overflow-x:auto}@media(max-width:650px){main{padding:10px}td,th{padding:6px;font-size:12px}}</style></head><body><header><h1>'+R.esc(title)+'</h1></header><main>'+body+'</main></body></html>';}
function navigation(path,m,auth){const [y,k]=m.split('-').map(Number);const prev=new Date(Date.UTC(y,k-2,1)).toISOString().slice(0,7),next=new Date(Date.UTC(y,k,1)).toISOString().slice(0,7);return '<nav>'+[[prev,'← '+prev],[next,next+' →']].map(([mm,t])=>'<a href="'+path+'?month='+mm+'&amp;'+R.esc(auth)+'">'+t+'</a>').join('')+'</nav>';}
function quote(row){
 const texts=row.socrates_contributions?.map(x=>x.evidence).filter(Boolean)||[row.raw_text];
 return [...new Set(texts.filter(Boolean))].map(t=>'<blockquote>'+R.esc(t)+'</blockquote>').join('');
}
function rowHTML(row,financial=false){const min=row.minutes??R.minutes(row),unset=min==null;return '<tr><td>'+R.esc(row.work_date instanceof Date?row.work_date.toISOString().slice(0,10):row.work_date)+'</td><td>'+R.esc(CATS[row.category]||row.category)+'</td><td>'+R.esc(row.object||'—')+' — '+R.esc(row.operation||'операция не определена')+(financial?quote(row):'')+(row.clarify_question?'<div class="warn">'+R.esc(row.clarify_question)+'</div>':'')+'</td><td class="n">'+(unset?'<span class="warn">не определено</span>':n(min/60)+' ч')+'</td>'+(financial?'<td class="n">'+(row.unpriced?'<span class="warn">ставка не назначена</span>':row.unresolved?'<span class="warn">нужны часы</span>':row.category==='absence'?'не оплачивается':money(row.amount)+' ₽')+'</td>':'')+'</tr>';}
function salary(rows,rates,m,{personal,auth,wdOverride,pending=0,shopAuth}={}){
 const all=R.payroll(rows,rates,m,wdOverride),masters=Object.values(all).filter(x=>!personal||x.master===personal);let total=0;
 const table=masters.map(x=>{total+=x.amount;const warnings=[x.unresolved?x.unresolved+' без времени':'',x.unpriced?x.unpriced+' без ставки':'',x.openQuestions?x.openQuestions+' требуют уточнения':''].filter(Boolean).join('; ');return '<tr><td>'+R.esc(x.master)+'</td><td class="n">'+n(x.minutes/60)+'</td><td class="n money">'+money(x.amount)+'</td><td>'+(warnings?'<span class="warn">'+warnings+'</span>':'')+'</td></tr>';}).join('');
 const details=masters.map(x=>'<details><summary>'+R.esc(x.master)+' · '+money(x.amount)+' ₽</summary><p>Надбавка: '+money(x.bonus)+' ₽. Ставка применяется по дате работы; внешний курс ×1,45.'+(x.master==='Витя Комисар'?' Творческие проекты — 120 000 ₽/месяц.':'')+'</p><section><table><tr><th>Дата</th><th>Категория</th><th>Работа и источник</th><th>Часы</th><th>Начислено</th></tr>'+x.rows.map(r=>rowHTML(r,true)).join('')+'</table></section></details>').join('');
 let body=navigation(personal?'/socrates/my-salary':'/socrates/salary',m,auth)+(pending?'<p class="warn">Есть '+pending+' необработанных или требующих проверки исходных сообщений. Начисление может быть неполным.</p>':'')+'<p>'+m+' · рабочих дней: '+(wdOverride||R.workdays(m))+(wdOverride?' (единая ручная норма этой страницы, включая себестоимость)':' (производственный календарь)')+'</p><section><table><tr><th>Мастер</th><th>Часы</th><th>Начислено, ₽</th><th>Незакрытые записи</th></tr>'+table+'<tr><th>Всего</th><th></th><th class="n">'+money(total)+'</th><th></th></tr></table></section>'+details;
 if(!personal){const cost={};for(const row of rows){const d=String(row.work_date instanceof Date?row.work_date.toISOString():row.work_date).slice(0,10);if(d.slice(0,4)!==m.slice(0,4)||d>R.bounds(m)[1]||!['deal','plakhov'].includes(row.category)||!row.object)continue;
   const a=R.rowAmount({...row,work_date:d},rates,d.startsWith(m)?wdOverride:undefined),k=R.objectKey(row.object),hours=(R.minutes(row)||0)/60;
   cost[k]??={object:row.object,hours:0,amount:0,unpriced:0,unresolved:0,months:{},operations:{}};
   const c=cost[k];c.hours+=hours;c.amount+=a.amount;c.unpriced+=a.unpriced?1:0;c.unresolved+=a.unresolved?1:0;
   const mm=d.slice(0,7),op=row.operation||'операция не определена';c.months[mm]??={hours:0,amount:0};c.months[mm].hours+=hours;c.months[mm].amount+=a.amount;
   c.operations[op]??={hours:0,amount:0};c.operations[op].hours+=hours;c.operations[op].amount+=a.amount;
  }
  if(shopAuth)body+='<p><a href="/socrates/report?month='+m+'&amp;'+R.esc(shopAuth)+'">Отчёт без сумм — ссылка для коллег</a></p>';
  body+='<h2>Прямые трудозатраты по изделиям с начала года</h2>'+Object.values(cost).sort((a,b)=>b.amount-a.amount).map(c=>{
   const table=(items,label)=>'<table><tr><th>'+label+'</th><th>Часы</th><th>Стоимость труда, ₽</th></tr>'+Object.entries(items).map(([name,v])=>'<tr><td>'+R.esc(name)+'</td><td class="n">'+n(v.hours)+'</td><td class="n">'+money(v.amount)+'</td></tr>').join('')+'</table>';
   return '<details><summary>'+R.esc(c.object)+' · '+n(c.hours)+' ч · '+(c.unpriced&&c.amount===0?'ставка не назначена':money(c.amount)+' ₽'+(c.unpriced||c.unresolved?' (неполная оценка)':''))+'</summary>'+(c.unpriced?'<p class="warn">Есть часы без назначенной ставки.</p>':'')+(c.unresolved?'<p class="warn">Есть записи без определённого времени.</p>':'')+'<section>'+table(c.months,'Месяц')+table(c.operations,'Работа')+'</section></details>';
  }).join('')+'<p class="mut">Оргработа, преподавание и надбавка в прямые затраты изделий не входят. Исторические ставки сохраняются отдельно от текущих.</p>';
 }
 return layout('Расчёт заработной платы · '+(personal||'мастерская'),body+'<p class="mut">Начисление по сохранённым отчётам. Авансы и выплаты не вычтены; это не остаток долга. Записи без часов или ставки требуют уточнения.</p>');
}
function report(rows,m,{auth}={}){
 const group={};for(const row of rows){if(!String(row.work_date instanceof Date?row.work_date.toISOString():row.work_date).startsWith(m))continue;(group[row.master]??=[]).push(row);}
 const masters=Object.keys(group).sort().map(master=>{const dates={};for(const row of group[master]){const d=String(row.work_date instanceof Date?row.work_date.toISOString():row.work_date).slice(0,10);(dates[d]??=[]).push(row);}
  return '<details><summary>'+R.esc(master)+' · '+n(group[master].filter(r=>r.category!=='absence').reduce((a,r)=>a+(R.minutes(r)||0),0)/60)+' ч</summary>'+Object.entries(dates).sort().map(([d,rr])=>'<details><summary>'+d+'</summary><section><table><tr><th>Дата</th><th>Категория</th><th>Работа и источник</th><th>Часы</th></tr>'+rr.map(r=>rowHTML(r)).join('')+'</table></section></details>').join('')+'</details>';
 }).join('');
 const objects={};for(const r of rows){if(!['deal','plakhov'].includes(r.category)||!r.object)continue;const k=R.objectKey(r.object);objects[k]??={label:r.object,hours:0};objects[k].hours+=(R.minutes(r)||0)/60;}
 return layout('Мастерская KARAKURKCHI-PLAKHOV',navigation('/socrates/report',m,auth)+'<h2>'+m+'</h2>'+masters+'<h2>Сделки и изделия с начала года</h2><table><tr><th>Изделие</th><th>Часы</th></tr>'+Object.values(objects).sort((a,b)=>b.hours-a.hours).map(x=>'<tr><td>'+R.esc(x.label)+'</td><td class="n">'+n(x.hours)+'</td></tr>').join('')+'</table>');
}
module.exports={layout,salary,report,rowHTML,quote,navigation};
