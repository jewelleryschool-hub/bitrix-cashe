'use strict';
const R=require('./rules.cjs'),S=require('./store.cjs'),P=require('./parser.cjs'),V=require('./views.cjs');
function registerSocrates(app,{getPool,aiFetch,aiCredential,loadDeals=async()=>[],fetchImpl=globalThis.fetch,env=process.env,clock=()=>Date.now(),logger=console,setIntervalImpl=setInterval}={}){
 let ready=false,busy=false;const chat=String(env.TG_SOCRATES_CHAT||'-1004300239646'),base=env.SOCRATES_BASE_URL||'https://bitrix-cashe-production.up.railway.app';
 const pool=()=>{const p=getPool();if(!p||!ready)throw new R.SocError('SOCRATES_NOT_READY',503);return p;};
 const admin=()=>Number(env.SOC_ADMIN_TG||639698476);
 const auth=(req,personal=false,shop=false)=>{
  if(!env.PHOTO_KEY)throw new R.SocError('AUTH_NOT_CONFIGURED',503);
  if(R.constantEqual(req.headers?.['x-socrates-admin-key']||req.query?.key,env.PHOTO_KEY))return {admin:true,auth:'v='+R.viewToken(env.PHOTO_KEY)};
  if(R.constantEqual(req.query?.v,R.viewToken(env.PHOTO_KEY)))return {admin:true,auth:'v='+R.viewToken(env.PHOTO_KEY)};
  if(shop&&R.constantEqual(req.query?.rv,R.shopToken(env.PHOTO_KEY)))return {shop:true,auth:'rv='+R.shopToken(env.PHOTO_KEY)};
  if(personal&&R.ROSTER[req.query?.m]&&R.constantEqual(req.query?.t,R.personalToken(env.PHOTO_KEY,req.query.m)))return {personal:req.query.m,auth:new URLSearchParams({m:req.query.m,t:req.query.t}).toString()};
  throw new R.SocError('ACCESS_DENIED',403);
 };
 function route(method,path,fn){app[method](path,async(req,res)=>{try{res.set?.('Cache-Control','no-store');await fn(req,res);}catch(e){logger.log('Socrates:',R.redactError(e));res.status(e.status||500).json({error:R.redactError(e)});}});}
 const selectedMonth=req=>R.month(req.query.month||R.today(clock()).slice(0,7));
 const selectedRange=req=>[R.date(req.query.from||'2026-01-01'),R.date(req.query.to||R.today(clock()))];
 const rows=async(from,to,master,db=pool())=>{if(from>to)throw new R.SocError('INVALID_RANGE');return (await db.query('SELECT w.*,work_date::text,digest_date::text FROM work_log w WHERE work_date >= $1 AND work_date <= $2'+(master?' AND master=$3':'')+' ORDER BY w.master,w.work_date,w.id',master?[from,to,master]:[from,to])).rows.map(r=>({...r,work_date:S.iso(r.work_date),digest_date:S.iso(r.digest_date),socrates_minutes:r.socrates_minutes==null?null:Number(r.socrates_minutes)}));};
 async function reportedRows(from,to,master){const rr=await rows(from,to,master),occupied=new Set(rr.map(r=>r.master+'|'+r.work_date));
  const facts=(await pool().query('SELECT id,master,kind,date_from::text,date_to::text,note FROM socrates_memory WHERE date_from<=$2 AND date_to>=$1'+(master?' AND master=$3':'')+' ORDER BY id DESC',master?[from,to,master]:[from,to])).rows;
  for(const f of facts){if(!R.ROSTER[f.master]||!['vacation','sick'].includes(f.kind))continue;const a=f.date_from>from?f.date_from:from,b=[f.date_to,to,R.today(clock())].sort()[0];
   for(let d=a;d<=b;d=R.addDays(d,1)){if(!d.startsWith('2026')||!R.isWorkingDay(d)||occupied.has(f.master+'|'+d))continue;occupied.add(f.master+'|'+d);rr.push({id:'memory:'+f.id+':'+d,master:f.master,work_date:d,category:'absence',object:null,operation:(f.kind==='sick'?'болезнь':'отпуск')+' (по сообщению)',day_fraction:1,socrates_minutes:480,raw_text:f.note||'',virtual:true,clarify:false});}
  }return rr;
 }
 const wd=req=>{if(req.query.wd===undefined)return undefined;const n=Number(req.query.wd);if(!Number.isSafeInteger(n)||n<1||n>31)throw new R.SocError('INVALID_WORKDAYS');return n;};
 function salaryLink(master,m){return base+'/socrates/my-salary?'+new URLSearchParams({month:m,m:master,t:R.personalToken(env.PHOTO_KEY,master)});}
 async function enqueueDM(c,uid,text,key){await S.enqueue(c,{key,kind:'dm',recipient:uid,text});}
 async function privateMessage(update){const msg=update.message||update.edited_message,uid=Number(msg.from.id),text=String(msg.text||'').trim();if(!Number.isSafeInteger(uid))throw new R.SocError('TELEGRAM_UPDATE_INVALID',400);
  await S.tx(pool(),async c=>{
   const event=await c.query('INSERT INTO socrates_private_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id',[update.update_id]);if(!event.rows.length)return;
   const who=uid===admin()?'Роман':(await c.query('SELECT name FROM socrates_users WHERE user_id=$1',[uid])).rows[0]?.name||(await c.query('SELECT master FROM socrates_identity WHERE author_id=$1',[uid])).rows[0]?.master;
   const key='private:'+update.update_id;
   if(text==='/start'){
    if(who){await c.query('INSERT INTO socrates_users(name,user_id) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET user_id=EXCLUDED.user_id',[who,uid]);const m=R.today(clock()).slice(0,7);
     await enqueueDM(c,uid,who==='Роман'?'Личный канал подключён. Расчёт: '+base+'/socrates/salary?month='+m+'&v='+R.viewToken(env.PHOTO_KEY):'Личный канал подключён, '+R.ROSTER[who].call+'. Ваш расчёт: '+salaryLink(who,m),key);
    }else{await enqueueDM(c,uid,'Я Сократ, учёт мастерской. Подключение должен подтвердить Роман.',key);await enqueueDM(c,admin(),'Нужна привязка личного канала: Telegram id '+uid+'. Команда: привязать '+uid+' Имя Фамилия.',key+':admin');}
    return;
   }
   if(who==='Роман'){
    const bind=text.match(/^привязать\s+(\d+)\s+(.+)$/iu),unbind=text.match(/^отвязать\s+(.+)$/iu);
    if(bind){const name=bind[2].trim(),target=Number(bind[1]);if(!R.ROSTER[name]||!Number.isSafeInteger(target)||target===admin())throw new R.SocError('INVALID_BINDING');
     await c.query('INSERT INTO socrates_identity(author_id,master,confirmed_by) VALUES($1,$2,$3) ON CONFLICT(author_id) DO UPDATE SET master=EXCLUDED.master,confirmed_by=EXCLUDED.confirmed_by',[target,name,'owner-private-command']);
     await c.query('INSERT INTO socrates_users(name,user_id) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET user_id=EXCLUDED.user_id',[name,target]);
     await enqueueDM(c,uid,'Привязал '+name,key);await enqueueDM(c,target,'Роман подтвердил подключение. Ваш расчёт: '+salaryLink(name,R.today(clock()).slice(0,7)),key+':target');return;
    }
    if(unbind){await c.query('DELETE FROM socrates_users WHERE name=$1',[unbind[1].trim()]);await enqueueDM(c,uid,'Личный канал отключён для '+unbind[1].trim(),key);return;}
   }
   if(who&&/зарплат|salary|расч[её]т/iu.test(text)){await enqueueDM(c,uid,who==='Роман'?base+'/socrates/salary?month='+R.today(clock()).slice(0,7)+'&v='+R.viewToken(env.PHOTO_KEY):salaryLink(who,R.today(clock()).slice(0,7)),key);}
  });
 }
 route('post','/socrates/tg',async(req,res)=>{
  if(!env.TG_SOCRATES_SECRET||!R.constantEqual(req.headers?.['x-telegram-bot-api-secret-token'],env.TG_SOCRATES_SECRET))throw new R.SocError('TELEGRAM_SECRET_REQUIRED',403);
  const update=req.body||{},msg=update.message||update.edited_message||update.channel_post;if(!msg)return res.sendStatus(200);
  if(!Number.isSafeInteger(update.update_id)||!Number.isSafeInteger(msg.from?.id))throw new R.SocError('TELEGRAM_UPDATE_INVALID',400);
  if(msg.chat?.type==='private')await privateMessage(update);else{const result=await S.ingest(pool(),update,env,clock());
   if(result.unbound&&Number(msg.from.id)!==admin())await S.enqueue(pool(),{key:'unbound-author:'+msg.from.id,kind:'dm',recipient:admin(),text:'В группе есть автор без подтверждённой привязки: '+[msg.from.first_name,msg.from.last_name].filter(Boolean).join(' ')+' (Telegram id '+msg.from.id+'). Его сообщение сохранено для проверки; часы автоматически не начислены.',sourceIds:[result.report_id]});
  }
  // Telegram is acknowledged only after its durable transaction commits.
  res.sendStatus(200);
 });
 route('get','/socrates/reports',async(req,res)=>{auth(req);const limit=Number(req.query.limit||30),before=Number(req.query.before_id||Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)throw new R.SocError('INVALID_PAGINATION');
  const r=await pool().query('SELECT id,message_id,author_name,text,msg_date FROM tg_reports WHERE id<$1 ORDER BY id DESC LIMIT $2',[before,limit]);res.json({count:r.rows.length,next_before_id:r.rows.length===limit?String(r.rows.at(-1).id):null,reports:r.rows.map(x=>({id:String(x.id),message_id:String(x.message_id),author:x.author_name,text:x.text,date:x.msg_date?new Date(Number(x.msg_date)*1000).toISOString():null}))});});
 route('get','/socrates/rows',async(req,res)=>{auth(req);const [from,to]=selectedRange(req);const r=await rows(from,to);res.json({count:r.length,rows:r});});
 route('get','/socrates/report',async(req,res)=>{const a=auth(req,false,true),m=selectedMonth(req);const all=await reportedRows(m.slice(0,4)+'-01-01',R.bounds(m)[1]);res.set('Content-Type','text/html; charset=utf-8');res.send(V.report(all,m,a));});
 for(const path of ['/socrates/salary','/socrates/my-salary'])route('get',path,async(req,res)=>{const a=auth(req,path.endsWith('my-salary')),m=selectedMonth(req),personal=a.personal||(path.endsWith('my-salary')?req.query.m:undefined);
  if(path.endsWith('my-salary')&&!R.ROSTER[personal])throw new R.SocError('UNKNOWN_MASTER',404);
  const all=await reportedRows(m.slice(0,4)+'-01-01',R.bounds(m)[1],personal),rateBook=await S.rates(pool());const pending=(await pool().query('SELECT count(*) n FROM socrates_sources WHERE NOT processed'+(personal?' AND master=$1':''),personal?[personal]:[])).rows[0];res.set('Content-Type','text/html; charset=utf-8');res.send(V.salary(all,rateBook,m,{...a,personal,wdOverride:wd(req),pending:Number(pending.n),shopAuth:'rv='+R.shopToken(env.PHOTO_KEY)}));});
 route('get','/socrates/month',async(req,res)=>{auth(req);const m=selectedMonth(req),rr=await reportedRows(...R.bounds(m));const masters={};for(const r of rr){if(req.query.master&&!R.norm(r.master).includes(R.norm(req.query.master)))continue;const x=masters[r.master]??={total_days:0,unresolved_entries:0,activities:[]};x.total_days+=(R.minutes(r)||0)/480;x.unresolved_entries+=R.minutes(r)==null?1:0;x.activities.push({category:r.category,object:r.object,operation:r.operation,days:R.minutes(r)==null?null:R.minutes(r)/480,virtual:!!r.virtual});}res.json({month:m,masters});});
 route('get','/socrates/workload',async(req,res)=>{auth(req);const days=Number(req.query.days||30);if(!Number.isSafeInteger(days)||days<1||days>365)throw new R.SocError('INVALID_RANGE');const from=R.addDays(R.today(clock()),-days),rr=await rows(from,R.today(clock()));const objects={},masters={},units={};for(const r of rr){const f=(R.minutes(r)||0)/480;
  if(['deal','plakhov'].includes(r.category)){const k=R.objectKey(r.object)||'(без объекта)';objects[k]??={object:r.object,category:r.category,total_fraction:0,person_days:0,dates:new Set()};objects[k].total_fraction+=f;objects[k].dates.add(r.master+'|'+r.work_date);objects[k].person_days=objects[k].dates.size;}
  const k=r.master+'|'+r.category;masters[k]??={master:r.master,category:r.category,days:0};masters[k].days+=f;units[r.business_unit||'common']=(units[r.business_unit||'common']||0)+f;
 }res.json({period_days:days,since:from,by_object:Object.values(objects).map(({dates,...x})=>x),by_master:Object.values(masters),by_business_unit:Object.entries(units).map(([business_unit,days])=>({business_unit,days}))});});
 // These old GET routes could change/pay/delete/send by merely opening a link.
 // Reconciliation is now an independently approved manifest, never an AI reparse
 // that deletes existing work before a model request succeeds.
 for(const path of ['digest','reparse','cleanup','drop-row','drop-master','merge-object','import','say','dm']){
  route('get','/socrates/'+path,async(req,res)=>{auth(req);if(path==='digest'){const pending=(await pool().query('SELECT master,last_error,needs_review FROM socrates_jobs ORDER BY master')).rows;return res.json({read_only:true,pending,note:'Разбор выполняется очередью; GET не меняет учёт и не отправляет сообщения.'});}res.status(405).json({error:'MUTATING_GET_DISABLED',approval_required:true});});
  route('post','/socrates/'+path,async(req,res)=>{auth(req);res.status(409).json({error:'APPROVED_CORRECTION_MANIFEST_REQUIRED',data_changed:false});});
 }
 async function away(master,d,db=pool()){const r=await db.query("SELECT 1 FROM socrates_memory WHERE master=$1 AND kind IN ('vacation','sick') AND date_from<=$2 AND date_to>=$2 LIMIT 1",[master,d]);if(r.rows.length)return true;return String(env.SOCRATES_VACATION||'').split(',').some(x=>{const [name,until]=x.split(':').map(s=>s.trim());return name===master&&until&&d<=until;});}
 async function chatReply(master,item,reports,c){const source=reports.find(r=>Number(r.id)===item.report_id);if(!source||item.disposition!=='chat')return;
  let text;if(/зарплат|оклад|деньг|себестоим|стоимост|ставк|сколько.*(?:заплат|получ)/iu.test(source.text))text='По деньгам — к Роману. Здесь я помогаю с днями и часами.';
  else{const d=R.today(clock());let from=R.addDays(d,-9),to=d,label='последние 10 дней';const q=source.text;
   if(/вчера/iu.test(q)){from=to=R.addDays(d,-1);label=from;}else if(/сегодня/iu.test(q)){from=to=d;label=d;}else if(/недел/iu.test(q)){from=R.addDays(d,-6);label='последние 7 дней';}else if(/месяц/iu.test(q)){from=d.slice(0,7)+'-01';label='этот месяц';}
   const explicit=q.match(/\b(\d{1,2})[.]\s*(\d{1,2})(?:[.](\d{4}))?/);if(explicit){try{from=to=R.date((explicit[3]||d.slice(0,4))+'-'+explicit[2].padStart(2,'0')+'-'+explicit[1].padStart(2,'0'));label=from;}catch{}}
   const order=q.match(/заказ[а-яё]*\s*#?\s*(\d+)|#\s*(\d+)/iu);let r=await rows(from,to,master,c);if(order){const num=order[1]||order[2];r=r.filter(x=>R.objectKey(x.object)===num);label+=' по заказу '+num;}
   const mins=r.filter(x=>x.category!=='absence').reduce((n,x)=>n+(R.minutes(x)||0),0),open=r.filter(x=>x.clarify||R.minutes(x)==null).length;
   text=R.ROSTER[master].call+', за '+label+' записано '+Math.round(mins/60*100)/100+' ч.'+(open?' Ещё '+open+' записей требуют уточнения.':'');
   if(/что|покажи|работ[а-яё]*\s+по/iu.test(q)&&r.length)text+='\n'+r.slice(-8).map(x=>x.work_date+' '+(x.object||'')+' '+(x.operation||'операция не определена')+': '+(R.minutes(x)==null?'время не определено':Math.round(R.minutes(x)/60*100)/100+' ч')).join('\n');
  }
  await S.enqueue(c,{key:'chat:'+source.id,kind:'chat',recipient:chat,text,sourceIds:[source.id]});
 }
 async function drain({force=false}={}){
  if(!ready||busy)return;busy=true;try{
   const now=clock(),hour=new Date(now+10800000).getUTCHours();const all=force||env.SOCRATES_LIVE==='on'||(env.SOCRATES_DIGEST==='on'&&hour>=22);
   for(let i=0;i<8;i++){
    const job=await S.claimJob(pool(),clock(),all);if(!job)break;let parsed;const reports=await S.pending(pool(),job.master);
    try{
     if(!reports.length){const gone=await pool().query('DELETE FROM socrates_jobs WHERE master=$1 AND lease_token=$2 AND revision=$3',[job.master,job.lease_token,job.revision]);if(!gone.rowCount)await pool().query('UPDATE socrates_jobs SET lease_token=NULL,lease_until=NULL WHERE master=$1 AND lease_token=$2',[job.master,job.lease_token]);continue;}
     const contextRows=await rows(R.addDays(R.today(clock()),-30),R.today(clock()),job.master);
     const oldOpen=(await pool().query('SELECT w.*,work_date::text FROM work_log w WHERE master=$1 AND clarify=true AND work_date<$2 ORDER BY w.work_date,w.id',[job.master,R.addDays(R.today(clock()),-30)])).rows;
     let catalog=[];try{catalog=await loadDeals();}catch{logger.log('Socrates: CATALOG_UNAVAILABLE');}
     const openReview=(await pool().query('SELECT reason,draft,work_dates FROM socrates_review WHERE master=$1 AND NOT resolved ORDER BY id DESC LIMIT 20',[job.master])).rows;
     const context=JSON.stringify({recent:[...contextRows,...oldOpen].map(r=>({date:S.iso(r.work_date),category:r.category,object:r.object,operation:r.operation,minutes:R.minutes(r),clarify:r.clarify,question:r.clarify_question})),open_review:openReview,open_production_deals:catalog.map(d=>({num:d.num,title:d.title,cat:d.cat}))});
     parsed=await P.parseReports(reports,job.master,{aiFetch,credential:aiCredential(),context,now:clock(),onProgress:async()=>{
      const r=await pool().query('UPDATE socrates_jobs SET lease_until=to_timestamp($1/1000.0) WHERE master=$2 AND revision=$3 AND lease_token=$4 RETURNING master',[clock()+600000,job.master,job.revision,job.lease_token]);if(!r.rows.length)throw new R.SocError('STALE_PARSE',409);
     }});
     await S.commitParsed(pool(),job,reports,parsed,{now:clock(),group:chat,dealCatalog:catalog,questions:env.SOCRATES_ASK==='on'&&!(await away(job.master,R.today(clock()))),onCommit:async(c,result)=>{
      for(const item of parsed.reports)await chatReply(job.master,item,reports,c);
      if(env.SOCRATES_LIVE_ACK==='on'&&result.written)await S.enqueue(c,{key:'ack:'+R.hash([job.master,reports.map(r=>r.id)]),kind:'ack',recipient:chat,text:'Принял изменения по отчёту, '+R.ROSTER[job.master].call+'.'+(result.review_source_ids.length?' Часть записей требует уточнения.':''),sourceIds:reports.map(r=>r.id)});
      if(result.review_source_ids.length)await enqueueDM(c,admin(),'Сократ: часть отчёта '+job.master+' требует проверки. Подтверждённые части сохранены; спорные часы не добавлены.','review-owner:'+R.hash([job.master,result.review_source_ids]));
     }});
    }catch(e){const code=await S.failJob(pool(),job,e,parsed,clock(),{group:chat,adminId:admin(),questions:env.SOCRATES_ASK==='on'&&!(await away(job.master,R.today(clock())))});logger.log('Socrates job:',code);}
   }
  }finally{busy=false;}
 }
 async function flush(){if(!ready||!env.TG_SOCRATES_TOKEN)return;for(let i=0;i<8;i++){
  const out=await S.tx(pool(),async c=>{
   const r=(await c.query("SELECT * FROM socrates_outbox WHERE status='pending' AND due_at<=to_timestamp($1/1000.0) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",[clock()])).rows[0];if(!r)return null;
   if(r.kind==='question'){
    if(env.SOCRATES_ASK!=='on'){await c.query("UPDATE socrates_outbox SET status='cancelled' WHERE id=$1",[r.id]);return {cancelled:true};}
    const sources=(await c.query('SELECT master FROM socrates_sources WHERE report_id=ANY($1::bigint[])',[(r.source_ids||[]).map(String)])).rows;
    const masters=[...new Set(sources.map(x=>x.master).filter(Boolean))];
    if(masters.length&&(await c.query('SELECT 1 FROM socrates_sources WHERE master=$1 AND NOT processed AND NOT review LIMIT 1',[masters[0]])).rows.length){await c.query('UPDATE socrates_outbox SET due_at=to_timestamp($1/1000.0) WHERE id=$2',[clock()+120000,r.id]);return {deferred:true};}
    const open=(await c.query(`SELECT 1 FROM work_log WHERE clarify=true AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(socrates_source_ids,'[]'::jsonb)) x WHERE x::text=ANY($1::text[])) LIMIT 1`,[(r.source_ids||[]).map(String)])).rows;
    const review=(await c.query('SELECT 1 FROM socrates_review WHERE NOT resolved AND source_ids @> $1::jsonb LIMIT 1',[JSON.stringify((r.source_ids||[]).slice(0,1))])).rows;
    if(!masters.length||(!open.length&&!review.length)||await away(masters[0],R.today(clock()),c)){await c.query("UPDATE socrates_outbox SET status='cancelled' WHERE id=$1",[r.id]);return {cancelled:true};}
   }
   if(r.kind==='reminder'){const [,master,d]=r.event_key.match(/^missing:(.+):(\d{4}-\d{2}-\d{2})$/)||[];
    const known=master?(await c.query('SELECT 1 FROM work_log WHERE master=$1 AND work_date=$2 UNION ALL SELECT 1 FROM socrates_sources WHERE master=$1 AND NOT processed AND NOT review UNION ALL SELECT 1 FROM socrates_review WHERE master=$1 AND NOT resolved AND work_dates @> $3::jsonb LIMIT 1',[master,d,JSON.stringify([d])])).rows:[];
    if(!master||env.SOCRATES_ASK!=='on'||known.length||await away(master,d,c)){await c.query("UPDATE socrates_outbox SET status='cancelled' WHERE id=$1",[r.id]);return {cancelled:true};}
   }
   await c.query("UPDATE socrates_outbox SET status='sending' WHERE id=$1",[r.id]);return r;
  });if(!out)break;if(out.cancelled||out.deferred)continue;
  let status='uncertain';try{const r=await fetchImpl('https://api.telegram.org/bot'+env.TG_SOCRATES_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:out.recipient,text:out.text,disable_web_page_preview:true}),signal:AbortSignal.timeout(15000)});const data=await r.json();if(r.ok&&data.ok)status='sent';}catch{}
  await pool().query('UPDATE socrates_outbox SET status=$1,sent_at=now() WHERE id=$2',[status,out.id]);
 }}
 async function once(key,action){return S.tx(pool(),async c=>{await c.query("INSERT INTO socrates_runs(job_key,state) VALUES($1,'pending') ON CONFLICT DO NOTHING",[key]);const run=(await c.query('SELECT * FROM socrates_runs WHERE job_key=$1 FOR UPDATE',[key])).rows[0];if(run.state==='done')return false;await action(c);await c.query("UPDATE socrates_runs SET state='done' WHERE job_key=$1",[key]);return true;});}
 async function scheduled(){if(!ready)return;const d=R.today(clock()),t=new Date(clock()+10800000),h=t.getUTCHours(),dow=t.getUTCDay();
  if(env.SOCRATES_DIGEST==='on'){
   if(h>=22&&R.isWorkingDay(d))for(const [master,info] of Object.entries(R.ROSTER)){
    if(info.starts&&d<info.starts||await away(master,d))continue;
    const pendingSource=(await pool().query('SELECT 1 FROM socrates_sources WHERE master=$1 AND NOT processed AND NOT review LIMIT 1',[master])).rows;if(pendingSource.length)continue;
    await once('missing:'+master+':'+d,async c=>{
     const work=(await c.query('SELECT 1 FROM work_log WHERE master=$1 AND work_date=$2 UNION ALL SELECT 1 FROM socrates_review WHERE master=$1 AND NOT resolved AND (work_dates @> $3::jsonb OR work_dates=\'[]\'::jsonb AND created_at>=to_timestamp($4/1000.0)) LIMIT 1',[master,d,JSON.stringify([d]),Date.parse(d+'T00:00:00+03:00')])).rows;
     if(!work.length&&env.SOCRATES_ASK==='on')await S.enqueue(c,{key:'missing:'+master+':'+d,kind:'reminder',recipient:chat,text:info.call+', не вижу отчёта за '+d+'. Напиши, пожалуйста, что было в работе.'});
    });
   }
   if(h*60+t.getUTCMinutes()>=20*60+5&&R.isWorkingDay(d))await once('guard:'+d,async c=>{const r=await c.query('SELECT 1 FROM tg_reports WHERE created_at >= $1 LIMIT 1',[Date.parse(d+'T00:00:00+03:00')]);if(!r.rows.length)await enqueueDM(c,admin(),'Сегодня в группе не сохранилось сообщений. Нужна проверка приёма Telegram.','guard:'+d);});
   if(h>=22&&env.SOCRATES_ASK==='on')await once('open-questions:'+d,async c=>{const open=(await c.query('SELECT * FROM work_log WHERE clarify=true OR socrates_minutes IS NULL AND day_fraction IS NULL ORDER BY work_date,id')).rows;
    const perMaster={};for(const row of open){if(!R.ROSTER[row.master]||!row.clarify_question||await away(row.master,d,c))continue;(perMaster[row.master]??=[]).push(row);}
    for(const [master,rr] of Object.entries(perMaster)){const selected=rr.slice(0,2);const ids=[...new Set(selected.flatMap(r=>r.socrates_source_ids||[]))];if(!ids.length)continue;await S.enqueue(c,{key:'repeat-question:'+master+':'+d,kind:'question',recipient:chat,text:selected.map(r=>r.clarify_question).join('\n'),sourceIds:ids});}
   });
   if(dow===5&&h>=22)await once('weekly:'+d,async c=>{const from=R.addDays(d,-4),rr=await rows(from,d,undefined,c);const pending=(await c.query('SELECT count(*) n FROM socrates_sources WHERE NOT processed')).rows[0];const unresolved=rr.filter(r=>r.clarify||R.minutes(r)==null).length;
    await enqueueDM(c,admin(),'Сверка '+from+' — '+d+': '+rr.length+' строк учёта; '+pending.n+' исходных сообщений не обработано; '+unresolved+' уточнений. Это контроль покрытия и открытых вопросов, не полная сверка исходных часов.','weekly:'+d);
   });
   if(t.getUTCDate()===1&&h>=10)await once('monthly:'+d,async c=>{const m=R.addDays(d,-1).slice(0,7);const users=(await c.query('SELECT name,user_id FROM socrates_users')).rows;for(const u of users){if(u.name!=='Роман'&&!R.ROSTER[u.name])continue;await enqueueDM(c,Number(u.user_id),'Расчёт за '+m+': '+(u.name==='Роман'?base+'/socrates/salary?month='+m+'&v='+R.viewToken(env.PHOTO_KEY):salaryLink(u.name,m)),'monthly:'+d+':'+u.name);}});
  }
 }
 async function tick(){for(const action of [drain,scheduled,flush])try{await action();}catch(e){logger.log('Socrates tick:',R.redactError(e));}}
 async function start({schedule=true}={}){const p=getPool();if(!p){logger.log('Socrates: DATABASE_NOT_CONFIGURED');return false;}try{await S.requireSchema(p);await S.rates(p);ready=true;
   // A crash after reserving an outbound attempt must never trigger a duplicate.
   await p.query("UPDATE socrates_outbox SET status='uncertain' WHERE status='sending'");
   if(schedule&&(env.SOCRATES_LIVE==='on'||env.SOCRATES_DIGEST==='on')){const timer=setIntervalImpl(()=>tick(),60000);timer?.unref?.();}
   return true;
  }catch(e){logger.log('Socrates start:',R.redactError(e));return false;}}
 return {start,tick,drain,flush,scheduled,auth,rows,reportedRows,salaryLink,away,isReady:()=>ready};
}
module.exports={registerSocrates};
