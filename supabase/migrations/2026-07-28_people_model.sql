-- @artifacts
--   table: public.people
--   column: public.pec_sales_team_members.name_aliases
--   index: uq_people_admin_user_id
--   index: uq_people_sales_team_member_id
--   index: uq_people_crew_member_id
--   setting: people_mirror_enabled
--   setting: birthday_reminder_enabled
--   setting: birthday_reminder_lead_days
--   none: triggers, sync/RPC functions, and RLS policies are not expressible in the four artifact kinds
-- @end
-- ============================================================================
-- 2026-07-28 (prompt 54): the People model. ONE person = one record, across
-- logins (admin_users), sales reps (pec_sales_team_members), and crew members
-- (pec_prod_crew_members). Author: Claude Code. Applied by Cowork (rule 8).
--
-- WHAT THIS IS: public.people becomes the source of truth for a person's
-- IDENTITY (name, contact, birthday, active). The three legacy tables remain
-- live and are kept in sync FROM people by triggers, so all existing readers
-- (RLS helpers, commission, bonus math, BusyBusy attribution, schedule
-- capacity) keep reading exactly what they read today. NOTHING IS DROPPED.
--
-- ROLE MODEL (locked decision 2, choice justified here): a person's roles are
-- the three nullable pointer columns themselves. admin_user_id set = login,
-- sales_team_member_id set = sales rep, crew_member_id set = crew member.
-- The pointer IS the role flag AND the identity map, so a role flag can never
-- disagree with its legacy row. No person_roles child table: there are exactly
-- three fixed roles and each needs a pointer anyway.
--
-- WHAT STAYS ON THE LEGACY TABLES (deliberate, the consistent half of the
-- prompt's either/or): hourly_wage, commission_pct, exclude_from_commission,
-- crew_id, Google calendar fields, permission booleans. Their readers are
-- unmoved; the People screen edits them ON the legacy tables. people carries
-- identity only.
--
-- LANDMINE 1 (commission attributed by free-text lowercased NAME against
-- pec_job_ar.salesperson): renames are made SAFE, not blocked. name_aliases
-- on pec_sales_team_members records every former name, captured by a trigger
-- ON THAT TABLE so every rename path (People screen, legacy Sales Team card,
-- Supabase Studio) is covered. renderCommission's pctByName / excluded-name
-- maps read the aliases, so historical pec_job_ar rows keep their rate and
-- their exclusion after a rename. The alias trigger ignores the mirror
-- switch on purpose: it is a safety net, not part of the mirror.
--
-- THE MIRROR (Part C) is TWO-WAY, one direction required + one defensive:
--   forward (people -> legacy): full_name / active write through to the
--     pointed-at legacy rows. Only the fields that CHANGED propagate, so a
--     per-role active toggled from a legacy card is never clobbered by an
--     unrelated people edit.
--   reverse-adopt (legacy -> people): an INSERT into a legacy table by an
--     existing writer (pec-create-staff.cjs, the "+ Add team member" button)
--     auto-creates a people row pointing at it. Without this, every existing
--     add path would silently reintroduce personless scatter on day one.
--   reverse-rename (legacy -> people): a rename on a legacy card follows to
--     people (and from there forward to sibling role rows), so the fallback
--     surfaces cannot diverge the model.
-- Loop prevention: reverse triggers carry WHEN (pg_trigger_depth() = 0), so
-- they fire only on direct DML, never on writes made by the forward trigger.
-- The forward trigger has NO depth guard so a reverse-initiated people update
-- still propagates to sibling role rows; the chain terminates at depth 2.
--
-- SWITCH-OFF (rollback without a deploy): settings key people_mirror_enabled.
-- Set it to 'false' (Settings > General, or SQL) and every sync trigger is a
-- no-op; the app runs on the legacy tables exactly as before this migration.
-- The transaction-local GUC pec.people_sync = 'off' is the surgical variant
-- the RPCs below use to write without echo.
--
-- ID STABILITY (non-negotiables): pec_prod_crew_members.id (BusyBusy hour
-- attribution + days off) and admin_users.id (user_permissions FK) are never
-- rewritten; the backfill only READS the legacy tables. The Verify block
-- asserts wage and commission sums are byte-identical pre/post.
--
-- BIRTHDAYS (Part E): month/day only, both-or-neither, NO YEAR COLUMN
-- ANYWHERE. Enforcement of "required on new adds" is a UI concern (rows
-- adopted from legacy inserts legitimately arrive birthday-less and feed the
-- backfill nag), so the columns stay nullable.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) Pre-capture: the sums that must survive byte-for-byte (Verify block
--    compares at the bottom of this transaction).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _pec_people_pre ON COMMIT DROP AS
SELECT
  (SELECT coalesce(sum(hourly_wage), 0)     FROM public.pec_prod_crew_members)                         AS wage_sum,
  (SELECT count(*)                          FROM public.pec_prod_crew_members WHERE hourly_wage IS NOT NULL) AS wage_rows,
  (SELECT coalesce(sum(commission_pct), 0)  FROM public.pec_sales_team_members)                        AS pct_sum,
  (SELECT count(*)                          FROM public.admin_users)                                   AS n_admin,
  (SELECT count(*)                          FROM public.pec_sales_team_members)                        AS n_sales,
  (SELECT count(*)                          FROM public.pec_prod_crew_members)                         AS n_crew,
  (SELECT count(*) FROM public.pec_sales_team_members s
     JOIN public.admin_users a ON a.auth_user_id = s.auth_user_id
    WHERE s.auth_user_id IS NOT NULL)                                                                  AS n_automerge;

