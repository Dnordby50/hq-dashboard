# Prescott CRM + Customer Portal — one-time setup

One file: everything from the old `prescott-epoxy-portal` is now inside `index.html`. To make it functional, wire up a Supabase project + Netlify env vars.

## 1. Create the Supabase project

1. New project at [supabase.com](https://supabase.com) — any region, any password.
2. In the SQL editor, run (in order):
   - `supabase/schema.sql`
   - `supabase/policies.sql`
   - `supabase/seed_colors.sql`
3. Under **Authentication → Providers**, make sure **Email** is enabled (it is by default). You can leave "Confirm email" on or off — staff users are created pre-confirmed by the `pec-create-staff` Netlify Function, so confirmation emails aren't needed for the Add Staff flow.
4. Under **Storage**, create a bucket named `pec-photos` and set it to **public**. (The policies in `policies.sql` already grant public read + staff write.)

## 2. Paste credentials into `index.html`

In `index.html`, find the `CONFIG` block (search for `SUPABASE_URL`) and replace:

```js
SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
PORTAL_BASE_URL: '' // e.g. 'https://yoursite.netlify.app' — leave '' for window.origin
```

Use the Project URL and the **anon / public** key from Supabase → Project Settings → API. Do NOT paste the service-role key here.

## 3. Netlify env vars (for DripJobs webhooks)

Set in Netlify → Site settings → Environment variables:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Same Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **service_role** key (NOT the anon key) |
| `PEC_WEBHOOK_SECRET` | Any random string; share with DripJobs |

Then point DripJobs webhooks at:

- `https://yoursite.netlify.app/.netlify/functions/pec-webhook-proposal-accepted`
- `https://yoursite.netlify.app/.netlify/functions/pec-webhook-stage-changed`
- `https://yoursite.netlify.app/.netlify/functions/pec-webhook-project-completed`

…with header `x-webhook-secret: <PEC_WEBHOOK_SECRET>` on each.

Two other Netlify Functions use the same `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env vars (no additional setup):

- `pec-log-signin` — called by the browser after sign-in; records IP + timestamp to `sign_in_log`.
- `pec-create-staff` — called from the Team section when you add a staff member; creates the Supabase Auth user and inserts the `admin_users` row.

## 4. First admin bootstrap

There's a chicken-and-egg: you need an admin row to create more staff, but there's no admin yet. Do this one-time bootstrap:

1. In Supabase → **Authentication → Users → Add user → Create new user**, enter your email + a password, and check **"Auto Confirm User"**.
2. In the SQL editor, link that user to the staff table as an admin:

```sql
insert into public.admin_users (auth_user_id, email, name, role)
values (
  (select id from auth.users where email = 'you@example.com'),
  'you@example.com',
  'Your Name',
  'admin'
);
```

3. Open the HQ site, enter the HQ password, click **Prescott CRM** in the sidebar, and sign in with that email + password.
4. From now on, use the **Team** section to add more staff — it creates the auth user + `admin_users` row in one step (via the `pec-create-staff` Netlify Function). Staff can change their own passwords via the "Forgot password?" link on the sign-in screen.

## 5. Test the customer portal

1. In **Customers**, click **+ New Customer**. Fill in a name.
2. Click the row, then the "Copy link" button on that row (or open the customer, make a job, and copy the portal link from the job header).
3. Open that URL in a private window — no HQ password should appear. You should see the customer portal view.

## Notes

- The HQ Dashboard is unchanged. If the Supabase CONFIG is not filled in, the HQ side continues to work; only the Prescott CRM side shows a console warning.
- All customer portal reads/writes go through token-scoped Postgres functions (`get_portal_data`, `portal_confirm_job`, `portal_submit_referral`, `portal_submit_review`), so RLS stays locked down.
- Photos upload to the `pec-photos` Storage bucket; signatures are stored inline on `jobs.signature_data` as a PNG data URL.
- Staff sign-ins write a row to `sign_in_log` (auth_user_id, email, IP, user-agent, timestamp). View the last 20 in the CRM **Team** section; query the full table in Supabase for older history.
- To wipe and re-seed, `drop`-and-re-run the three SQL files. Nothing is in the repo that references `portal.db` from the old project.
