# TopCoat HQ Dashboard: Supabase Schema Reference (public schema)

Generated 2026-07-21 from the live schema of project `zdfpzmmrgotynrwkeakd` via MCP `list_tables`.
Refreshed 2026-08-08 (Claude Code, prompt 77 Part 0) after applying the two stranded migrations live via MCP: (1) `2026-07-31_salesask_integration.sql`: new `pec_salesask_recordings` table (RLS staff-read, service-role write), `pec_appointments.salesask_synced_at` / `salesask_sync_hash`, `pec_sales_team_members.salesask_email`, and three `salesask_*` settings keys (sync ships 'false'); (2) `2026-08-14_prompt75_notification_targeting.sql`: `pec_notifications.target_user_id` (uuid, FK admin_users.id on delete set null; NULL = shared row, a display filter not a security boundary) + its index and three estimate-view settings keys. Also documented here for the first time: the two prompt-76 keys (`estimate_line_generate_enabled`, `estimator_line_sheet_breakpoint_px`) applied by the prompt 76 session on 2026-08-07. Settings 89 rows to 95. Only those sections changed.
Refreshed 2026-08-06 (Claude Code) after applying the prompt-74 migration (2026-08-13_prompt74_estimate_schedule_terms.sql) live via MCP: new `estimate_installments` table (the estimate-side payment schedule, mirroring pec_invoice_installments minus computed_amount), `pec_brand_identity.estimate_terms_text`, and the `estimate_schedule_enabled` settings key. Only those sections changed.
Refreshed 2026-08-06 (Claude Code) after applying the prompt-73 migration (2026-08-12_prompt73_instant_touch_drips.sql) live via MCP: pec_drip_steps gained fixed_template / fixed_subject / auto_send and ai_guidance went NULLABLE; the lead campaign was renumbered to 9 steps (new day-0 instant-touch step at index 0, existing 8 shifted to 1..8, max_touches 9; zero active enrollments at renumber time, so nothing was bumped); settings gained routemize_booking_url (seeded EMPTY, Dylan supplies the real URL), drip_instant_touch_enabled ('true'), and routemize_answer_routing (the questionId route map). Only those sections changed.
Refreshed 2026-07-27 (Cowork) against the live schema after the prompt-51 migration: pec_prod_jobs (ten touchup_* columns + idx_pec_prod_jobs_touchup_queue) and the settings key list. Only those changed; every other section is unchanged from the refreshes below.
Refreshed 2026-07-26 (Cowork) against the live schema after the prompt-50 migrations: pec_prod_job_costing (office_notes/_by/_at), pec_prod_job_bonuses (review_status/reviewed_by/reviewed_at/review_note), pec_bonus_payouts (reversed_at/reversed_by/reversal_reason). Only those three tables changed; every other section is unchanged from the 2026-07-21 dump.

Refreshed 2026-07-27 (Cowork) against the live schema after the prompt-52 migration: pec_prod_busybusy_time_entries was DROPPED and RECREATED with a new shape, and pec_prod_busybusy_imports / pec_prod_busybusy_projects / pec_prod_busybusy_employees are new, plus four busybusy_* settings keys and the pec_busybusy_import() function. Only those sections changed.

Refreshed 2026-07-28 (Cowork) against the live schema after the prompt-53 migration: pec_prod_products gained datasheet_path + msds_path, settings gained datasheet_max_upload_mb, and the previously-undocumented pec_invoice_installments section was written. Also new and NOT a public-schema table: the `pec-datasheets` Storage bucket (public, PDF-only, 10 MB), created by that migration.

Refreshed 2026-07-28 (Cowork, second pass) after the prompt-54 People model migration: new `people` table (81st), `pec_sales_team_members.name_aliases`, and three settings keys (people_mirror_enabled, birthday_reminder_enabled, birthday_reminder_lead_days). No legacy table changed shape beyond that one added column.

Refreshed 2026-07-28 (Cowork, third pass) after the prompt-55 Ops Queue migration: new `pec_ops_items` table (the 82nd) with its shape CHECK, two indexes, four policies and the `pec_ops_item_notify` RPC, plus twelve `ops_*` settings keys (settings 45 rows to 57). Additive only: no existing table, policy, or permission changed.

Refreshed 2026-07-29 (Cowork) after applying the prompt-56 Routemize adapter migration (`2026-08-01_routemize_contact_id.sql`): `routemize_contact_id` (nullable text, no index) added to BOTH `leads` and `customers`, holding Routemize's own `contact.contactId` so a repeat booker stays recognizable even if their phone or email changes on our side; the intake writes it fill-if-blank and pec-appt-intake.cjs tolerates the column being absent. New settings key `routemize_service_type_map` (settings 57 rows to 58), JSON mapping a Routemize serviceName to one of the four appt types, seeded `{"estimate":"on_site_estimate"}`, matched lowercased with serviceName first and anything unmapped defaulting to on_site_estimate. Row counts refreshed off live: leads 1 to 6, customers 84 to 91. `pec_appointments` is unchanged by this migration and already carried `routemize_appt_id`. Additive only.

Refreshed 2026-07-29 (Cowork) after the prompt-57 migrations: `pec_prod_crews.color` (Part F, applied); `colors.product_id` / `colors.default_basecoat_product_id` / `colors.active` plus six inserted flake-blend rows, `pec_prod_areas.flake_color_id`, `job_areas.flake_color_id`, and the `Standard Flake` product rename (Part G steps 1-7, applied). Part G step 8 (deactivating 18 flake products) is NOT applied and is split into 2026-07-30_flake_deactivate_collapsed_blends.sql. Additive only: no existing column changed type, and nothing was deleted or deactivated.

Refreshed 2026-07-29 (Claude Code) after the material-order-overrides migration (2026-08-02_material_order_overrides.sql, applied via MCP): `pec_prod_material_lines` gained `order_qty_manual` and `manual_added` (both boolean not null default false); 12 legacy order_index >= 9000 rows backfilled manual_added=true. Only that table's section changed.

Refreshed 2026-07-29 (Claude Code) after the estimate-scheduled-stage migration (2026-08-03_lead_stage_estimate_scheduled.sql, applied via MCP): `leads.estimate_scheduled_at` (timestamptz, nullable) and `leads_stage_check` replaced to admit `estimate_scheduled` (seven stages, verified live via pg_get_constraintdef). Only the leads section changed.

Refreshed 2026-07-31 (Claude Code) after the review-drip migration (2026-08-04_review_drip.sql, applied via MCP): two new tables `pec_review_requests` and `pec_review_bonuses`; `reviews` widened for the Zapier Google feed (source/platform/external_id/reviewer_name/review_text/review_url/posted_at/match_status/matched_by/matched_at/crew_lead/crew_id/review_request_id) with `job_id` and `customer_id` NOT NULL DROPPED (a Google review arrives before we know whose job it is); `pec_drip_campaigns_kind_check` recreated to admit 'review' (verified live via pg_get_constraintdef); seven `review_*` settings keys (settings 58 rows to 65). The seeded Review request campaign is mode **'live'** (decision 15): the approval gate is its only safety.

Refreshed 2026-07-31 (Claude Code) after the lead-source-unification migration (2026-08-05_lead_source_unification.sql, applied via MCP): `pec_lead_sources.aliases` (text[] not null default '{}'), six new managed rows (19 to 25), and a data-only rewrite of `leads.source` (9 rows: meta->Facebook, google->Google, manual->Manual entry, other->Other, webform->Website, word_of_mouth->Word of Mouth) and `customers.lead_source` (0 rows changed; values were already managed names, 55 nulls untouched). Only the pec_lead_sources section changed shape.

Refreshed 2026-08-01 (Claude Code) after the prompt-62 migration (2026-08-06_prompt62_lead_customer_estimate.sql, applied via MCP and verified by information_schema/pg_indexes re-query): `leads.business_name` / `leads.archived_at` / `leads.lost_notes` (all nullable), `estimates.customer_id` (uuid, nullable, FK -> customers.id), and indexes `estimates_customer_id_idx` + `leads_archived_at_idx`. Row counts refreshed off live: leads 6 to 11, estimates 5 to 9. Additive only; no CHECK constraint changed (there is deliberately NO estimate_draft lead stage; the pipeline Drafts column is derived from estimates.status).

Refreshed 2026-08-02 (Claude Code) after the prompt-64 migration (2026-08-07_prompt64_presentation.sql, applied via MCP and verified by re-query): new table `pec_presentation_sections` (presentation literature: brand + kind CHECKs, jsonb images of storage paths, sort_order, active; index idx_pec_presentation_brand_order; RLS policy pec_presentation_staff), two settings keys `presentation_reviews_count` (seeded '3') and `presentation_reviews_min_rating` (seeded '4') (settings 66 rows to 68), and NOT a public-schema table: the `pec-presentation` Storage bucket (public, image/jpeg+png+webp, 5 MB) with four pec_presentation_* storage.objects policies. Additive only.

Refreshed 2026-08-05 (Claude Code) after the prompt-72 migration (2026-08-11_prompt72_optional_lines.sql, applied via MCP and verified by information_schema re-query): `estimate_areas.is_optional` (boolean not null default false, the source of truth for an optional area/custom line, mirrored onto estimate_line_items at save) and `estimate_areas.preselected` (boolean not null default true, whether an optional line starts ticked for the customer); `estimates.price_all_options` (numeric nullable, the every-line-at-full-value ceiling; `estimates.price` becomes the required-only floor while open and the signed total after acceptance); three `optional_lines_*` settings keys (enabled 'true', preselect_default 'true', gp_warn_pct '40' seeded from the live line-pricing floor; settings 78 rows to 81). Forward-only, NO backfill: pre-72 rows read is_optional=false everywhere and behave byte-identically.

Refreshed 2026-08-04 (Claude Code) after the prompt-70 migration (2026-08-10_prompt70_pricing_intelligence.sql, applied via MCP and verified by re-query): two settings keys seeded, estimate_ai_enabled 'true' and comps_min_sample '3' (settings 76 rows to 78). Data-only: no table or column changed. Behavioral notes recorded here because they change what stored jsonb means: production/comps.js buildComps is HARD-FILTERED on system type since prompt 70 (the ladder is exact -> same-system any-size -> none; the old similar_size/any rules can no longer be produced but stay renderable for pre-70 pricing_snapshot rows), and estimates.pricing_snapshot.ai now carries a `lines` array (one recommendation per estimate line with a server-computed confidence flag) whose top-level recommended_low/high/why keep the legacy shape (the roll-up), so both vintages render on the estimate detail page.

Refreshed 2026-08-04 (Claude Code) after the prompt-69 migration (2026-08-09_prompt69_per_line_pricing.sql, applied via MCP and verified by information_schema re-query): `estimate_areas` gained eight nullable/defaulted columns for per-line pricing and custom lines (`is_custom` boolean not null default false, `custom_label`, `custom_scope`, `custom_material_cost`, `custom_labor_hours`, `notes` [INTERNAL, never customer-facing], `calc_price`, `price_override`), and five `line_pricing_*` settings keys were seeded (line_pricing_gp_floor_pct '40' [copied from the live estimator_floor_gp_pct so day-one behavior is unchanged], line_pricing_block_below_floor 'false', line_pricing_custom_label_default 'Custom work', line_pricing_reason_threshold_pct '2', line_pricing_reason_threshold_dollars '100'; settings 71 rows to 76). Forward-only, NO backfill: existing estimate_areas rows keep every stored amount. A row with `is_custom=true` is a typed custom line (label/scope/material cost/labor hours typed; its price lives in `price_override`, `calc_price` stays null); on a calculator area `calc_price` is that line's own solved cost-plus price and `price_override` is a rep-typed per-line price (null = use calc_price).

Refreshed 2026-08-04 (Claude Code) after the prompt-68 migration (2026-08-08_prompt68_busybusy_autocreate.sql, applied via MCP and verified by re-query): three `busybusy_autocreate_*` settings keys seeded (busybusy_autocreate_enabled 'true', busybusy_autocreate_radius_m '150', busybusy_autocreate_reminders 'false'; settings 68 rows to 71). Data-only: no table or column changed. Behavioral note recorded here because it reuses existing columns: a `pec_prod_busybusy_projects` row with `linked_by`/`linked_at` NULL and a `job_id` set is a PENDING link created by the accept path (netlify/functions/_pec-busybusy.cjs) at estimate acceptance, carrying the estimate digits as `project_number`; the importer's number-first match confirms it when hours arrive.

**Rule: Consult this before writing any SQL or supabase-js select. Regenerate after applying migrations.**

84 tables documented, 84 live, all in `public`, all with RLS enabled. No gaps.

## Key relationships

