'use strict';
const crypto=require('node:crypto');
const R=require('./rules.cjs');const {combined,validate}=require('./parser.cjs');
const iso=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
async function tx(pool,fn){
 if(typeof pool.connect==='function'){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 if(typeof pool.transaction==='function')return pool.transaction(fn);
 throw new R.SocError('TRANSACTION_REQUIRED',503);
}
function rowKey(r){return JSON.stringify([r.category,R.objectKey(r.object),R.norm(r.operation),r.business_unit||'common']);}
function sourceRecord(r,id){return {...r,source_ids:[Number(id)]};}
function toRecord(r){return {category:r.category,object:r.object,deal_id:r.deal_id||null,operation:r.operation,minutes:R.minutes(r),business_unit:r.business_unit||'common',clarify_question:r.clarify_question||null,evidence:r.raw_text||'',source_ids:r.socrates_source_ids||[],contributions:r.socrates_contributions||null};}
function withoutSources(records,removed){return records.flatMap(r=>{
 const parts=(r.contributions||[{source_ids:r.source_ids,minutes:r.minutes,evidence:r.evidence}]).filter(p=>!p.source_ids.some(id=>removed.includes(Number(id))));
 if(!parts.length)return [];
 return [{...r,contributions:parts,source_ids:[...new Set(parts.flatMap(p=>p.source_ids))],minutes:parts.some(p=>p.minutes==null)?null:parts.reduce((n,p)=>n+Number(p.minutes),0)}];
});}
async function requireSchema(pool){const r=await pool.query('SELECT version FROM socrates_schema WHERE version=2');if(!r.rows.length)throw new R.SocError('SOCRATES_MIGRATION_REQUIRED',503);}
async function rates(pool){const rows=(await pool.query('SELECT master,effective_from::text,effective_to::text,base,bonus,basis FROM socrates_rates ORDER BY master,effective_from')).rows.map(r=>({...r,effective_from:iso(r.effective_from),effective_to:r.effective_to?iso(r.effective_to):null,base:Number(r.base),bonus:Number(r.bonus)}));
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)if(rows[i].master===rows[j].master&&rows[i].effective_from<=(rows[j].effective_to||'9999-12-31')&&rows[j].effective_from<=(rows[i].effective_to||'9999-12-31'))throw new R.SocError('OVERLAPPING_RATES',503);return rows;}
async function ingest(pool,update,env={},now=Date.now()){
 const msg=update.message||update.edited_message||update.channel_post;if(!msg)return {ignored:true};
 if(!Number.isSafeInteger(update.update_id)||!Number.isSafeInteger(msg.message_id)||!Number.isSafeInteger(msg.from?.id)||!Number.isFinite(msg.date))throw new R.SocError('TELEGRAM_UPDATE_INVALID',400);
 if(String(msg.chat?.id)!==String(env.TG_SOCRATES_CHAT||'-1004300239646'))throw new R.SocError('CHAT_NOT_ALLOWED',403);
 return tx(pool,async c=>{
  const author=[msg.from.first_name,msg.from.last_name].filter(Boolean).join(' ')||msg.from.username||'';
  const ins=await c.query(`INSERT INTO tg_reports(update_id,message_id,chat_id,author_id,author_name,text,msg_date,raw,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(update_id) DO NOTHING RETURNING id`,[update.update_id,msg.message_id,msg.chat.id,msg.from.id,author,msg.text||msg.caption||'',msg.date,JSON.stringify(msg),now]);
  if(!ins.rows.length)return {duplicate:true};const id=Number(ins.rows[0].id);
  const identity=(await c.query('SELECT master FROM socrates_identity WHERE author_id=$1',[msg.from.id])).rows[0];
  const master=identity?.master||null;const version=update.update_id;
  const changed=await c.query(`INSERT INTO socrates_sources(chat_id,message_id,report_id,master,version,received_at,processed) VALUES($1,$2,$3,$4,$5,to_timestamp($6/1000.0),false)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET report_id=EXCLUDED.report_id,master=EXCLUDED.master,version=EXCLUDED.version,received_at=EXCLUDED.received_at,processed=false,review=false WHERE socrates_sources.version<EXCLUDED.version RETURNING report_id`,[msg.chat.id,msg.message_id,id,master,version,now]);
  if(!master||!R.ROSTER[master]){
   if(changed.rows.length)await c.query('INSERT INTO socrates_review(master,source_ids,reason) VALUES(NULL,$1,$2)',[JSON.stringify([id]),'UNBOUND_TELEGRAM_AUTHOR']);
   return {stored:true,unbound:true,report_id:id};
  }
  if(changed.rows.length)await c.query(`INSERT INTO socrates_jobs(master,due_at) VALUES($1,to_timestamp($2/1000.0)) ON CONFLICT(master) DO UPDATE SET revision=socrates_jobs.revision+1,due_at=EXCLUDED.due_at,needs_review=false`,[master,now+115000]);
  return {stored:true,report_id:id,master};
 });
}
async function pending(pool,master){return (await pool.query(`SELECT t.*,s.version,s.processed FROM socrates_sources s JOIN tg_reports t ON t.id=s.report_id WHERE s.master=$1 AND NOT s.processed AND NOT s.review ORDER BY s.version,t.id`,[master])).rows.map(r=>({...r,id:Number(r.id),master,is_edit:!!r.raw?.edit_date}));}
async function claimJob(pool,now=Date.now(),runAll=true){
 const token=crypto.randomUUID();const r=await pool.query(`UPDATE socrates_jobs SET lease_token=$1,lease_until=to_timestamp($2/1000.0),attempts=attempts+1
 WHERE master=(SELECT master FROM socrates_jobs WHERE NOT needs_review AND ($4 OR last_error IS NOT NULL) AND due_at<=to_timestamp($3/1000.0) AND (lease_until IS NULL OR lease_until<to_timestamp($3/1000.0)) ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[token,now+600000,now,runAll]);return r.rows[0]||null;
}
async function enqueue(c,{key,kind,recipient,text,sourceIds=[]}){
 if(!recipient||!text)return;await c.query(`INSERT INTO socrates_outbox(event_key,kind,recipient,text,source_ids) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_key) DO NOTHING`,[key,kind,recipient,text,JSON.stringify(sourceIds)]);
}
async function commitParsed(pool,job,reports,parsed,{now=Date.now(),group,questions=true,onCommit=async()=>{},dealCatalog=[]}={}){
 validate(parsed,reports,job.master,now);
 return tx(pool,async c=>{
  const locked=(await c.query('SELECT * FROM socrates_jobs WHERE master=$1 FOR UPDATE',[job.master])).rows[0];
  if(!locked||locked.lease_token!==job.lease_token||String(locked.revision)!==String(job.revision))throw new R.SocError('STALE_PARSE',409);
  for(const source of reports){const current=(await c.query('SELECT report_id FROM socrates_sources WHERE chat_id=$1 AND message_id=$2 FOR UPDATE',[source.chat_id,source.message_id])).rows[0];if(String(current?.report_id)!==String(source.id))throw new R.SocError('STALE_PARSE',409);}
  const sourceMap=new Map(reports.map(x=>[Number(x.id),x]));const dayMap=new Map(),reviewIds=new Set();
  const reviewDay=async(items,reason,workDates=[])=>{const ids=[...new Set(items.map(x=>x.report_id))];ids.forEach(id=>reviewIds.add(id));
   await c.query('INSERT INTO socrates_review(master,source_ids,reason,draft,work_dates) VALUES($1,$2,$3,$4,$5)',[job.master,JSON.stringify(ids),reason,JSON.stringify({reports:items}),JSON.stringify(workDates)]);
   if(questions){const qs=[...new Set(items.flatMap(r=>[r.question,...r.days.flatMap(d=>d.records.map(x=>x.clarify_question))]).filter(Boolean))].slice(0,2);for(const q of qs)await enqueue(c,{key:'review:'+R.hash([job.master,ids,q]),kind:'question',recipient:group,text:q,sourceIds:ids});}
  };
  const obsolete=[];
  for(const source of reports){const prior=(await c.query('SELECT id FROM tg_reports WHERE chat_id=$1 AND message_id=$2 AND id<>$3',[source.chat_id,source.message_id,source.id])).rows;obsolete.push(...prior.map(x=>Number(x.id)));}
  for(const item of parsed.reports){
   if(item.disposition==='needs_review'){await reviewDay([item],'SOURCE_NEEDS_REVIEW',item.days.map(d=>d.work_date));continue;}
   for(const day of item.days){const arr=dayMap.get(day.work_date)||[];arr.push({item,day,source:sourceMap.get(item.report_id)});dayMap.set(day.work_date,arr);}
  }
  if(obsolete.length){const oldDays=(await c.query(`SELECT DISTINCT work_date::text FROM work_log WHERE master=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(socrates_source_ids,'[]'::jsonb)) x WHERE x::text=ANY($2::text[]))`,[job.master,obsolete.map(String)])).rows;
   for(const old of oldDays)if(!dayMap.has(iso(old.work_date)))dayMap.set(iso(old.work_date),[]);}
  let written=0;
  dayLoop: for(const [d,units] of [...dayMap.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
   await c.query('INSERT INTO socrates_days(master,work_date) VALUES($1,$2) ON CONFLICT DO NOTHING',[job.master,d]);
   const state=(await c.query('SELECT * FROM socrates_days WHERE master=$1 AND work_date=$2 FOR UPDATE',[job.master,d])).rows[0];
   const before=(await c.query('SELECT w.*,work_date::text,digest_date::text FROM work_log w WHERE master=$1 AND work_date=$2 ORDER BY id FOR UPDATE',[job.master,d])).rows;
   if(state.protected||before.some(r=>r.socrates_revision==null)){await reviewDay(units.length?units.map(x=>x.item):parsed.reports,'LEGACY_DAY_REQUIRES_APPROVED_CORRECTION',[d]);continue;}
   if(units.some(x=>x.day.mode==='clarify')){await reviewDay(units.map(x=>x.item),'CLARIFICATION_REQUIRED',[d]);continue;}
   let after=withoutSources(before.map(toRecord),obsolete);
   for(const {item,day,source} of units){
    // Remove only this Telegram message's previous revision contribution. A
    // revised source is different from a separate additional operation.
    const oldSourceIds=(await c.query('SELECT id FROM tg_reports WHERE chat_id=$1 AND message_id=$2',[source.chat_id,source.message_id])).rows.map(x=>Number(x.id));
    if(source.is_edit&&before.length&&day.mode!=='replace'){
     const owned=(await c.query(`SELECT 1 FROM work_log WHERE master=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(socrates_source_ids,'[]'::jsonb)) x WHERE x::text=ANY($2::text[])) LIMIT 1`,[job.master,oldSourceIds.map(String)])).rows;
     if(!owned.length){await reviewDay(units.map(x=>x.item),'EDIT_SOURCE_NOT_OWNED_REVIEW',[d]);continue dayLoop;}
    }
    const existingIds=[...new Set(after.flatMap(r=>r.source_ids))];
    if(day.mode==='append'&&existingIds.length){
     const prior=(await c.query('SELECT id,text FROM tg_reports WHERE id=ANY($1::bigint[])',[existingIds.map(String)])).rows;
     const identical=prior.filter(r=>R.norm(r.text)===R.norm(source.text)).map(r=>Number(r.id));
     if(identical.length)after=withoutSources(after,identical);
     else if(!source.is_edit&&!/дополн|ещ[её]|плюс|сверх|добав/iu.test(source.text)&&day.records.some(r=>after.some(old=>rowKey(old)===rowKey(r)))){
      await reviewDay(units.map(x=>x.item),'AMBIGUOUS_SAME_OPERATION',[d]);continue dayLoop;
     }
    }
    if(day.mode==='replace')after=[];
    else after=withoutSources(after,oldSourceIds);
    after.push(...day.records.map(rec=>{const matches=dealCatalog.filter(d=>rec.category==='deal'&&String(d.num)===R.objectKey(rec.object));return {...sourceRecord(rec,item.report_id),deal_id:matches.length===1?matches[0].id:null};}));
   }
   after=combined(after);const sum=after.filter(r=>r.category!=='absence').reduce((n,r)=>n+(r.minutes||0),0);if(sum>1440.000001)throw new R.SocError('DAY_EXCEEDS_24H');
   const fingerprint=R.hash(after);if(state.last_hash===fingerprint)continue;
   const revision=Number(state.revision)+1;
   await c.query('DELETE FROM work_log WHERE master=$1 AND work_date=$2',[job.master,d]);
   for(const rec of after){
    const sid=rec.source_ids[0];const source=sourceMap.get(Number(sid));const fraction=rec.minutes==null?null:rec.minutes/480;
    await c.query(`INSERT INTO work_log(tg_report_id,work_date,master,category,object,operation,business_unit,day_fraction,confidence,clarify,clarify_question,raw_text,digest_date,created_at,socrates_minutes,socrates_source_ids,socrates_revision,socrates_contributions,deal_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'v2', $9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[sid,d,job.master,rec.category,rec.object,rec.operation,rec.business_unit,fraction,rec.minutes==null||!!rec.clarify_question,rec.clarify_question,source?.text||rec.evidence||'',R.today(now),now,rec.minutes,JSON.stringify(rec.source_ids),revision,JSON.stringify(rec.contributions),rec.deal_id||null]);written++;
    if(questions&&rec.clarify_question)await enqueue(c,{key:'question:'+job.master+':'+d+':'+R.hash(rowKey(rec)+rec.clarify_question),kind:'question',recipient:group,text:rec.clarify_question,sourceIds:rec.source_ids});
   }
   await c.query('INSERT INTO socrates_revisions(master,work_date,revision,before_rows,after_rows,source_ids,basis) VALUES($1,$2,$3,$4,$5,$6,$7)',[job.master,d,revision,JSON.stringify(before),JSON.stringify(after),JSON.stringify(units.length?units.map(x=>x.item.report_id):reports.map(x=>x.id)),'validated-source']);
   await c.query('UPDATE socrates_days SET revision=$1,last_hash=$2,source_version=$3 WHERE master=$4 AND work_date=$5',[revision,fingerprint,units.length?Math.max(...units.map(x=>Number(x.source.version))):Number(state.source_version),job.master,d]);
   if(!after.some(r=>r.minutes==null||r.clarify_question))await c.query(`UPDATE socrates_review SET resolved=true WHERE master=$1 AND work_dates @> $2::jsonb`,[job.master,JSON.stringify([d])]);
  }
  for(const item of parsed.reports){
   for(const f of item.facts){await c.query(`INSERT INTO socrates_memory(master,kind,date_from,date_to,note,created_at) SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS(SELECT 1 FROM socrates_memory WHERE master=$1 AND kind=$2 AND date_from=$3 AND date_to=$4)`,[job.master,f.kind,f.date_from,f.date_to,f.evidence,now]);}
   await c.query('UPDATE socrates_sources SET processed=$1,review=$2 WHERE report_id=$3',[!reviewIds.has(item.report_id),reviewIds.has(item.report_id),item.report_id]);
  }
  await onCommit(c,{written,review_source_ids:[...reviewIds]});
  await c.query('DELETE FROM socrates_jobs WHERE master=$1 AND revision=$2 AND lease_token=$3',[job.master,job.revision,job.lease_token]);
  return {written,review_source_ids:[...reviewIds]};
 });
}
async function failJob(pool,job,error,parsed,now=Date.now(),{group,questions=false,adminId}={}){
 const code=R.redactError(error);const review=code.startsWith('MODEL_')||Number(job.attempts)>=5||['SOURCE_NEEDS_REVIEW','CLARIFICATION_REQUIRED','LEGACY_DAY_REQUIRES_APPROVED_CORRECTION','REPLACEMENT_NOT_PROVEN','SOURCE_TOO_LARGE_REVIEW_REQUIRED','WORK_DATE_NOT_ALLOWED','DAY_EXCEEDS_24H','UNSAFE_QUESTION','MISSING_CLARIFICATION','AMBIGUOUS_PARTIAL_MERGE'].includes(code);
 const currentAttempt=await tx(pool,async c=>{
  const current=(await c.query('SELECT revision,lease_token FROM socrates_jobs WHERE master=$1 FOR UPDATE',[job.master])).rows[0];
  if(!current||current.lease_token!==job.lease_token||String(current.revision)!==String(job.revision)){
   if(current?.lease_token===job.lease_token)await c.query('UPDATE socrates_jobs SET lease_token=NULL,lease_until=NULL WHERE master=$1 AND lease_token=$2',[job.master,job.lease_token]);
   return false;
  }
  if(review){const ids=parsed?.reports?.map(r=>r.report_id)||[],days=[...new Set(parsed?.reports?.flatMap(r=>r.days.map(d=>d.work_date))||[])];
   if(!ids.length){const p=(await c.query('SELECT report_id FROM socrates_sources WHERE master=$1 AND NOT processed AND NOT review',[job.master])).rows;ids.push(...p.map(x=>Number(x.report_id)));}
   await c.query('INSERT INTO socrates_review(master,source_ids,reason,draft,work_dates) VALUES($1,$2,$3,$4,$5)',[job.master,JSON.stringify(ids),code,parsed?JSON.stringify(parsed):null,JSON.stringify(days)]);
   await c.query('UPDATE socrates_sources SET review=true WHERE report_id=ANY($1::bigint[])',[ids.map(String)]);
   if(questions){const qs=[...new Set(parsed?.reports?.flatMap(r=>[r.question,...r.days.flatMap(d=>d.records.map(x=>x.clarify_question))]).filter(Boolean)||[])].slice(0,2);
    for(const q of qs)await enqueue(c,{key:'review:'+R.hash([job.master,ids,q]),kind:'question',recipient:group,text:q,sourceIds:ids});}
  }
  await c.query(`UPDATE socrates_jobs SET lease_token=NULL,lease_until=NULL,last_error=$1,due_at=to_timestamp($2/1000.0),needs_review=$3 WHERE master=$4 AND lease_token=$5`,[code,now+(code==='STALE_PARSE'?115000:Math.min(3600000,60000*2**Math.min(Number(job.attempts),6))),review,job.master,job.lease_token]);
  if(adminId&&code!=='STALE_PARSE')await enqueue(c,{key:'processing-error:'+job.master+':'+R.today(now)+':'+code,kind:'dm',recipient:adminId,text:'Сократ: разбор отчёта '+job.master+' не завершён ('+code+'). Исходные сообщения сохранены. '+(review?'Нужна проверка; часы не будут угаданы.':'Запланирован повтор обработки.')});
  return true;
 });return currentAttempt?code:'STALE_PARSE';
}
module.exports={tx,iso,requireSchema,rates,ingest,pending,claimJob,enqueue,commitParsed,failJob,toRecord,withoutSources};
