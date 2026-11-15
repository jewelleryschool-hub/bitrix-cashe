'use strict';
const R=require('./rules.cjs'),S=require('./store.cjs');
const fields=['id','work_date','master','category','object','operation','day_fraction','confidence','clarify','digest_date'];
function visible(row){return Object.fromEntries(fields.map(k=>[k,k==='id'?String(row[k]):k.endsWith('date')?S.iso(row[k]):k==='day_fraction'?row[k]==null?null:Number(row[k]):row[k]??null]));}
function digest(plan){const {manifestSha256,...body}=plan;return R.hash(body);}
function sameRows(a,b){const sort=x=>x.map(visible).sort((a,b)=>Number(a.id)-Number(b.id));return JSON.stringify(sort(a))===JSON.stringify(sort(b));}
async function applyCorrections(pool,plan,{approval,mode}={}){
 if(!approval||approval.manifestSha256!==plan.manifestSha256||digest(plan)!==plan.manifestSha256||!['local-test','owner-approved-production'].includes(mode))throw new R.SocError('CORRECTION_APPROVAL_REQUIRED',403);
 return S.tx(pool,async c=>{
  await S.requireSchema(c);
  await c.query("INSERT INTO socrates_runs(job_key,state) VALUES($1,'pending') ON CONFLICT DO NOTHING",['correction:'+plan.manifestSha256]);await c.query('SELECT * FROM socrates_runs WHERE job_key=$1 FOR UPDATE',['correction:'+plan.manifestSha256]);
  if((await c.query('SELECT 1 FROM socrates_correction_batches WHERE batch_hash=$1',[plan.manifestSha256])).rows.length)return {alreadyApplied:true,changed:0};
  // Lock every affected day before source/baseline checks. No delete happens until
  // ALL prerequisites have been verified for the entire approved manifest.
  const unique=new Set();for(const day of plan.days){R.date(day.work_date);if(!R.ROSTER[day.master]||unique.has(day.master+'|'+day.work_date))throw new R.SocError('INVALID_CORRECTION_DAYS');unique.add(day.master+'|'+day.work_date);}
  for(const day of [...plan.days].sort((a,b)=>(a.master+'|'+a.work_date).localeCompare(b.master+'|'+b.work_date))){await c.query('INSERT INTO socrates_days(master,work_date) VALUES($1,$2) ON CONFLICT DO NOTHING',[day.master,day.work_date]);await c.query('SELECT * FROM socrates_days WHERE master=$1 AND work_date=$2 FOR UPDATE',[day.master,day.work_date]);}
  const current={};for(const day of plan.days){const rr=(await c.query('SELECT w.*,work_date::text,digest_date::text FROM work_log w WHERE master=$1 AND work_date=$2 ORDER BY id FOR UPDATE',[day.master,day.work_date])).rows;
   if(!sameRows(rr,day.before))throw new R.SocError('CORRECTION_BASELINE_DRIFT',409);current[day.master+'|'+day.work_date]=rr;}
  // New/edited reports after the audit require a fresh preview, even if the old
  // application has not yet incorporated them into work_log.
  const newReports=await c.query('SELECT 1 FROM tg_reports WHERE created_at>$1 LIMIT 1',[Date.parse(plan.sourceSnapshot)]);
  if(newReports.rows.length)throw new R.SocError('SOURCE_SNAPSHOT_DRIFT',409);
  const resolved=new Map();
  for(const ref of plan.sources){
   const rr=(await c.query('SELECT * FROM tg_reports WHERE author_name=$1 AND msg_date=$2 ORDER BY id DESC',[ref.author,Date.parse(ref.msg_date)/1000])).rows;
   const candidate=rr.find(x=>R.hash(x.text||'')===ref.sha256);if(!candidate)throw new R.SocError('CORRECTION_SOURCE_MISSING',409);
   const latest=(await c.query('SELECT * FROM tg_reports WHERE chat_id=$1 AND message_id=$2 ORDER BY update_id DESC NULLS LAST,id DESC LIMIT 1',[candidate.chat_id,candidate.message_id])).rows[0];
   if(!latest||R.hash(latest.text||'')!==ref.sha256)throw new R.SocError('CORRECTION_SOURCE_SUPERSEDED',409);
   const identity=(await c.query('SELECT master FROM socrates_identity WHERE author_id=$1',[latest.author_id])).rows[0];
   resolved.set(ref.sha256,{...latest,master:identity?.master});
  }
  for(const day of plan.days){if(day.after.filter(r=>r.category!=='absence').reduce((n,r)=>n+r.minutes,0)>1440)throw new R.SocError('CORRECTION_DAY_EXCEEDS_24H');for(const rec of day.after){const source=resolved.get(rec.source.sha256);
   if(!source||source.master!==day.master||!String(source.text).includes(rec.evidence)||!R.cats.has(rec.category)||!Number.isFinite(rec.minutes)||rec.minutes<0||rec.minutes>1440)throw new R.SocError('CORRECTION_SOURCE_MISMATCH',409);
   if(R.ROSTER[day.master]?.starts&&day.work_date<R.ROSTER[day.master].starts)throw new R.SocError('CORRECTION_BEFORE_EMPLOYMENT');
  }}
  let inserted=0,removed=0;
  for(const day of plan.days){const before=current[day.master+'|'+day.work_date],state=(await c.query('SELECT revision FROM socrates_days WHERE master=$1 AND work_date=$2',[day.master,day.work_date])).rows[0];const rev=Number(state.revision)+1;
   const retain=day.retainIds||[];if(retain.some(id=>!before.some(r=>String(r.id)===String(id))))throw new R.SocError('INVALID_RETAINED_ROWS');
   removed+=(await c.query('DELETE FROM work_log WHERE master=$1 AND work_date=$2 AND NOT(id=ANY($3::bigint[]))',[day.master,day.work_date,retain])).rowCount||0;
   const records=before.filter(r=>retain.includes(String(r.id)));
   for(const rec of day.after){const source=resolved.get(rec.source.sha256),id=Number(source.id);const contributions=[{source_ids:[id],minutes:rec.minutes,evidence:rec.evidence}];
    const old=current[day.master+'|'+day.work_date].find(r=>r.object===rec.object&&r.deal_id);
    // Preserve known CRM links; do not invent a deal id from a short order number.
    await c.query(`INSERT INTO work_log(tg_report_id,work_date,master,category,object,deal_id,operation,business_unit,day_fraction,confidence,clarify,clarify_question,raw_text,digest_date,created_at,socrates_minutes,socrates_source_ids,socrates_revision,socrates_contributions)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'owner-reviewed-correction',$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[id,day.work_date,day.master,rec.category,rec.object,old?.deal_id||null,rec.operation,rec.business_unit,rec.minutes/480,!!rec.clarify,rec.clarify_question||null,source.text,plan.asOf,Date.now(),rec.minutes,JSON.stringify([id]),rev,JSON.stringify(contributions)]);
    inserted++;records.push({...rec,source_ids:[id],contributions});
   }
   await c.query('INSERT INTO socrates_revisions(master,work_date,revision,before_rows,after_rows,source_ids,basis) VALUES($1,$2,$3,$4,$5,$6,$7)',[day.master,day.work_date,rev,JSON.stringify(before),JSON.stringify(records),JSON.stringify([...new Set(records.flatMap(r=>r.source_ids))]),'owner-approved-manifest:'+plan.manifestSha256]);
   await c.query('UPDATE socrates_days SET revision=$1,protected=false,last_hash=$2 WHERE master=$3 AND work_date=$4',[rev,R.hash(records),day.master,day.work_date]);
  }
  await c.query('INSERT INTO socrates_correction_batches(batch_hash,before_rows) VALUES($1,$2)',[plan.manifestSha256,JSON.stringify(Object.values(current).flat())]);
  await c.query('UPDATE socrates_sources SET processed=true,review=false WHERE report_id=ANY($1::bigint[])',[[...new Set([...resolved.values()].map(r=>String(r.id)))]]);
  await c.query('UPDATE socrates_review SET resolved=true WHERE reason=$1',['AWAITING_APPROVED_HOURS:'+plan.manifestSha256]);
  return {changed:plan.days.length,removed,inserted,alreadyApplied:false};
 });
}
module.exports={visible,sameRows,digest,applyCorrections};