- **jobs ↔ customers**: customer name lives on `public.customers` (`name`, plus `first_name`/`last_name`/`company_name`), reached via `jobs.customer_id → customers.id`. Verified against the live dump: `jobs` has **no** `customer_name` column (49 columns, none of them name/email/phone).
- `jobs.id` is the hub of the HQ side: referenced by `estimates`, `job_areas`, `job_colors`, `pec_payments`, `pec_notifications`, `pec_portal_views`, `pec_change_order_batches`, `pec_change_order_signatures`, `photos`, `reviews`, `timeline_stages` (all via `job_id`).
- `customers.id` has declared FKs from `jobs`, `leads`, `pec_call_log`, `pec_portal_views`, `pec_prod_jobs`, `referrals`, `reviews` (all via `customer_id`). Note: `pec_email_log`, `pec_sms_log`, and others also carry `customer_id` columns but with **no FK constraint declared**: joins still work, integrity is not enforced.
- Production side is a parallel world: `pec_prod_jobs` is the hub there (referenced by `pec_prod_areas`, `pec_prod_labor_entries`, `pec_prod_job_costing`, `pec_prod_material_lines`, schedule/bonus/costing tables, and self-referenced via `original_job_id`). `pec_prod_products` is the most-referenced table overall (16 FKs, from estimate/job/prod area material, recipe-slot, and color-pairing tables).
- `jobs.system_type_id → pec_prod_system_types.id` is the main bridge between the HQ and production sides; `pec_prod_jobs.customer_id → customers.id` links production jobs back to shared customers.
- `admin_users.id` is referenced by `user_permissions`, `pec_user_todos`, `pec_whats_new_acks`; `admin_users.auth_user_id → auth.users.id`.
- `pec_appointments` (sales appointments) links to `customers` (`customer_id`) and `pec_sales_team_members` (`sales_member_id`, the assignee), and carries `lead_id` with **no FK** (an appointment outlives its lead). Google two-way-sync bookkeeping lives on `google_event_id/google_calendar_id/google_etag/google_updated`. Per-member Google OAuth tokens sit in `pec_sales_member_google_tokens` (**RLS on, zero policies: default-deny, service-role only** — do not add a policy); client-readable connection flags (`google_connected/google_email/google_calendar_id/google_connected_at`) are on `pec_sales_team_members`.

## Gotchas

- **Asymmetric timestamps on the comms logs** (verified in dump): `pec_email_log` has `sent_at` (default `now()`) plus `opened_at`/`clicked_at`/`bounced_at`: it has **no** `created_at`. `pec_sms_log` has `created_at` (default `now()`) and **no** `sent_at`. Don't assume the same "when" column across the two logs.
- **supabase-js does not throw on a nonexistent column.** Selecting a bad column returns an in-band error on the response (`res.error`) with `res.data` null/empty. A mysteriously empty read means: check `res.error` first, before suspecting RLS.
- `pec_payments` has **no** `created_at`: its timestamps are `received_date` (date) and `recorded_at`.
- `jobs` vs `pec_prod_jobs` are different tables: `pec_prod_jobs` (the production/sync side) *does* carry a denormalized `customer_name` column; `jobs` (HQ side) does not: join to `customers`.
- All 64 tables have RLS enabled; server-side code needs the service-role key or matching policies.
- `public.pec_schema_probe(jsonb)` (added 2026-07-25, prompt 48) is the drift checker's batched existence query: it answers table/column/index/setting probes and returns every live public table for reverse-drift comparison. SECURITY DEFINER with `search_path` pinned, `stable`, read-only. EXECUTE is granted to service_role ONLY (revoked from public/anon/authenticated), because it reads pg_catalog; do not expose it to the browser. It exists because PostgREST cannot see pg_indexes or pg_tables directly.

## Tables (alphabetical)

### admin_users
RLS: enabled · rows: 6

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| auth_user_id | uuid | yes |  |
| email | text | no |  |
| name | text | no |  |
| role | text | no | 'office' |
| created_at | timestamptz | no | now() |
| company | text | no | 'both' |

PK: id
FK: auth_user_id → auth.users.id

### audit_log
RLS: enabled · rows: 754

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| auth_user_id | uuid | yes |  |
| admin_email | text | yes |  |
| action | text | no |  |
| entity_type | text | no |  |
| entity_id | uuid | yes |  |
| before_json | jsonb | yes |  |
| after_json | jsonb | yes |  |
| created_at | timestamptz | no | now() |

PK: id

### colors
RLS: enabled · rows: 21

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| type | text | no |  |
| hex | text | yes |  |
| swatch_image | text | yes |  |
| category | text | yes |  |
| created_at | timestamptz | no | now() |
| sku | text | yes |  |
| product_id | uuid | yes |  |
| default_basecoat_product_id | uuid | yes |  |
| active | boolean | no | true |

PK: id
FK: product_id → pec_prod_products.id; default_basecoat_product_id → pec_prod_products.id

Added 2026-07-29 (prompt 57 Part G). `colors` is now the source of truth for the FLAKE BLEND, not just a swatch list. For `category = 'flake-blend'` rows (21 of them, all `type = 'simiron'`):
- `product_id` is which `pec_prod_products` row PRICES this blend. 18 point at `Standard Flake` (8fb6d88d, $87.44 / 325); Obsidian, Autumn Brown and Stonewash point at their own surviving products because their cost or spread rate differs.
- `default_basecoat_product_id` carries the flake-to-basecoat pairing that used to live on the flake PRODUCT. All 21 were backfilled from their matching product and verified identical to the pre-migration pairing.
- Six rows (Garnet, Obsidian, Pumice, Schist, Stonewash, Wombat) were INSERTED by that migration. Their `hex` values are derived neutrals, NOT sourced from Simiron, and their `sku` is deliberately NULL. Dylan owes real chip values.
- NAMING DRIFT, known and deliberate: these rows carry `type = 'simiron'` while the matching products carry `manufacturer = 'Torginol'`. Torginol makes the flake, Simiron supplies it. Flagged, not reconciled.

