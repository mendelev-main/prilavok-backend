import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createOwnerService,OWNER_TTL} from '../owner-auth.js';
import {PGlite} from '@electric-sql/pglite';
function fixture(){
 let time=10000000,revision=0,document={owner:null,sessions:{},audit:[]};
 const config={enabled:true,deviceId:'device',bootstrapTelegramId:'123',botSecret:'s'.repeat(43),botUsername:'test_owner_bot'};
 const store={read:async()=>({revision,document:structuredClone(document)}),cas:async(r,d)=>{if(r!==revision)return false;document=d;revision++;return true;}};
 const service=createOwnerService({store,config,now:()=>time});
 const input=(id='s1',kind='bind')=>({id,kind,employeeId:'employee',name:'Owner',installationId:'ipad',secret:'x'.repeat(43),token:(id+'t'.repeat(43)).slice(0,43)});
 const approve=i=>service.bot({token:i.token,telegramId:'123',action:'approve',name:'Owner TG'});
 return {service,config,store,input,approve,advance:ms=>time+=ms,state:()=>document};
}
test('bind requires approved trusted Telegram identity and native proof, creates one owner',async()=>{
 const f=fixture(),i=f.input();await f.service.start(i);
 await assert.rejects(f.service.finish(i),/подтвердите/);
 await assert.rejects(f.service.bot({token:i.token,telegramId:'456',action:'approve'}),/только владельцу/);
 await f.approve(i);await assert.rejects(f.service.finish({...i,secret:'wrong'}),/не найден/);
 const result=await f.service.finish(i);assert.equal(result.owner.epoch,1);
 assert.deepEqual(await f.service.finish(i),result);
 await assert.rejects(f.service.start({...f.input('s2'),employeeId:'other'}),/уже зарегистрирован/);
 assert.ok(!JSON.stringify(f.state()).includes(i.secret));assert.ok(!JSON.stringify(f.state()).includes(i.token));
});
test('recovery increments epoch, invalidates replay and never changes owner or installation',async()=>{
 const f=fixture(),i=f.input();await f.service.start(i);await f.approve(i);await f.service.finish(i);
 const recovery=f.input('s2','recover');await f.service.start(recovery);await f.approve(recovery);
 const result=await f.service.finish(recovery);assert.equal(result.owner.epoch,2);
 await assert.rejects(f.service.finish(i),/заменено/);
 await assert.rejects(f.service.start({...f.input('s3','recover'),installationId:'stolen-ipad'}),/не найден/);
});
test('expired, denied, cancelled tokens cannot finish',async()=>{
 for(const mode of ['expire','deny','cancel']){const f=fixture(),i=f.input();await f.service.start(i);await f.approve(i);
 if(mode==='expire')f.advance(OWNER_TTL+1);else if(mode==='deny')await f.service.bot({token:i.token,telegramId:'123',action:'deny'});else await f.service.cancel(i);
 await assert.rejects(f.service.finish(i));}
});
test('rate limit survives expired-session pruning and blocked feature fails closed',async()=>{
 const f=fixture();for(let n=0;n<6;n++)await f.service.start(f.input('s'+n));f.advance(OWNER_TTL+1);
 await assert.rejects(f.service.start(f.input('s7')),e=>e.status===429);
 f.advance(3600000);await f.service.start(f.input('s8'));f.config.enabled=false;
 await assert.rejects(f.service.start(f.input('s9')),e=>e.status===503);
});
test('same installation can retry an interrupted first Keychain install after server retention',async()=>{
 const f=fixture(),i=f.input();await f.service.start(i);await f.approve(i);await f.service.finish(i);f.advance(86400001);
 assert.equal((await f.service.start(i)).kind,'recover');await f.approve(i);assert.equal((await f.service.finish(i)).owner.epoch,2);
});
test('concurrent finish returns same owner and concurrent distinct bindings cannot replace it',async()=>{
 const f=fixture(),i=f.input();await f.service.start(i);await f.approve(i);
 const result=await Promise.all([f.service.finish(i),f.service.finish(i)]);assert.deepEqual(result[0],result[1]);assert.equal(f.state().audit.filter(a=>a.action==='bind').length,1);
});
test('real PostgreSQL migration: anon and authenticated denied, service CAS atomic, reapply preserves owner',async()=>{
 const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 const filename=readdirSync(new URL('../supabase/migrations/',import.meta.url)).find(f=>f.endsWith('_owner_access.sql'));
 const migration=readFileSync(new URL('../supabase/migrations/'+filename,import.meta.url),'utf8');await db.exec(migration);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select * from public.owner_auth_state'),/permission denied/);await assert.rejects(db.query("select public.owner_auth_compare_swap(0,'{}')"),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');
 assert.equal((await db.query(`select public.owner_auth_compare_swap(0,'{"owner":{"id":"one"}}') as ok`)).rows[0].ok,true);
 assert.equal((await db.query(`select public.owner_auth_compare_swap(0,'{}') as ok`)).rows[0].ok,false);
 await db.exec('reset role');await db.exec(migration);const state=(await db.query('select revision, document from public.owner_auth_state')).rows[0];assert.equal(state.revision,1);assert.equal(state.document.owner.id,'one');await db.close();
});

