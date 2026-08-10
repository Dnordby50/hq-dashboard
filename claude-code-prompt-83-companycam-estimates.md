# Claude Code Prompt 83: CompanyCam photos on estimates (internal while you price, customer-visible on the proposal)

Run this AFTER prompt 82 is committed. Its own commit, its own migration.

## Context

Today CompanyCam is job-side only. `jobs.companycam_project_id` is picked from a searchable project picker on the job detail (index.html ~15666 for the markup, ~17057 for the IIFE), photos come through the staff-authenticated proxy `netlify/functions/pec-companycam.cjs`, and the Job Schedule +Schedule modal shows the same photos read-only (index.html ~33308). A `jobs` row only exists AFTER the customer accepts, so nothing about CompanyCam is reachable while an estimate is being written or when the customer opens the proposal.

Dylan wants two things:

1. To see the job's CompanyCam photos while he is estimating, because many proposals are written off site and he is pricing from someone else's photos.
2. The customer to see those photos on the proposal, so the pictures the crew or the homeowner attached show up in the estimate they are signing.

Repo: HQ-Dashboard, `main`. Deploy: Netlify.

## Decisions locked with Dylan. Do not reopen these.

1. **Linking is fuzzy-name auto-match with manual override.** On the estimate, search CompanyCam projects by the estimate's customer name. If exactly ONE candidate scores above the match threshold, auto-link it. Two or more high scorers, or none, leaves it unlinked and shows the picker. The rep can always change or unlink manually. There is precedent for the search: the job detail already calls `searchProjects(custName)` to pre-seed its results list (index.html ~17127 and ~17150). Reuse the proxy's existing `action=projects&query=` passthrough. Do NOT create CompanyCam projects; the proxy is read-only and stays read-only.
2. **Internal surfaces: the estimate detail page (`renderEstimateDetail`, index.html ~29172) and Present mode (`openPresentMode`, index.html ~30214). NOT the estimator PWA.** The estimator is offline-first and a separate app; keeping it out avoids a network dependency in the driveway. Do not touch `apps/estimator/`.
3. **The customer sees hand-picked photos, and every photo starts picked.** The rep unticks what should not go out. Default is all-in, so the common case is zero clicks.
4. **The public page never calls CompanyCam.** The chosen photo URLs are snapshotted onto the estimate. No new unauthenticated endpoint, no token anywhere near the public page.
5. **Live until sent, frozen after.** Before `sent_at`, the estimate detail shows the CompanyCam project live (new photos appear as the crew shoots them). At send, the currently-chosen photos freeze into the estimate. Re-sending re-snapshots.
6. **On accept, copy the link to the job and keep it on the estimate.** Set `jobs.companycam_project_id` from the estimate during the accept path, and leave the estimate's own link and snapshot in place as the record of what the customer actually signed against.

## Schema

One migration, with the `@artifacts` header per standing rule 13. Check SCHEMA.md before writing it and regenerate SCHEMA.md after applying.

- `estimates.companycam_project_id` text, nullable. The linked project.
- `estimates.companycam_excluded` jsonb, not null, default `'[]'`. The photo IDs the rep UNTICKED.
- `estimates.companycam_photos` jsonb, nullable. The frozen snapshot written at send: an array of `{ id, url, thumb, captured_at }` in display order.

Store EXCLUSIONS, not inclusions, and say so in a comment. Because the default is all-picked and the project keeps gaining photos right up to the send, an inclusion list would silently drop every photo shot after the rep last opened the card. An exclusion list means "everything except what I vetoed", which is what decision 3 actually means.

