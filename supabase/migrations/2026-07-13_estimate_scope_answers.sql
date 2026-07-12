-- ============================================================================
-- 2026-07-13 (15c): scope BLANK answers + open questions on the estimate.
-- Author: Claude Code. Idempotent. Applied to prod from the build session.
--
-- Why: Dylan's Quartz/Patio DripJobs templates carry the literal word BLANK.
-- 15b's scope writer correctly leaves unresolvable placeholders verbatim, so a
-- BLANK can ride to a customer. 15c turns each literal BLANK into a question:
--   scope_answers   jsonb  { <stable context-hash key>: "<rep's answer>" }
--                          substituted into the template by pec-estimate-scope
--                          before the model call (an answer survives a
--                          regeneration because the key is a hash of the
--                          placeholder's surrounding text, not its position).
--   scope_questions jsonb  [ { key, label, context, contextLabel } ]
--                          the OPEN (still-BLANK) questions, written by the
--                          scope writer so the estimate page's "Finish the
--                          scope" card can list them without loading templates.
-- ============================================================================

begin;

alter table public.estimates add column if not exists scope_answers   jsonb not null default '{}'::jsonb;
alter table public.estimates add column if not exists scope_questions jsonb not null default '[]'::jsonb;

commit;

-- Verify:
--   select column_name, data_type from information_schema.columns
--     where table_name='estimates' and column_name in ('scope_answers','scope_questions'); -- 2 jsonb rows
