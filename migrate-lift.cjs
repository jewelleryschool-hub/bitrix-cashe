'use strict';
// Explicit Railway pre-deploy step. Does not import/start the app or any scheduler.
const {Pool}=require('pg');
const fs=require('node:fs');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
(async()=>{
 if(!process.env.DATABASE_URL)throw Error('DATABASE_UNAVAILABLE');
 await pool.query(fs.readFileSync(__dirname+'/lift-delivery.sql','utf8'));
 console.log('Lift delivery schema ready');
})().catch(()=>{console.error('Lift schema migration failed; private details omitted');process.exitCode=1;})
 .finally(()=>pool.end());
