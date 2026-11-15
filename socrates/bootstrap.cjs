'use strict';
const fs=require('node:fs');const R=require('./rules.cjs'),S=require('./store.cjs');
async function bootstrap(pool,{approved=false,mode,salarySnapshot,identityDecisions={},baselineThrough,hoursPlan}={}){
 if(!approved||!['local-test','owner-approved-production'].includes(mode))throw new R.SocError('MIGRATION_APPROVAL_REQUIRED',403);
 const cutoff=baselineThrough?Date.parse(baselineThrough):mode==='local-test'?Date.now():NaN;if(!Number.isSafeInteger(cutoff))throw new R.SocError('BASELINE_CUTOFF_REQUIRED');
 const snapshot=salarySnapshot||R.INITIAL_RATES;
 for(const [master,pair] of Object.entries(snapshot))if(!Array.isArray(pair)||pair.length!==2||!pair.every(x=>Number.isFinite(x)&&x>=0))throw new R.SocError('INVALID_RATE_SNAPSHOT');
 return S.tx(pool,async c=>{
  const sql=fs.readFileSync(__dirname+'/schema.sql','utf8');if(c.exec)await c.exec(sql);else await c.query(sql);
  const users=(await c.query('SELECT name,user_id FROM socrates_users')).rows;
  const duplicateUserIds=new Map();for(const u of users){const key=String(u.user_id);if(duplicateUserIds.has(key)&&duplicateUserIds.get(key)!==u.name)throw new R.SocError('AMBIGUOUS_PRIVATE_BINDING');duplicateUserIds.set(key,u.name);}
  const identities=(await c.query('SELECT DISTINCT author_id,author_name FROM tg_reports WHERE author_id IS NOT NULL')).rows;
  const byId=new Map();for(const r of identities){const master=R.canonical(r.author_name);if(!master)continue;const id=String(r.author_id);if(!byId.has(id))byId.set(id,new Set());byId.get(id).add(master);}
  for(const u of users)if(R.ROSTER[u.name]){const id=String(u.user_id);if(!byId.has(id))byId.set(id,new Set());byId.get(id).add(u.name);}
  for(const [id,names] of byId){const master=identityDecisions[id]||(names.size===1?[...names][0]:null);if(!master||!R.ROSTER[master]||!names.has(master))throw new R.SocError('IDENTITY_REVIEW_REQUIRED');
   const old=(await c.query('SELECT master FROM socrates_identity WHERE author_id=$1',[id])).rows[0];if(old&&old.master!==master)throw new R.SocError('IDENTITY_CHANGED');
   await c.query('INSERT INTO socrates_identity(author_id,master,confirmed_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,master,'approved-initial-group-history']);}
  const initial={...snapshot,'Константин Пинчук':[100000,0]};
  for(const [master,[base,bonus]] of Object.entries(initial)){
   if(!R.ROSTER[master])continue;const from=R.ROSTER[master].starts||'1900-01-01';
   const old=(await c.query('SELECT base,bonus FROM socrates_rates WHERE master=$1 AND effective_from=$2',[master,from])).rows[0];
   if(old&&(Number(old.base)!==base||Number(old.bonus)!==bonus))throw new R.SocError('RATE_SNAPSHOT_CONFLICT');
   await c.query('INSERT INTO socrates_rates(master,effective_from,base,bonus,basis) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[master,from,base,bonus,master==='Константин Пинчук'?'owner-confirmed-2026-11-14':'frozen-legacy-compatibility-not-certified-contract-history']);
  }
  await c.query(`INSERT INTO socrates_sources(chat_id,message_id,report_id,master,version,processed,review,received_at)
    SELECT t.chat_id,t.message_id,t.id,i.master,COALESCE(t.update_id,t.id),t.created_at<=$1,i.master IS NULL AND t.created_at>$1,to_timestamp(t.created_at/1000.0)
    FROM (SELECT DISTINCT ON(chat_id,message_id) * FROM tg_reports WHERE message_id IS NOT NULL ORDER BY chat_id,message_id,update_id DESC NULLS LAST,id DESC) t
    LEFT JOIN socrates_identity i ON i.author_id=t.author_id ON CONFLICT DO NOTHING`,[cutoff]);
  if(hoursPlan&&!(await c.query('SELECT 1 FROM socrates_correction_batches WHERE batch_hash=$1',[hoursPlan.manifestSha256])).rows.length){
   const {digest}=require('./corrections.cjs');if(digest(hoursPlan)!==hoursPlan.manifestSha256)throw new R.SocError('INVALID_HOURS_MANIFEST');
   for(const ref of hoursPlan.sources){const found=(await c.query('SELECT s.report_id,t.text FROM socrates_sources s JOIN tg_reports t ON t.id=s.report_id WHERE t.author_name=$1 AND t.msg_date=$2',[ref.author,Date.parse(ref.msg_date)/1000])).rows.filter(r=>R.hash(r.text||'')===ref.sha256);
    if(!found.length)throw new R.SocError('CORRECTION_SOURCE_MISSING');const ids=found.map(x=>Number(x.report_id));
    await c.query('UPDATE socrates_sources SET processed=false,review=true WHERE report_id=ANY($1::bigint[])',[ids.map(String)]);
    const workDates=hoursPlan.days.filter(d=>d.after.some(r=>r.source.sha256===ref.sha256)).map(d=>d.work_date),reason='AWAITING_APPROVED_HOURS:'+hoursPlan.manifestSha256;
    await c.query('INSERT INTO socrates_review(master,source_ids,reason,work_dates) SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM socrates_review WHERE reason=$3 AND source_ids=$2::jsonb)',[R.canonical(ref.author),JSON.stringify(ids),reason,JSON.stringify(workDates)]);
   }
  }
  await c.query(`INSERT INTO socrates_jobs(master,due_at) SELECT master,MAX(received_at)+INTERVAL '115 seconds' FROM socrates_sources WHERE NOT processed AND NOT review AND master IS NOT NULL GROUP BY master ON CONFLICT DO NOTHING`);
  await c.query('INSERT INTO socrates_days(master,work_date,protected) SELECT DISTINCT master,work_date,true FROM work_log WHERE master IS NOT NULL AND work_date IS NOT NULL ON CONFLICT DO NOTHING');
  await S.rates(c);return {schema:2,identities:byId.size,rates:Object.keys(initial).filter(n=>R.ROSTER[n]).length,existingWorkLogChanged:false};
 });
}
module.exports={bootstrap};
