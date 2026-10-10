import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverCreatedOrder,createCustomerOrderNotificationWorker} from '../customer-order-notifications.js';
const job={order_id:'synthetic-order',claim_token:'synthetic-claim',chat_id:'synthetic-recipient',external_id:'synthetic'};
const quiet={warn(){},error(){}};
const reply=(ok,body)=>({ok,json:async()=>body});
const send=fetchImpl=>deliverCreatedOrder({botToken:'synthetic-token',chatId:job.chat_id,externalId:job.external_id,fetchImpl});
test('only confirmed Telegram success is sent; ambiguous errors never retry',async()=>{
 assert.deepEqual(await send(async(_url,options)=>{assert.ok(options.signal instanceof AbortSignal);return reply(true,{ok:true,result:{message_id:42}})}),{state:'sent',messageId:42});
 for(const response of [reply(false,null),reply(true,{}),reply(false,{ok:false,error_code:403}),reply(false,{ok:false,error_code:429,parameters:{retry_after:45}}),reply(false,{ok:false,error_code:500})]){
  const result=await send(async()=>response);
  assert.equal(result.state,response.ok?'uncertain':(await response.json())?.error_code===403?'rejected':(await response.json())?.error_code?'retry':'uncertain');
 }
 assert.deepEqual(await send(async()=>{throw Error('network timeout')}),{state:'uncertain'});
});
test('polls do not overlap and release the guard after completion',async()=>{
 let release,claims=0,finishes=0;
 const gate=new Promise(resolve=>release=resolve);
 const supabase={rpc(name){return {abortSignal:async()=>name.startsWith('claim')?{data:++claims===1?[job]:[],error:null}:{data:(finishes++,true),error:null}}}};
 const poll=createCustomerOrderNotificationWorker({supabase,botToken:'synthetic',logger:quiet,fetchImpl:async()=>{await gate;return reply(true,{ok:true,result:{message_id:1}})}});
 const first=poll();await Promise.resolve();await Promise.resolve();await poll();assert.equal(claims,1);release();await first;assert.equal(finishes,1);await poll();assert.equal(claims,3);
});
test('database failures are fail closed; acknowledgement failure does not resend',async()=>{
 let sends=0,claimed=false;
 const supabase={rpc(name){return {abortSignal:async()=>name.startsWith('claim')?{data:claimed?[]:(claimed=true,[job]),error:null}:{error:{message:'synthetic failure'}}}}};
 for(let i=0;i<2;i++)await createCustomerOrderNotificationWorker({supabase,botToken:'synthetic',logger:quiet,fetchImpl:async()=>{sends++;return reply(true,{ok:true,result:{message_id:1}})}})();
 assert.equal(sends,1);
 let accesses=0;
 await createCustomerOrderNotificationWorker({supabase:{rpc(){accesses++;throw Error('must skip')}},botToken:'',logger:quiet})();assert.equal(accesses,0);
});
