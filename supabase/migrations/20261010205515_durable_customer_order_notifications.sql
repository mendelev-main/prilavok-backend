-- Service-only durable acknowledgement. No message text, bot token or chat ID stored here.
create table public.customer_notification_settings (
 id boolean primary key default true check(id), enabled_at timestamptz
);
insert into public.customer_notification_settings(id) values(true);
create table public.customer_order_notifications (
 order_id uuid primary key references public.orders(id) on delete cascade,
 state text not null default 'pending' check(state in ('pending','sending','sent','uncertain','retry','rejected')),
 claim_token uuid, attempts integer not null default 0,
 updated_at timestamptz not null default now(), next_attempt_at timestamptz not null default now(),
 telegram_message_id bigint
);
create index customer_order_notifications_due on public.customer_order_notifications(next_attempt_at) where state in ('pending','retry');
alter table public.customer_notification_settings enable row level security;
alter table public.customer_order_notifications enable row level security;
revoke all on public.customer_notification_settings,public.customer_order_notifications from public,anon,authenticated;
grant select,insert,update,delete on public.customer_notification_settings,public.customer_order_notifications to service_role;

create function public.claim_customer_order_notification()
returns table(order_id uuid,claim_token uuid,chat_id text,external_id text)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare cutoff timestamptz; selected_id uuid; recipient text; reference text; token uuid;
begin
 select enabled_at into cutoff from public.customer_notification_settings where id=true;
 if cutoff is null then return; end if;
 -- A crash after claiming could have delivered a message. Expired claims are terminal.
 update public.customer_order_notifications n set state='uncertain',updated_at=now()
 where n.state='sending' and n.updated_at<now()-interval '2 minutes';
 insert into public.customer_order_notifications(order_id)
 select distinct o.id from public.orders o join public.checkout_sessions c on c.order_id=o.id
 where o.status='new' and o.created_at>=cutoff and o.created_at>=now()-interval '15 minutes'
 and c.telegram_user_id is not null
 on conflict do nothing;
 select n.order_id,c.telegram_user_id,o.external_id into selected_id,recipient,reference
 from public.customer_order_notifications n join public.orders o on o.id=n.order_id
 join lateral (select s.telegram_user_id from public.checkout_sessions s where s.order_id=o.id and s.telegram_user_id is not null order by s.updated_at desc,s.id limit 1) c on true
 where n.state in ('pending','retry') and n.next_attempt_at<=now() and n.attempts<3
 and o.status='new' and o.created_at>=now()-interval '15 minutes'
 order by n.next_attempt_at,n.order_id for update of n skip locked limit 1;
 if selected_id is null then return; end if;
 token=gen_random_uuid();
 update public.customer_order_notifications n set state='sending',claim_token=token,attempts=n.attempts+1,updated_at=now() where n.order_id=selected_id;
 return query select selected_id,token,recipient,reference;
end $$;

create function public.finish_customer_order_notification(p_order_id uuid,p_token uuid,p_state text,p_message_id bigint default null,p_retry_seconds integer default 30)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare changed integer;
begin
 if p_state not in ('sent','uncertain','retry','rejected') then raise exception 'INVALID_NOTIFICATION_STATE'; end if;
 update public.customer_order_notifications n set
 state=case when p_state='retry' and n.attempts>=3 then 'rejected' else p_state end,
 telegram_message_id=p_message_id,updated_at=now(),next_attempt_at=now()+make_interval(secs=>greatest(30,least(86400,p_retry_seconds)))
 where n.order_id=p_order_id and n.claim_token=p_token and n.state='sending';
 get diagnostics changed=row_count;
 return changed=1;
end $$;
revoke all on function public.claim_customer_order_notification(),public.finish_customer_order_notification(uuid,uuid,text,bigint,integer) from public,anon,authenticated;
grant execute on function public.claim_customer_order_notification(),public.finish_customer_order_notification(uuid,uuid,text,bigint,integer) to service_role;
