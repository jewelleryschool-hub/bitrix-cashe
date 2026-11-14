'use strict';
const crypto=require('node:crypto');
function authorized(key,env){
 if(typeof key!=='string'||!key)return false;
 const digest=crypto.createHash('sha256').update(key).digest();
 return (env.AI_GATEWAY_KEY_SHA256||'').split(',').map(s=>s.trim())
  .filter(s=>/^[a-f0-9]{64}$/.test(s)).some(s=>crypto.timingSafeEqual(digest,Buffer.from(s,'hex')));
}
function validIds(body){return body && /^\d{1,20}$/.test(body.chatId) && /^\d{1,20}$/.test(body.clientMessageId);}
async function claim(pool,body){
 if(!validIds(body))throw new Error('INVALID_IDS');
 const token=crypto.randomUUID();
 // A single committed statement arbitrates across workers, restarts and server replicas.
 const r=await pool.query(`INSERT INTO romeo_lift_delivery (chat_id,client_message_id,claim_token)
 VALUES ($1,$2,$3) ON CONFLICT (chat_id,client_message_id) DO NOTHING RETURNING claim_token`,
 [BigInt(body.chatId).toString(),BigInt(body.clientMessageId).toString(),token]);
 return r.rows.length?{claimed:true,token:r.rows[0].claim_token}:{claimed:false};
}
async function complete(pool,body){
 if(!validIds(body)||!/^[a-f0-9-]{36}$/.test(body.token||'')||!['accepted','skipped','uncertain'].includes(body.status))throw new Error('INVALID_COMPLETION');
 const r=await pool.query(`UPDATE romeo_lift_delivery SET status=$4,finished_at=now()
 WHERE chat_id=$1 AND client_message_id=$2 AND claim_token=$3 AND status='claimed' RETURNING status`,
 [BigInt(body.chatId).toString(),BigInt(body.clientMessageId).toString(),body.token,body.status]);
 return {recorded:r.rows.length===1};
}
function registerLiftDelivery(app,{getPool,env=process.env}){
 for(const [path,action] of [['claim',claim],['complete',complete]]){
  app.post('/romeo/lift/'+path,async(req,res)=>{
   if(!authorized(req.headers['x-api-key'],env))return res.status(403).json({error:'ACCESS_DENIED'});
   const pool=getPool();
   if(env.LIFT_DURABLE_ENABLED!=='true'||!pool)return res.status(503).json({error:'LIFT_NOT_READY'});
   try{return res.json(await action(pool,req.body));}
   catch(e){return res.status(/^INVALID_/.test(e.message)?400:503).json({error:/^INVALID_/.test(e.message)?'INVALID_REQUEST':'LIFT_STORAGE_UNAVAILABLE'});}
  });
 }
}
module.exports={claim,complete,authorized,registerLiftDelivery};
