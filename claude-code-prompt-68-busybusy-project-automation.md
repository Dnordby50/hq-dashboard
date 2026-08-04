# Claude Code prompt 68: BusyBusy project auto-creation and the clock-in number in TopCoat

Scoped by Cowork 2026-08-03. Sibling of prompt 66 (metrics/GP fixes) and prompt 67 (appointment calendar chips). Run prompt 66 first; this one is independent of 67.

Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first, per standing rule 4.

---

## What Dylan asked for

"BusyBusy clock in ID in TopCoat, automation to create a BusyBusy project when a project is accepted."

Two things: a crew-facing identifier printed where the crew can see it, and no more hand-creating projects in BusyBusy after every sale.

## What Cowork verified before writing this (do not re-derive)

**The write path exists and is already authenticated.** The Zapier BusyBusy app (`selected_api: BusybusyCLIAPI`) is enabled on Dylan's Zapier account with 196 actions, `needs_auth: false`, 2 connections. Relevant ones: `create_project`, `update_project`, `archive_project`, `search_project`, `search_projects`.

**`create_project` parameters, read from the live schema:** `title` (required, "the name of the project that an employee will see for selecting a project when clocking in", should be unique), `project_number` (**we supply it**; "not required to be unique but it is recommended"), `customer`, `address_1`, `address_2`, `city`, `state`, `postal_code`, `phone`, `project_group`, `latitude`, `longitude`, `radius` (geofence, meters, minimum 100), `reminders` (boolean), `onsite_verification` (`none` / `self` / `self_and_children`), `additional_information`, `cost_codes`, `sub_projects`.

**The BusyBusy REST/GraphQL path is still dead.** `export.busybusy.io` is a read-only CSV snapshot endpoint (`netlify/functions/pec-busybusy-export.cjs:3`), and `graphql.busybusy.io` has returned 401 since 2026-06-13. Do not spend the session trying to revive either.

**CRITICAL ARCHITECTURAL CONSTRAINT, read this twice.** The Zapier MCP tools are an ASSISTANT-side capability. A Netlify function at runtime cannot call them. The accept path (`pec-public-estimate.cjs` `handleAccept`) therefore CANNOT invoke `busybusy_create_project` directly. The integration must be:

`TopCoat accept path -> POST to a Zapier Catch Hook -> Zap runs BusyBusy Create Project`

This is the Routemize pattern in reverse, and it is the ONLY proven outbound path today. Do not design around a direct API call. If you believe you have found a way for the function to reach BusyBusy directly, STOP and report it before building; do not silently switch architectures.

## Locked decisions (Dylan chose these)

1. **Trigger: estimate accepted.** Hook the same place the job and production job already get created.
2. **Write path: Zapier**, via a Catch Hook that TopCoat POSTs to.
3. **Naming: `title` = customer name exactly as TopCoat stores it; `project_number` = the estimate number's digits** (EST-102047 -> `102047`); `customer` = the customer name as well.
4. **Address: yes, plus a geofence radius, with `reminders` OFF and `onsite_verification` = `none`.** Set the radius so onsite verification is available later without nagging anyone now.
5. **Clock-in number shows on the printed work order, replacing the dead `DJ #` row.**

## Why the naming decision matters (state this in the code comment)

`pec_prod_busybusy_projects` links a BusyBusy project to a job by the rule NAME ONCE, THEN NUMBER (SCHEMA.md): the importer auto-links on the exact normalized `pec_prod_jobs.customer_name` on first sight, then keys on `project_number` forever. Because TopCoat now SETS the number at creation, the link does not have to be discovered at all: write the `pec_prod_busybusy_projects` row (project_number, project_name, job_id) at creation time, and the importer will match on the number the first time hours arrive. The name match becomes a fallback, not the mechanism.

Dylan's first instinct was to put the EST number in the project title. That was rejected once the `project_number` field was found, because a title of "Tom Bechtel EST-102047" fails the importer's normalized name match and would force a manual mapping for every job.

## Part A: the outbound call

In `netlify/functions/pec-public-estimate.cjs`, at the point where `handleAccept` has created the `jobs` row and the `pec_prod_jobs` row, fire a **fire-and-forget** POST to the Catch Hook URL from `process.env.ZAPIER_BUSYBUSY_HOOK_URL`.

