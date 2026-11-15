'use strict';
const crypto=require('node:crypto');
class SocError extends Error { constructor(code,status=422){super(code);this.code=code;this.status=status;} }
const ROSTER={
 'Степан Ершов':{call:'Степан',gender:'m',aliases:['ershov','степан ершов','степан','ершов','stepan']},
 'Олег Гиниборг':{call:'Олег',gender:'m',aliases:['oleg','олег','гиниборг']},
 'Игорь Деменцов':{call:'Игорь',gender:'m',aliases:['игорь','деменцов','igor']},
 'Витя Комисар':{call:'Витя',gender:'m',aliases:['viktor','витя','виктор','комисар','komisar']},
 'Кристина Спасская':{call:'Кристина',gender:'f',aliases:['кристина','спасская','kristina']},
 'Володя Плахов':{call:'Володя',gender:'m',aliases:['володя','плахов','vladimir','volodya','plakhov']},
 'Максим Калинин':{call:'Максим',gender:'m',aliases:['максим','калинин','maksim','maxim','kalinin']},
 'Константин Пинчук':{call:'Константин',gender:'m',aliases:['leningraver','константин пинчук','пинчук'],starts:'2026-11-10'}
};
// Frozen compatibility snapshot. These are not claims about historical contracts.
// Changes are new dated rows in socrates_rates, never overwrites of this snapshot.
const INITIAL_RATES={
 'Володя Плахов':[200000,0],'Игорь Деменцов':[80000,0],'Витя Комисар':[90000,0],
 'Кристина Спасская':[160000,0],'Степан Ершов':[180000,40000],'Олег Гиниборг':[120000,0],
 'Константин Пинчук':[100000,0]
};
const CALENDAR={2025:[17,20,21,22,18,19,23,21,22,23,19,22],2026:[15,19,21,22,19,21,23,21,22,22,20,22]};
const HOLIDAYS_2026=new Set(['01-01','01-02','01-05','01-06','01-07','01-08','01-09','02-23','03-09','05-01','05-11','06-12','11-04','12-31']);
const cats=new Set(['deal','plakhov','teaching','orgwork','absence']);
const clean=s=>String(s??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const norm=s=>clean(s).toLocaleLowerCase('ru').replace(/ё/g,'е');
const hash=s=>crypto.createHash('sha256').update(typeof s==='string'?s:JSON.stringify(s)).digest('hex');
function canonical(author){
 const t=norm(author);const found=Object.keys(ROSTER).filter(n=>n===author||ROSTER[n].aliases.some(a=>new RegExp('(^|[^a-zа-яё])'+a+'(?=$|[^a-zа-яё])','iu').test(t)));
 if(found.length!==1)return null;return found[0];
}
function date(value){
 const s=String(value??'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw new SocError('INVALID_DATE');
 const d=new Date(s+'T12:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s)throw new SocError('INVALID_DATE');return s;
}
function month(value){const s=String(value??'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(s))throw new SocError('INVALID_MONTH');return s;}
function bounds(m){month(m);const [y,n]=m.split('-').map(Number);return [m+'-01',new Date(Date.UTC(y,n,0)).toISOString().slice(0,10)];}
const today=(now=Date.now())=>new Date(now+10800000).toISOString().slice(0,10);
function addDays(d,n){return new Date(Date.parse(date(d)+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
function workdays(m){const [y,n]=month(m).split('-').map(Number);if(!CALENDAR[y])throw new SocError('CALENDAR_NOT_APPROVED',409);return CALENDAR[y][n-1];}
function isWorkingDay(d){date(d);if(!CALENDAR[+d.slice(0,4)])throw new SocError('CALENDAR_NOT_APPROVED',409);const w=new Date(d+'T12:00:00Z').getUTCDay();if(w===0||w===6)return false;
 if(d.startsWith('2026'))return !HOLIDAYS_2026.has(d.slice(5));
 // 2025 is retained for historical monthly calculations only; no guessed daily scheduler calendar.
 throw new SocError('DAILY_CALENDAR_NOT_APPROVED',409);
}
function minutes(row){const v=row.socrates_minutes??(row.day_fraction==null?null:Number(row.day_fraction)*480);return v==null?null:Number(v);}
function creative(master,obj){return master==='Витя Комисар'&&['подсолнух','ирис','тюльпан','титан цвет'].some(s=>norm(obj).includes(s));}
function objectKey(obj){if(obj==null)return null;let s=norm(obj);s=s.replace(/^#\s*(\d+)$/,'$1');return s||null;}
function rateAt(rates,master,d){date(d);return rates.filter(r=>r.master===master&&r.effective_from<=d&&(!r.effective_to||r.effective_to>=d)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]||null;}
function rowAmount(row,rates,wdOverride){
 if(!cats.has(row.category))throw new SocError('INVALID_CATEGORY');if(row.category==='absence')return {amount:0,unpriced:false};
 const m=minutes(row);if(m==null)return {amount:0,unresolved:true,unpriced:false};
 const d=date(row.work_date instanceof Date?row.work_date.toISOString():row.work_date);
 const r=rateAt(rates,row.master,d);if(!r)return {amount:0,unpriced:true};
 const wd=wdOverride??workdays(d.slice(0,7));if(!Number.isSafeInteger(wd)||wd<1||wd>31)throw new SocError('INVALID_WORKDAYS');
 const base=creative(row.master,row.object)?120000:Number(r.base);
 return {amount:m/480*base/wd*(row.category==='teaching'?1.45:1),unpriced:false,rate:base/wd};
}
function payroll(rows,rates,m,wdOverride){
 const [from,to]=bounds(m);const result={};
 for(const r of rates){if(r.effective_from<=to&&(!r.effective_to||r.effective_to>=from))result[r.master]??={master:r.master,minutes:0,subtotal:0,bonus:0,amount:0,unresolved:0,unpriced:0,openQuestions:0,rows:[]};}
 for(const row of rows){if(row.category==='ignore')continue;const d=date(row.work_date instanceof Date?row.work_date.toISOString():row.work_date);if(d<from||d>to)continue;
  const out=result[row.master]??={master:row.master,minutes:0,subtotal:0,bonus:0,amount:0,unresolved:0,unpriced:0,openQuestions:0,rows:[]};
  const a=rowAmount({...row,work_date:d},rates,wdOverride);const mins=minutes(row);out.rows.push({...row,work_date:d,...a,minutes:mins});
  out.subtotal+=a.amount;out.unresolved+=a.unresolved?1:0;out.unpriced+=a.unpriced?1:0;out.openQuestions+=row.clarify||row.clarify_question?1:0;if(row.category!=='absence')out.minutes+=mins||0;
 }
 for(const out of Object.values(result)){
  // Leadership is a monthly fixed duty, including remote work; independent of shop hours.
  const bonuses=[...new Set(rates.filter(r=>r.master===out.master&&r.effective_from<=to&&(!r.effective_to||r.effective_to>=from)).map(r=>Number(r.bonus)))];
  if(bonuses.length>1)throw new SocError('BONUS_POLICY_REQUIRED',409);out.bonus=bonuses[0]||0;
  out.amount=Math.round((out.subtotal+out.bonus+Number.EPSILON)*100)/100;
 }
 return result;
}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function constantEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;const aa=hash(a),bb=hash(b);return crypto.timingSafeEqual(Buffer.from(aa),Buffer.from(bb));}
function viewToken(key){if(!key)throw new SocError('AUTH_NOT_CONFIGURED',503);return hash(key+'|view-reports').slice(0,12);}
function personalToken(key,name){if(!key)throw new SocError('AUTH_NOT_CONFIGURED',503);return hash(key+'|'+name).slice(0,10);}
function shopToken(key){if(!key)throw new SocError('AUTH_NOT_CONFIGURED',503);return hash(key+'|shop-reports').slice(0,16);}
function redactError(e){return e instanceof SocError?e.code:'SOCRATES_INTERNAL_ERROR';}
module.exports={SocError,ROSTER,INITIAL_RATES,CALENDAR,cats,canonical,clean,norm,hash,date,month,bounds,today,addDays,workdays,isWorkingDay,minutes,creative,objectKey,rateAt,rowAmount,payroll,esc,constantEqual,viewToken,personalToken,shopToken,redactError};
