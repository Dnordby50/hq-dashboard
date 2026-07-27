-- @artifacts
--   table: public.pec_prod_busybusy_imports
--   table: public.pec_prod_busybusy_time_entries
--   table: public.pec_prod_busybusy_projects
--   table: public.pec_prod_busybusy_employees
--   column: public.pec_prod_busybusy_time_entries.import_id
--   column: public.pec_prod_busybusy_time_entries.employee_name
--   column: public.pec_prod_busybusy_time_entries.wage_type
--   column: public.pec_prod_busybusy_time_entries.is_overhead
--   column: public.pec_prod_busybusy_time_entries.source_export_id
--   index: idx_pec_bb_entries_work_date
--   index: idx_pec_bb_entries_job
--   index: idx_pec_bb_entries_crew_member
--   index: idx_pec_bb_entries_import
--   index: uq_pec_bb_projects_number
--   index: uq_pec_bb_projects_name
--   setting: busybusy_import_window_weeks
--   setting: busybusy_anomaly_hours_threshold
--   setting: busybusy_overhead_project_names
--   setting: busybusy_export_base_url
--   none: function public.pec_busybusy_import (a function is not expressible in the four artifact kinds)
-- @end
-- ============================================================================
-- 2026-07-27 (prompt 52): BusyBusy Payroll Export as the hours source for job
-- costing. Author: Claude Code. Written for Cowork to apply (standing rule 8).
--
-- WHY A REBUILD, NOT AN ALTER: the Payroll Export endpoint is a SNAPSHOT API,
-- not a sync API. Its `Id` is a calculated record: deterministic while data is
-- unchanged (two identical pulls were byte-identical, discovery task 8), but
-- any edit to a punch regenerates it, one row can split into three, and there
-- is no updatedSince and no deletion feed. The old table's entire design
-- (unique busybusy_entry_id, upsert, soft delete via deleted_at) is the exact
-- pattern this API forbids. It has ZERO rows (the GraphQL sync it was built
-- for has 401'd since 2026-06-13 and never inserted anything), so drop and
-- recreate is safe and honest. Storage model: DELETE-THEN-INSERT BY DATE
-- RANGE, atomically, inside the pec_busybusy_import() function below. Never
-- upsert on the export Id; never dedup against it.
--
-- DELIBERATELY ABSENT: any wage or cost column. BusyBusy's OT1 rows carry
-- Wage at 1.5x and their Cost therefore includes the OT premium, but it does
-- NOT include our 25% burden, so it is not loaded labor and storing it would
-- invite someone to sum it. Costing uses pec_prod_crew_members.hourly_wage
-- plus the existing burden math (computeCrewBonus), exactly as today. Do not
-- "helpfully" add a wage/cost column here later; that omission is a decision
-- (Dylan, 2026-07-27), not an oversight.
--
-- SPLIT REG/OT1 PAIRS: when a punch segment crosses an employee's 40th hour
-- of the week, BusyBusy emits TWO rows with the SAME Start/End (one REG, one
-- OT1) whose Hours split the span. Each hour of wall time appears in exactly
-- one row, so summing hours never double counts, but any uniqueness rule on
-- (employee, started_at, ended_at) WITHOUT wage_type would silently drop half
-- a pair. This table therefore has NO uniqueness constraint on punch shape.
--
-- pec_prod_jobs.busybusy_project_id (added 2026-06-13 for GraphQL project
-- GUIDs) is now DEAD: the export identifies projects by a 7-digit
-- ProjectNumber, mapped in pec_prod_busybusy_projects below. The column is
-- left in place (dropping it buys nothing and breaks replays); do not read it.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) The import audit trail. One row per committed pull; also the unit of
--    replacement (time entries cascade-delete with their import).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pec_prod_busybusy_imports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_start       date NOT NULL,
  window_end         date NOT NULL,
  imported_by        uuid,
  imported_at        timestamptz NOT NULL DEFAULT now(),
  row_count          int,
  total_hours        numeric,
  ot_hours           numeric,
  overhead_hours     numeric,
  employees_seen     int,
  unmapped_employees text[],
  unlinked_projects  text[],
  anomaly_count      int,
  notes              text
);

