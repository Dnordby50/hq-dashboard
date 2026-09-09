# Prompt 103: Google Ads conversion signal from the /book and /pricing intake forms

Written by Cowork, 2026-09-09. Numbered from git HEAD 790341b (prompt 102 is the highest existing).

## Why

Dylan's Google Ads web developer reports Ads cannot see successful estimate requests. He sent a gtag.js snippet (GA4 G-81HQTNS16Z, Ads AW-16589902180) and asked for it on "the estimate request form thank you page." Two facts change the design:

1. Neither intake form has a thank-you URL. /book (pec-booking.cjs) and /pricing (pec-pricing.cjs) are single-page flows; success is a JS state (`stepDone` shown).
2. prescottepoxy.com embeds `https://prescottepoxy.netlify.app/book?embed=1` in an iframe and runs Google Tag Manager container GTM-5ST5QR5R on the parent page. The gclid and GA4 session live on the parent domain. Firing gtag inside the cross-domain iframe produces unattributed conversions, which is the "disconnect" he is seeing. Pasting his snippet into the iframe will not fix it.

Dylan's decisions (Cowork Q&A, 2026-09-09): postMessage to the parent + GTM fires the Google tags (no Google script inside TopCoat, no Google IDs in TopCoat, so no settings surface is needed); PEC only; both forms now; conversion = lead captured; first submission only, never on duplicates.

## What to build

### Part A: post a conversion message from both forms (embed AND direct visits)

Add one shared helper to the inline client script of BOTH pages (pageShell already differs per page; keep the helper identical, do not extract a shared module unless one already exists for these two functions):

```js
function pecSignal(stage){
  try{
    var msg={pecEvent:'estimate_request',stage:stage,form:FORM_SLUG,brand:'pec',ts:Date.now()};
    if(window.parent&&window.parent!==window){window.parent.postMessage(msg,'*');}
    window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:'estimate_request',pec_stage:stage,pec_form:FORM_SLUG});
  }catch(e){}
}
```

`FORM_SLUG` is `'book'` or `'pricing'`. The message carries NO customer data (no name, phone, email, address, price), so `'*'` as targetOrigin is acceptable and matches the existing `pecBookingHeight` post. The local `dataLayer.push` is harmless today and makes direct (non-embedded) visits work the moment anyone adds GTM to the TopCoat pages later; it is not a substitute for Part B.

Fire points, exactly these:

- **/book** (pec-booking.cjs, the `Book it` handler around line 1443, the `.then(function(j){...})` block): after `show('stepDone',true)`, call `pecSignal('lead_captured')` ONLY when `j.ok && !j.duplicate && j.appointment_id`. The honeypot success body has no `appointment_id` (line 601) and the duplicate body sets `duplicate:true` (line 664), so this gate excludes both without changing any server response. Do not add a field to the honeypot response (it must teach the bot nothing).
- **/pricing** (pec-pricing.cjs, the `See my price` handler around line 906): after `S.contact=c;S.quote=j;`, call `pecSignal('lead_captured')` ONLY when `j.ok && j.request_id && !j.duplicate`. The honeypot body is `okBody(null,false)` so `request_id` is null (line 394); the deduped body carries `duplicate:true` (line 386). This is the lead-captured moment by design (contact comes before the price).
- **/pricing** booking success (around line 1054): call `pecSignal('appointment_booked')` when `j.ok && !j.duplicate && j.appointment_id`. Dylan's Ads conversion is lead_captured; this second stage exists so the web developer can add a booked conversion later without another TopCoat change. GTM must be told to ignore it for the estimate_request conversion (the email covers that).

Never fire in preview mode (`?preview=1`, submits are already dead there) and never fire on the `taken`, error, out-of-area-without-request, or catch paths.

### Part B: put the parent-page listener in the Settings embed snippets

`bkEmbedSnippet` (index.html ~line 20131) and `prEmbedSnippet` (~line 19644) become iframe + a small listener script so a fresh paste on any site works with GTM out of the box:

```html
<script>
window.addEventListener('message',function(e){
  if(e.origin!=='<TOPCOAT_ORIGIN>')return;
  var d=e.data;if(!d||d.pecEvent!=='estimate_request')return;
  window.dataLayer=window.dataLayer||[];
  window.dataLayer.push({event:'estimate_request',pec_stage:d.stage,pec_form:d.form});
});
</script>
```

`<TOPCOAT_ORIGIN>` is derived from the same base URL the snippet already uses for the iframe src (no new setting). The listener pushes to `dataLayer` only; it does not load gtag and holds no Google IDs. The Settings card copy under the snippet should say, in plain language with no em dashes: "The snippet tells your website's tag manager when a lead is captured. Your Google Ads or analytics person creates the conversion from the estimate_request event."

Update the pricing and booking-form Settings help text (and the help assistant content if it describes the embed) accordingly.

### Part C: CSP, tests, docs

- netlify.toml Content-Security-Policy-Report-Only: no change is required (no external script is loaded). Do NOT add googletagmanager.com. If a future prompt loads gtag on TopCoat itself, that is the moment to add it.
- Tests: production/booking.test.cjs and production/pricing.test.cjs are fixture tests on the server modules; the fire gates are client-side. Add at least one assertion per page that the served HTML contains `pecSignal('lead_captured')` and that the honeypot response body for /book carries no `appointment_id` and for /pricing carries `request_id:null`, so a later refactor that breaks the gate fails a test. Run the full suite.
- features.json: update the Online booking (prompt 101) and Instant pricing (2026-08-24) entries with the signal, the gates, and the embed listener.
- What's New: one entry (Settings-facing, plain language, no em dashes): the embed snippet now reports estimate requests to your website's tag manager for Google Ads conversion tracking; re-copy the snippet from Settings if you want the built-in listener, or have your ads person add a GTM listener.
- PROJECT-LOG entry per CLAUDE.md, then commit and push under the standing authorization, then verify live: submit a test booking on https://prescottepoxy.netlify.app/book?embed=1 through a scratch HTML page that embeds it and logs `message` events, confirm exactly one `estimate_request` message with `stage:'lead_captured'`, then cancel the test appointment through its manage link and mark the lead lost or archived.

## Out of scope

- Loading gtag.js or GTM on TopCoat pages, or storing Google IDs in settings (Dylan chose postMessage-only).
- FTP (PEC only).
- The web developer's GTM configuration. Cowork sent him the trigger and tag spec by email; his side is: a Custom HTML tag or the re-pasted embed snippet to receive the message, a Custom Event trigger on `estimate_request` filtered to `pec_stage equals lead_captured`, a GA4 event tag and an Ads conversion tag on that trigger, and the site's own GA4/Ads config tags already in GTM-5ST5QR5R.

## Handoff to Dylan (after ship)

Reply to the web developer that the signal is live and ask him to confirm a test conversion appears in Ads (Conversions > Diagnostics, or Tag Assistant on the live page).
