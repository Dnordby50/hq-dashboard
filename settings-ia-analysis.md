# Settings IA Analysis: DripJobs vs TopCoat

Cowork, 2026-08-08. Read-only investigation. No code changed.

---

## 1. What DripJobs actually does

The thing worth copying is not their tab list. It is their **two-tier split**.

### Tier 1 — sidebar "Settings" section (9 items)

These are **records you maintain**, each on its own full page:

| Item | What it is |
| --- | --- |
| Booking Form | list of forms, submissions count, public link, Edit / Duplicate |
| Card Labels | tag list |
| **Company Settings** | the config hub (Tier 2 below) |
| Crews | roster |
| Employees | roster |
| Products / Services | catalog |
| Reminders | reminder rules, grouped For Appointments / For Jobs, then Email / SMS |
| Subcontractors | roster |
| Users | logins and roles |

### Tier 2 — Company Settings, 11 horizontal tabs

Pure configuration, nothing you "add a row to":

1. **Company Information** — account status and plan, company details (name, short name, business type, timezone, license, phone, tax rate), tax registration, physical + billing addresses
2. **Brand** — website URL, review URL, logo, social profiles, Brand Finder
3. **Email Settings** — reply email, BCC on receipt, override reply-to, route replies into DripJobs, custom email domain + DKIM/Return-Path DNS
4. **App Settings** — Tags & Sources (contact tags, payment methods, lead sources, internal lead sources), Schedule Defaults, Lead Assignment Defaults, Pause Drips, on-site estimate comms, countersign
5. **Calendar** — Event Types table (name, calendar, default color, Edit/Delete, Add)
6. **Templates** — one dropdown selector + one rich editor, plus PDF Options
7. **Notifications** — seven flat toggles, each with a one-line description
8. **Payments** — Stripe connection, card, ACH (with fee caps), alternative payments, default deposit/invoice settings, currency
9. **Integrations** — Acorn Finance, CompanyCam, QuickBooks, Angi, Twilio, Routemize
10. **Customer Portal** — hero image, accent color, proposal section order (drag to reorder), About Us, proposal display toggles, trust builders, social proof banner, company documents
11. **Add-Ons** — paid modules

### The five patterns worth stealing

1. **Records live outside the config tabs.** Crews, Employees, Users, Products each get a page. They do not sit as cards inside a settings tab.
2. **Every card has a one-line description under the heading.** "Categorize contacts and track where leads come from." TopCoat has almost none of these.
3. **Tabs are named for the domain, never for the vendor.** BusyBusy would be a card inside Integrations, not a top-level tab.
4. **One tab owns everything the customer sees.** Customer Portal collects hero, colors, section order, trust builders, documents. TopCoat scatters this across Brand, Presentation and Estimates.
5. **Templates is one selector plus one editor**, not N stacked cards.

### Two patterns worth NOT copying

- **App Settings is itself a junk drawer.** Tags, schedule defaults, lead assignment, drip pause, estimate comms and countersign in one tab. That is the same mistake as TopCoat's General. Do not port the name or the shape.
- **Brand is nearly empty and carries a "Portal Accent Color has moved" notice.** That is a visible scar from a split that went wrong. If TopCoat reorganizes, redirect deep links rather than leave breadcrumb notices.

---

## 2. What TopCoat has today

Ten tabs in a horizontally scrolling strip: General, People, Email, Appointments, Drips, Estimates, Invoicing, Presentation, BusyBusy, Brand.

The strip already does not fit. From `settingsTabBar` (index.html:18794):

> the strip scrolls horizontally on narrow windows (no wrap, no dropdown) with a static right-edge fade as the "there's more" affordance

A horizontal nav that needs a fade gradient to hint at hidden items is out of room. That is the structural problem, independent of grouping.

### General is the real offender

One `pec-card` labelled "Settings" holds roughly 30 unrelated knobs in a flat list:

Google review link (Epoxy), Google review link (Paint), Review request drip, Close-out popup default, Review bonus amount, Minimum stars for credit, Review match window, Stop drip on touch-up, Bad review alert threshold, Referral reward amount, Metrics default time window, Metrics AI insight cache, Bonus lock, Touch-up aging, Touch-up default duration, Touch-ups show Done for, Data sheet max upload, Birthday reminders, Birthday reminder lead, People mirror, Crew share of labor savings, Labor burden on wages, Overtime multiplier, Fallback labor budget, Derive labor cost from crew hours, Count an unapproved bonus in gross profit, Financing block (7 fields), Touch-up open threshold, Deposit threshold.

Reviews, metrics, touch-ups, payroll math, birthdays, file upload limits and consumer financing in one undifferentiated column. Below it sit five record lists: Crews, Team Members, Sales Team, Lead Sources, System Types.

### Three findings from the database

Queried live (`settings` table, project `zdfpzmmrgotynrwkeakd`):

**a. 97 rows in `settings`. 78 knobs exposed in the Settings UI. They do not line up.**

**b. 16 of the 78 UI knobs have never been saved once.** Rows only get created on first write, so an absent row means the control has never been touched since it shipped:

