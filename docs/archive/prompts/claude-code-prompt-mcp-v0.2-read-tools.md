# Claude Code prompt: Topcoat MCP connector v0.2 — read tools + metrics

Paste into Claude Code. Follow CLAUDE.md (commit + PROJECT-LOG). This edits `netlify/functions/mcp.cjs`. The connector is LIVE and connected (bearer-gated, confirmed working with `get_schedule`). Goal: expand it so CRM data is pulled through the connector instead of browser scraping. READ-ONLY — no write/mutation tools in this round.

## Context / current state

`mcp.cjs` v0.1 exposes ONE tool, `get_schedule`, which reads the Booked Jobs sheet (`BOOKED_JOBS_ID`, range `booked jobs!A:G`) via the Apps Script proxy `SHEETS_PROXY` (see `fetchSheet`, `tool_get_schedule` ~line 72). The server imports only `crypto` — it has NO Supabase access yet. Auth, JSON-RPC dispatch (`handleRpc`), and the `TOOLS` array are already in place; new tools just register into `HANDLERS` + `TOOLS`.

Two data sources are in play, and each new tool should read the RIGHT one:
- Google Sheets (Booked Jobs) = the bookings/sales numbers Dylan reports on. Use for the metric tool.
- Supabase (the live CRM: `public.customers`, `public.jobs`, the `pec_job_ar` view, `pec_prod_jobs`, costing tables) = the detailed records Chrome was scraping. Use for the record-read tools. Mind the Architecture Gotcha in CLAUDE.md: `public.jobs` (Jobs page) and `pec_prod_jobs` (schedule) are parallel siblings — for customer/job lookups use `public.jobs` + `public.customers`.

## Tasks

### 1. Metric tool (sheet-based): `get_sales_summary`

Aggregates the SAME Booked Jobs sheet `get_schedule` already reads (reuse `fetchSheet` + the A:G column mapping; factor the row parse into a shared helper so the two tools can't drift). Args:
- `business` (enum all|pec|ftp, default all) — reuse `bizMatch`.
- `start_date`, `end_date` (ISO, inclusive; same scheduled-date-else-date-booked rule as `get_schedule`).
- `group_by` (enum: `none`|`business`|`salesperson`, default `none`).

Returns: total booked job count and total revenue for the filtered set, plus a per-group breakdown (count + revenue) when `group_by` is set. Include the date range echoed back. This answers "how much did we book this month / by whom."

### 2. Wire Supabase service-role READ access

Add a minimal SELECT-only Supabase helper (reuse the pattern in `netlify/functions/_pec-supabase.cjs`; `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are already in the site env — confirm they're in scope for the `mcp` function, and if a tool can't reach them, return a clean tool error, never throw). Service role bypasses RLS, which is fine server-side, but this connector stays READ-ONLY: the helper must only ever issue GET/SELECT (PostgREST GET). Do not add any insert/update/delete path.

### 3. Supabase read tools

- `find_customers(query, limit=20)` — case-insensitive search of `public.customers` by name/email/phone (PostgREST `or=` + `ilike`). Return id, name, email, phone, company, and a job count if cheap.
- `find_jobs(customer, address, status, business, limit=20)` — search `public.jobs` joined to `public.customers`; filter by any provided arg. Return job id, customer name, address, status, system/type, revenue, signed_date, and scheduled date(s) if reachable. Keep the payload focused (don't dump every column).
- `list_pipeline(stage, business, limit=50)` — read the `pec_job_ar` view (or the pipeline source `renderPipeline` uses) to list jobs by AR/pipeline stage, newest first. Return customer, stage, revenue, and the relevant AR timestamps.

Implement each against the ACTUAL current schema (read the table/view definitions in `supabase/` and how `index.html` queries them — don't assume column names). Each tool: validate/limit inputs, cap `limit` (e.g. max 200), and wrap the fetch so a failure returns `isError` content, not a 500.

### 4. Register + housekeeping

- Add each tool to `TOOLS` (valid JSON Schema `inputSchema`, clear descriptions — the description is how the agent decides when to call it) and to `HANDLERS`.
- Bump `SERVER_INFO.version` to `0.2.0`.
- Keep `get_schedule` byte-for-byte behaviorally unchanged.

## Guardrails

- READ-ONLY. No write tools, no mutations, service-role client issues SELECT/GET only.
- Do not log secrets or the bearer token. Do not reintroduce the removed `[mcp-*]` diagnostic loggers.
- Keep every `tools/list` schema valid — a malformed `inputSchema` breaks the client connection (that was a live failure mode).
- Don't change auth, the OAuth endpoints, or the JSON-RPC envelope.

## Acceptance

- `node --check netlify/functions/mcp.cjs` passes.
- A local/again-staged `tools/list` returns all four tools with valid schemas; `initialize` still succeeds.
- Spot-check each tool returns sane data shapes (you can reason from the schema/queries; live verification happens after deploy + connector refresh).

## After (per CLAUDE.md)

- Commit (`mcp: v0.2 read tools (sales summary, customers, jobs, pipeline)`).
- PROJECT-LOG entry (By: Claude Code) listing the new tools, their data source (sheet vs Supabase), and that the connector stays read-only.
- `## Handoff to Dylan`: no new env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY already set). After deploy, the connector caches its tool list, so he should refresh/reconnect Topcoat in Settings -> Connectors to pick up the new tools. Then Cowork can test each one live.