-- ---------------------------------------------------------------------------
-- 1) The people table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.people (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name             text NOT NULL,
  display_name          text,                    -- preferred name; blank = full_name
  email                 text,                    -- nullable: a crew member may have none
  phone                 text,
  -- Month/day only. No year, ever (locked decision 5).
  birth_month           smallint CHECK (birth_month BETWEEN 1 AND 12),
  birth_day             smallint CHECK (birth_day BETWEEN 1 AND 31),
  CONSTRAINT people_birthday_both_or_neither
    CHECK ((birth_month IS NULL) = (birth_day IS NULL)),
  active                boolean NOT NULL DEFAULT true,
  -- Role pointers = the identity map = the role flags (see header).
  -- ON DELETE SET NULL: deleting a legacy row (e.g. staff delete in Settings >
  -- Users) clears the role off the person instead of erroring or orphaning.
  admin_user_id         uuid REFERENCES public.admin_users(id)            ON DELETE SET NULL,
  sales_team_member_id  uuid REFERENCES public.pec_sales_team_members(id) ON DELETE SET NULL,
  crew_member_id        uuid REFERENCES public.pec_prod_crew_members(id)  ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One legacy row belongs to at most one person. Partial (NULLs are the
-- unassigned majority), same pattern as uq_pec_sales_team_members_auth_user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_people_admin_user_id
  ON public.people (admin_user_id) WHERE admin_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_people_sales_team_member_id
  ON public.people (sales_team_member_id) WHERE sales_team_member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_people_crew_member_id
  ON public.people (crew_member_id) WHERE crew_member_id IS NOT NULL;

-- RLS: staff-visible, writable by can_manage_team (existing permission, rule:
-- invent nothing new). has_permission() already returns true for role=admin.
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS people_staff_read ON public.people;
CREATE POLICY people_staff_read ON public.people
  FOR SELECT USING (public.is_admin_staff());
DROP POLICY IF EXISTS people_manage_ins ON public.people;
CREATE POLICY people_manage_ins ON public.people
  FOR INSERT WITH CHECK (public.is_admin_staff() AND public.has_permission('can_manage_team'));
DROP POLICY IF EXISTS people_manage_upd ON public.people;
CREATE POLICY people_manage_upd ON public.people
  FOR UPDATE USING (public.is_admin_staff() AND public.has_permission('can_manage_team'))
             WITH CHECK (public.is_admin_staff() AND public.has_permission('can_manage_team'));
DROP POLICY IF EXISTS people_manage_del ON public.people;
CREATE POLICY people_manage_del ON public.people
  FOR DELETE USING (public.is_admin_staff() AND public.has_permission('can_manage_team'));

-- updated_at touch.
CREATE OR REPLACE FUNCTION public.pec_people_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS people_touch_updated_at ON public.people;
CREATE TRIGGER people_touch_updated_at
  BEFORE UPDATE ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.pec_people_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Commission rename safety: name_aliases + capture trigger (landmine 1).
-- ---------------------------------------------------------------------------
ALTER TABLE public.pec_sales_team_members
  ADD COLUMN IF NOT EXISTS name_aliases text[] NOT NULL DEFAULT '{}';

-- Captures the OLD name on any rename, whatever path wrote it. Deliberately
-- NOT gated on the mirror switch: even with sync off, a rename must never
-- orphan historical pec_job_ar.salesperson strings.
CREATE OR REPLACE FUNCTION public.pec_sales_capture_name_alias()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.name IS DISTINCT FROM NEW.name
     AND OLD.name IS NOT NULL AND btrim(OLD.name) <> '' THEN
    -- The current name is no longer an alias of itself.
    NEW.name_aliases := array_remove(coalesce(NEW.name_aliases, '{}'), NEW.name);
    IF NOT (OLD.name = ANY (NEW.name_aliases)) THEN
      NEW.name_aliases := NEW.name_aliases || OLD.name;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pec_sales_capture_name_alias ON public.pec_sales_team_members;
CREATE TRIGGER pec_sales_capture_name_alias
  BEFORE UPDATE ON public.pec_sales_team_members
  FOR EACH ROW EXECUTE FUNCTION public.pec_sales_capture_name_alias();

-- ---------------------------------------------------------------------------
-- 3) The mirror switch.
-- ---------------------------------------------------------------------------
-- 'false' turns every sync trigger below into a no-op (real rollback, no
-- deploy). The GUC variant is transaction-local suppression for the RPCs.
CREATE OR REPLACE FUNCTION public.pec_people_sync_enabled()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT value FROM public.settings WHERE key = 'people_mirror_enabled' LIMIT 1), 'true') <> 'false'
     AND coalesce(current_setting('pec.people_sync', true), 'on') <> 'off';
