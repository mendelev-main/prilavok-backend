import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync(new URL('../supabase/migrations/20261010205515_durable_customer_order_notifications.sql',import.meta.url),'utf8');
test('durable claims survive restart, stale leases and changed order timestamps without duplicates',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create table public.orders(id uuid primary key default gen_random_uuid(),status text default 'new',external_id text default 'synthetic',created_at timestamptz default now(),updated_at timestamptz default now());
  create table public.checkout_sessions(id uuid primary key default gen_random_uuid(),order_id uuid references public.orders(id),telegram_user_id text,updated_at timestamptz default now());`);
  await db.exec(migration);
  const add=async()=>{const id=(await db.query('insert into orders default values returning id')).rows[0].id;await db.query("insert into checkout_sessions(order_id,telegram_user_id) values($1,'synthetic')",[id]);return id;};
  const claim=async()=> (await db.query('select * from claim_customer_order_notification()')).rows;
  const finish=async(j,state,token=j.claim_token)=>(await db.query('select finish_customer_order_notification($1,$2,$3) done',[j.order_id,token,state])).rows[0].done;
  const legacy=await add();assert.equal((await claim()).length,0);
  await db.exec('update customer_notification_settings set enabled_at=now();');
  await db.query("update orders set created_at=now()-interval '1 minute' where id=$1",[legacy]);
  const id=await add(),j=(await claim())[0];assert.equal(j.order_id,id);assert.equal((await claim()).length,0);
  assert.equal(await finish(j,'sent','00000000-0000-0000-0000-000000000000'),false);
  assert.equal(await finish(j,'sent'),true);assert.equal(await finish(j,'retry'),false);
  await db.query('update orders set updated_at=now() where id=$1',[id]);assert.equal((await claim()).length,0);
  await add();const stale=(await claim())[0];await db.query("update customer_order_notifications set updated_at=now()-interval '3 minutes' where order_id=$1",[stale.order_id]);assert.equal((await claim()).length,0);assert.equal((await db.query('select state from customer_order_notifications where order_id=$1',[stale.order_id])).rows[0].state,'uncertain');assert.equal(await finish(stale,'sent'),false);
  await add();let retry=(await claim())[0];for(let attempt=0;attempt<3;attempt++){assert.equal(await finish(retry,'retry'),true);assert.equal((await claim()).length,0);await db.query("update customer_order_notifications set next_attempt_at=now()-interval '1 minute' where order_id=$1",[retry.order_id]);if(attempt<2)retry=(await claim())[0];}
  assert.equal((await claim()).length,0);assert.equal((await db.query('select state from customer_order_notifications where order_id=$1',[retry.order_id])).rows[0].state,'rejected');
  assert.equal((await db.query("select has_function_privilege('anon','claim_customer_order_notification()','EXECUTE') allowed")).rows[0].allowed,false);
  await db.query('delete from checkout_sessions where order_id=$1',[id]);await db.query('delete from orders where id=$1',[id]);assert.equal((await db.query('select count(*)::int n from customer_order_notifications where order_id=$1',[id])).rows[0].n,0);
 } finally {await db.close();}
});
