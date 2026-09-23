-- @artifacts public.pec_estimate_first_send_confirmations
-- Explicit owner testimony for legacy history, never a fabricated delivery receipt.
create table public.pec_estimate_first_send_confirmations (
  estimate_id uuid primary key references public.estimates(id),
  brand text not null check (brand in ('PEC','FTP')),
  first_sent_on date not null,
  confirmed_by text not null check (length(trim(confirmed_by)) > 0),
  evidence_ref text not null check (length(trim(evidence_ref)) > 0),
  confirmed_at timestamptz not null default now()
);
alter table public.pec_estimate_first_send_confirmations enable row level security;
revoke all on public.pec_estimate_first_send_confirmations from public, anon, authenticated, service_role;
grant select, insert on public.pec_estimate_first_send_confirmations to service_role;
comment on table public.pec_estimate_first_send_confirmations is
  'Immutable owner-confirmed historical first-send calendar dates. Owner reporting reads through its existing authorized server endpoint. No delivery channel or timestamp is inferred.';