-- ---------------------------------------------------------------------------
-- 2) Replace the time-entries table. Old shape (upsert/soft-delete around
--    busybusy_entry_id) is unusable against a snapshot API; zero rows exist.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.pec_prod_busybusy_time_entries CASCADE;

CREATE TABLE public.pec_prod_busybusy_time_entries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id               uuid NOT NULL REFERENCES public.pec_prod_busybusy_imports(id) ON DELETE CASCADE,
  work_date               date NOT NULL,            -- the CSV Date column, verbatim (always equals date(Start), verified)
  employee_name           text NOT NULL,            -- FirstName + ' ' + LastName, verbatim; the ONLY identity BusyBusy gives us
  crew_member_id          uuid REFERENCES public.pec_prod_crew_members(id) ON DELETE SET NULL,
  busybusy_project_number text,                     -- 7-digit stable string; empty on Shop
  busybusy_project_name   text,
  job_id                  uuid REFERENCES public.pec_prod_jobs(id) ON DELETE SET NULL,
  is_overhead             boolean NOT NULL DEFAULT false,  -- Shop etc.: stored + reported, never charged to a job
  started_at              timestamptz,              -- built with explicit -07:00 (Arizona, no DST) by the import function
  ended_at                timestamptz,
  hours                   numeric(10,4) NOT NULL DEFAULT 0,
  wage_type               text NOT NULL,            -- 'REG' | 'OT1' verbatim; OT hours = sum where wage_type = 'OT1'
  break_hours             numeric(10,4) NOT NULL DEFAULT 0,
  description             text,
  source_export_id        text,                     -- the export's calculated Id: logging/change detection WITHIN one run ONLY, never a key
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pec_bb_entries_work_date   ON public.pec_prod_busybusy_time_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_pec_bb_entries_job         ON public.pec_prod_busybusy_time_entries(job_id);
CREATE INDEX IF NOT EXISTS idx_pec_bb_entries_crew_member ON public.pec_prod_busybusy_time_entries(crew_member_id);
CREATE INDEX IF NOT EXISTS idx_pec_bb_entries_import      ON public.pec_prod_busybusy_time_entries(import_id);

-- ---------------------------------------------------------------------------
-- 3) The remembered project link: name once, then number. On first sight of a
--    project the import auto-links by exact normalized customer name and
--    persists the ProjectNumber; thereafter the number is the key, so a rename
--    in BusyBusy never breaks an established link.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pec_prod_busybusy_projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_number text,
  project_name   text NOT NULL,
  job_id         uuid REFERENCES public.pec_prod_jobs(id) ON DELETE SET NULL,
  is_overhead    boolean NOT NULL DEFAULT false,
  linked_by      uuid,
  linked_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Numbered projects key on the number; number-less projects (Shop) key on the
-- lowercased name. Partial uniques so the two schemes cannot collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pec_bb_projects_number
  ON public.pec_prod_busybusy_projects(project_number)
  WHERE project_number IS NOT NULL AND project_number <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_pec_bb_projects_name
  ON public.pec_prod_busybusy_projects(lower(project_name))
  WHERE project_number IS NULL OR project_number = '';

-- Seed the one known overhead project so the very first import classifies
-- Shop as overhead without a human step.
INSERT INTO public.pec_prod_busybusy_projects (project_name, is_overhead)
SELECT 'Shop', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.pec_prod_busybusy_projects
  WHERE lower(project_name) = 'shop' AND (project_number IS NULL OR project_number = '')
);

-- ---------------------------------------------------------------------------
-- 4) The employee mapping screen's table. Name is the only join key BusyBusy
--    gives us (EmployeeId comes back empty on every row), so every distinct
--    exported name gets a row here, mapped to a crew member or ignored (Aron
--    Bronson is a salesperson: ignored, never costed). No fuzzy matching
--    anywhere; "Preston" (no surname in pec_prod_crew_members) is exactly why.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pec_prod_busybusy_employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  busybusy_name  text NOT NULL UNIQUE,
  crew_member_id uuid REFERENCES public.pec_prod_crew_members(id) ON DELETE SET NULL,
  ignored        boolean NOT NULL DEFAULT false,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 5) RLS: match the existing costing posture (2026-06-13 pattern). Reads for
