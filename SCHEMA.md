# TopCoat HQ Dashboard: Supabase Schema Reference (public schema)

Generated 2026-07-21 from the live schema of project `zdfpzmmrgotynrwkeakd` via MCP `list_tables`.

**Rule: Consult this before writing any SQL or supabase-js select. Regenerate after applying migrations.**

68 tables, all in `public`, all with RLS enabled.

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
RLS: enabled · rows: 15

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

PK: id

### customers
RLS: enabled · rows: 84

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

PK: id
FK: basecoat_product_id → pec_prod_products.id; estimate_id → estimates.id; flake_product_id → pec_prod_products.id; system_type_id → pec_prod_system_types.id; topcoat_product_id → pec_prod_products.id

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
RLS: enabled · rows: 5

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| lead_id | uuid | yes |  |
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

PK: id
FK: job_id → jobs.id; lead_id → leads.id; pec_prod_job_id → pec_prod_jobs.id; system_type_id → pec_prod_system_types.id

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

PK: id
FK: basecoat_product_id → pec_prod_products.id; flake_product_id → pec_prod_products.id; job_id → jobs.id; system_type_id → pec_prod_system_types.id

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
| hq_invoice_number | text | yes |  |
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
RLS: enabled · rows: 1

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| brand | text | no | 'PEC' |
| source | text | yes |  |
| source_ref | text | yes |  |
| first_name | text | yes |  |
| last_name | text | yes |  |
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

PK: id
FK: customer_id → customers.id

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

PK: brand

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
Note: kind CHECK in ('lead','estimate','invoice'); status CHECK in ('active','paused'); mode CHECK in ('dry_run','live'). Seeded campaigns: lead (8-step taper, days 1,2,4,7,11,16,22,30), estimate (4 steps, days 1,3,7,14), invoice (4 steps, days 0,3,7,14). All dry_run. RLS staff-only.

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
RLS: enabled · rows: 16

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| campaign_id | uuid | no |  |
| step_index | integer | no |  |
| day_offset | integer | no |  |
| channel | text | no |  |
| ai_guidance | text | no |  |
| email_subject | text | yes |  |
| active | boolean | no | true |

PK: id
FK: campaign_id → pec_drip_campaigns.id
Note: UNIQUE (campaign_id, step_index). channel CHECK in ('sms','email','both'). ai_guidance is the per-step instruction to the model (not customer copy); the runner appends real links/amounts from data. 16 rows across the 3 campaigns. RLS staff-only.

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

### pec_lead_sources
RLS: enabled · rows: 19

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| name | text | no |  |
| active | boolean | no | true |
| notes | text | yes |  |
| created_at | timestamptz | no | now() |
| updated_at | timestamptz | no | now() |

PK: id

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

PK: id
FK: job_id → jobs.id

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

PK: id
FK: basecoat_product_id → pec_prod_products.id; flake_product_id → pec_prod_products.id; job_id → pec_prod_jobs.id; system_type_id → pec_prod_system_types.id; topcoat_product_id → pec_prod_products.id

### pec_prod_busybusy_time_entries
RLS: enabled · rows: 0

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| busybusy_entry_id | text | no |  |
| busybusy_member_id | text | yes |  |
| crew_member_id | uuid | yes |  |
| busybusy_project_id | text | yes |  |
| job_id | uuid | yes |  |
| work_date | date | yes |  |
| hours | numeric | no | 0 |
| started_at | timestamptz | yes |  |
| ended_at | timestamptz | yes |  |
| deleted_at | timestamptz | yes |  |
| updated_at | timestamptz | no | now() |
| created_at | timestamptz | no | now() |
| ot_hours | numeric | no | 0 |

PK: id
FK: crew_member_id → pec_prod_crew_members.id; job_id → pec_prod_jobs.id

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

PK: id

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

PK: id
FK: crew_id → pec_prod_crews.id; customer_id → customers.id; original_job_id → pec_prod_jobs.id

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
RLS: enabled · rows: 127

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
RLS: enabled · rows: 181

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

PK: id
FK: default_basecoat_product_id → pec_prod_products.id

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

PK: id
FK: auth_user_id → auth.users.id
Unique: (auth_user_id) WHERE auth_user_id IS NOT NULL — partial index uq_pec_sales_team_members_auth_user; one login maps to at most one member, any number of unmapped (NULL) rows allowed. Set from Settings > Sales Team; drives the estimator's current-user salesperson default (prompt 47).

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
| job_id | uuid | no |  |
| customer_id | uuid | no |  |
| rating | integer | no |  |
| feedback | text | yes |  |
| created_at | timestamptz | no | now() |

PK: id
FK: customer_id → customers.id; job_id → jobs.id

### settings
RLS: enabled · rows: 17

| column | type | nullable | default |
|---|---|---|---|
| id | uuid | no | gen_random_uuid() |
| key | text | no |  |
| value | text | yes |  |

PK: id

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
