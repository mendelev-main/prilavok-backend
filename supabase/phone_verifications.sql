create table if not exists public.phone_verifications (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  phone text not null,
  status text not null default 'PENDING' check (status in ('PENDING','VERIFIED','CONSUMED','EXPIRED')),
  expires_at timestamptz not null,
  verified_at timestamptz,
  consumed_at timestamptz,
  telegram_user_id text,
  return_url text,
  created_at timestamptz not null default now()
);

create index if not exists phone_verifications_expires_at_idx
  on public.phone_verifications (expires_at);

create index if not exists phone_verifications_phone_idx
  on public.phone_verifications (phone);

alter table public.phone_verifications enable row level security;

-- No anon policies: verification records are server-only and are accessed
-- by the Railway backend through SUPABASE_SERVICE_ROLE_KEY.
