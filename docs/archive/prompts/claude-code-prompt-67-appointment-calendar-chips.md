# Claude Code prompt 67: appointment calendar chips (Google Calendar shape)

Scoped by Cowork 2026-08-03. Sibling of prompt 66 (metrics/GP fixes) and prompt 68 (BusyBusy project automation). This prompt touches the Appointments view ONLY.

Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first, per standing rule 4.

---

## The complaint and what is actually there

Dylan: "The appointment calendar looks really generic and bland. I want the cards to look similar to how a modern calendar would look, similar to Google Calendar."

There is no custom event renderer. `apptEventFromRow` (`index.html:23751`) returns FullCalendar's default event object with:
- `title`: `` `${row.title || type.label} · ${member.name}` ``
- `backgroundColor`: the salesperson's color (`apptMemberColor`, 8-color palette by roster order)
- `borderColor`: the appointment type's accent (`APPT_TYPES`, 4 types)

FullCalendar draws its stock chip from that. No `eventContent`, no `eventClassNames`, no per-view treatment. The theme block at `index.html:1970-1992` re-skins the toolbar and sets `--fc-*` tokens, and that is the whole visual layer.

Live data shape, measured 2026-08-03 (8 rows, all `source = 'routemize'`): `title` is `"Tom Bechtel, Estimate"`, `customer_id` is NULL on every row, `lead_id` is set on 7 of 8, `location_address` and `location_city` are populated on 7 of 8, one row has no name at all (title `"On-site estimate"`, no lead). So a chip that shows "who" has to resolve a name, and must degrade cleanly when there is none.

## Locked decisions (Dylan chose these)

1. Chip shows **time + customer name**, with the appointment **type as a colored dot**. Salesperson stays the background color; type moves out of the text.
2. Color by **salesperson** (unchanged meaning, so the existing legend still reads true), type as the dot.
3. **Google Calendar's actual behavior**: month view gets tinted pills (dot + time + name), week/day view gets solid blocks with more detail stacked. Two treatments, because the available space is genuinely different.
4. Customer name comes from a **real join to leads and customers**, not by parsing the title. Dylan chose correctness over the cheaper title-split.
5. `dayMaxEventRows` stays **4**.
6. The crew Job Schedule calendar is **NOT touched**. Appointments only.
7. Verification: screenshots at desktop, iPad, and phone widths, in light AND dark mode.

## Part A: resolve the name properly

`loadAppointmentsRange` (`index.html` ~23735) currently does `select('*')`. Widen it to embed the two relations in the SAME query (PostgREST embeds, not a second round trip, and never per-event lookups):

```js
.select('*, leads(first_name,last_name,full_name,business_name), customers(name)')
```

Name precedence, most specific first: `customers.name` -> `leads.business_name` -> `leads.full_name` -> `leads.first_name + ' ' + leads.last_name` -> the title with a trailing type suffix stripped -> the type label. The suffix-strip helper already exists from prompt 65 Part C (the Start Estimate flow splits `"Name, Estimate"`); reuse it, do not write a second one.

Both embeds must degrade: an errored or missing relation falls through to the next source, never blanks the chip and never throws inside the events callback (a throw there leaves the calendar empty with no error surfaced).

## Part B: month view chips

Add `eventContent` returning a DOM node, and `eventClassNames` for the view-specific styling hook. Month chip, in order: a 8px round dot in the appointment type's accent, the start time in the user's short format (no `:00` on the hour, so "9am" not "9:00 AM"), then the resolved name, ellipsised.

Google's month treatment is a TINTED pill, not a solid one: background = the member color at low alpha, text = ink (not white), with the member color as a left bar or a saturated dot. Use `color-mix(in srgb, <member color> 14%, transparent)` against the card background, consistent with how the theme block already builds `--fc-today-bg-color` at `index.html:1975`.

**Dark mode is where tinted pills die.** The palette at `index.html` `APPT_MEMBER_COLORS` is 8 saturated hex values chosen against a light card. Verify contrast in dark mode and adjust the mix percentage per theme rather than shipping one number that only works in light. `--fc-event-text-color: #fff` at `index.html:1976` is a solid-chip assumption and will need to change or be scoped to the week/day blocks.

An all-day event keeps the solid treatment (that is what Google does) and shows no time.

## Part C: week and day view blocks

A timed block has real vertical room. Stack: name (semibold), then type label, then city or short address when the block is tall enough. Solid background in the member color with white text is correct here (that is Google's behavior and the current `--fc-event-text-color` already assumes it).

Blocks under roughly 30 minutes cannot fit three lines. Collapse to one line rather than clipping mid-word, keyed off the event's duration, not off a resize observer.

## Part D: chrome polish (small, deliberate)

Rounded corners, a subtle hover lift, and the `today` column treatment. Do NOT rebuild the toolbar or the legend beyond what the token block already does. The legend at `index.html:23788-23791` still needs to read true after the change: it shows a round dot per member and a square dot per type, which now matches the chip exactly. Leave the legend's meaning alone.

## Guardrails

- `editable: true` and `eventResize` are live (`index.html:23864-23866`). A custom `eventContent` is the classic way to break drag-and-drop, because the returned node can swallow the pointer target. Drag AND resize must still commit through `apptCommitMove`, proven in the browser, not assumed.
- `eventClick` -> `apptOpenById` must still fire from anywhere on the chip, including the dot and the time.
- The CDN-blocked fallback (`renderApptFallbackList`, `index.html:23874`) is a different renderer. It does NOT need the new chip design, but it must still render and still open the form. Do not let a shared helper break it.
- Do not touch `loadAppointmentsRange`'s filters, `pec_appointments` writes, the Google Calendar push/pull (`pec-appt-sync-push`, `pec-google-calendar-pull`), or the reminder runner. This is a rendering change.
- Do not touch `renderSchedule` or anything in the Job Schedule view.
- No migration. No new table. No new column.
- CLAUDE.md rule 12: no settings surface needed (a visual restyle has no parameter to tune). Say so in the log so a later session does not add one.

## Verification bar

1. `npm test` green before the first commit and after the last code change. Report check count and exit code.
2. Live deploy, signed in, real appointments. Screenshots: month and week views at desktop (~1440px), iPad (~1180px), and phone (~390px), each in LIGHT and DARK mode. State the contrast ratio of chip text against chip background in dark mode for at least the worst of the 8 member colors.
3. Drag an appointment to another day and resize one in week view. Re-query `pec_appointments` and prove `start_at`/`end_at` actually moved. Undo by moving it back and re-query again.
4. Click a chip's dot, its time text, and its name. All three must open the appointment modal.
5. Prove the no-name row (title `"On-site estimate"`, no lead, no customer) renders without a blank gap or an "undefined".
6. Kill the FullCalendar CDN (block it in DevTools) and prove the fallback list still renders and still edits.
7. Zero test rows created; if you create any, delete them and re-query to prove no residue.

## After

- PROJECT-LOG.md entry at the TOP, `By: Claude Code`, with the screenshots described and the dark-mode contrast numbers stated.
- `features.json`: update the "Appointments calendar" entry.
- `help/whats-new.json`: one entry, plain language, no em dashes.
- Commit per standing rule 1, staging named files only.
