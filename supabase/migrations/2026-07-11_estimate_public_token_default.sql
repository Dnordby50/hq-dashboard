-- Estimate public_token: mint at creation (prompt 16, customer-facing estimate).
--
-- WHY: the /e/<token> public estimate page keys on estimates.public_token, but
-- the column was created with NO default and the estimator never writes it, so
-- every live row had NULL. The prompt-16 contract is "the token is minted when
-- the estimate is created but is inert until sent_at" (the public page 404s
-- until sent_at is set), so the fix is a column default, not app code: every
-- writer (offline estimator outbox, dashboard, any future path) gets a token
-- for free and none of them can forget it.
--
-- gen_random_uuid()::text because public_token is TEXT (it predates this
-- build); the ::text cast keeps the column type untouched while the value
-- stays a v4 UUID, which is what tokenFromEvent()'s path-parse fallback and
-- the public page's shape check both expect. The unique index
-- estimates_public_token_key already exists (verified in prod 2026-07-11).
--
-- The backfill covers rows saved before this default (1 row in prod at apply
-- time). Backfilling is safe because a token is INERT until sent_at is set:
-- giving the legacy draft a token does not expose it.

alter table public.estimates
  alter column public_token set default gen_random_uuid()::text;

update public.estimates
  set public_token = gen_random_uuid()::text
  where public_token is null;

-- Footer check (run after applying):
--   select count(*) from estimates where public_token is null;  -- expect 0
--   select column_default from information_schema.columns
--     where table_name='estimates' and column_name='public_token';
--   -- expect (gen_random_uuid())::text
