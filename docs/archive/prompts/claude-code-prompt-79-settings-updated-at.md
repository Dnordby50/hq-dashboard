# Prompt 79: `settings.updated_at`

Small, isolated, schema-only. Ships BEFORE the Settings redesign (prompts 80 and 81) so the cleanup that follows is measurable instead of guessed at. Three migrations were stranded in the last two weeks; this one is deliberately kept to a single file with nothing else riding on it.

**Scope: one migration file, one SCHEMA.md update, one log entry. No `index.html` changes. No Netlify function changes. No deploy.**

---

## Why

The `settings` table is `(id uuid, key text, value text)`. There is no timestamp of any kind. Today the only way to tell a live knob from a dead one is that a row does not exist yet, because rows are created lazily on first save. That signal is real (an audit on 2026-08-08 found 16 of the 78 UI-exposed knobs have no row at all, including the entire financing block and the entire labor/bonus costing block from prompt 56) but it burns permanently the first time anyone saves. After prompt 81 re-homes the knobs, there will be no way to check the result.

One nullable column plus a trigger fixes this for good.

## The one rule that matters

**Do NOT backfill `updated_at` on the existing rows.** Not with `now()`, not with a guess, not with `created_at` (there isn't one). A `NULL` means "has not been written since 2026-08-16" and that is exactly the signal being preserved. Backfilling with `now()` would assert that all 97 rows were touched today, which is false and destroys the entire point of the migration. This is the single most likely way to get this prompt wrong.

For the same reason the column is nullable with **no** column default. New rows get their value from the trigger, not from a default, so there is one code path and it is the trigger.

## Migration file

Create `supabase/migrations/2026-08-16_prompt79_settings_updated_at.sql` (confirm the next date in sequence; the last file on disk is `2026-08-15_prompt76_line_editor_settings.sql`).

Per standing rule 13 it opens with an `@artifacts` header. Two artifacts: the column, and the one settings seed prompt 80 needs (see below). The trigger and its function are not expressible in the four artifact kinds and are simply not declared; do not invent a kind for them and do not add a `none:` line alongside real artifacts.

```sql
-- @artifacts
--   column: public.settings.updated_at
--   setting: settings_rail_breakpoint_px
-- @end
--
-- Prompt 79: give the settings table a write timestamp, and seed the one
-- tunable prompt 80's Settings rail needs (rule 12).
--
-- updated_at is NULLABLE with NO column default and is NOT backfilled, on
-- purpose. A NULL row is one that has not been written since this migration
-- ran. That is the audit signal; backfilling now() would erase it. The
-- trigger is the only writer.

alter table public.settings
  add column if not exists updated_at timestamptz;

create or replace function public.settings_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists settings_touch_updated_at on public.settings;

create trigger settings_touch_updated_at
  before insert or update on public.settings
  for each row
  execute function public.settings_touch_updated_at();

-- settings_rail_breakpoint_px: below this viewport width the Settings rail
-- (prompt 80) collapses to a single dropdown instead of a vertical list.
-- Mirrors the estimator_line_sheet_breakpoint_px pattern from prompt 76.
-- Insert-only; never clobber a value Dylan has already tuned.
insert into public.settings (key, value)
values ('settings_rail_breakpoint_px', '900')
on conflict (key) do nothing;
```

### Things to check before you write it

- `settings` already has `UNIQUE (key)` (constraint `settings_key_key`) in addition to the `id` primary key, so the `on conflict (key)` above is valid and the app's existing `upsert({key, value}, {onConflict: 'key'})` calls keep working unchanged.
- RLS is enabled on `settings`. A `BEFORE` row trigger runs regardless of RLS, so no policy change is needed. Do not add one.
- Verify `updated_at` does not already exist before assuming; the live schema is the source of truth, not SCHEMA.md.

## Verification

Run all three after applying:

```sql
-- 1. Column exists, nullable, no default.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='settings' and column_name='updated_at';
-- expect: timestamptz, YES, null

-- 2. Nothing was backfilled. Every pre-existing row is still NULL, and the
--    only non-NULL row is the seed this migration just inserted.
select count(*) filter (where updated_at is null)  as untouched,
       count(*) filter (where updated_at is not null) as touched,
       count(*) as total
from public.settings;
-- expect: untouched = the pre-migration row count (97 as of 2026-08-08),
--         touched = 1 (settings_rail_breakpoint_px), total = 98.
-- If `touched` is anything other than 1, the backfill rule was broken.
--   Fix by setting the wrongly-stamped rows back to NULL before continuing.

-- 3. The trigger fires on update.
update public.settings set value = value where key = 'settings_rail_breakpoint_px';
select key, value, updated_at from public.settings where key='settings_rail_breakpoint_px';
-- expect: updated_at moved to now(). (Safe: the value is written to itself.)
```

## SCHEMA.md

Update the `### settings` block at line 2049:

- Add the `updated_at | timestamptz | yes | (none, set by trigger)` row to the column table.
- Note the trigger `settings_touch_updated_at` and, in one sentence, the no-backfill rule and what NULL means, so a future session does not "helpfully" backfill it.
- Add the `settings_rail_breakpoint_px` seed to the "Keys added" notes in the existing style.
- **Flag the drift:** the block currently reads `rows: 95`. A live count on 2026-08-08 returned **97** before this migration. Correct the number and note the discrepancy in the log entry per the standing rule that the live schema wins.

## Explicit non-goals

Do not add `created_at`. Do not add a `description` or `category` column in anticipation of prompt 81; the grouping lives in the front-end manifest, not the table. Do not touch `index.html`. Do not build any UI that displays `updated_at` yet. Do not refactor the five duplicated local `saveSetting` helpers (lines 18896, 19079, 19324, 20049, 37680) even though they are all writers to this table; that is noted for prompt 80 and is not in scope here.

## Log entry

Append to the top of PROJECT-LOG.md. `By: Claude Code`. Record: the migration filename, that `updated_at` was deliberately left NULL on all pre-existing rows and why, the verification counts you actually got, and the SCHEMA.md row-count drift (95 documented vs 97 live). If the trigger or the seed failed, log that rather than skipping the entry.

## Migration manifest

Adding a migration file means `netlify/functions/_migration-manifest.json` is stale. Regenerate it with `node scripts/build-migration-manifest.mjs` and commit the result, same as commit `0dd66ab`. Skipping this is what makes the drift checker report a false negative later.

## Commit

`git add` the migration file, `netlify/functions/_migration-manifest.json`, SCHEMA.md and PROJECT-LOG.md specifically (never `git add .`), then commit in the repo's usual `<area>: <description>` style:

```
git commit -m "settings: updated_at column + touch trigger (no backfill, NULL means untouched since 2026-08-16), rail breakpoint seed"
```

Do not push.
