-- Server-side checkout drafts used while the customer verifies their phone in Telegram.
-- Drafts are private and accessed only by the Railway backend with the service role key.

create table if not exists public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  phone text not null,
  status text not null default 'PENDING' check (status in ('PENDING','VERIFIED','ORDER_CREATED','EXPIRED')),
  order_payload jsonb not null,
  verification_token_hash text,
  order_id uuid references public.orders(id) on delete set null,
  tracking_token text,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists checkout_sessions_expires_at_idx
  on public.checkout_sessions (expires_at);

create index if not exists checkout_sessions_phone_idx
  on public.checkout_sessions (phone);

alter table public.checkout_sessions enable row level security;

-- Intentionally no anon policies.