### customers
RLS: enabled · rows: 91

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| token | text | no |  |
| name | text | no |  |
| email | text | yes |  |
| phone | text | yes |  |
| company | text | no | 'prescott-epoxy' |
| archived_at | timestamptz | yes |  |
| created_at | timestamptz | no | now() |
| first_name | text | yes |  |
| last_name | text | yes |  |
| company_name | text | yes |  |
| billing_address_line1 | text | yes |  |
| billing_address_line2 | text | yes |  |
| billing_city | text | yes |  |
| billing_state | text | yes |  |
| billing_zip | text | yes |  |
| lead_source | text | yes |  |
| tags | ARRAY | no | '{}' |
| stripe_customer_id | text | yes |  |
| sms_opt_out | boolean | no | false |
| sms_opt_out_at | timestamptz | yes |  |
| phone_norm | text | yes | 
CASE
    WHEN (length(regexp_replace(COALESC... |
| routemize_contact_id | text | yes |  |

PK: id

### estimate_area_materials
RLS: enabled · rows: 9

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| estimate_area_id | uuid | no |  |
| recipe_slot_id | uuid | yes |  |
| slot_label | text | yes |  |
| slot_kind | text | yes |  |
| material_type | text | yes |  |
| product_id | uuid | yes |  |
| choice_value | text | yes |  |
| text_value | text | yes |  |
| pick_index | integer | no | 0 |
| is_custom | boolean | no | false |
| order_index | integer | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: estimate_area_id → estimate_areas.id; product_id → pec_prod_products.id; recipe_slot_id → pec_prod_recipe_slots.id

### estimate_areas
RLS: enabled · rows: 6

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| estimate_id | uuid | no |  |
| name | text | no | 'Main' |
| sqft | numeric | yes |  |
| system_type_id | uuid | yes |  |
| flake_product_id | uuid | yes |  |
| basecoat_product_id | uuid | yes |  |
| topcoat_product_id | uuid | yes |  |
| basecoat_cure_speed | text | yes |  |
| topcoat_cure_speed | text | yes |  |
| answers | jsonb | yes |  |
| sort_order | integer | no | 0 |
| created_at | timestamptz | no | now() |
| mvb | boolean | no | false |
| is_custom | boolean | no | false |
| custom_label | text | yes |  |
| custom_scope | text | yes |  |
| custom_material_cost | numeric | yes |  |
| custom_labor_hours | numeric | yes |  |
| notes | text | yes |  |
| calc_price | numeric | yes |  |
| price_override | numeric | yes |  |
| is_optional | boolean | no | false |
| preselected | boolean | no | true |

PK: id
FK: basecoat_product_id → pec_prod_products.id; estimate_id → estimates.id; flake_product_id → pec_prod_products.id; system_type_id → pec_prod_system_types.id; topcoat_product_id → pec_prod_products.id

Optional lines (prompt 72, 2026-08-05): `is_optional` on the AREA row is the source of truth for whether an area/custom line is optional (the estimator reloads areas by position, never by id) and is MIRRORED onto the matching estimate_line_items row at save; every downstream read keeps using estimate_line_items.is_optional/selected_by_customer. `preselected` = whether an optional line starts TICKED for the customer (opt-out; add-ons stay opt-in and ignore these columns). Ignored while is_optional is false.

Per-line pricing / custom lines (prompt 69, 2026-08-04): an estimate_areas row is the ONE line unit. Calculator area: `calc_price` = that line's own solved cost-plus price, `price_override` = rep-typed per-line price (null = use calc_price). Custom line: `is_custom=true`, typed `custom_label`/`custom_scope`/`custom_material_cost`/`custom_labor_hours`, typed price in `price_override`, `calc_price` null, no catalog products. `notes` is INTERNAL per-line context fed to scope generation, never rendered customer-facing. All nullable/defaulted, no backfill: pre-69 rows have them null/false and render unchanged.

### estimate_installments
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| estimate_id | uuid | no |  |
| seq | integer | no | 0 |
| label | text | no | ''::text |
| amount_kind | text | no | 'percent' |
| amount_value | numeric | no |  |
| trigger_kind | text | no | 'manual' |
| due_date | date | yes |  |
| is_deposit | boolean | no | false |
| note | text | yes |  |
| created_at | timestamptz | no | now() |
| created_by | uuid | yes |  |

PK: id
FK: estimate_id → estimates.id ON DELETE CASCADE
CHECK: amount_kind in ('fixed','percent'); trigger_kind in ('on_acceptance','on_start','on_completion','manual','date'); amount_value >= 0
Indexes: idx_estimate_installments_estimate (estimate_id, seq); uq_estimate_installments_deposit UNIQUE (estimate_id) WHERE is_deposit — at most ONE deposit row per estimate, mirroring the job-side constraint.
Live since 2026-08-13_prompt74_estimate_schedule_terms.sql (prompt 74): the estimate-side payment schedule, created and approved BEFORE the customer signs. Deliberately mirrors pec_invoice_installments field-for-field MINUS computed_amount and the send-lifecycle columns: dollars are computed at render (percent rows recompute live as the customer ticks optional lines) and frozen into estimates.signature at acceptance, then copied to pec_invoice_installments as the job's planned installments (replacing the legacy auto-prepared deposit). Math lives in production/estimate-installments.cjs (fixture-tested); zero rows = the estimate behaves exactly as before prompt 74.

### estimate_line_items
RLS: enabled · rows: 10

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| estimate_id | uuid | no |  |
| addon_id | uuid | yes |  |
| estimate_area_id | uuid | yes |  |
| label | text | no |  |
| description | text | yes |  |
| qty | numeric | no | 1 |
| unit_price | numeric | no | 0 |
| unit_cost | numeric | no | 0 |
| total | numeric | no | 0 |
| is_optional | boolean | no | false |
| selected_by_customer | boolean | no | false |
| sort_order | integer | no | 0 |
| created_at | timestamptz | no | now() |

PK: id
FK: addon_id → pec_prod_addons.id; estimate_area_id → estimate_areas.id; estimate_id → estimates.id

### estimates
RLS: enabled · rows: 9

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| lead_id | uuid | yes |  |
| customer_id | uuid | yes |  |
| brand | text | no | 'PEC' |
| system_type_id | uuid | yes |  |
| status | text | no | 'draft' |
| intake | jsonb | yes |  |
| materials_cost | numeric | yes |  |
| fixed_addons | numeric | no | 0 |
| labor_pct | numeric | yes |  |
| commission_pct | numeric | yes |  |
| target_gp_pct | numeric | yes |  |
| price | numeric | yes |  |
| price_increment | numeric | yes |  |
| gp_dollars | numeric | yes |  |
| gp_pct | numeric | yes |  |
| gp_per_hour | numeric | yes |  |
| labor_budget | numeric | yes |  |
| commission_dollars | numeric | yes |  |
| budgeted_hours | numeric | yes |  |
| material_plan | jsonb | yes |  |
| scope_of_work | text | yes |  |
| calc_version | text | yes |  |
| public_token | text | yes | (gen_random_uuid()) |
| signature | jsonb | yes |  |
| signed_name | text | yes |  |
| signed_at | timestamptz | yes |  |
| signed_ip | text | yes |  |
| deposit_payment_id | uuid | yes |  |
| deposit_amount | numeric | yes |  |
| job_id | uuid | yes |  |
| pec_prod_job_id | uuid | yes |  |
| created_by | uuid | yes |  |
| created_at | timestamptz | no | now() |
| sent_at | timestamptz | yes |  |
| accepted_at | timestamptz | yes |  |
| updated_at | timestamptz | no | now() |
| client_updated_at | timestamptz | yes |  |
| rev | integer | no | 0 |
| deleted_at | timestamptz | yes |  |
| estimate_number | integer | yes | nextval('estimates_estimate_number_seq') |
| line_items | jsonb | yes |  |
| crew_notes | text | yes |  |
| custom_sqft | numeric | yes |  |
| mvb | text | no | 'none' |
| flake_color | text | yes |  |
| customer_name | text | yes |  |
| customer_email | text | yes |  |
| customer_phone | text | yes |  |
| customer_address | text | yes |  |
| change_request_note | text | yes |  |
| rejected_reason | text | yes |  |
| rejected_at | timestamptz | yes |  |
| pricing_snapshot | jsonb | yes |  |
| scope_edited_at | timestamptz | yes |  |
| scope_stale | boolean | no | false |
| scope_generated_at | timestamptz | yes |  |
| scope_model | text | yes |  |
| scope_answers | jsonb | no | '{}' |
| scope_questions | jsonb | no | '[]' |
| calc_price | numeric | yes |  |
| price_override_reason | text | yes |  |
| price_overridden_by | uuid | yes |  |
| price_overridden_at | timestamptz | yes |  |
| deleted_by | uuid | yes |  |
| customer_first_name | text | yes |  |
| customer_last_name | text | yes |  |
| customer_company | text | yes |  |
| customer_is_commercial | boolean | yes |  |
| customer_address1 | text | yes |  |
| customer_address2 | text | yes |  |
| customer_city | text | yes |  |
| customer_state | text | yes |  |
| customer_zip | text | yes |  |
| is_custom | boolean | yes | false |
| custom_scope | text | yes |  |
| custom_price | numeric | yes |  |
| price_all_options | numeric | yes |  |

PK: id
FK: customer_id → customers.id; job_id → jobs.id; lead_id → leads.id; pec_prod_job_id → pec_prod_jobs.id; system_type_id → pec_prod_system_types.id

### job_area_materials
RLS: enabled · rows: 253

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_area_id | uuid | no |  |
| recipe_slot_id | uuid | yes |  |
| slot_label | text | yes |  |
| slot_kind | text | yes |  |
| material_type | text | yes |  |
| order_index | integer | no | 0 |
| pick_index | integer | no | 0 |
| product_id | uuid | yes |  |
| choice_value | text | yes |  |
| text_value | text | yes |  |
| is_custom | boolean | no | false |
| created_at | timestamptz | yes | now() |

PK: id
FK: job_area_id → job_areas.id; product_id → pec_prod_products.id; recipe_slot_id → pec_prod_recipe_slots.id

### job_areas
RLS: enabled · rows: 127

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| name | text | yes | 'Main' |
| sqft | numeric | yes |  |
| system_type_id | uuid | yes |  |
| flake_product_id | uuid | yes |  |
| basecoat_product_id | uuid | yes |  |
| order_index | integer | yes | 0 |
| created_at | timestamptz | yes | now() |
| topcoat_cure_speed | text | yes |  |
| price | numeric | yes |  |
| description | text | yes |  |
| is_change_order | boolean | no | false |
| flake_color_id | uuid | yes |  |

PK: id
FK: basecoat_product_id → pec_prod_products.id; flake_product_id → pec_prod_products.id; flake_color_id → colors.id; job_id → jobs.id; system_type_id → pec_prod_system_types.id

`flake_color_id` added 2026-07-29 (prompt 57 Part G): which BLEND the area carries. `flake_product_id` still prices it. Backfilled from the product's `color` name for Torginol blend rows only, so 54 rows carry a colour and 22 do not (those 22 are Simiron Special, Special Order, Standard Flake, or a quartz/metallic product stored in the same generic swatch column).

### job_colors
RLS: enabled · rows: 1

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| color_id | uuid | no |  |
| label | text | no |  |

PK: id
FK: color_id → colors.id; job_id → jobs.id

### jobs
RLS: enabled · rows: 86

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| customer_id | uuid | no |  |
| type | text | no |  |
| address | text | yes |  |
| package | text | yes |  |
| status | text | no | 'signed' |
| scope | text | yes |  |
| sqft | text | yes |  |
| price | numeric | yes |  |
| monthly_payment | numeric | yes |  |
| warranty | text | yes |  |
| dripjobs_url | text | yes |  |
| dripjobs_deal_id | text | yes |  |
| confirmed | boolean | no | false |
| signature_data | text | yes |  |
| confirmed_at | timestamptz | yes |  |
| source | text | no | 'native' |
| archived_at | timestamptz | yes |  |
| created_at | timestamptz | no | now() |
| job_class | text | yes |  |
| system_type_id | uuid | yes |  |
| companycam_project_id | text | yes |  |
| gate_code | text | yes |  |
| coat_past_garage | boolean | yes |  |
| stem_walls | boolean | yes |  |
| moisture | integer | yes |  |
| mohs_hardness | integer | yes |  |
| additional_non_slip | text | yes |  |
| grinder_tooling_grit | text | yes |  |
| deposit_amount | numeric | yes |  |
| deposit_collected | boolean | no | false |
| signed_date | date | yes |  |
| completed_date | date | yes |  |
| salesperson | text | yes |  |
| bill_to_address | text | yes |  |
| line_items | jsonb | yes |  |
| hq_invoice_number | text | yes | nextval('pec_invoice_number_seq')::text |
| voided_at | timestamptz | yes |  |
| deposit_waived | boolean | no | false |
| colors_confirmed | boolean | no | false |
| colors_confirmed_at | timestamptz | yes |  |
| finalized | boolean | no | false |
| finalized_at | timestamptz | yes |  |
| public_token | uuid | no | gen_random_uuid() |
| public_token_revoked_at | timestamptz | yes |  |
| status_manual_at | timestamptz | yes |  |
| line_items_manual_override | boolean | no | false |
| colors_confirmed_by_customer_at | timestamptz | yes |  |
| invoice_first_sent_at | timestamptz | yes |  |
| crew_notes | text | yes |  |

PK: id
FK: customer_id → customers.id; system_type_id → pec_prod_system_types.id

### lead_events
RLS: enabled · rows: 1

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| lead_id | uuid | no |  |
| event_type | text | no |  |
| from_stage | text | yes |  |
| to_stage | text | yes |  |
| payload | jsonb | yes |  |
| actor_user_id | uuid | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: lead_id → leads.id

### leads
RLS: enabled · rows: 11

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| brand | text | no | 'PEC' |
| source | text | yes |  |
| source_ref | text | yes |  |
| first_name | text | yes |  |
| last_name | text | yes |  |
| business_name | text | yes |  |
| full_name | text | yes |  |
| email | text | yes |  |
| phone | text | yes |  |
| address | text | yes |  |
| city | text | yes |  |
| state | text | yes |  |
| zip | text | yes |  |
| gate_code | text | yes |  |
| stage | text | no | 'new' |
| lost_reason | text | yes |  |
| lost_notes | text | yes |  |
| archived_at | timestamptz | yes |  |
| owner_user_id | uuid | yes |  |
| score | integer | yes |  |
| sms_consent | boolean | no | false |
| sms_consent_source | text | yes |  |
| sms_consent_at | timestamptz | yes |  |
| email_consent | boolean | no | true |
| opted_out | boolean | no | false |
| opted_out_at | timestamptz | yes |  |
| dripjobs_deal_id | text | yes |  |
| customer_id | uuid | yes |  |
| notes | text | yes |  |
| contacted_at | timestamptz | yes |  |
| estimate_scheduled_at | timestamptz | yes |  |
| estimate_sent_at | timestamptz | yes |  |
| presented_at | timestamptz | yes |  |
| accepted_at | timestamptz | yes |  |
| lost_at | timestamptz | yes |  |
| created_by | uuid | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| client_updated_at | timestamptz | yes |  |
| rev | integer | no | 0 |
| deleted_at | timestamptz | yes |  |
| campaign | text | yes |  |
| ad_meta | jsonb | yes |  |
| ai_analysis | jsonb | yes |  |
| ai_analyzed_at | timestamptz | yes |  |
| phone_norm | text | yes | 
CASE
    WHEN (length(regexp_replace(COALESC... |
| routemize_contact_id | text | yes |  |

PK: id
FK: customer_id → customers.id
CHECK leads_stage_check: stage in ('new','contacted','estimate_scheduled','estimate_sent','presented','accepted','lost')

### pec_appointment_reminder_rules
RLS: enabled · rows: 2

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| enabled | boolean | no | true |
| audience | text | no |  |
| channel | text | no |  |
| on_book | boolean | no | false |
| offset_minutes | integer | no | 0 |
| appt_type | text | yes |  |
| message_template | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id

### pec_appointment_reminder_sends
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| appointment_id | uuid | yes |  |
| rule_id | uuid | yes |  |
| channel | text | yes |  |
| sent_at | timestamptz | yes | now() |
| status | text | yes |  |

PK: id
FK: appointment_id → pec_appointments.id (on delete cascade); rule_id → pec_appointment_reminder_rules.id (on delete set null)
Unique: (appointment_id, rule_id, channel) — the never-double-send backstop.

### pec_appointments
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| appt_type | text | no |  |
| title | text | yes |  |
| lead_id | uuid | yes |  |
| customer_id | uuid | yes |  |
| sales_member_id | uuid | yes |  |
| start_at | timestamptz | no |  |
| end_at | timestamptz | no |  |
| all_day | boolean | no | false |
| location_address | text | yes |  |
| location_city | text | yes |  |
| location_state | text | yes |  |
| location_zip | text | yes |  |
| location_place_id | text | yes |  |
| notes | text | yes |  |
| customer_notes | text | yes |  |
| status | text | no | 'scheduled' |
| source | text | no | 'topcoat' |
| google_event_id | text | yes |  |
| google_calendar_id | text | yes |  |
| google_etag | text | yes |  |
| google_updated | timestamptz | yes |  |
| created_by | uuid | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| routemize_appt_id | text | yes |  |
| salesask_synced_at | timestamptz | yes |  |
| salesask_sync_hash | text | yes |  |

PK: id
FK: customer_id → customers.id; sales_member_id → pec_sales_team_members.id
Note: lead_id has NO FK (appointment survives its lead's soft-delete). appt_type check: on_site_estimate / project_walkthrough / site_visit / other. status check: scheduled / completed / canceled. source check: topcoat / google / routemize. Unique (google_event_id) where not null; unique (routemize_appt_id) where not null (the Routemize intake idempotency + lookup key; routemize_appt_id = external Routemize appointment id, set when source = 'routemize'). notes = internal "Company notes" (pushed to the Google event description); customer_notes = customer-facing "Job notes" (appended to the customer's confirmation/reminder texts and emails, never pushed to Google).

### pec_bonus_payouts
RLS: enabled · rows: 16

| column | type | nullable | default |
|---|---|---|---|
| bonus_id | uuid | no |  |
| amount | numeric | yes |  |
| paid_on | date | yes |  |
| payroll_date | date | yes |  |
| paid_by | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| reversed_at | timestamptz | yes |  |
| reversed_by | uuid | yes |  |
| reversal_reason | text | yes |  |

PK: bonus_id
FK: bonus_id → pec_prod_job_bonuses.id

### pec_brand_identity
RLS: enabled · rows: 1

| column | type | nullable | default |
|---|---|---|---|
| brand | text | no |  |
| logo_url | text | yes |  |
| primary_color | text | no | '#1e3a5f' |
| accent_color | text | no | '#ea580c' |
| business_name | text | no |  |
| address_line | text | no |  |
| phone | text | yes |  |
| license_number | text | yes |  |
| website | text | yes |  |
| footer_disclaimer | text | yes |  |
| payment_instructions_html | text | yes |  |
| updated_at | timestamptz | no | now() |
| zelle_email | text | yes |  |
| card_surcharge_pct | numeric | no | 3 |
| invoice_intro_text | text | yes |  |
| offline_payment_details_text | text | yes |  |
| invoice_footer_text | text | yes |  |
| invoice_terms_text | text | yes |  |
| estimate_terms_text | text | yes |  |

PK: brand

`estimate_terms_text` (prompt 74, 2026-08-13 migration): the estimate's terms and conditions, per brand, edited in Settings > Brand next to the invoice terms and rendered in a fixed-height scrollable card above the signature on the public estimate. NULL/empty = no terms card renders at all (FTP stays empty until Dylan writes it; note FTP also has no pec_brand_identity row yet, so its estimates fall back to the prescott-epoxy row). Customer-facing: no em dashes.

### pec_call_log
RLS: enabled · rows: 474

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| quo_call_id | text | no |  |
| brand | text | yes |  |
| direction | text | yes |  |
| from_number | text | yes |  |
| to_number | text | yes |  |
| customer_id | uuid | yes |  |
| duration_seconds | numeric | yes |  |
| occurred_at | timestamptz | yes |  |
| summary | text | yes |  |
| next_steps | text | yes |  |
| transcript | jsonb | yes |  |
| status | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
FK: customer_id → customers.id

### pec_change_order_batches
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| token | uuid | no | gen_random_uuid() |
| status | text | no | 'pending' |
| signed_co_ids | ARRAY | yes |  |
| signed_name | text | yes |  |
| signature_data | text | yes |  |
| signed_at | timestamptz | yes |  |
| signer_ip | text | yes |  |
| signer_user_agent | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
FK: job_id → jobs.id

### pec_change_order_signatures
RLS: enabled · rows: 5

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| area_id | uuid | yes |  |
| token | uuid | no | gen_random_uuid() |
| title | text | no |  |
| description | text | yes |  |
| system_name | text | yes |  |
| sqft | numeric | yes |  |
| amount | numeric | no |  |
| status | text | no | 'pending' |
| signed_name | text | yes |  |
| signature_data | text | yes |  |
| signed_at | timestamptz | yes |  |
| signer_ip | text | yes |  |
| signer_user_agent | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| batch_id | uuid | yes |  |

PK: id
FK: area_id → job_areas.id; batch_id → pec_change_order_batches.id; job_id → jobs.id

### pec_commission_payouts
RLS: enabled · rows: 119

| column | type | nullable | default |
|---|---|---|---|
| payment_id | uuid | no |  |
| amount | numeric | no |  |
| paid_on | date | no |  |
| paid_by | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| payroll_date | date | yes |  |

PK: payment_id
FK: payment_id → pec_payments.id

### pec_blasts
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| channel | text | no |  |
| sms_body | text | yes |  |
| email_subject | text | yes |  |
| email_body | text | yes |  |
| audience_filter | jsonb | no | '{}'::jsonb |
| status | text | no | 'draft' |
| total_queued | integer | no | 0 |
| total_sent | integer | no | 0 |
| total_failed | integer | no | 0 |
| total_skipped | integer | no | 0 |
| created_by | uuid | yes |  |
| created_at | timestamptz | no | now() |
| confirmed_at | timestamptz | yes |  |
| completed_at | timestamptz | yes |  |
| updated_at | timestamptz | no | now() |

PK: id
Note: manual blast header (Phase 3). channel CHECK in ('sms','email','both'); status CHECK in ('draft','confirmed','sending','done','canceled'). Recipients are materialized as pec_drip_sends rows with blast_id set (shared ledger). RLS staff-only via is_admin_staff(), no anon.

### pec_drip_campaigns
RLS: enabled · rows: 3

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| kind | text | no | 'lead' |
| status | text | no | 'active' |
| mode | text | no | 'dry_run' |
| max_touches | integer | no | 8 |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
Note: kind CHECK in ('lead','estimate','invoice','review') (extended 2026-07-31, prompt 60); status CHECK in ('active','paused'); mode CHECK in ('dry_run','live'). Seeded campaigns: lead (9-step taper since prompt 73: day-0 instant touch + days 1,2,4,7,11,16,22,30, max_touches 9), estimate (4 steps, days 1,3,7,14), invoice (4 steps, days 0,3,7,14), review (4 steps, days 1,3,7,14, channels sms/sms/email/sms). Lead/estimate/invoice shipped dry_run; **review shipped mode 'live'** (decision 15: the drip_approval_required gate is its safety, plus an enroll-time guard in _pec-drip.cjs). RLS staff-only.

### pec_drip_enrollments
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| lead_id | uuid | yes |  |
| campaign_id | uuid | no |  |
| status | text | no | 'active' |
| next_step_index | integer | no | 0 |
| next_send_at | timestamptz | yes |  |
| stop_reason | text | yes |  |
| enrolled_at | timestamptz | no | now() |
| stopped_at | timestamptz | yes |  |
| updated_at | timestamptz | no | now() |
| subject_type | text | no | 'lead' |
| subject_id | uuid | no |  |

PK: id
FK: lead_id → leads.id (nullable since Phase 3); campaign_id → pec_drip_campaigns.id
Note: subject_type CHECK in ('lead','job'); subject_id is polymorphic (no FK). For subject_type='lead', lead_id stays populated and equals subject_id (CHECK chk_pec_drip_enroll_lead_link; the contact counter + Quo STOP join on lead_id). PARTIAL UNIQUE idx_pec_drip_enroll_one_active_subj on (subject_type, subject_id, campaign_id) WHERE status='active' (replaced the Phase 2 one-active-per-lead index). Index idx_pec_drip_enroll_due on (status, next_send_at). RLS staff-only.

### pec_drip_sends
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| enrollment_id | uuid | yes |  |
| lead_id | uuid | yes |  |
| campaign_id | uuid | yes |  |
| step_index | integer | no |  |
| channel | text | no |  |
| status | text | no |  |
| scheduled_for | timestamptz | yes |  |
| sent_at | timestamptz | yes |  |
| subject | text | yes |  |
| body | text | yes |  |
| provider_id | text | yes |  |
| error_message | text | yes |  |
| created_at | timestamptz | no | now() |
| subject_type | text | yes |  |
| subject_id | uuid | yes |  |
| blast_id | uuid | yes |  |

PK: id
FK: enrollment_id → pec_drip_enrollments.id; lead_id → leads.id; campaign_id → pec_drip_campaigns.id; blast_id → pec_blasts.id (on delete set null)
Note: the send ledger for BOTH drips and blasts, and the 4th source for the Phase 1 times-contacted count (status='sent' only). channel CHECK in ('sms','email'); status CHECK pec_drip_sends_status_check in ('queued','sending','sent','failed','skipped','dry_run'); subject_type CHECK in ('lead','job','customer'). CHECK chk_pec_drip_sends_origin: enrollment_id IS NOT NULL OR blast_id IS NOT NULL (every row belongs to a drip enrollment or a blast). Drip rows keep enrollment_id/campaign_id/lead_id; blast rows have those null, blast_id set, step_index 0. Indexes: idx_pec_drip_sends_lead (lead_id, status), idx_pec_drip_sends_enrollment, idx_pec_drip_sends_blast (blast_id, status) WHERE blast_id IS NOT NULL, idx_pec_drip_sends_subject (subject_type, subject_id). RLS staff-only.

### pec_drip_steps
RLS: enabled · rows: 21

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| campaign_id | uuid | no |  |
| step_index | integer | no |  |
| day_offset | integer | no |  |
| channel | text | no |  |
| ai_guidance | text | yes |  |
| email_subject | text | yes |  |
| active | boolean | no | true |
| fixed_template | text | yes |  |
| fixed_subject | text | yes |  |
| auto_send | boolean | no | false |

PK: id
FK: campaign_id → pec_drip_campaigns.id
Note: UNIQUE (campaign_id, step_index). channel CHECK in ('sms','email','both'). ai_guidance is the per-step instruction to the model (not customer copy); the runner appends real links/amounts from data. Prompt 73 (2026-08-06): ai_guidance became NULLABLE and fixed_template / fixed_subject / auto_send were added. fixed_template set = the step sends that text verbatim after token substitution ({first_name}, {booking_link}, {{#booking_link}}...{{/booking_link}} conditional) with ZERO model calls; auto_send=true = the step bypasses the approval gate and quiet hours (PER-STEP by design, never a global flag). Today exactly one step has them: the lead campaign's day-0 instant touch. RLS staff-only.

### pec_estimate_views
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| estimate_id | uuid | no |  |
| viewed_at | timestamptz | no | now() |
| user_agent | text | yes |  |
| ip | text | yes |  |

PK: id
FK: estimate_id → estimates.id (on delete cascade)
Index: (estimate_id, viewed_at desc). RLS: staff read only via is_admin_staff(); inserts are service-role (the public estimate page logs the view server-side). Feeds the estimate view bell + card summary (prompt 46).

### pec_email_log
RLS: enabled · rows: 25

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| sent_at | timestamptz | no | now() |
| sent_by_user | uuid | yes |  |
| job_id | uuid | yes |  |
| customer_id | uuid | yes |  |
| brand | text | yes |  |
| template_key | text | yes |  |
| to_email | text | yes |  |
| from_email | text | yes |  |
| subject | text | yes |  |
| status | text | no | 'queued' |
| resend_id | text | yes |  |
| opened_at | timestamptz | yes |  |
| clicked_at | timestamptz | yes |  |
| bounced_at | timestamptz | yes |  |
| error_message | text | yes |  |
| body_html | text | yes |  |

PK: id

### pec_email_senders
RLS: enabled · rows: 1

| column | type | nullable | default |
|---|---|---|---|
| brand | text | no |  |
| from_name | text | no |  |
| from_email | text | no |  |
| reply_to | text | yes |  |
| updated_at | timestamptz | no | now() |

PK: brand

### pec_email_templates
RLS: enabled · rows: 2

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| key | text | no |  |
| brand | text | no |  |
| name | text | no |  |
| subject | text | no |  |
| html | text | no |  |
| text_body | text | yes |  |
| vars | jsonb | yes |  |
| updated_at | timestamptz | no | now() |

PK: id

### pec_invoice_installments
RLS: enabled · rows: 2

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| seq | integer | no | 0 |
| label | text | no | ''::text |
| amount_kind | text | no | 'fixed' |
| amount_value | numeric | no |  |
| computed_amount | numeric | no | 0 |
| trigger_kind | text | no | 'manual' |
| due_date | date | yes |  |
| status | text | no | 'planned' |
| is_deposit | boolean | no | false |
| standalone | boolean | no | false |
| note | text | yes |  |
| queued_at | timestamptz | yes |  |
| sent_at | timestamptz | yes |  |
| paid_at | timestamptz | yes |  |
| payment_id | uuid | yes |  |
| created_at | timestamptz | no | now() |
| created_by | uuid | yes |  |

PK: id
FK: job_id → jobs.id ON DELETE CASCADE; payment_id → pec_payments.id ON DELETE SET NULL
CHECK: amount_kind in ('fixed','percent'); trigger_kind in ('on_acceptance','on_start','on_completion','manual','date'); status in ('planned','queued','pending_approval','sent','paid','skipped','canceled'); amount_value >= 0; computed_amount >= 0
Indexes: idx_pec_invoice_installments_job (job_id, seq); idx_pec_invoice_installments_status (status) WHERE status in ('planned','pending_approval'); uq_pec_invoice_installments_deposit UNIQUE (job_id) WHERE is_deposit — at most ONE deposit installment per job, enforced in the database.
Live since 2026-07-22_invoice_installments.sql (partial invoicing, prompt 45). Documented 2026-07-28; it was the one live-but-undocumented table called out in this file's header from 2026-07-27 to 2026-07-28.

### pec_lead_sources
RLS: enabled · rows: 25

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| active | boolean | no | true |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| aliases | text[] | no | '{}' |

PK: id
Note: since 2026-07-31 (prompt 61 Part D) this is THE one lead-source vocabulary: `leads.source` and `customers.lead_source` both hold `name` values (the stored data was rewritten; rows matching nothing were left alone). `aliases` holds the raw tokens intake feeds send ('meta', 'webform', 'google_lsa', ...); `resolveLeadSourceName` (netlify/functions/_pec-lead-source.cjs) maps exact name > case-insensitive name > alias and returns the raw string unchanged (with a warn) on no match. Six rows added by the unification for tokens with no counterpart: Google LSA, Manual entry, Word of Mouth, Angi, Phone Call, DripJobs. Aliases are editable in Settings > Lead sources, so a new feed vocabulary is a data change, not a deploy.

### pec_notifications
RLS: enabled · rows: 20

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| type | text | no |  |
| job_id | uuid | yes |  |
| body | text | yes |  |
| priority | text | no | 'normal' |
| created_at | timestamptz | no | now() |
| read_at | timestamptz | yes |  |
| target_view | text | yes |  |
| target_id | uuid | yes |  |
| target_user_id | uuid | yes |  |

PK: id
FK: job_id → jobs.id; target_user_id → admin_users.id (on delete set null)
Note: target_user_id (prompt 75, applied 2026-08-08) — NULL means shared (every pre-existing row), a value means the bell shows the row only to that user. Client-side DISPLAY filter, not a security boundary: staff RLS still reads the whole table. Index idx_pec_notifications_target_user (target_user_id, created_at desc).

### pec_ops_items
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| source | text | no |  |
| title | text | yes |  |
| body | text | yes |  |
| assigned_to | uuid | yes |  |
| created_by | uuid | yes |  |
| due_date | date | yes |  |
| status | text | no | 'open' |
| link_view | text | yes |  |
| link_id | uuid | yes |  |
| check_key | text | yes |  |
| created_at | timestamptz | no | now() |
| done_at | timestamptz | yes |  |
| done_by | uuid | yes |  |

PK: id
FK: assigned_to → admin_users.id (ON DELETE SET NULL); created_by → admin_users.id (ON DELETE SET NULL); done_by → admin_users.id (ON DELETE SET NULL). Deliberately `admin_users` and NOT `people`: prompt 54's People migration was unapplied when prompt 55 was written, and admin logins are the assignees anyway. Nothing in this feature reads or writes `people`.
CHECK: `source` in ('manual','auto'); `status` in ('open','done','dismissed'); plus the shape constraint `pec_ops_items_shape` — a 'manual' row MUST carry a title and MUST NOT carry a check_key, an 'auto' row MUST carry a check_key. Verified live 2026-07-28: `insert into pec_ops_items (source) values ('manual')` fails with 23514.
Index: `idx_pec_ops_items_auto_check_key` UNIQUE on (check_key) WHERE source = 'auto' — one dismissal per derived item, ever; manual rows have no check_key so they are unaffected (verified live: a second identical 'auto' insert fails with 23505). `idx_pec_ops_items_badge` on (status, assigned_to), which serves the nav badge's open-manual-item count and per-assignee filtering.
Policies (4, on THIS table only, reusing existing helpers with no new permission concept): `pec_ops_items_staff_read` SELECT using `is_admin_staff()`; `pec_ops_items_admin_insert` INSERT with check `is_admin_role()`; `pec_ops_items_admin_update` UPDATE using/with check `is_admin_role()`; `pec_ops_items_admin_delete` DELETE using `is_admin_role()`.
RPC: `pec_ops_item_notify(p_item_id uuid, p_title text, p_assignee text default null)` returns void, SECURITY DEFINER, `search_path = public`, EXECUTE granted to `authenticated`. Raises `admin only` unless `is_admin_role()`; otherwise inserts exactly ONE `pec_notifications` row (type 'ops_item', target_view 'ops', target_id = the item id). It exists because staff sessions cannot insert into pec_notifications directly (that table grants SELECT/UPDATE only), the same pattern as `log_costing_submitted`. Derived Ops Queue checks NEVER call it: they re-derive on every render and would re-fire the bell forever.
WHAT THIS TABLE IS NOT: it is not the queue. The ten Ops Queue checks are DERIVED at render time from tables that already exist, so they self-clear when the underlying data is fixed. This table stores only the two things that cannot be derived — manual items (source='manual') and dismissals of a single derived row (source='auto', keyed by check_key such as 'job_missing_revenue:<uuid>').

### pec_payments
RLS: enabled · rows: 123

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| amount | numeric | no |  |
| method | text | no |  |
| reference | text | yes |  |
| received_date | date | no | ((now() AT TIME ZONE 'America/Phoenix')) |
| recorded_by | text | yes |  |
| recorded_at | timestamptz | no | now() |
| notes | text | yes |  |

PK: id
FK: job_id → jobs.id

### pec_portal_views
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| customer_id | uuid | yes |  |
| customer_token | text | yes |  |
| job_id | uuid | yes |  |
| user_agent | text | yes |  |
| viewed_at | timestamptz | no | now() |

PK: id
FK: customer_id → customers.id; job_id → jobs.id

### pec_presentation_sections
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| brand | text | no |  |
| kind | text | no |  |
| title | text | no |  |
| body | text | yes |  |
| images | jsonb | no | '[]'::jsonb |
| sort_order | integer | no | 0 |
| active | boolean | no | true |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
Note: prompt 64 presentation literature, ONE content store for TWO consumers: the dashboard's full-screen Present mode and the public estimate page both render every ACTIVE row for the estimate's brand in sort_order (no per-estimate storage). CHECKs: brand in ('prescott-epoxy','finishing-touch') (the long pec_brand_identity keys; estimates.brand short forms PEC/FTP are mapped at read time), kind in ('why_us','process','gallery','financing'). `images` is a jsonb array of paths inside the public `pec-presentation` Storage bucket (resized to 1600 px JPEG client-side on upload). body is the mdToSafeHtml markdown subset, customer-facing (no em dashes). Reviews are NOT stored here; the gallery kind pulls them live from `reviews` using the presentation_reviews_count / presentation_reviews_min_rating settings.

### pec_prod_addons
RLS: enabled · rows: 6

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| description | text | yes |  |
| unit | text | no | 'each' |
| default_price | numeric | no | 0 |
| default_cost | numeric | no | 0 |
| is_optional_default | boolean | no | false |
| scope_snippet | text | yes |  |
| system_type_id | uuid | yes |  |
| active | boolean | no | true |
| sort_order | integer | no | 0 |
| created_at | timestamptz | no | now() |

PK: id
FK: system_type_id → pec_prod_system_types.id

### pec_prod_area_tints
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| area_id | uuid | no |  |
| product_id | uuid | no |  |
| attach_to | text | no |  |
| packs | integer | no | 1 |
| order_index | integer | no | 0 |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
FK: area_id → pec_prod_areas.id; product_id → pec_prod_products.id

### pec_prod_areas
RLS: enabled · rows: 43

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| name | text | no | 'Main' |
| sqft | numeric | no |  |
| system_type_id | uuid | no |  |
| flake_product_id | uuid | yes |  |
| basecoat_product_id | uuid | yes |  |
| notes | text | yes |  |
| order_index | integer | no | 0 |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| flake_size | text | yes |  |
| special_order_color | text | yes |  |
| topcoat_product_id | uuid | yes |  |
| basecoat_cure_speed | text | yes |  |
| topcoat_cure_speed | text | yes |  |
| mvb | boolean | no | false |
| flake_color_id | uuid | yes |  |

PK: id
FK: flake_color_id → colors.id; basecoat_product_id → pec_prod_products.id; flake_product_id → pec_prod_products.id; job_id → pec_prod_jobs.id; system_type_id → pec_prod_system_types.id; topcoat_product_id → pec_prod_products.id

`flake_color_id` added 2026-07-29 (prompt 57 Part G): the blend the area carries; `flake_product_id` still prices it. Backfilled from the product colour name for Torginol blend rows (2 rows carried one, 0 blend rows left unmatched).

### pec_prod_busybusy_employees
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| busybusy_name | text | no |  |
| crew_member_id | uuid | yes |  |
| ignored | boolean | no | false |
| first_seen_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id · UNIQUE: busybusy_name
FK: crew_member_id → pec_prod_crew_members.id
Policy: bb_employees_admin_all (ALL, is_admin_staff() both USING and WITH CHECK).
The employee mapping screen's table (Settings > BusyBusy). The payroll export's `EmployeeId` column comes back EMPTY on every row, so `FirstName + ' ' + LastName` is the only identity BusyBusy gives us and this table is how a name becomes a crew member. `ignored = true` means deliberately not production (Aron Bronson is a salesperson). A name with no row, or a row with a null `crew_member_id` and `ignored = false`, is reported as unmapped on every import and its hours never reach costing. No fuzzy matching exists anywhere by design: `pec_prod_crew_members` contains "Preston" with no surname, which would break any auto-match heuristic.

### pec_prod_busybusy_imports
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| window_start | date | no |  |
| window_end | date | no |  |
| imported_by | uuid | yes |  |
| imported_at | timestamptz | no | now() |
| row_count | integer | yes |  |
| total_hours | numeric | yes |  |
| ot_hours | numeric | yes |  |
| overhead_hours | numeric | yes |  |
| employees_seen | integer | yes |  |
| unmapped_employees | text[] | yes |  |
| unlinked_projects | text[] | yes |  |
| anomaly_count | integer | yes |  |
| notes | text | yes |  |

PK: id
Policy: bb_imports_admin_read (SELECT, is_admin_staff()). No write policy: rows are created only inside `pec_busybusy_import()`.
One row per committed pull, and the unit of replacement: `pec_prod_busybusy_time_entries.import_id` cascade-deletes with it. Every derivable summary column is computed inside the function from the rows actually stored, so the audit row cannot disagree with the data.

### pec_prod_busybusy_projects
RLS: enabled · rows: 1

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| project_number | text | yes |  |
| project_name | text | no |  |
| job_id | uuid | yes |  |
| is_overhead | boolean | no | false |
| linked_by | uuid | yes |  |
| linked_at | timestamptz | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: job_id → pec_prod_jobs.id
UNIQUE (partial): uq_pec_bb_projects_number on (project_number) WHERE project_number IS NOT NULL AND project_number <> ''; uq_pec_bb_projects_name on (lower(project_name)) WHERE project_number IS NULL OR project_number = ''. Two schemes that cannot collide: numbered projects key on the number, number-less ones (Shop) on the lowercased name.
Policy: bb_projects_admin_all (ALL, is_admin_staff() both USING and WITH CHECK).
The remembered BusyBusy-project-to-job link. Rule is NAME ONCE, THEN NUMBER: on first sight the import auto-links by exact normalized (lowercased, whitespace-collapsed) `pec_prod_jobs.customer_name` and persists the 7-digit `ProjectNumber`; thereafter the number is the key, so a rename in either system never breaks an established link. BusyBusy project names ARE customer names. Seeded with one row: project_name 'Shop', is_overhead true, so the first import classifies shop time as overhead with no human step. `is_overhead` rows never carry a `job_id`.
NOTE: `pec_prod_jobs.busybusy_project_id` (added 2026-06-13 for the GraphQL API's project GUIDs) is DEAD and superseded by this table. It is left in place so migration replays still work. Do not read it.

### pec_prod_busybusy_time_entries
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| import_id | uuid | no |  |
| work_date | date | no |  |
| employee_name | text | no |  |
| crew_member_id | uuid | yes |  |
| busybusy_project_number | text | yes |  |
| busybusy_project_name | text | yes |  |
| job_id | uuid | yes |  |
| is_overhead | boolean | no | false |
| started_at | timestamptz | yes |  |
| ended_at | timestamptz | yes |  |
| hours | numeric(10,4) | no | 0 |
| wage_type | text | no |  |
| break_hours | numeric(10,4) | no | 0 |
| description | text | yes |  |
| source_export_id | text | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: import_id → pec_prod_busybusy_imports.id (ON DELETE CASCADE); crew_member_id → pec_prod_crew_members.id (SET NULL); job_id → pec_prod_jobs.id (SET NULL)
Indexes: idx_pec_bb_entries_work_date, idx_pec_bb_entries_job, idx_pec_bb_entries_crew_member, idx_pec_bb_entries_import
Policies: bb_entries_admin_read (SELECT, is_admin_staff()); bb_entries_admin_update (UPDATE, is_admin_staff() both clauses, so the mapping and link screens can re-resolve crew_member_id / job_id / is_overhead in place). NO insert or delete policy from the browser: only `pec_busybusy_import()` writes rows.

REPLACED 2026-07-27 (prompt 52). The prior shape (unique `busybusy_entry_id`, `busybusy_member_id`, `busybusy_project_id`, `deleted_at`, `updated_at`, `ot_hours`, upsert-and-soft-delete) is GONE. It was built for the GraphQL sync that never ran, held zero rows, and its design is the exact pattern the Payroll Export API forbids.

Four things to know before writing any query against this table:
1. **Snapshot, not sync.** Storage is DELETE-THEN-INSERT BY DATE RANGE inside `pec_busybusy_import()`. `source_export_id` is the export's calculated Id: deterministic while data is unchanged, but any punch edit regenerates it and one row can split into three. It is for logging and within-run change detection ONLY. Never upsert, join, or dedup on it.
2. **OT lives in `wage_type`, not a column.** Values are 'REG' and 'OT1' verbatim. `hours` is that row's own hours. **Overtime hours for a job or member = sum(hours) WHERE wage_type = 'OT1'**, and total hours = sum(hours) over all rows. This differs from the old `hours` TOTAL plus `ot_hours` convention on `pec_prod_job_manual_labor`, which still applies there.
3. **Split REG/OT1 pairs share a punch.** When a segment crosses the employee's 40th hour of the week, BusyBusy emits two rows with the SAME `started_at`/`ended_at` and project, one REG and one OT1, whose hours divide the span. Each hour of wall time appears in exactly one row so summing never double counts, but there is deliberately NO uniqueness constraint on punch shape: any dedup that ignores `wage_type` silently drops half a pair.
4. **Not every row is costable.** Rows with `is_overhead = true` (Shop) or a null `crew_member_id` (unmapped or ignored person) are stored and reported but MUST be excluded from job labor cost and bonus math. `started_at`/`ended_at` are built with an explicit -07:00 offset (Arizona, no DST); `work_date` comes from the export's own Date column and is authoritative.

Function: `public.pec_busybusy_import(p_window_start date, p_window_end date, p_rows jsonb, p_user uuid, p_summary jsonb DEFAULT '{}')` returns the new import id. SECURITY DEFINER, `search_path` pinned to public, gated on `is_admin_staff()`, EXECUTE granted to `authenticated` only (revoked from public and anon). Does insert-audit-row, delete-window, insert-rows in one atomic body so a mid-import failure can never empty a payroll window.

### pec_prod_color_pairings
RLS: enabled · rows: 20

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| flake_product_id | uuid | no |  |
| basecoat_product_id | uuid | no |  |
| is_default | boolean | no | false |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: basecoat_product_id → pec_prod_products.id; flake_product_id → pec_prod_products.id

### pec_prod_costing_sendbacks
RLS: enabled · rows: 2

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| note | text | no |  |
| sent_back_by | text | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: job_id → pec_prod_jobs.id

### pec_prod_crew_member_days_off
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| crew_member_id | uuid | yes |  |
| off_date | date | no |  |
| reason | text | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: crew_member_id → pec_prod_crew_members.id

### pec_prod_crew_members
RLS: enabled · rows: 7

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| crew_id | uuid | yes |  |
| name | text | no |  |
| busybusy_member_id | text | yes |  |
| active | boolean | no | true |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| hourly_wage | numeric | yes |  |

PK: id
FK: crew_id → pec_prod_crews.id

### pec_prod_crews
RLS: enabled · rows: 4

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| active | boolean | no | true |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| color | text | yes |  |

PK: id

`color` added 2026-07-29 (prompt 57 Part F): the hex the Job Schedule bars, Next Day cards, and run sheet fill with, so the calendar reads as who-is-where. Backfilled Davey #10b981, Dylan #ec4899, Kyle #8b5cf6, Landen #f59e0b. A NULL falls back to the system-type colour in the UI, never grey. The system type now rides along as a thin banner on the top edge of the bar.

### pec_prod_holidays
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| holiday_date | date | no |  |
| name | text | yes |  |
| created_at | timestamptz | no | now() |

PK: id

### pec_prod_job_bonuses
RLS: enabled · rows: 36

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| crew_member_id | uuid | yes |  |
| crew_member_name | text | no |  |
| hours_actual | numeric | yes |  |
| amount | numeric | no | 0 |
| note | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| suggested_amount | numeric | yes |  |
| approved_by | text | yes |  |
| approved_at | timestamptz | yes |  |
| review_status | text | yes |  |
| reviewed_by | uuid | yes |  |
| reviewed_at | timestamptz | yes |  |
| review_note | text | yes |  |

PK: id
FK: crew_member_id → pec_prod_crew_members.id; job_id → pec_prod_jobs.id

### pec_prod_job_costing
RLS: enabled · rows: 38

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| materials_ordered_cost | numeric | no | 0 |
| materials_used_cost | numeric | no | 0 |
| equipment_rental_cost | numeric | no | 0 |
| salary_wages_cost | numeric | no | 0 |
| subcontractor_cost | numeric | no | 0 |
| misc_cost | numeric | no | 0 |
| bonus_cost | numeric | no | 0 |
| commission_cost | numeric | no | 0 |
| misc_text | text | yes |  |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| office_notes | text | yes |  |
| office_notes_by | uuid | yes |  |
| office_notes_at | timestamptz | yes |  |

PK: id
FK: job_id → pec_prod_jobs.id

### pec_prod_job_manual_labor
RLS: enabled · rows: 98

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| crew_member_id | uuid | yes |  |
| hours | numeric | no | 0 |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| ot_hours | numeric | no | 0 |

PK: id
FK: crew_member_id → pec_prod_crew_members.id; job_id → pec_prod_jobs.id

### pec_prod_job_schedule_days
RLS: enabled · rows: 222

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| scheduled_date | date | no |  |
| day_index | integer | no | 0 |
| crew_id | uuid | yes |  |
| crew_lead | text | yes |  |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| time_slot | text | yes |  |

PK: id
FK: crew_id → pec_prod_crews.id; job_id → pec_prod_jobs.id

### pec_prod_job_sub_expenses
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| name | text | no |  |
| amount | numeric | no | 0 |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
FK: job_id → pec_prod_jobs.id

### pec_prod_jobs
RLS: enabled · rows: 80

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| proposal_number | text | no |  |
| customer_name | text | no |  |
| address | text | yes |  |
| install_date | date | yes |  |
| crew | text | yes |  |
| status | text | no | 'unscheduled' |
| revenue | numeric | yes |  |
| notes | text | yes |  |
| last_synced_at | timestamptz | yes |  |
| sync_status | text | no | 'dirty' |
| sync_error | text | yes |  |
| completed_at | timestamptz | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| customer_id | uuid | yes |  |
| proposal_id | uuid | yes |  |
| estimated_hours | numeric | yes |  |
| actual_hours | numeric | yes |  |
| sales_team | text | yes |  |
| crew_id | uuid | yes |  |
| crew_lead | text | yes |  |
| callback | boolean | no | false |
| dripjobs_deal_id | text | yes |  |
| standalone_mvb | boolean | no | false |
| job_class | text | yes |  |
| line_items | jsonb | yes |  |
| archived_at | timestamptz | yes |  |
| pending_hidden_at | timestamptz | yes |  |
| is_callback | boolean | no | false |
| original_job_id | uuid | yes |  |
| busybusy_project_id | text | yes |  |
| hours_reconciled_at | timestamptz | yes |  |
| hours_reconciled_by | text | yes |  |
| costing_finalized_at | timestamptz | yes |  |
| costing_finalized_by | text | yes |  |
| costing_submitted_at | timestamptz | yes |  |
| costing_submitted_by | text | yes |  |
| subcontracted | boolean | no | false |
| reschedule_days_owed | integer | no | 0 |
| rescheduled_from | date | yes |  |
| touchup_state | text | yes |  |
| touchup_opened_at | timestamptz | yes |  |
| touchup_closed_at | timestamptz | yes |  |
| touchup_cause | text | yes |  |
| touchup_cause_note | text | yes |  |
| touchup_closed_by | uuid | yes |  |
| touchup_order | integer | yes |  |
| touchup_order_prev | integer | yes |  |
| touchup_billable | boolean | no | false |
| touchup_requested_by | text | yes |  |

PK: id
FK: crew_id → pec_prod_crews.id; customer_id → customers.id; original_job_id → pec_prod_jobs.id
CHECK: `touchup_state` in ('open','scheduled','waiting_customer','done'); `touchup_cause` in ('crew_workmanship','material_failure','customer_expectation','damage_after_install','sales_spec_error','other'). Both NULL on non-callback rows.
Index: `idx_pec_prod_jobs_touchup_queue` on (is_callback, touchup_state, touchup_order), the Touch-ups panel's filter.
Touch-up columns added 2026-07-27 (prompt 51). `touchup_state` is a PARALLEL axis to `status`, not a replacement: a callback stays `status = 'unscheduled'` by design (runScheduleStatusSync skips callbacks; the calendar reads day rows), so a touch-up can be status 'unscheduled' AND touchup_state 'waiting_customer' at the same time. `is_callback` (touch-up visit, from 2026-06-08) is a DIFFERENT column from `callback` (legacy crew-lead quality flag): never conflate them. `pec_prod_jobs_scheduled_needs_revenue` still exempts callbacks, so a billable touch-up (touchup_billable + revenue) passes it trivially.

### pec_prod_labor_entries
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| crew_member | text | no |  |
| role | text | no |  |
| hours | numeric | no |  |
| hourly_rate | numeric | no |  |
| date | date | no |  |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: job_id → pec_prod_jobs.id

### pec_prod_material_lines
RLS: enabled · rows: 142

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| area_id | uuid | yes |  |
| material_type | text | no |  |
| product_id | uuid | yes |  |
| product_name | text | no |  |
| supplier | text | yes |  |
| color | text | yes |  |
| spread_rate | numeric | no |  |
| kit_size | numeric | no | 1 |
| qty_needed | numeric | no | 0 |
| backstock_qty | numeric | no | 0 |
| order_qty | numeric | no | 0 |
| use_backstock | boolean | no | false |
| ordered | boolean | no | false |
| delivered | boolean | no | false |
| unit_cost_snapshot | numeric | yes |  |
| line_cost | numeric | yes |  |
| order_index | integer | no | 0 |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| cure_speed | text | yes |  |
| actual_used_qty | numeric | yes |  |
| order_qty_manual | boolean | no | false |
| manual_added | boolean | no | false |

PK: id
FK: area_id → pec_prod_areas.id; job_id → pec_prod_jobs.id; product_id → pec_prod_products.id

### pec_prod_overhead_allocations
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| allocation_type | text | no |  |
| amount | numeric | no |  |
| effective_date | date | no | CURRENT_DATE |
| active | boolean | no | true |
| created_at | timestamptz | no | now() |

PK: id

### pec_prod_products
RLS: enabled · rows: 182

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| material_type | text | no |  |
| supplier | text | yes |  |
| color | text | yes |  |
| spread_rate | numeric | no |  |
| kit_size | numeric | no | 1 |
| unit_cost | numeric | yes |  |
| effective_date | date | no | CURRENT_DATE |
| active | boolean | no | true |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| manufacturer | text | yes |  |
| image_url | text | yes |  |
| default_basecoat_product_id | uuid | yes |  |
| datasheet_path | text | yes |  |
| msds_path | text | yes |  |

PK: id
FK: default_basecoat_product_id → pec_prod_products.id
Added 2026-07-28 (prompt 53): datasheet_path (TDS) and msds_path (MSDS/SDS) hold the Storage OBJECT PATH inside the `pec-datasheets` bucket, never a full URL. The browser builds the link with supabase.storage.from('pec-datasheets').getPublicUrl(path). The bucket is public, PDF-only, 10 MB, with public read and is_admin_staff() writes; it is the app's first Storage feature and was created in SQL by 2026-07-28_product_datasheets.sql.

Changed 2026-07-29 (prompt 57 Part G): product `8fb6d88d-33f3-4886-84d0-5e1eb8321509` was renamed from `Standard Flake (color TBD)` to **`Standard Flake`** with `color = 'Per-job pick'`, and is now THE product behind 18 of the 21 flake blends (the blend itself lives on `colors`, see that section). NO product was deactivated: step 8 of that migration is HELD in `supabase/migrations/2026-07-30_flake_deactivate_collapsed_blends.sql` because the portal RPC and the CRM job-card swatch grid both filter on `active`. `material_type = 'Flake' and active` therefore still counts **25**, not 7.

### pec_prod_recipe_slots
RLS: enabled · rows: 24

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| system_type_id | uuid | no |  |
| order_index | integer | no | 0 |
| material_type | text | no |  |
| default_product_id | uuid | yes |  |
| required | boolean | no | true |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| label | text | yes |  |
| slot_kind | text | no | 'product' |
| min_select | integer | no | 0 |
| max_select | integer | no | 1 |
| options | jsonb | yes |  |
| product_filter | jsonb | yes |  |
| editor_hidden | boolean | no | false |

PK: id
FK: default_product_id → pec_prod_products.id; system_type_id → pec_prod_system_types.id

### pec_prod_system_types
RLS: enabled · rows: 11

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| description | text | yes |  |
| requires_flake_color | boolean | no | false |
| requires_basecoat_color | boolean | no | false |
| active | boolean | no | true |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| color | text | yes |  |
| labor_budget_pct | numeric | yes |  |
| materials_budget_pct | numeric | yes |  |
| sort_order | integer | yes |  |
| target_gp_pct | numeric | yes |  |
| scope_template | text | yes |  |
| scope_template_mvb | text | yes |  |
| deposit_pct | numeric | yes |  |

PK: id

### pec_prod_tasks
RLS: enabled · rows: 14

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| task_date | date | no |  |
| crew_lead | text | yes |  |
| description | text | no |  |
| completed | boolean | no | false |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| crew_id | uuid | yes |  |
| time_slot | text | yes |  |

PK: id
FK: crew_id → pec_prod_crews.id

### pec_review_bonuses
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| review_id | uuid | no |  |
| job_id | uuid | yes |  |
| prod_job_id | uuid | yes |  |
| crew_lead | text | no |  |
| crew_member_id | uuid | yes |  |
| amount | numeric | no | 0 |
| status | text | no | 'pending' |
| approved_by | text | yes |  |
| approved_at | timestamptz | yes |  |
| paid_on | date | yes |  |
| payroll_date | date | yes |  |
| paid_by | text | yes |  |
| voided_at | timestamptz | yes |  |
| voided_by | text | yes |  |
| void_reason | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
FK: review_id → reviews.id (**UNIQUE**: one review can never pay twice, including a Confirm double-click); job_id → jobs.id; prod_job_id → pec_prod_jobs.id; crew_member_id → pec_prod_crew_members.id
Note: added 2026-07-31 (prompt 60). Flat-amount bonus per HUMAN-CONFIRMED 5-star review (amount from settings.review_bonus_amount at confirm time). status CHECK in ('pending','approved','paid','voided'). **Deliberately parallel to pec_prod_job_bonuses and deliberately NOT it**: this ledger must never write pec_prod_job_bonuses or contribute to pec_prod_job_costing.bonus_cost / computeCostingRow / any GP number (decision 13; the prompt-56 lesson: a late bonus moved 34 finalized jobs by $4,785). RLS staff-only.

### pec_review_requests
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| prod_job_id | uuid | yes |  |
| customer_id | uuid | yes |  |
| token | uuid | no | gen_random_uuid() |
| status | text | no | 'asked' |
| crew_lead | text | yes |  |
| crew_id | uuid | yes |  |
| brand | text | no | 'epoxy' |
| asked_at | timestamptz | yes |  |
| job_completed_date | date | yes |  |
| first_clicked_at | timestamptz | yes |  |
| click_count | integer | no | 0 |
| review_id | uuid | yes |  |
| skipped_at | timestamptz | yes |  |
| skipped_by | text | yes |  |
| stop_reason | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
FK: job_id → jobs.id (cascade); prod_job_id → pec_prod_jobs.id; customer_id → customers.id; review_id → reviews.id
Note: added 2026-07-31 (prompt 60). One row per review ask; token is the /r/&lt;token&gt; tracking-link key (UNIQUE). status CHECK in ('asked','clicked','reviewed','skipped','stopped'). crew_lead/crew_id are SNAPSHOTS taken at ask time from pec_prod_jobs and never re-derived (schedule edits must not rewrite attribution history). job_completed_date preserves the real completion date for backfilled asks (asked_at is stamped at enrollment). PARTIAL UNIQUE idx_pec_review_req_one_open on (job_id) WHERE status in ('asked','clicked'): a job never holds two open asks. Index idx_pec_review_req_status_asked on (status, asked_at). RLS staff-only, no anon policy (the public redirect uses the service key).

### pec_sales_member_google_tokens
RLS: enabled (NO policies — default-deny token vault, service-role only) · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| sales_member_id | uuid | yes |  |
| access_token | text | yes |  |
| refresh_token | text | yes |  |
| token_expiry | timestamptz | yes |  |
| sync_token | text | yes |  |
| updated_at | timestamptz | yes | now() |

PK: id
FK: sales_member_id → pec_sales_team_members.id (unique)

### pec_sales_team_members
RLS: enabled · rows: 2

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| active | boolean | no | true |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| commission_pct | numeric | no | 0 |
| exclude_from_commission | boolean | no | false |
| google_connected | boolean | no | false |
| google_email | text | yes |  |
| google_calendar_id | text | yes |  |
| google_connected_at | timestamptz | yes |  |
| auth_user_id | uuid | yes |  |
| name_aliases | text[] | no | '{}' |
| salesask_email | text | yes |  |

PK: id
FK: auth_user_id → auth.users.id
Unique: (auth_user_id) WHERE auth_user_id IS NOT NULL — partial index uq_pec_sales_team_members_auth_user; one login maps to at most one member, any number of unmapped (NULL) rows allowed. Set from Settings > Sales Team; drives the estimator's current-user salesperson default (prompt 47).
name_aliases (added 2026-07-28, prompt 54) is the commission rename safety net. Commission is attributed by FREE-TEXT lowercased name against pec_job_ar.salesperson, not by id, so a rename would otherwise orphan a rep's history. The BEFORE UPDATE trigger `pec_sales_capture_name_alias` captures the OLD name into this array on any rename, whatever path wrote it (People screen, the legacy Sales Team card, or Studio), and removes the current name from the array when a name is reused. renderCommission folds aliases into both the rate lookup and the excluded-names set, current names winning. The trigger is deliberately NOT gated on people_mirror_enabled: it is a safety net, not part of the mirror.
salesask_email (2026-07-31 migration, applied 2026-08-08) is the rep's SalesAsk login override; the sync resolves salesask_email → people.email → google_email.

### pec_salesask_recordings
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| salesask_recording_id | text | no |  |
| appointment_id | uuid | yes |  |
| lead_id | uuid | yes |  |
| customer_id | uuid | yes |  |
| sales_member_id | uuid | yes |  |
| rep_email | text | yes |  |
| occurred_at | timestamptz | yes |  |
| duration_seconds | numeric(10,1) | yes |  |
| status | text | yes |  |
| title | text | yes |  |
| summary | text | yes |  |
| notes | text | yes |  |
| action_items | jsonb | yes |  |
| coaching | jsonb | yes |  |
| tags | jsonb | yes |  |
| process_followed | integer | yes |  |
| process_missed | integer | yes |  |
| process_total | integer | yes |  |
| recording_url | text | yes |  |
| transcript | jsonb | yes |  |
| raw | jsonb | yes |  |
| match_method | text | yes |  |
| transcript_pending | boolean | no | true |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
FK: appointment_id → pec_appointments.id (on delete set null); customer_id → customers.id (on delete set null); sales_member_id → pec_sales_team_members.id (on delete set null)
Unique: salesask_recording_id. lead_id deliberately has NO FK (matches pec_appointments.lead_id, survives lead soft-delete). Indexes: idx_pec_salesask_recordings_customer (customer_id, occurred_at desc), idx_pec_salesask_recordings_appt, idx_pec_salesask_recordings_lead (lead_id, occurred_at desc). Same trust model as pec_call_log: staff READ, service-role write only (pec-webhook-salesask.cjs + pec-salesask-sync.cjs). status: 'processing' | 'processed' | 'processing-failed'. transcript = SalesAsk utterances {speaker,text,start,end} verbatim; raw = last full API/webhook document. match_method: 'event_id' | 'rep_time_window' | 'name_fuzzy' | 'unmatched'.

### pec_sms_log
RLS: enabled · rows: 68

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| created_at | timestamptz | no | now() |
| direction | text | no |  |
| brand | text | yes |  |
| from_number | text | yes |  |
| to_number | text | yes |  |
| customer_id | uuid | yes |  |
| job_id | uuid | yes |  |
| body | text | yes |  |
| kind | text | yes |  |
| status | text | no | 'sent' |
| quo_message_id | text | yes |  |
| error_message | text | yes |  |
| sent_by_user | uuid | yes |  |

PK: id

### pec_sms_senders
RLS: enabled · rows: 2

| column | type | nullable | default |
|---|---|---|---|
| brand | text | no |  |
| from_number | text | no |  |
| quo_inbox_id | text | yes |  |
| active | boolean | no | true |
| updated_at | timestamptz | no | now() |

PK: brand

### pec_status_descriptions
RLS: enabled · rows: 4

| column | type | nullable | default |
|---|---|---|---|
| brand | text | no | 'prescott-epoxy' |
| status | text | no |  |
| body_text | text | no | '' |
| updated_at | timestamptz | no | now() |

PK: brand, status

### pec_stripe_pending
RLS: enabled · rows: 1

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| payment_intent | text | no |  |
| job_id | uuid | no |  |
| kind | text | yes |  |
| amount | numeric | no |  |
| status | text | no | 'pending' |
| failure_message | text | yes |  |
| created_at | timestamptz | no | now() |
| resolved_at | timestamptz | yes |  |

PK: id

### pec_sync_stuck_reports
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| op_id | text | no |  |
| table_name | text | no |  |
| row_id | uuid | yes |  |
| attempts | integer | no | 0 |
| first_queued_at | timestamptz | yes |  |
| last_error | text | yes |  |
| estimate_id | uuid | yes |  |
| reported_at | timestamptz | no | now() |
| resolved_at | timestamptz | yes |  |

PK: id
Unique: (op_id) — the estimator upserts on its outbox op id, so repeated reports from new sessions UPDATE one row instead of piling up.
Index: (resolved_at, reported_at desc) as idx_pec_sync_stuck_reports_open (unresolved first, newest first).
Note: escalation ledger for estimator saves stuck in the offline outbox (prompt 48, Part B). Written service-role-only via pec-sync-stuck.cjs after sync_stuck_threshold_attempts failures; carries ids, attempt count and the raw error, never row bodies or customer PII. RLS: staff SELECT only via public.is_admin_staff(), NO write policy by design. resolved_at is set by the office when the cause is fixed; a later report on the same op clears it and re-bells.

### pec_user_todos
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| admin_user_id | uuid | no |  |
| body | text | no |  |
| done | boolean | no | false |
| created_at | timestamptz | no | now() |
| done_at | timestamptz | yes |  |

PK: id
FK: admin_user_id → admin_users.id

### pec_webhook_ingest_log
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| endpoint | text | yes |  |
| deal_id | text | yes |  |
| customer_name | text | yes |  |
| company | text | yes |  |
| outcome | text | no |  |
| status_code | integer | yes |  |
| message | text | yes |  |
| payload | jsonb | yes |  |
| public_job_id | uuid | yes |  |
| prod_job_id | uuid | yes |  |
| created_at | timestamptz | no | now() |

PK: id
Indexes: (created_at desc); (deal_id)
Note: One row per inbound webhook attempt, from the DripJobs proposal/appointment webhooks and the Routemize appt-intake (endpoint label 'appt-intake'). outcome: ok / rejected / error / bridge_failed. Written by the service role (bypasses RLS); admin-only read via policy pec_webhook_ingest_log_admin_read (public.is_admin_staff()). Powers the Sync Health view. Applied to prod 2026-07-21 (the 2026-06-19 migration had never been applied).

### pec_whats_new_acks
RLS: enabled · rows: 236

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| admin_user_id | uuid | no |  |
| entry_id | text | no |  |
| acked_at | timestamptz | no | now() |

PK: id
FK: admin_user_id → admin_users.id

### people
RLS: enabled · rows: 13

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| full_name | text | no |  |
| display_name | text | yes |  |
| email | text | yes |  |
| phone | text | yes |  |
| birth_month | smallint | yes |  |
| birth_day | smallint | yes |  |
| active | boolean | no | true |
| admin_user_id | uuid | yes |  |
| sales_team_member_id | uuid | yes |  |
| crew_member_id | uuid | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id
FK: admin_user_id → admin_users.id ON DELETE SET NULL; sales_team_member_id → pec_sales_team_members.id ON DELETE SET NULL; crew_member_id → pec_prod_crew_members.id ON DELETE SET NULL
CHECK: birth_month between 1 and 12; birth_day between 1 and 31; people_birthday_both_or_neither ((birth_month IS NULL) = (birth_day IS NULL))
Unique: uq_people_admin_user_id / uq_people_sales_team_member_id / uq_people_crew_member_id, each partial WHERE the column IS NOT NULL — a legacy row belongs to at most one person.
Policies: 4 (staff read via is_admin_staff(); insert/update/delete additionally require has_permission('can_manage_team')).

Live since 2026-07-28_people_model.sql (prompt 54). The unified person record: one row per human across logins, sales reps, and crew members.

**The three pointer columns ARE the roles.** A person holds the Login role iff admin_user_id is set, Sales iff sales_team_member_id is set, Crew iff crew_member_id is set. There is no role table and no role boolean; the pointer is simultaneously the role flag and the identity map, so the two cannot disagree.

**What this table does NOT hold:** hourly_wage, commission_pct, and crew assignment stay on pec_prod_crew_members / pec_sales_team_members. Every existing reader (crew bonus math, the Commission view, schedule capacity, BusyBusy attribution) is unchanged and still reads the legacy tables. `people` carries identity only. Settings > People edits the legacy fields inline, writing the same rows the legacy Settings cards write.

**No year is stored.** birth_month / birth_day only, and no age is computed anywhere in the app.

Mirror (8 triggers, all no-ops when settings.people_mirror_enabled = 'false'):
- people_touch_updated_at — BEFORE UPDATE on people.
- people_mirror_forward — AFTER UPDATE on people; full_name and active write through to the pointed-at legacy rows, changed fields only. No pg_trigger_depth guard, so a reverse-initiated rename still reaches sibling role rows.
- people_adopt_admin_user / people_adopt_sales_member / people_adopt_crew_member — AFTER INSERT on each legacy table, WHEN pg_trigger_depth() = 0; an insert by an existing writer (pec-create-staff.cjs, "+ Add team member") auto-creates its person so no new scatter appears.
- people_follow_admin_rename / people_follow_sales_rename / people_follow_crew_rename — AFTER UPDATE on each legacy table, WHEN pg_trigger_depth() = 0 AND the name changed.
The chain terminates at depth 2. The RPCs suppress echo with the transaction-local GUC `pec.people_sync = 'off'`.

RPCs (both SECURITY DEFINER, both require is_admin_staff() AND can_manage_team):
- pec_people_grant_role(p_person_id uuid, p_role text) — adds a 'sales' or 'crew' role by inserting the legacy row with sync suppressed, then setting the pointer. 'login' is not grantable (creating a login means creating an auth user; that is pec-create-staff.cjs's job).
- pec_people_merge(p_keep uuid, p_remove uuid) — the dedupe screen's Merge. Moves pointers onto the kept person, coalesces identity fields, deletes the losing people row. RAISEs if both people hold the same role (two real records, not a duplicate). Touches no legacy table.

### photos
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| url | text | no |  |
| storage_path | text | yes |  |
| caption | text | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: job_id → jobs.id

### referrals
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| customer_id | uuid | no |  |
| friend_name | text | no |  |
| friend_phone | text | yes |  |
| friend_email | text | yes |  |
| service_interest | text | yes |  |
| status | text | no | 'submitted' |
| payment_amount | numeric | yes |  |
| paid_at | timestamptz | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: customer_id → customers.id

### reviews
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | yes |  |
| customer_id | uuid | yes |  |
| rating | integer | no |  |
| feedback | text | yes |  |
| created_at | timestamptz | no | now() |
| source | text | no | 'manual' |
| platform | text | no | 'google' |
| external_id | text | yes |  |
| reviewer_name | text | yes |  |
| review_text | text | yes |  |
| review_url | text | yes |  |
| posted_at | timestamptz | yes |  |
| match_status | text | no | 'unmatched' |
| matched_by | text | yes |  |
| matched_at | timestamptz | yes |  |
| crew_lead | text | yes |  |
| crew_id | uuid | yes |  |
| review_request_id | uuid | yes |  |

PK: id
FK: customer_id → customers.id; job_id → jobs.id; review_request_id → pec_review_requests.id (on delete set null)
Note: widened 2026-07-31 (prompt 60) from the 6-column stub for the Zapier Google Business Profile feed. **job_id and customer_id are now NULLABLE** (a Google review arrives before we know whose job it is; the intake inserts unmatched and matches after). `external_id` is the Google review id and the intake's idempotency key (partial UNIQUE index uq_reviews_external_id where not null). `review_text` is the customer's public review; the legacy `feedback` column stays for internal notes. CHECKs: source in ('manual','zapier_gbp'); match_status in ('unmatched','auto','confirmed','rejected'). The intake function is FORBIDDEN from writing 'confirmed'; only a human confirm in the Reviews view does, and only 'confirmed' can create a pec_review_bonuses row. crew_lead/crew_id are copied from the request snapshot on match, never re-derived.

### settings
RLS: enabled · rows: 98

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| key | text | no |  |
| value | text | yes |  |
| updated_at | timestamptz | yes | (none, set by trigger) |

PK: id
Trigger: settings_touch_updated_at (BEFORE INSERT OR UPDATE, sets updated_at := now(); the trigger is the ONLY writer, there is no column default). **Do NOT backfill updated_at: a NULL means the row has not been written since the 2026-08-16 prompt-79 migration ran, and that NULL is the audit signal the column exists to provide.** Row-count note: this block previously read 95; a live count on 2026-08-08 (pre-migration) returned 97, so the documented number had drifted by 2 (the live schema wins); 98 after the settings_rail_breakpoint_px seed.
Key added 2026-08-08 (prompt 79): settings_rail_breakpoint_px ('900'; below this viewport width the prompt-80 Settings rail collapses to a single dropdown instead of a vertical list, the estimator_line_sheet_breakpoint_px pattern). Inserted insert-only. Settings 97 rows to 98.
Keys added 2026-08-08 (prompt 77 Part 0, applying the two stranded migrations): salesask_sync_enabled ('false'; nothing pushes to or pulls from SalesAsk until Dylan flips it on AFTER the API key + webhook exist in Netlify), salesask_push_window_days ('14'), salesask_pull_lookback_days ('3'), all in Settings > Appointments; estimate_view_slack_enabled ('true'; #epoxysales post on EVERY logged proposal open, independent of the bell's first-per-day throttle), estimate_hot_min_views ('3') and estimate_hot_window_hours ('48') (hot = views >= min AND last view within the window), all in Settings > Estimates. Settings 89 rows to 95 in this session (the salesask migration's three seeds landed first, then the prompt-75 three).
Keys added 2026-08-07 (prompt 76, applied by that session): estimate_line_generate_enabled ('true'; hides the per-line Generate button when false) and estimator_line_sheet_breakpoint_px ('700'; below this viewport width the line editor is a full-height bottom sheet, above it a centered window), in Settings > Estimates under "Line editor".
Keys added 2026-08-05 (prompt 72), in Settings > Estimates under "Optional lines": optional_lines_enabled ('true'; a CREATE gate: when false the Optional checkbox does not render in the estimator, but already-optional lines on existing estimates still render and work), optional_lines_preselect_default ('true'; whether a newly ticked-Optional area or custom line starts pre-selected for the customer; add-ons always start unselected), optional_lines_gp_warn_pct ('40', seeded from the live line_pricing_gp_floor_pct; the required-only GP% threshold below which the estimator shows the amber warn-not-block notice). Inserted insert-only. Settings 78 rows to 81.
Keys added 2026-08-04 (prompt 70), in Settings > Estimates under "Pricing intelligence": estimate_ai_enabled ('true'; the master switch for the AI price read, gated server-side in pec-estimate-ai.cjs AND client-side, 'false' returns a clean disabled response, never an error) and comps_min_sample ('3'; the ONE sample-size knob shared by the comps ladder in production/comps.js and the per-line AI confidence flag in production/ai-lines.cjs, so the panel and the flag can never disagree about what "thin" means). Inserted insert-only. Settings 76 rows to 78.
Keys added 2026-08-04 (prompt 69), in Settings > Estimates under "Line pricing": line_pricing_gp_floor_pct ('40', seeded from the live estimator_floor_gp_pct; the per-line GP floor that turns a line red in the estimator), line_pricing_block_below_floor ('false', whether a below-floor LINE forces the save confirmation, or only warns), line_pricing_custom_label_default ('Custom work', the prefilled label on a new custom line), line_pricing_reason_threshold_pct ('2') and line_pricing_reason_threshold_dollars ('100') (a written reason is required when the final total lands under the calculated total by more than the GREATER of the two). Inserted insert-only. Settings 71 rows to 76.
Keys added 2026-08-04 (prompt 68), in Settings > BusyBusy under "Project auto-create": busybusy_autocreate_enabled ('true'), busybusy_autocreate_radius_m ('150'), busybusy_autocreate_reminders ('false'). Settings 68 rows to 71.
Keys added 2026-08-02 (prompt 64), in Settings > Presentation: presentation_reviews_count ('3', how many recent reviews the gallery section shows, 1 to 10) and presentation_reviews_min_rating ('4', minimum star rating that qualifies, 1 to 5). Read by pec-public-estimate.cjs (loadLiterature) and the dashboard's Present mode. Inserted insert-only. Settings 66 rows to 68.
Key added 2026-08-01 (prompt 62 Part G), in Settings > Drips: lost_reason_ai_backfill_enabled ('true'; the nightly pec-lost-reason-backfill treats a MISSING row as on too, so this seed is for Settings visibility, and 'false' is the only value that turns the pass off). Settings 65 rows to 66.
Keys added 2026-07-31 (prompt 60), all in Settings > Reviews: review_drip_enabled ('true', master switch for the review campaign, checked ALONGSIDE drip_sending_enabled: both must be 'true'), review_ask_default_on ('true', whether the job close-out popup pre-selects Send), review_bonus_amount ('25', dollars per human-confirmed 5-star review), review_bonus_min_stars ('5', minimum rating that earns credit and a bonus), review_match_window_days ('45', how far back the intake looks for a candidate ask), review_stop_on_touchup ('true', a touch-up or callback opening stops the drip), review_alert_max_stars ('3', a review at or below this raises a bell for Dylan and Anne and stops the enrollment). The Google review URL itself stays on the pre-existing google_review_link_epoxy key. Inserted insert-only. Settings 58 rows to 65.
Keys added 2026-07-28 (prompt 55): twelve `ops_*` keys, all surfaced in Settings > General under "Ops Queue". Ten on/off switches, one per derived check (ops_check_busybusy_unmapped, ops_check_costing_unfinalized, ops_check_missing_revenue, ops_check_never_invoiced, ops_check_missing_salesperson, ops_check_missing_system, ops_check_drip_approvals, ops_check_touchup_age, ops_check_deposit_uncollected, ops_check_system_health, each 'true'), plus two day thresholds: ops_touchup_age_days ('7', a touch-up open longer than this lands on the queue, NOT the same knob as touchup_aging_days '14', which only reddens the Touch-ups panel row) and ops_deposit_age_days ('7', days after signing before an uncollected deposit is flagged). Inserted insert-only, so live edits are never clobbered by a re-run.
Keys added 2026-07-28 (prompt 54): people_mirror_enabled ('true'; set to 'false' and EVERY people sync trigger becomes a no-op, which is the build's real rollback, no deploy needed), birthday_reminder_enabled ('true', master switch for the dashboard banner and the daily bell), birthday_reminder_lead_days ('7', how many days ahead a birthday surfaces).
Keys added 2026-07-28 (prompt 53): datasheet_max_upload_mb ('10', the max PDF size the catalog's data-sheet upload accepts, in MB; the pec-datasheets bucket enforces 10 MB server-side regardless, so raising this above 10 needs a bucket change too).
Keys added 2026-07-27 (prompt 52): busybusy_import_window_weeks ('2', how many full weeks back the Settings > BusyBusy window picker defaults to), busybusy_anomaly_hours_threshold ('16', a single time-entry row longer than this is flagged for review, never dropped), busybusy_overhead_project_names ('Shop', comma-separated BusyBusy project names treated as overhead and never charged to a job), busybusy_export_base_url ('https://export.busybusy.io/', the Payroll Export endpoint).
Keys added 2026-07-27 (prompt 51): touchup_aging_days ('14', days open before a Touch-ups panel row renders red), touchup_default_duration_hours ('2', prefills Estimated hours when scheduling a touch-up), touchup_panel_show_done_days ('30', how far back the panel's Done section reaches).
Keys added 2026-07-25 (prompt 48): migration_drift_check_enabled ('true', master switch for the daily drift check; the on-demand Diagnostics run always works), migration_drift_baseline ('2026-07-01', only migrations dated on/after this are probed), sync_stuck_threshold_attempts ('2', failed attempts before the estimator shows the red not-syncing state), sync_stuck_escalation_enabled ('true', whether a stuck save also raises an admin bell).

### sign_in_log
RLS: enabled · rows: 20

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| auth_user_id | uuid | yes |  |
| email | text | yes |  |
| ip_address | text | yes |  |
| user_agent | text | yes |  |
| signed_in_at | timestamptz | no | now() |

PK: id
FK: auth_user_id → auth.users.id

### timeline_stages
RLS: enabled · rows: 420

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| job_id | uuid | no |  |
| stage_name | text | no |  |
| status | text | no | 'pending' |
| completed_at | timestamptz | yes |  |
| sort_order | integer | no | 0 |

PK: id
FK: job_id → jobs.id

### user_permissions
RLS: enabled · rows: 6

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| admin_user_id | uuid | no |  |
| can_move_pipeline | boolean | no | true |
| can_view_job_costing | boolean | no | true |
| can_override_status | boolean | no | true |
| can_view_commission | boolean | no | true |
| can_edit_catalog | boolean | no | true |
| can_manage_team | boolean | no | true |
| can_manage_settings | boolean | no | true |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |
| can_finalize_costing | boolean | no | true |

PK: id
FK: admin_user_id → admin_users.id
