# SOP Hub Setup — One-Time Configuration

The SOP Hub pulls markdown files from a GitHub repo synced from your Obsidian `SOP Hub/` folder. It uses a Netlify Function to proxy Claude API calls (keeping the key server-side). Follow these steps once.

## 1. Create a public GitHub repo for SOPs

1. Go to github.com → **New repository**
2. Name: `hq-sops`
3. Visibility: **Public** (required for unauth API access)
4. Initialize with a README (optional)
5. Create

## 2. Sync Obsidian `SOP Hub/` folder to the repo

Install the **Obsidian Git** community plugin in your HQ vault:

1. Settings → Community plugins → Browse → search "Obsidian Git" → Install + Enable
2. Open Obsidian Git settings:
   - **Vault backup interval**: 5 minutes (or your preference)
   - **Pull/push on startup**: on
   - **Auto pull**: on
   - **Auto push**: on

Then either:

**Option A — Dedicated repo for SOP Hub only** (recommended):
- `cd` into `~/Desktop/HQ/SOP Hub` in terminal
- `git init && git remote add origin https://github.com/YOUR_USERNAME/hq-sops.git`
- `git add . && git commit -m "Initial SOP sync" && git branch -M main && git push -u origin main`
- Configure Obsidian Git to use this subfolder as a separate repo (see plugin docs on "submodule" / "separate repo" modes)

**Option B — Whole HQ vault as one repo, subfolder only on GitHub**:
- Use GitHub Actions or a pre-commit hook to filter to just `SOP Hub/` on push. More complex. Skip unless you want the whole vault backed up.

**Simplest thing that works:** manually `cd SOP Hub && git push` after editing SOPs. The dashboard will pick up changes within 10 minutes (session cache) or on a fresh login.

## 3. Update CONFIG.SOP_REPO.owner in index.html

Find the `SOP_REPO` block in `CONFIG` (around line 678) and set `owner` to your actual GitHub username. Also update `rawBase` and `apiBase` URLs to match.

Currently set to `dylannordby` — change if your GitHub username is different.

## 4. Set the Anthropic API key in Netlify

1. Go to Netlify → your dashboard site → **Site settings** → **Environment variables**
2. Add a new variable:
   - Key: `ANTHROPIC_API_KEY`
   - Value: (copy the key from `CONFIG.ANTHROPIC_API_KEY` in index.html — the one starting with `sk-ant-api03-...`)
3. Save

The Netlify Function at `netlify/functions/sop-chat.js` reads this env var. The key never ships to the browser.

**Important:** The JARVIS tab still uses the client-side key for backward compatibility. You can remove it from client code once you migrate JARVIS to the function too. Until then, the key remains in `index.html` — that's fine, it was already exposed.

## 5. Verify the Netlify Function deploys

1. Commit + push the dashboard repo. Netlify will detect `netlify.toml` and build functions.
2. Check the deploy log for "Functions bundling" — should show `sop-chat`.
3. Test: `curl -X POST https://YOUR-SITE.netlify.app/.netlify/functions/sop-chat -H 'Content-Type: application/json' -d '{"system":"test","messages":[{"role":"user","content":"hi"}]}'`
4. Should return a Claude response JSON (or a 400/500 with error info).

## 6. Test the SOP Hub end-to-end

1. Open the dashboard, log in with owner password `hq2026`.
2. Click **SOPs** tab (5th tab in the nav).
3. Should load SOPs from GitHub and render cards. Chat panel on right.
4. Ask: "What's in PEC-FIN-001?" — should get an answer from the SOP content.
5. Log out. Log in as `dusty2026`.
6. Should see the employee view — SOPs filtered to PEC + sales role, chat works.
7. Try other codes: `doug2026` (FTP/sales), `justin2026` (PEC/crew), `kyle2026` (PEC/crew).

## 7. Adding/changing employees

Edit `CONFIG.EMPLOYEE_CODES` in index.html. Add new entries like:
```js
'newperson2026': { name: 'First Name', company: 'PEC', role: 'crew', code: 'newperson2026' }
```
Commit + push → Netlify redeploys → they can log in.

## 8. Role-based SOP filtering

By default, every SOP is visible to every role in its company. To restrict:

**Option A — Frontmatter** (edit the SOP markdown file):
```
---
roles: sales,pm
---
# SOP content here
```

**Option B — Inline** (first 10 lines of the .md file):
```
roles: sales,pm
# Actual SOP title
```

Valid role values: `sales`, `crew`, `office`, `pm`, `all`. Comma-separated.

Company is derived from folder: `SOP Hub/PEC/…` → PEC, `SOP Hub/Shared/…` → visible to all companies.

## Troubleshooting

- **"SOP library not yet configured"**: The GitHub repo is empty or the `owner` field in CONFIG doesn't match your GitHub username.
- **GitHub rate limit errors**: Unauthenticated GitHub API allows 60 req/hour per IP. With a normal SOP library (~20-50 files), this is plenty. If you hit it, wait an hour or add a GitHub token to the fetch call.
- **Chat returns "ANTHROPIC_API_KEY not configured"**: The Netlify env var isn't set or Netlify hasn't redeployed. Trigger a new deploy.
- **Employee sees wrong SOPs**: Check the SOP's frontmatter `roles` and path-based company. Owner view shows everything for debugging.