$$;

-- ---------------------------------------------------------------------------
-- 4) Forward mirror: people -> legacy. SECURITY DEFINER so a can_manage_team
--    office user's people edit can reach admin_users (whose direct write
--    policies are tighter); the People screen itself is what gates access.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pec_people_mirror_forward()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pec_people_sync_enabled() THEN RETURN NEW; END IF;
  IF OLD.full_name IS DISTINCT FROM NEW.full_name THEN
    IF NEW.admin_user_id IS NOT NULL THEN
      UPDATE public.admin_users SET name = NEW.full_name
       WHERE id = NEW.admin_user_id AND name IS DISTINCT FROM NEW.full_name;
    END IF;
    IF NEW.sales_team_member_id IS NOT NULL THEN
      -- The alias-capture trigger on the sales table records the old name.
      UPDATE public.pec_sales_team_members SET name = NEW.full_name
       WHERE id = NEW.sales_team_member_id AND name IS DISTINCT FROM NEW.full_name;
    END IF;
    IF NEW.crew_member_id IS NOT NULL THEN
      UPDATE public.pec_prod_crew_members SET name = NEW.full_name
       WHERE id = NEW.crew_member_id AND name IS DISTINCT FROM NEW.full_name;
    END IF;
  END IF;
  -- Person-level active mirrors to role rows ONLY when it actually changed,
  -- so a per-role deactivation done on a legacy card survives unrelated edits.
  -- admin_users has no active column; login disablement stays in Users.
  IF OLD.active IS DISTINCT FROM NEW.active THEN
    IF NEW.sales_team_member_id IS NOT NULL THEN
      UPDATE public.pec_sales_team_members SET active = NEW.active
       WHERE id = NEW.sales_team_member_id AND active IS DISTINCT FROM NEW.active;
    END IF;
    IF NEW.crew_member_id IS NOT NULL THEN
      UPDATE public.pec_prod_crew_members SET active = NEW.active
       WHERE id = NEW.crew_member_id AND active IS DISTINCT FROM NEW.active;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS people_mirror_forward ON public.people;
