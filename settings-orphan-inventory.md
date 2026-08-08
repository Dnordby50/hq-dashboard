# Settings orphan inventory (input to prompt 81)

Cowork, 2026-08-08. Read-only. **This file corrects a number in `settings-ia-analysis.md`.**

## Correction first

The analysis file says "about 35 rows in `settings` have no Settings surface at all." **That number is wrong and it was wrong in my favour** (it made the problem sound bigger and tidier than it is).

It came from grepping `map.<key>` in `index.html`. That only catches the General tab's access pattern. The sub-tab renderers read their settings through differently named locals, so five keys that DO have working controls were counted as orphans: `salesask_sync_enabled`, `salesask_push_window_days`, `salesask_pull_lookback_days` (all in Settings > Appointments under "SalesAsk recording sync") and `routemize_answer_routing`, `routemize_service_type_map` (Settings > Appointments under "Routemize booking intake / questions").

The remaining rows are also not one homogeneous pile. They split three ways, and only the first group should get controls. Verified by grepping every key across `netlify/`, `estimator/`, `apps/`, `production/`, `scripts/` and `supabase/` for an actual consumer.

---

## A. Real rule-12 gaps: live consumer, no control anywhere (22 keys)

These are read at runtime and cannot be changed without a code edit or raw SQL. Under the amended rule 12 they need a home, nearly all of them behind Advanced.

| Key | Live value | Consumer | Proposed home |
| --- | --- | --- | --- |
| `drip_kill_switch` | `false` | `netlify/functions/_pec-drip.cjs` | **Automations, front-of-card** |
| `security_alerts_enabled` | `true` | `pec-security-monitor.cjs` | Advanced (Advanced page) |
| `security_alerts_lookback_min` | `20` | `pec-security-monitor.cjs` | Advanced |
| `busybusy_export_base_url` | `https://export.busybusy.io/` | `pec-busybusy-export.cjs` | Integrations > BusyBusy, Advanced |
| `default_labor_hourly_rate` | `35` | `index.html` (10 refs, read-only) | **Job Costing, front-of-card** |
| `estimator_target_gp_pct` | `50` | `apps/estimator/src/lib/catalog.ts` | Sales & Estimates, Advanced |
| `estimator_sundries_pct` | `2` | catalog.ts | Sales & Estimates, Advanced |
| `estimator_charm_band` | `250` | catalog.ts | Sales & Estimates, Advanced |
| `estimator_charm_threshold` | `1000` | catalog.ts | Sales & Estimates, Advanced |
| `estimator_price_increment` | `5` | catalog.ts | Sales & Estimates, Advanced |
| `estimator_default_commission_pct` | `6` | catalog.ts | Sales & Estimates, Advanced |
| `estimator_hide_material_qty` | `true` | catalog.ts | Sales & Estimates, Advanced |
| `estimator_allowed_emails` | `dylan@prescottepoxy.com` | catalog.ts | Sales & Estimates, Advanced |
| `ops_check_busybusy_unmapped` | `true` | index.html ops queue | Notifications, Advanced |
| `ops_check_costing_unfinalized` | `true` | ops queue | Notifications, Advanced |
| `ops_check_deposit_uncollected` | `true` | ops queue | Notifications, Advanced |
| `ops_check_drip_approvals` | `true` | ops queue | Notifications, Advanced |
| `ops_check_missing_revenue` | `true` | ops queue | Notifications, Advanced |
| `ops_check_missing_salesperson` | `true` | ops queue | Notifications, Advanced |
| `ops_check_missing_system` | `true` | ops queue | Notifications, Advanced |
| `ops_check_never_invoiced` | `true` | ops queue | Notifications, Advanced |
| `ops_check_system_health` | `true` | ops queue | Notifications, Advanced |
| `ops_check_touchup_age` | `true` | ops queue | Notifications, Advanced |

Two things stand out. **`drip_kill_switch` is a kill switch with no UI** — the one setting you would most want to reach in a hurry is the one you currently need SQL for. It belongs front-of-card next to the existing master switch, and prompt 81 should reconcile it with `drip_sending_enabled` (two rows that both stop sending is a footgun; confirm which one `_pec-drip.cjs` actually honours before wiring a second control). And the ten `ops_check_*` toggles are a natural single card ("which checks run in the ops queue"), not ten scattered switches.

The nine estimator keys are read by the **separate estimator app** (`apps/estimator`), not the dashboard. Confirm that app reads them live from `settings` rather than at build time before promising a control changes anything.

## B. Not settings — app-written state (2 keys). Do NOT give these controls.

| Key | What it actually is |
| --- | --- |
| `metrics_tab_ai_insights` | A cached AI response blob. The current value is a ~1,500-character generated paragraph with `generated_at` and `model` fields. |
| `people_merge_dismissed` | An array of dismissed person-merge pair IDs. |

Neither is a human-tunable parameter; both are written by the app. Under the amended rule 12 these should not get a control and ideally should not live in `settings` at all. Moving them is out of scope for prompt 81 — just do not build UI for them, and do not let a future audit re-flag them as gaps. Worth a one-line note in SCHEMA.md marking them as state.

## C. Dead: seeded by a migration, no consumer anywhere (3 keys)

| Key | Value | Only appearance |
| --- | --- | --- |
| `drip_autosend_email` | `false` | `supabase/migrations/2026-06-21_estimator_core.sql` |
| `drip_autosend_sms` | `false` | same |
| `estimator_enabled` | `false` | same |

No consumer in `index.html`, `netlify/`, `apps/`, `production/` or `estimator/`. Candidates for deletion, but **do not delete them in prompt 81.** `estimator_enabled` reads `false` while the estimator is plainly in use, which means either the key was abandoned or something reads it by a name this grep did not catch. Confirm before removing anything, and delete in a separate prompt with its own log entry. A dead row costs nothing; a wrongly deleted one costs an outage.

## D. Partially surfaced, verify

`migration_drift_baseline` and `migration_drift_check_enabled` both have a write path in `index.html` (the drift panel), so they are not orphans, but confirm the control is reachable from Settings rather than only from the drift banner.

---

## Net effect on prompt 81

Not "add ~35 controls." It is: **22 new controls (20 behind Advanced, 2 front-of-card), 2 rows explicitly excluded as state, 3 rows quarantined pending a delete decision, 5 rows that were never orphans.**