import {mountOwnerRoutes} from '../owner-auth.js';
function routeFixture(){
 const f=fixture(),routes=new Map(),sent=[];
 f.config.botToken='test-token';f.config.reportChatId='fixed-group';
 const db={from:table=>{const conditions={};return{select(){return this;},eq(k,v){conditions[k]=v;return this;},async maybeSingle(){return{data:conditions.id==='device'&&conditions.device_key==='device-key-123456789'&&conditions.is_active===true?{id:'device'}:null};},async single(){return{data:await f.store.read()};}};},rpc:async(name,input)=>({data:await f.store.cas(input.expected_revision,input.next_document)})};
 mountOwnerRoutes({post:(path,handler)=>routes.set(path,handler)},{db,config:f.config,fetchImpl:async(url,options)=>{sent.push({url,options});return{ok:true,json:async()=>({ok:true})};}});
 async function post(path,body={},headers={}){let status=200,result;const response={setHeader(){},status(s){status=s;return this;},json(d){result=d;}};await routes.get('/api/owner/'+path)({body,header:name=>headers[name]},response);return{status,result};}
 return{...f,post,sent};
}
test('HTTP routes reject untrusted device, missing bot secret, forged Telegram approval',async()=>{
 const f=routeFixture(),i=f.input();assert.equal((await f.post('start',i)).status,401);
 assert.equal((await f.post('start',i,{'x-device-key':'invalid-device-key'})).status,403);
 const headers={'x-device-key':'device-key-123456789'};assert.equal((await f.post('start',i,headers)).status,200);
 assert.equal((await f.post('bot',{token:i.token,telegramId:'123',action:'approve'})).status,403);
 assert.equal((await f.post('bot',{token:i.token,telegramId:'123',action:'approve'},{'x-owner-bot-secret':'я'.repeat(43)})).status,403);
 assert.equal((await f.post('finish',{...i,telegramId:'123',approved:true},headers)).status,409);
 assert.equal((await f.post('bot',{token:i.token,telegramId:'123',action:'approve'},{'x-owner-bot-secret':f.config.botSecret})).status,200);
 assert.equal((await f.post('finish',i,headers)).status,200);
});
test('report relay authenticates device, fixes recipient on server and limits bursts',async()=>{
 const f=routeFixture(),headers={'x-device-key':'device-key-123456789'};
 assert.equal((await f.post('report',{text:'Test'})).status,401);
 for(let n=0;n<12;n++)assert.equal((await f.post('report',{text:'Test',chat_id:'attacker'},headers)).status,200);
 assert.equal(JSON.parse(f.sent[0].options.body).chat_id,'fixed-group');assert.equal((await f.post('report',{text:'Test'},headers)).status,429);
 assert.equal(f.sent.length,12);
});