CREATE TRIGGER people_mirror_forward
  AFTER UPDATE ON public.people
  FOR EACH ROW
  WHEN (OLD.full_name IS DISTINCT FROM NEW.full_name OR OLD.active IS DISTINCT FROM NEW.active)
  EXECUTE FUNCTION public.pec_people_mirror_forward();

-- ---------------------------------------------------------------------------
-- 5) Reverse-adopt: an INSERT into a legacy table creates its person.
--    WHEN (pg_trigger_depth() = 0): direct DML only, never mirror echo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pec_people_adopt_admin_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pec_people_sync_enabled() THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.people WHERE admin_user_id = NEW.id) THEN
    INSERT INTO public.people (full_name, email, active, admin_user_id)
    VALUES (NEW.name, NEW.email, true, NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS people_adopt_admin_user ON public.admin_users;
CREATE TRIGGER people_adopt_admin_user
  AFTER INSERT ON public.admin_users
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION public.pec_people_adopt_admin_user();

CREATE OR REPLACE FUNCTION public.pec_people_adopt_sales_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pec_people_sync_enabled() THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.people WHERE sales_team_member_id = NEW.id) THEN
    -- If the new sales row is login-linked to an existing person, attach the
    -- role there (same hard-key rule as the backfill) instead of splitting.
    UPDATE public.people p SET sales_team_member_id = NEW.id
      FROM public.admin_users a
     WHERE NEW.auth_user_id IS NOT NULL
       AND a.auth_user_id = NEW.auth_user_id
       AND p.admin_user_id = a.id
       AND p.sales_team_member_id IS NULL;
    IF NOT FOUND THEN
      INSERT INTO public.people (full_name, active, sales_team_member_id)
      VALUES (NEW.name, coalesce(NEW.active, true), NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS people_adopt_sales_member ON public.pec_sales_team_members;
CREATE TRIGGER people_adopt_sales_member
  AFTER INSERT ON public.pec_sales_team_members
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION public.pec_people_adopt_sales_member();

CREATE OR REPLACE FUNCTION public.pec_people_adopt_crew_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pec_people_sync_enabled() THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.people WHERE crew_member_id = NEW.id) THEN
    INSERT INTO public.people (full_name, active, crew_member_id)
    VALUES (NEW.name, coalesce(NEW.active, true), NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS people_adopt_crew_member ON public.pec_prod_crew_members;
CREATE TRIGGER people_adopt_crew_member
  AFTER INSERT ON public.pec_prod_crew_members
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION public.pec_people_adopt_crew_member();

-- ---------------------------------------------------------------------------
-- 6) Reverse-rename: a rename on a legacy card follows to the person. The
--    forward trigger (no depth guard) then carries it to sibling role rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pec_people_follow_admin_rename()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pec_people_sync_enabled() THEN RETURN NEW; END IF;
  UPDATE public.people SET full_name = NEW.name
   WHERE admin_user_id = NEW.id AND full_name IS DISTINCT FROM NEW.name;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS people_follow_admin_rename ON public.admin_users;