--    is_admin_staff(). Writes: imports + time-entry inserts go through the
--    import function / service role only; the mapping screens (Parts D/E)
--    update employees/projects and re-resolve stored entries from an admin
--    browser session, so those get admin-gated write policies. Nothing wider.
-- ---------------------------------------------------------------------------
ALTER TABLE public.pec_prod_busybusy_imports      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pec_prod_busybusy_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pec_prod_busybusy_projects     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pec_prod_busybusy_employees    ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pec_prod_busybusy_imports' AND policyname='bb_imports_admin_read') THEN
    CREATE POLICY bb_imports_admin_read ON public.pec_prod_busybusy_imports
      FOR SELECT USING (public.is_admin_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pec_prod_busybusy_time_entries' AND policyname='bb_entries_admin_read') THEN
    CREATE POLICY bb_entries_admin_read ON public.pec_prod_busybusy_time_entries
      FOR SELECT USING (public.is_admin_staff());
  END IF;
  -- Re-resolve in place (mapping/link changes update crew_member_id / job_id /
  -- is_overhead on stored rows). UPDATE only: the browser can never insert or
  -- delete time entries; that is the import function's job, atomically.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pec_prod_busybusy_time_entries' AND policyname='bb_entries_admin_update') THEN
    CREATE POLICY bb_entries_admin_update ON public.pec_prod_busybusy_time_entries
      FOR UPDATE USING (public.is_admin_staff()) WITH CHECK (public.is_admin_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pec_prod_busybusy_projects' AND policyname='bb_projects_admin_all') THEN
    CREATE POLICY bb_projects_admin_all ON public.pec_prod_busybusy_projects
      FOR ALL USING (public.is_admin_staff()) WITH CHECK (public.is_admin_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pec_prod_busybusy_employees' AND policyname='bb_employees_admin_all') THEN
    CREATE POLICY bb_employees_admin_all ON public.pec_prod_busybusy_employees
      FOR ALL USING (public.is_admin_staff()) WITH CHECK (public.is_admin_staff());
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6) The atomic replace. Delete-then-insert across two supabase-js calls is
--    not acceptable: a failure between them empties a payroll window. This
--    function does insert-audit-row + delete-window + insert-rows in ONE
--    transaction (a plpgsql function body is atomic: any error rolls back all
--    three), and returns the new import id.
--
--    p_rows: jsonb array of objects shaped exactly like the table columns
--    (work_date, employee_name, crew_member_id, busybusy_project_number,
--    busybusy_project_name, job_id, is_overhead, started_at, ended_at, hours,
--    wage_type, break_hours, description, source_export_id).
--
--    p_summary (optional, additive to the prompt-52 signature): audit fields
--    the SQL cannot derive from the rows alone (anomaly_count from the
--    parser's overlap/threshold checks, free-text notes). Everything
--    derivable (row_count, hour sums, employees_seen, unmapped/unlinked
--    lists) is computed HERE from p_rows so the audit row cannot disagree
--    with what was actually stored. Callable with the four documented args.
--
--    SECURITY DEFINER + is_admin_staff() gate: the Netlify function calls
--    this via PostgREST with the CALLER'S JWT (not the service key), so
--    auth.uid() is the real admin and imported_by is honest.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pec_busybusy_import(
  p_window_start date,
  p_window_end   date,
  p_rows         jsonb,
  p_user         uuid,
  p_summary      jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_import_id uuid;
BEGIN
  IF NOT public.is_admin_staff() THEN
    RAISE EXCEPTION 'Admins only';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_window_end < p_window_start THEN
    RAISE EXCEPTION 'Invalid import window';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a jsonb array';
  END IF;

  INSERT INTO public.pec_prod_busybusy_imports (
    window_start, window_end, imported_by,
    row_count, total_hours, ot_hours, overhead_hours, employees_seen,
    unmapped_employees, unlinked_projects, anomaly_count, notes
  )
  SELECT
    p_window_start, p_window_end, p_user,
    count(*),
    coalesce(sum(r.hours), 0),
    coalesce(sum(r.hours) FILTER (WHERE r.wage_type = 'OT1'), 0),
    coalesce(sum(r.hours) FILTER (WHERE r.is_overhead), 0),
    count(DISTINCT r.employee_name),
    -- Unmapped = no crew member AND not deliberately ignored in the mapping.
    nullif(array(
      SELECT DISTINCT r2.employee_name
      FROM jsonb_to_recordset(p_rows) AS r2(employee_name text, crew_member_id uuid)
      WHERE r2.crew_member_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.pec_prod_busybusy_employees e
          WHERE e.busybusy_name = r2.employee_name AND e.ignored
        )
      ORDER BY r2.employee_name
    ), '{}'),
    nullif(array(
      SELECT DISTINCT coalesce(r3.busybusy_project_name, '')
      FROM jsonb_to_recordset(p_rows) AS r3(busybusy_project_name text, job_id uuid, is_overhead boolean)
      WHERE r3.job_id IS NULL AND NOT coalesce(r3.is_overhead, false)
      ORDER BY 1
    ), '{}'),
    nullif(p_summary->>'anomaly_count', '')::int,
    nullif(p_summary->>'notes', '')
  FROM jsonb_to_recordset(p_rows) AS r(employee_name text, hours numeric, wage_type text, is_overhead boolean)
  RETURNING id INTO v_import_id;

  DELETE FROM public.pec_prod_busybusy_time_entries
  WHERE work_date BETWEEN p_window_start AND p_window_end;

  INSERT INTO public.pec_prod_busybusy_time_entries (
    import_id, work_date, employee_name, crew_member_id,
    busybusy_project_number, busybusy_project_name, job_id, is_overhead,
    started_at, ended_at, hours, wage_type, break_hours, description,
    source_export_id
  )
  SELECT
    v_import_id,
    r.work_date, r.employee_name, r.crew_member_id,
    nullif(r.busybusy_project_number, ''), r.busybusy_project_name, r.job_id,
    coalesce(r.is_overhead, false),
    r.started_at, r.ended_at,
    coalesce(r.hours, 0), r.wage_type, coalesce(r.break_hours, 0),
    nullif(r.description, ''), r.source_export_id
  FROM jsonb_to_recordset(p_rows) AS r(
    work_date date, employee_name text, crew_member_id uuid,
    busybusy_project_number text, busybusy_project_name text, job_id uuid,
    is_overhead boolean, started_at timestamptz, ended_at timestamptz,
    hours numeric, wage_type text, break_hours numeric, description text,
    source_export_id text
  );

  RETURN v_import_id;
END
$function$;

REVOKE ALL ON FUNCTION public.pec_busybusy_import(date, date, jsonb, uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.pec_busybusy_import(date, date, jsonb, uuid, jsonb) TO authenticated;
-- The Netlify commit path calls with the caller's JWT; service_role keeps
-- execute implicitly (it bypasses grants), which is fine: it is server-side.

-- ---------------------------------------------------------------------------
-- 7) Settings (standing rule 12). Editable in Settings > BusyBusy.
-- ---------------------------------------------------------------------------
INSERT INTO public.settings (key, value)
SELECT k, v FROM (VALUES
  ('busybusy_import_window_weeks',     '2'),
  ('busybusy_anomaly_hours_threshold', '16'),
  ('busybusy_overhead_project_names',  'Shop'),
  ('busybusy_export_base_url',         'https://export.busybusy.io/')
) AS seed(k, v)
WHERE NOT EXISTS (SELECT 1 FROM public.settings s WHERE s.key = seed.k);

COMMIT;

-- Verify after running:
--   select count(*) from public.pec_prod_busybusy_time_entries;                  -- 0
--   select column_name from information_schema.columns
--     where table_name = 'pec_prod_busybusy_time_entries'
--       and column_name in ('import_id','employee_name','wage_type');            -- 3 rows
--   select project_name, is_overhead from public.pec_prod_busybusy_projects;     -- Shop | true
--   select key from public.settings where key like 'busybusy_%' order by key;    -- 4 rows
--   select proname from pg_proc where proname = 'pec_busybusy_import';           -- 1 row