Settings keys (standing rule 12: at most TWO front-of-card in Settings > Estimates, the rest behind that card's Advanced disclosure):

- Front of card: `companycam_estimate_photos_enabled` (default `'true'`, the master switch for the whole feature) and `companycam_customer_photos_enabled` (default `'true'`, whether photos render on the CUSTOMER page at all; off means internal-only).
- Advanced: `companycam_name_match_min_score` (the fuzzy threshold, default your choice, document the scale you picked) and `companycam_max_customer_photos` (default `'24'`, a cap so a 400-photo project does not ship a 400-image proposal).

Do not add settings rows for state. The project id, the exclusions, and the snapshot are per-estimate data, not settings.

## What to build

### A. Estimate detail card (internal)

A CompanyCam section on the estimate card, modeled on the job detail's, NOT copy-pasted into a third divergent implementation. The job detail's picker, the schedule modal's read-only gallery, and this new one are now three consumers of the same proxy: extract the shared search + gallery + lightbox wiring into one helper and have all three call it. If that refactor turns out to be riskier than it looks, say so in the log and explain what you did instead, but do not silently triple the code.

Behavior:

- On open, if `companycam_project_id` is set, render the gallery for it.
- If not set, run the fuzzy name match against the estimate's customer name (`estimates.customer_name`, or the first/last/company fields, whichever the card already uses). One clear winner auto-links and saves. Otherwise show the picker with the name pre-seeded in the search box, exactly like the job detail does.
- The section stays HIDDEN when the first proxy call errors, same as the job detail, so a missing token or an unauthorized caller never shows a dead picker.
- Each photo carries a tick control. Ticked = the customer sees it. Every photo renders ticked unless its id is in `companycam_excluded`. Toggling writes `companycam_excluded` immediately (no separate save button) and shows a brief saved state like the existing `#ccStatus` pattern.
- Show a count line, plain language, no em dashes: `18 of 22 photos will show on the proposal.`
- Clicking a photo opens the existing fullscreen lightbox. Do not build a second viewer.

### B. Present mode

`openPresentMode` (index.html ~30214) gets the estimate's CompanyCam photos as a slide or a section, rendering the SAME set the customer will see (ticked photos only, capped by `companycam_max_customer_photos`). Before send that reads live; after send it reads the snapshot, so what Dylan presents matches what was sent.

### C. Snapshot at send

Wherever `sent_at` is stamped (the estimate send path, both the email and the SMS leg, since prompt 38 made a text-only send a real send), write `estimates.companycam_photos` from the live project minus the exclusions, capped, in display order. Re-sending overwrites it. A send with no linked project writes null and changes nothing else.

Failure policy, and be explicit about it in the code and the log: if CompanyCam is unreachable at send time, the send MUST still go through. Log the failure, leave the previous snapshot alone (or null), and surface a non-blocking note to the rep. An estimate not going out because a photo service hiccuped is a worse outcome than a proposal without pictures.

### D. Public estimate page

`netlify/functions/pec-public-estimate.cjs` (1844 lines; `estimatePage` composes the document, `literatureBlockHtml` at ~931 is the closest existing pattern for an image block). Render a photos block from `estimates.companycam_photos` ONLY. No CompanyCam call, no token, no live fetch. Gate on `companycam_customer_photos_enabled`. An empty or null snapshot renders NO block at all, not an empty heading.

Place it near the presentation literature block and match its visual language (`loading="lazy"`, object-fit cover, same radius). Any copy you add is customer-facing: no em dashes.

Preview mode (`{ preview: true }`, ~1801) is staff-authenticated and may render the live-minus-exclusions set so Dylan can preview before the first send, when no snapshot exists yet. Say clearly in the preview which one it rendered.

### E. Accept path

In the accept handler that creates the job, set `jobs.companycam_project_id` from the estimate. Do not overwrite a value the job already has. Leave the estimate's columns untouched.

## Explicitly out of scope

- Uploading or writing to CompanyCam from TopCoat.
- Any change to `apps/estimator/`.
- Re-hosting photos in Supabase storage.
- Changing the job detail's existing picker behavior beyond the shared-helper extraction.

## Verification, required before you commit

1. `npm test` green.
2. Migration applied via MCP and verified by an `information_schema` re-query, per the pattern in recent log entries. Regenerate SCHEMA.md.
3. Browser walkthrough on the deployed or local dashboard, reporting actual results:
   - Estimate whose customer name matches exactly one CompanyCam project: auto-links on open.
   - Estimate whose name matches two or more: does NOT auto-link, shows the picker.
   - Untick two photos, reload the estimate: still unticked, count line correct.
   - Preview the estimate: only ticked photos appear.
   - Send it, then add a photo in CompanyCam, then reopen the public link: the new photo is NOT there (frozen), and the estimate card still shows it live.
   - Accept it: `jobs.companycam_project_id` is set on the new job.
   - Turn `companycam_customer_photos_enabled` off: public page has no photo block, estimate card still shows photos.
4. Confirm the public estimate page makes zero requests to `pec-companycam` (check the network tab and say so).

## Standing rules that apply

- Commit format `<area>: <what changed>`. Stage specific files, never `git add .`.
- PROJECT-LOG.md entry at the TOP, for a human, naming what you verified and anything that did not work.
- What's New entry in `help/whats-new.json`: photos on estimates, how to untick one, plain language, no em dashes.
- New `features.json` entry (or extend "CompanyCam integration") with the code anchors and the new columns.
- Migration carries the `@artifacts` header.
- Do NOT push. Dylan pushes.
