'use strict';
const crypto=require('node:crypto');
const {authorized}=require('./lift-delivery.cjs');
function ids(b){if(!b||!/^\d{1,20}$/.test(b.chatId)||!/^\d{1,20}$/.test(b.clientMessageId))throw Error('INVALID_REQUEST');return [BigInt(b.chatId).toString(),BigInt(b.clientMessageId).toString()];}
async function claim(pool,b){
 const pair=ids(b),received=Date.parse(b.receivedAt);
 if(!Number.isFinite(received))throw Error('INVALID_REQUEST');
 const token=crypto.randomUUID();
 const r=await pool.query(`INSERT INTO romeo_reply_delivery(chat_id,client_message_id,token,status,received_at,lease_until)
 SELECT $1,$2,$3,'processing',$4::timestamptz,now()+interval '10 minutes'
 WHERE $4::timestamptz > now()-interval '23 hours 30 minutes' AND $4::timestamptz <= now()+interval '1 minute'
 ON CONFLICT(chat_id,client_message_id) DO UPDATE SET token=$3,status='processing',attempts=romeo_reply_delivery.attempts+1,lease_until=now()+interval '10 minutes',updated_at=now()
 WHERE romeo_reply_delivery.status IN ('queued','processing') AND romeo_reply_delivery.lease_until<=now()
 AND romeo_reply_delivery.attempts<3 AND romeo_reply_delivery.received_at>now()-interval '23 hours 30 minutes'
 RETURNING token,attempts`,[...pair,token,new Date(received).toISOString()]);
 return r.rows.length?{claimed:true,token:r.rows[0].token,attempts:r.rows[0].attempts}:{claimed:false};
}
async function status(pool,b){
 const r=await pool.query(`SELECT status,attempts,dispatches,next_dispatch_at<=now() AS dispatch_ready,lease_until<=now() AS expired,received_at>now()-interval '23 hours 30 minutes' AS in_window FROM romeo_reply_delivery WHERE chat_id=$1 AND client_message_id=$2`,ids(b));
 const v=r.rows[0];if(!v)return{state:'ready'};
 if(v.status==='queued')return{state:!v.in_window?'review_window':!v.dispatch_ready?'processing':v.dispatches>=3?'review_ingress_limit':'ready'};
 return{state:v.status==='processing'?(v.attempts>=3&&v.expired?'review_attempt_limit':v.dispatches>=3&&v.expired&&v.dispatch_ready?'review_ingress_limit':!v.in_window?'review_window':v.expired?'ready':'processing'):v.status==='sending'?'review_delivery_unknown':v.status};
}
async function transition(pool,b,action){
 const pair=ids(b);if(!/^[a-f0-9-]{36}$/.test(b.token||''))throw Error('INVALID_REQUEST');
 const before=action==='accepted'?'sending':'processing';
 const r=await pool.query(`UPDATE romeo_reply_delivery SET status=$4,updated_at=now()
 WHERE chat_id=$1 AND client_message_id=$2 AND token=$3 AND status=$5
 ${action==='sending'?"AND lease_until>now() AND received_at>now()-interval '23 hours 30 minutes'":''}
 RETURNING status`,[...pair,b.token,action,before]);
 return{recorded:r.rows.length===1};
}
async function offer(pool,b){
 const pair=ids(b),received=Date.parse(b.receivedAt);if(!Number.isFinite(received))throw Error('INVALID_REQUEST');
 const r=await pool.query(`INSERT INTO romeo_reply_delivery(chat_id,client_message_id,token,status,attempts,dispatches,received_at,lease_until,next_dispatch_at)
 SELECT $1,$2,$3,'queued',0,1,$4::timestamptz,now(),now()+interval '15 minutes'
 WHERE $4::timestamptz>now()-interval '23 hours 30 minutes' AND $4::timestamptz<=now()+interval '1 minute'
 ON CONFLICT(chat_id,client_message_id) DO UPDATE SET dispatches=romeo_reply_delivery.dispatches+1,next_dispatch_at=now()+interval '15 minutes',updated_at=now()
 WHERE romeo_reply_delivery.status IN ('queued','processing') AND romeo_reply_delivery.lease_until<=now()
 AND romeo_reply_delivery.next_dispatch_at<=now() AND romeo_reply_delivery.dispatches<3 AND romeo_reply_delivery.attempts<3
 AND romeo_reply_delivery.received_at>now()-interval '23 hours 30 minutes'
 RETURNING dispatches`,[...pair,crypto.randomUUID(),new Date(received).toISOString()]);
 return{offered:r.rows.length===1};
}
const reasons=new Set(['review_partial_history','review_worktime_policy','review_window','review_invalid_time','review_invalid_ids','review_attempt_limit','review_ingress_limit','review_delivery_unknown','review_read_or_dispatch_failed']);
async function review(pool,b){
 if(!b||!reasons.has(b.reason))throw Error('INVALID_REQUEST');
 const key=b.chatId&&/^\d{1,20}$/.test(b.chatId)?'chat:'+b.chatId+':'+(/^\d{1,20}$/.test(b.clientMessageId||'')?b.clientMessageId:'0'):b.sessionId&&/^\d{1,20}$/.test(b.sessionId)?'session:'+b.sessionId:null;
 if(!key)throw Error('INVALID_REQUEST');
 await pool.query('INSERT INTO romeo_reply_attention(item_key,reason) VALUES($1,$2) ON CONFLICT(item_key) DO UPDATE SET reason=$2,last_seen_at=now(),resolved_at=NULL',[key,b.reason]);return{recorded:true};
}
async function attention(pool,b={}){
 const offset=b.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw Error('INVALID_REQUEST');
 const items=(await pool.query('SELECT item_key,reason,last_seen_at FROM romeo_reply_attention WHERE resolved_at IS NULL ORDER BY last_seen_at DESC,item_key LIMIT 100 OFFSET $1',[offset])).rows;
 return{items,nextOffset:items.length===100?offset+100:null};
}
async function resolve(pool,b){
 if(!b||!/^\d{1,20}$/.test(b.chatId))throw Error('INVALID_REQUEST');
 await pool.query("UPDATE romeo_reply_attention SET resolved_at=now() WHERE item_key LIKE $1",['chat:'+b.chatId+':%']);return{recorded:true};
}
function registerReplyDelivery(app,{getPool,env=process.env}){
 const actions={claim,status,offer,review,attention,resolve,begin:(p,b)=>transition(p,b,'sending'),accepted:(p,b)=>transition(p,b,'accepted'),suppress:(p,b)=>transition(p,b,'suppressed')};
 for(const [name,fn]of Object.entries(actions))app.post('/romeo/reply/'+name,async(req,res)=>{
  if(!authorized(req.headers['x-api-key'],env))return res.status(403).json({error:'ACCESS_DENIED'});
  const pool=getPool();if(env.ROMEO_REPLY_DURABLE_ENABLED!=='true'||!pool)return res.status(503).json({error:'REPLY_NOT_READY'});
  try{return res.json(await fn(pool,req.body));}catch(e){return res.status(e.message==='INVALID_REQUEST'?400:503).json({error:e.message==='INVALID_REQUEST'?'INVALID_REQUEST':'REPLY_STORAGE_UNAVAILABLE'});}
 });
}
module.exports={claim,status,offer,review,attention,resolve,transition,registerReplyDelivery};