```
bonus_crew_fraction_pct, bonus_labor_burden_pct, bonus_lock_days,
bonus_ot_multiplier, costing_count_pending_bonus,
costing_default_labor_budget_pct, costing_labor_from_hours,
financing_apply_url, financing_apr_pct, financing_embed_url,
financing_enabled, financing_min_amount, financing_provider_name,
financing_term_months, metrics_ai_cache_days, metrics_default_window
```

Two whole feature blocks (the entire financing block, the entire labor/bonus costing block) plus both metrics knobs are running on hardcoded defaults. They occupy about a third of the General tab and have produced zero user actions.

**c. About 35 rows in `settings` have no Settings surface at all** — `ops_check_*`, `estimator_charm_band`, `estimator_sundries_pct`, `estimator_target_gp_pct`, `default_labor_hourly_rate`, `drip_kill_switch`, `drip_autosend_email/sms`, `security_alerts_*`, `migration_drift_*`, `metrics_tab_ai_insights`, `estimator_allowed_emails`, `busybusy_export_base_url` and others.

So standing rule 12 is being broken in both directions: knobs shipped that nobody uses, and settings that exist with nowhere to change them.

**d. The `settings` table is `(id, key, value)`.** No `updated_at`. There is no way to tell a live knob from a dead one except by row absence, which only works once. Adding `updated_at` costs one migration and makes every future audit trivial.

---

## 3. Proposed structure

Not a copy of DripJobs' 11 tabs. TopCoat has roughly twice their configuration surface because rule 12 forces every feature to ship knobs, so the container has to be denser.

### Change 1 — vertical rail, not a horizontal strip (the big one)

Replace the scrolling tab strip with a two-column layout: a grouped vertical nav on the left, content on the right. A rail holds 15 items with group headers and no scrolling. This is what DripJobs does and it is why their sidebar reads cleanly at 9 items while TopCoat's strip needs a fade at 10.

### Change 2 — split records from configuration

```
RECORDS
  People            crew members, sales team, logins, roles
  Crews
  System Types      + recipe slots
  Lead Sources
  Appointment Types

CONFIGURATION
  Company           identity, logo, review links, brand colors
  Customer Portal   presentation sections, gallery reviews, status
                    descriptions, financing block, hero
  Templates         email templates, estimate T&C, invoice intro,
                    payment instructions, terms, thank-you, footer,
                    scope templates, sender identities
  Sales & Estimates line editor, line pricing, optional lines, GP
                    floors, pricing intelligence, comps, estimate AI,
                    customer search, hot thresholds, breakpoint,
                    stuck-save
  Invoicing         deposit default, payment schedules, estimate
                    schedule, approval gate, check/cash/Zelle details
  Scheduling        appointment types config, booking confirmations
                    and reminders, Google Calendar sync, job start
                    defaults
  Automations       drip master switch, approval gate, quiet hours,
                    instant reply, review request drip, close-out
                    popup, match window, stop-on-touch-up, referral
                    reward, AI lost-reason backfill
  Notifications     estimate view notifications, Slack, bad review
                    alert, birthday reminders, ops queue thresholds
                    (touch-up open, deposit age)
  Job Costing       labor burden, OT multiplier, crew share, fallback
                    labor budget, derive from crew hours, unapproved
                    bonus in GP, bonus lock, review bonus, touch-up
                    aging / duration / show-done
  Integrations      BusyBusy, Routemize, SalesAsk, Google Calendar,
                    Slack, Stripe, email sending domain, CompanyCam
  Advanced          data sheet upload cap, People mirror, metrics
                    window and AI cache, migration drift, security
                    alerts, ops check toggles
```

Eleven config items plus five record items. General disappears entirely; every one of its 30 knobs lands in a tab named after what it does. BusyBusy stops being a top-level vendor tab and becomes a card in Integrations with a drill-in for import history.

### Change 3 — add a settings search box

Roughly 80 controls. At that count, search beats navigation for anything you touch less than weekly. Filter card and label text, jump to the match, highlight it. DripJobs does not have this. It is the cheapest single improvement per line of code and it makes the tab count stop mattering.

### Change 4 — one-line description under every card heading

DripJobs does this consistently and it is most of why their pages read calmly. TopCoat has a few (the labor burden field has a good one) and mostly does not.

### Change 5 — hide the dead knobs behind "Advanced"

Every card gets its one or two live controls up front and the rest behind a collapsed "Advanced" disclosure. Seed the split from finding (b): the 16 never-saved keys go behind the fold on day one.

---

## 4. The thing that will undo this in six months

Standing rule 12 ("every major feature ships with a settings surface") is what produced the clutter. It is a good rule for avoiding hardcoded values, but it guarantees monotonic growth in the Settings UI, and finding (b) shows a third of what it produced has never been used.

Reorganizing without amending the rule buys time, not a fix. Suggested amendment:

> Every major feature's key parameters must be **stored in the `settings` table** and changeable without a code edit. Only parameters expected to be tuned in normal operation get a **visible** control; the rest sit behind the card's Advanced disclosure. A feature ships at most two front-of-card controls.

That keeps the no-hardcoding guarantee, which is the part that has actual value, and drops the "must be visible" part, which is the part generating the clutter.

---

## 5. Open questions for Dylan

Listed in the chat message alongside this file.