Non-negotiable properties:
- **The accept path must never fail because BusyBusy did.** A signed estimate becoming a job is the single most important write in this product. Wrap the call so no error, timeout, or missing env var can reject `handleAccept`. Follow the existing fire-and-forget pattern (`apptPostWrite` kicking `pec-appt-sync-push` is the in-repo precedent).
- **No env var configured = clean no-op**, exactly like the Google OAuth path no-ops while unconfigured. No error bell, no log noise.
- **Idempotency.** A customer can hit accept twice, and the accept path already defends against double-recording elsewhere (see the payment recover-verify-retry note in CLAUDE.md's Architecture Gotchas). Before POSTing, check for an existing `pec_prod_busybusy_projects` row for this job or this project_number and skip if present. Two projects for one job is worse than none: the crew picks the wrong one and the hours land nowhere.
- Payload: `title`, `project_number`, `customer`, `address_1`, `city`, `state`, `postal_code`, `phone`, `radius`, plus `topcoat_job_id` and `estimate_number` for traceability in the Zap history. Include a shared secret header the same way the Routemize intake validates one (`safeEqual`, per the security hardening entry in features.json).

Write the `pec_prod_busybusy_projects` row locally at the same moment, marked as pending-confirmation, so the link exists even if the Zap is slow or the run fails. Add a column or reuse an existing nullable one for that state rather than inventing a parallel table; if a migration is needed, it carries an `@artifacts` header per CLAUDE.md rule 13.

**Settings surface (rule 12, this one IS a major feature):** on/off switch, the geofence radius, and whether reminders are on, all in Settings > BusyBusy next to the existing import knobs, backed by the `settings` table.

## Part B: the clock-in number on the work order

`index.html:14710` prints:

```html
<div class="lbl">DJ #:</div>  <div class="val num">${e(job.dripjobs_deal_id || '')}</div>
```

`dripjobs_deal_id` is blank on every TopCoat-native job now (measured: 20 of 93 production rows carry no deal id, and every August row so far has none). Replace that pair with the BusyBusy clock-in number, resolved from `pec_prod_busybusy_projects` for the job.

Constraints:
- Prompt 53 verified the work order header height math against a grid of 2 label/value pairs per row. **Replace the pair, do not add one.** Row count must not change.
- Label it what the crew calls it, not what the database calls it. "Clock in #" beats "BusyBusy project number".
- A job with no project yet prints blank, not "null" and not "pending".
- If Dylan still wants the DripJobs id visible for the 73 legacy jobs that have one, print it only when the BusyBusy number is absent AND the deal id exists. Report this fallback before shipping it rather than deciding alone.

## Part C: prove it end to end, then hand off the Zap

The Zap itself is a web-UI build. Per CLAUDE.md rule 5 and rule 8, this is a **Cowork handoff**, not something you do from this session. Write the handoff prompt into the PROJECT-LOG entry AND print it in chat as a standalone fenced block in the CLAUDE.md handoff format, containing:
- The exact Catch Hook trigger to create, the field mapping from the POST body to `create_project`'s parameters (name each one), and the `project_number` format.
- That `reminders` must be False and `onsite_verification` must be `none` on this first build.
- The env var name to hand back (`ZAPIER_BUSYBUSY_HOOK_URL`) plus the shared secret, and that Dylan sets both in Netlify.
- An acceptance test: fire one test payload, confirm the project appears in BusyBusy with the right title and number, then ARCHIVE that test project (`archive_project`) rather than leaving it in the crew's picker.

## Guardrails

- Do not touch the import path (`pec-busybusy-export.cjs`, the mapping screens, the `pec_busybusy_import` RPC). Creating projects and importing hours are separate concerns and the import is load-bearing for payroll.
- Do not write BusyBusy wage or cost data anywhere. The import deliberately never reads those columns; do not open that door from the write side.
- Do not create a project for a callback/touch-up job (`is_callback`). Those hours belong to the original job.
- Do not put the shared secret, the hook URL, or any token in committed code. Placeholder plus a handoff, per rule 7.
- No customer-facing string changes. The work order is internal, but keep the em-dash rule anyway.

## Verification bar

1. `npm test` green before the first commit and after the last code change.
2. Unit-test the payload builder with fixtures: a residential customer with a full address, a business customer, a customer with no address, and a callback job (which must produce NO payload). A real Zap call cannot be faked honestly, so test the builder, not the network.
3. Prove idempotency with a fixture: same job twice produces one payload and one `pec_prod_busybusy_projects` row.
4. Prove the accept path survives a failing hook: simulate a rejected fetch and a 500, and show the estimate still accepts and the job still gets created. This is the single most important test in this prompt.
5. Print a work order for a job with a project number and one without. Screenshot both headers. Prove the row count and header height are unchanged from a pre-change print.
6. Report whether the settings switch actually gates the call, tested with it off.
7. Delete every test row and re-query for zero residue. Archive any test project created in BusyBusy.

## After

- PROJECT-LOG.md entry at the TOP, `By: Claude Code`, including the Cowork handoff section for the Zap build.
- `features.json`: new entry for the outbound integration, and update the BusyBusy import entry to point at it.
- `help/whats-new.json`: one entry (the clock-in number on the work order is user-visible; the outbound plumbing is not).
- SCHEMA.md regenerated only if you applied a migration.
- Commit per standing rule 1, staging named files only.