CREATE TRIGGER people_follow_admin_rename
  AFTER UPDATE ON public.admin_users
  FOR EACH ROW WHEN (pg_trigger_depth() = 0 AND OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.pec_people_follow_admin_rename();

CREATE OR REPLACE FUNCTION public.pec_people_follow_sales_rename()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pec_people_sync_enabled() THEN RETURN NEW; END IF;
  UPDATE public.people SET full_name = NEW.name
   WHERE sales_team_member_id = NEW.id AND full_name IS DISTINCT FROM NEW.name;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS people_follow_sales_rename ON public.pec_sales_team_members;
CREATE TRIGGER people_follow_sales_rename
  AFTER UPDATE ON public.pec_sales_team_members
  FOR EACH ROW WHEN (pg_trigger_depth() = 0 AND OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.pec_people_follow_sales_rename();

CREATE OR REPLACE FUNCTION public.pec_people_follow_crew_rename()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pec_people_sync_enabled() THEN RETURN NEW; END IF;
  UPDATE public.people SET full_name = NEW.name
   WHERE crew_member_id = NEW.id AND full_name IS DISTINCT FROM NEW.name;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS people_follow_crew_rename ON public.pec_prod_crew_members;
CREATE TRIGGER people_follow_crew_rename
  AFTER UPDATE ON public.pec_prod_crew_members
  FOR EACH ROW WHEN (pg_trigger_depth() = 0 AND OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.pec_people_follow_crew_rename();

-- ---------------------------------------------------------------------------
-- 7) RPC: grant a role to an existing person. Inserts the legacy row with the
--    GUC set so the adopt trigger does not spawn a duplicate person, then sets
--    the pointer. 'login' is NOT grantable here: creating a login means
--    creating an auth user, which is pec-create-staff.cjs's job (its
--    admin_users insert is adopted or hand-linked on the People screen).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pec_people_grant_role(p_person_id uuid, p_role text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  person public.people%ROWTYPE;
  new_id uuid;
BEGIN
  IF NOT (public.is_admin_staff() AND public.has_permission('can_manage_team')) THEN
    RAISE EXCEPTION 'permission denied: can_manage_team required';
  END IF;
  SELECT * INTO person FROM public.people WHERE id = p_person_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'person % not found', p_person_id; END IF;
  PERFORM set_config('pec.people_sync', 'off', true);
  IF p_role = 'sales' THEN
    IF person.sales_team_member_id IS NOT NULL THEN RETURN person.sales_team_member_id; END IF;
    INSERT INTO public.pec_sales_team_members (name, active, commission_pct)
    VALUES (person.full_name, person.active, 0) RETURNING id INTO new_id;
    UPDATE public.people SET sales_team_member_id = new_id WHERE id = p_person_id;
  ELSIF p_role = 'crew' THEN
    IF person.crew_member_id IS NOT NULL THEN RETURN person.crew_member_id; END IF;
    INSERT INTO public.pec_prod_crew_members (name, active)
    VALUES (person.full_name, person.active) RETURNING id INTO new_id;
    UPDATE public.people SET crew_member_id = new_id WHERE id = p_person_id;
  ELSE
    RAISE EXCEPTION 'unsupported role % (grantable: sales, crew; logins go through Settings > Users)', p_role;
  END IF;
  RETURN new_id;
END $$;

-- ---------------------------------------------------------------------------
-- 8) RPC: merge two people (the dedupe review screen's Merge button). Atomic:
--    moves role pointers onto the kept person, coalesces identity fields,
--    deletes the duplicate people row (people rows are the NEW table; the
--    no-drop guarantee covers the legacy tables, which this never touches).
--    Refuses a merge that would need two legacy rows in one role slot.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pec_people_merge(p_keep uuid, p_remove uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  keep public.people%ROWTYPE;
  rem  public.people%ROWTYPE;
BEGIN
  IF NOT (public.is_admin_staff() AND public.has_permission('can_manage_team')) THEN
    RAISE EXCEPTION 'permission denied: can_manage_team required';
  END IF;
  IF p_keep = p_remove THEN RAISE EXCEPTION 'cannot merge a person into themselves'; END IF;
  SELECT * INTO keep FROM public.people WHERE id = p_keep   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'person % not found', p_keep; END IF;
  SELECT * INTO rem  FROM public.people WHERE id = p_remove FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'person % not found', p_remove; END IF;
  IF (keep.admin_user_id IS NOT NULL AND rem.admin_user_id IS NOT NULL)
     OR (keep.sales_team_member_id IS NOT NULL AND rem.sales_team_member_id IS NOT NULL)
     OR (keep.crew_member_id IS NOT NULL AND rem.crew_member_id IS NOT NULL) THEN
    RAISE EXCEPTION 'both people hold the same role; they are two real records, not a duplicate';
  END IF;
  PERFORM set_config('pec.people_sync', 'off', true);
  -- Clear the loser's pointers first so the partial unique indexes never see
  -- the same legacy row claimed twice inside the transaction.
  UPDATE public.people SET admin_user_id = NULL, sales_team_member_id = NULL, crew_member_id = NULL
   WHERE id = p_remove;
  UPDATE public.people SET
    admin_user_id        = coalesce(keep.admin_user_id,        rem.admin_user_id),
    sales_team_member_id = coalesce(keep.sales_team_member_id, rem.sales_team_member_id),
    crew_member_id       = coalesce(keep.crew_member_id,       rem.crew_member_id),
    email                = coalesce(keep.email,        rem.email),
    phone                = coalesce(keep.phone,        rem.phone),
    display_name         = coalesce(keep.display_name, rem.display_name),
    birth_month          = coalesce(keep.birth_month,  rem.birth_month),
    birth_day            = CASE WHEN keep.birth_month IS NOT NULL THEN keep.birth_day ELSE rem.birth_day END,
    active               = (keep.active OR rem.active)
   WHERE id = p_keep;
  DELETE FROM public.people WHERE id = p_remove;
END $$;

-- ---------------------------------------------------------------------------
-- 9) Backfill (Part B, the unambiguous cases only). Auto-merge happens ONLY on
--    the hard key auth_user_id (admin_users x pec_sales_team_members). Every
--    other cross-table identity (name/email similarity) is a SUGGESTION on the
--    one-time review screen, resolved by a human via pec_people_merge.
--    Idempotent: re-running adds nothing and never duplicates.
-- ---------------------------------------------------------------------------
-- Suppress sync while backfilling (nothing here writes the legacy tables, but
-- belt and suspenders).
SELECT set_config('pec.people_sync', 'off', true);

INSERT INTO public.people (full_name, email, active, admin_user_id)
SELECT a.name, a.email, true, a.id
  FROM public.admin_users a
 WHERE NOT EXISTS (SELECT 1 FROM public.people p WHERE p.admin_user_id = a.id);

-- Hard-key auto-merge: a sales member whose auth_user_id matches a login gets
-- the sales role attached to that login's person.
UPDATE public.people p
   SET sales_team_member_id = s.id
  FROM public.pec_sales_team_members s
  JOIN public.admin_users a ON a.auth_user_id = s.auth_user_id
 WHERE s.auth_user_id IS NOT NULL
   AND p.admin_user_id = a.id
   AND p.sales_team_member_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.people x WHERE x.sales_team_member_id = s.id);

INSERT INTO public.people (full_name, active, sales_team_member_id)
SELECT s.name, s.active, s.id
  FROM public.pec_sales_team_members s
 WHERE NOT EXISTS (SELECT 1 FROM public.people p WHERE p.sales_team_member_id = s.id);

INSERT INTO public.people (full_name, active, crew_member_id)
SELECT c.name, c.active, c.id
  FROM public.pec_prod_crew_members c
 WHERE NOT EXISTS (SELECT 1 FROM public.people p WHERE p.crew_member_id = c.id);

SELECT set_config('pec.people_sync', 'on', true);

-- ---------------------------------------------------------------------------
-- 10) Settings (rule 12). Insert-only so live values are never clobbered.
-- ---------------------------------------------------------------------------
INSERT INTO public.settings (key, value)
SELECT 'people_mirror_enabled', 'true'
 WHERE NOT EXISTS (SELECT 1 FROM public.settings WHERE key = 'people_mirror_enabled');
