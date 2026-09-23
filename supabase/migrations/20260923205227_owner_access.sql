begin;
create table if not exists public.owner_auth_state (
  id boolean primary key default true check (id),
  revision bigint not null default 0 check (revision >= 0),
  document jsonb not null default '{"owner":null,"sessions":{},"audit":[],"starts":[]}'::jsonb
    check (jsonb_typeof(document) = 'object')
);
alter table public.owner_auth_state enable row level security;
revoke all on public.owner_auth_state from public, anon, authenticated;
grant select, update on public.owner_auth_state to service_role;
insert into public.owner_auth_state (id) values (true) on conflict (id) do nothing;
create or replace function public.owner_auth_compare_swap(expected_revision bigint, next_document jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.owner_auth_state set document = next_document, revision = revision + 1
    where id = true and revision = expected_revision;
  return found;
end;
$$;
revoke all on function public.owner_auth_compare_swap(bigint,jsonb) from public, anon, authenticated;
grant execute on function public.owner_auth_compare_swap(bigint,jsonb) to service_role;
commit;
