# Booking integrations

The public booking page is `/book`. `/book/pec` is an alias; other configured forms use `/book/<slug>`. The page, the Instant Pricing continuation, and any future integration must use the same availability and booking code in `netlify/functions/pec-booking.cjs`.

## What is in place

- The public form has labeled inputs, buttons, current-step information, and a visible booking confirmation.
- Active public pages have a canonical URL, a description, and `WebPage`/`Service` structured data. Business name, phone, service label, and copy come from the existing brand and form records. This metadata contains no appointment slots, customer information, ratings, business hours, or invented business address.
- The canonical origin comes from the trusted deployment `URL` setting, with `https://prescottepoxy.netlify.app` as the fallback. Request hosts and query strings never set it. `/book/pec` resolves to `/book` in the canonical link.
- Preview, embedded, closed, and private appointment-management pages are marked `noindex, nofollow`. They have no public booking metadata. A private manage link must never go into a sitemap, a business feed, or shared integration documentation. Index controls do not replace the manage token's authorization check.
- The JSON APIs below already exist. No new public write endpoint or AI provider integration is enabled by this redesign.

The metadata helper is `production/booking-discovery.cjs`. Its `bookingDiscovery({ brand, form, siteUrl, publicBooking, preview, embed })` function returns `{ head, robots, canonicalUrl }`. The default is non-indexable. The caller must establish that booking is open before setting `publicBooking: true`.

## Existing API contract

All POST requests use `Content-Type: application/json`. Times returned by the API are authoritative. Display time labels in `America/Phoenix`, and send back the selected `start` string exactly. A displayed time is not a reservation.

| Endpoint | Current behavior |
| --- | --- |
| `GET /api/booking/config` | Returns `{ ok: true, disclosure }`, the current SMS notice. It does **not** return form questions, service areas, services, or availability. The current browser sends a `form` query parameter, but the response is the global disclosure. |
| `POST /api/booking/slots` | Accepts `form` (default `pec`), `address1`, `city`, `zip`, and optional `state`. Checks the configured service area, calendar health, and current availability. Returns `days` for an eligible address. |
| `POST /api/booking/book` | Accepts the selected `start`, form, contact details, project address, and configured question answers. Rechecks current availability and writes through the existing locked booking function. Sends the existing confirmations and updates the customer/lead and calendar. |
| `POST /api/booking/lead` | Requests a callback for an address outside the online booking area. Takes form, name, phone, email, address fields, project text, and optional answers. This creates or updates a lead; it does not reserve an appointment. |
| `POST /api/booking/manage` | Accepts a private `token` and `action`: `slots`, `reschedule`, or `cancel`. Reschedule also takes `start`. Keep this separate from public discovery and business feeds. |

Availability request shape:

```json
{
  "form": "pec",
  "address1": "123 Example Street",
  "city": "Prescott",
  "zip": "86301",
  "state": "AZ"
}
```

The success shape is `{ ok: true, open: true, in_area: true, days: [{ date, label, slots: [{ start, label }] }] }`. A closed form returns `{ ok: true, open: false }`; an address outside the online service area returns `{ ok: true, open: true, in_area: false }`. Empty `days` means no offered times. Unverified calendars return HTTP 503 with `calendar_unavailable: true` and no slots. Do not substitute guessed or previously cached times.

Booking requests use these fields:

- `form` and `start` from the form and the selected live slot.
- `name`, `phone`, `email`, `address1`, `city`, `zip`; optional `state` and `place_id`.
- `answers`, keyed by the current form's question IDs. Required questions remain required. The current page receives their definitions in its server-rendered configuration; the disclosure endpoint is not a substitute.
- `website`, the existing honeypot field, and `fill_ms`, the measured elapsed form time. Preserve the existing abuse checks. Do not fabricate timing values for an integration.
- The existing browser also sends `sms_consent: "true"`. The server currently treats form submission as consent and records the current disclosure. A future adapter must show that disclosure and require the user's final confirmation before submitting; this document does not change consent behavior.

A confirmed new booking returns `ok`, `appointment_id`, `when`, `message`, and a private `manage_url`. A duplicate response has `duplicate: true` and may include the existing manage URL; it is not a second appointment. HTTP 409 with `taken: true` means the selected time is gone and the user must choose again from the returned `days`. HTTP 400, 429, 503, and 500 are not booking confirmations. Do not infer confirmation from HTTP 200 alone: the honeypot intentionally returns a harmless success response without an appointment. Do not blindly replay a write after a timeout or uncertain response.

## Future AI connections

Finding this page in AI search and completing a booking inside an AI service are separate capabilities.

For search, keep the public page accessible to crawlers, link to it from the business website, and keep visible business information accurate. Google says its generative search features do not need special AI markup or `llms.txt`. OpenAI's `OAI-SearchBot` controls search crawling independently of `GPTBot`, which is used for model training. Check the business website and hosting rules before changing robots policies; this repository also serves staff and private customer pages. Sources: [Google search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide), [OpenAI crawlers](https://developers.openai.com/api/docs/bots).

For agents working in a browser, semantic buttons, labels, and visible state make the flow easier to operate. WebMCP is another possible adapter, but support depends on the browser and rollout. It is not enabled here. Sources: [Google's browser-agent guidance](https://web.dev/articles/ai-agent-site-ux), [OpenAI site tools](https://learn.chatgpt.com/docs/webmcp).

For a direct ChatGPT connection, OpenAI currently documents a local-services Get Quote flow in beta for approved partners. That route requires enrollment, a business feed with verified business details, and a configured MCP plugin that opens a quote-request widget. Adding schema to `/book` does not enroll the business or create that connection. Source: [Local services Get Quote specification](https://developers.openai.com/plugins/guides/local-services-request-quote-conversion-spec).

When a provider is chosen, build an adapter around the existing booking functions. It will need current form/question definitions, the disclosure, an explicit customer confirmation step, and a way to reconcile uncertain write results. It must retain the service-area rules, calendar-health checks, live slot recheck, locked write, attribution, and existing notifications. Do not expose the staff MCP server or database credentials as a public booking integration. Provider-specific authentication, business-feed fields, and review requirements belong in that adapter after access and the contract are confirmed.

Official integration guidance was checked on September 14, 2026. Check it again before building a provider adapter.