INSERT INTO public.settings (key, value)
SELECT 'birthday_reminder_enabled', 'true'
 WHERE NOT EXISTS (SELECT 1 FROM public.settings WHERE key = 'birthday_reminder_enabled');
INSERT INTO public.settings (key, value)
SELECT 'birthday_reminder_lead_days', '7'
 WHERE NOT EXISTS (SELECT 1 FROM public.settings WHERE key = 'birthday_reminder_lead_days');

-- ---------------------------------------------------------------------------
-- 11) Verify block: assertions run INSIDE the transaction; any failure rolls
--     the whole migration back. Same spirit as prompt 52's Verify block, but
--     executable because the stakes are silent payroll corruption.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pre  record;
  cur_wage_sum  numeric;
  cur_wage_rows bigint;
  cur_pct_sum   numeric;
  n_people      bigint;
  n_uncovered   bigint;
BEGIN
  SELECT * INTO pre FROM _pec_people_pre;

  -- Wages and commission percentages byte-for-byte (non-negotiable, Part C).
  SELECT coalesce(sum(hourly_wage), 0), count(*) FILTER (WHERE hourly_wage IS NOT NULL)
    INTO cur_wage_sum, cur_wage_rows FROM public.pec_prod_crew_members;
  SELECT coalesce(sum(commission_pct), 0) INTO cur_pct_sum FROM public.pec_sales_team_members;
  IF cur_wage_sum IS DISTINCT FROM pre.wage_sum OR cur_wage_rows IS DISTINCT FROM pre.wage_rows THEN
    RAISE EXCEPTION 'ABORT: hourly_wage changed during migration (pre sum=% rows=%, post sum=% rows=%)',
      pre.wage_sum, pre.wage_rows, cur_wage_sum, cur_wage_rows;
  END IF;
  IF cur_pct_sum IS DISTINCT FROM pre.pct_sum THEN
    RAISE EXCEPTION 'ABORT: commission_pct changed during migration (pre sum=%, post sum=%)',
      pre.pct_sum, cur_pct_sum;
  END IF;

  -- Legacy row counts untouched (nothing dropped, nothing added).
  IF (SELECT count(*) FROM public.admin_users)            IS DISTINCT FROM pre.n_admin
     OR (SELECT count(*) FROM public.pec_sales_team_members) IS DISTINCT FROM pre.n_sales
     OR (SELECT count(*) FROM public.pec_prod_crew_members)  IS DISTINCT FROM pre.n_crew THEN
    RAISE EXCEPTION 'ABORT: a legacy table row count changed during migration';
  END IF;

  -- Every legacy row is covered by exactly one person (uniqueness is enforced
  -- by the partial unique indexes; coverage is asserted here).
  SELECT (SELECT count(*) FROM public.admin_users a
           WHERE NOT EXISTS (SELECT 1 FROM public.people p WHERE p.admin_user_id = a.id))
       + (SELECT count(*) FROM public.pec_sales_team_members s
           WHERE NOT EXISTS (SELECT 1 FROM public.people p WHERE p.sales_team_member_id = s.id))
       + (SELECT count(*) FROM public.pec_prod_crew_members c
           WHERE NOT EXISTS (SELECT 1 FROM public.people p WHERE p.crew_member_id = c.id))
    INTO n_uncovered;
  IF n_uncovered <> 0 THEN
    RAISE EXCEPTION 'ABORT: % legacy rows have no person', n_uncovered;
  END IF;

  SELECT count(*) INTO n_people FROM public.people;
  RAISE NOTICE 'People backfill: % people rows for % logins + % sales + % crew (% auto-merged on auth_user_id)',
    n_people, pre.n_admin, pre.n_sales, pre.n_crew, pre.n_automerge;
END $$;

COMMIT;

-- Verify after running (Cowork: capture the outputs in the log entry):
--   select count(*) from public.people;
--     -- expected on first run: 6 + 2 + 7 - (auto-merged pairs); the NOTICE above prints the merge count
--   select coalesce(sum(hourly_wage),0) from public.pec_prod_crew_members;    -- identical to pre-migration
--   select coalesce(sum(commission_pct),0) from public.pec_sales_team_members; -- identical to pre-migration
--   select full_name, (admin_user_id is not null) as login,
--          (sales_team_member_id is not null) as sales,
--          (crew_member_id is not null) as crew
--     from public.people order by full_name;
--   select tgname from pg_trigger where tgname like 'people_%' or tgname = 'pec_sales_capture_name_alias';
--     -- 8 triggers: touch, forward, 3 adopt, 3 follow-rename (+ the alias capture)
--   select key, value from public.settings
--     where key in ('people_mirror_enabled','birthday_reminder_enabled','birthday_reminder_lead_days');
--
-- Rollback ("turn the mirror off"): update public.settings
--   set value = 'false' where key = 'people_mirror_enabled';
-- Every trigger above becomes a no-op and the app runs on the legacy tables
-- exactly as before. The people table just sits there; nothing reads it that
-- breaks when it goes stale.
