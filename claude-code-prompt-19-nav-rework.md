# Build Prompt 19: left rail rework (icon rail + flyout)

## Context

Repo: /Users/dylannordby/Claude-Code/HQ-Dashboard. Single-file dashboard, index.html. DO NOT START THIS UNTIL PROMPT 18 IS DEPLOYED AND VERIFIED. Prompt 18 removes the Estimator rail button and rebuilds the mobile schedule layouts; this prompt rewrites the rail itself, and running them together makes any regression impossible to attribute. Read CLAUDE.md and the last 3 PROJECT-LOG.md entries first.

Dylan's complaint, in his words: "there are a lot of side tab buttons ... the buttons on the left tab bar do not feel flowy right now." When pushed on what specifically is wrong, he named all three of: too many items visible at once, the existing group headers reading as noise rather than structure, and the wrong things being top-level.

He wants an ICON RAIL + FLYOUT (the Linear / Notion pattern): a thin icon rail, with a submenu that opens on interaction.

## The current nav, exactly

Markup lives in a hidden `<nav id="pecSubnav">` at index.html:2361-2393, which is CLONED into the visible rail. The clone/render function is at index.html:4995-5059 (item query at 5002, includes `#pecEstimatorNav`; a MutationObserver syncs active state and display). The router is `switchView(v)` at index.html:6841 with the view map at 6908-6930. Initial dispatch at 6470, popstate restore at 6830. Existing responsive rules for the shell and subnav: index.html:1281-1287, 1604-1620, 1830.

Eighteen items in five groups:

- Overview: Dashboard (2363), Metrics (2364)
- Sales: Jobs (2366), Customers (2367), Messages (2368), Leads (2369), Estimates (2370), Jobs pipeline (2371). Estimator (Beta) (2378) is REMOVED by prompt 18; it should not exist when you start.
- Production: Ordering (2380), Job Schedule (2381), Next Day Schedule (2382)
- Finance: Invoicing (2384), Job Costing (2385, admin), Bonus Report (2386, admin), Commission (2387, admin)
- Admin: Price & Material Catalog (2389, admin), DripJobs Sync Health (2390, admin), Settings (2391, admin), Help (2392)

## Tasks

### 1. Audit before you build. This is a required first step, not optional.

Dylan says the wrong things are top-level but has not said WHICH. Do not guess and do not silently demote a view he uses daily. Produce a short written proposal FIRST, in chat, before writing any code:

- For each of the 18 items: is it a destination (a place you go and work) or an action/report (something you generate and leave)? Destinations earn a rail slot. Actions and one-off reports are candidates for nesting inside a destination.
- Name the specific candidates for demotion with your reasoning. Strong candidates on their face: DripJobs Sync Health (a diagnostic, arguably belongs inside Settings), Bonus Report and Commission (reports, arguably belong as tabs inside Job Costing or a single Finance view), Ordering (check whether it is still live at all; PROJECT-LOG records that the Order Sheet workflow was retired on 2026-07-09 and materials/ordering moved into TopCoat, so this rail item may be pointing at something that no longer earns a top-level slot; VERIFY by reading the code, do not assume).
- Name anything that should be PROMOTED or renamed.
- Every demoted view must keep its route working. Nesting an item under another view does not mean deleting `switchView('bonus')`; a deep link or an old bookmark must still land somewhere sane.

Present that proposal and WAIT for Dylan's sign-off before implementing. He explicitly agreed to sign off on the structure before you build it.

### 2. Build the icon rail + flyout

Only after sign-off.

- Thin icon-only rail, always visible. Every rail item needs an icon; pick a single consistent set (inline SVG, no new dependency, no icon-font CDN). Icons alone are not self-explanatory: every rail item needs a tooltip on hover AND an accessible label (`aria-label`), and the flyout must show the text label.
- Interaction: clicking or hovering a rail icon opens a flyout panel with that group's items as text labels. Decide hover-vs-click and justify it; hover flyouts are fast on desktop and hostile on touch, so if you choose hover, it must also work on click/tap.
- The active view's group is visually marked on the rail at all times, so you always know where you are without opening anything.
- The flyout closes on outside click, on Escape, and on selecting an item.
- Keyboard: the rail is tabbable, Enter/Space opens a flyout, arrow keys move within it, Escape closes and returns focus to the rail icon. Do not ship a nav that only works with a mouse.
- Admin-only items (Job Costing, Bonus Report, Commission, Catalog, Sync Health, Settings) must stay admin-gated exactly as they are today. Whatever mechanism currently hides them (read it at index.html:4995-5059) survives the rewrite. A non-admin must not see an empty group or a flyout with nothing in it.

### 3. Do not break the clone

The single biggest risk in this prompt: the visible rail is built by CLONING the hidden `#pecSubnav` (index.html:4995-5059), and a MutationObserver keeps active state and visibility in sync. Every view depends on this. You have two options and must state which you took and why:

(a) Keep `#pecSubnav` as the declarative source of truth and rewrite only the clone/render step to emit an icon rail plus flyouts. Lower risk, keeps one place to add a view.
(b) Replace the hidden-nav-plus-clone architecture with a single data-driven nav config (an array of groups and items, with icons), rendered once. Cleaner, but it means touching the MutationObserver, active-state sync, and anything else that queries the rail DOM.

Recommendation: (b) is the better end state and the clone-a-hidden-nav pattern is the reason this code is hard to change, but only take it if you can grep every reader of `#pecSubnav` and `.rd-crm-btn` and prove nothing else depends on the current DOM shape. If you cannot prove that, take (a).

### 4. Mobile

Prompt 18 establishes mobile layouts for the schedule views at roughly 720px. The rail must not fight them. On phone widths an icon rail plus a flyout is usually the wrong pattern; a bottom bar or a hamburger drawer is standard. Decide, state your reasoning, and make sure the existing subnav responsive rules (index.html:1604-1620) are updated rather than left to conflict.

## Guardrails

- Every one of the current routes must still resolve. `switchView` (6841), the view map (6908-6930), the initial dispatch (6470) and the popstate restore (6830) must all still work, including for a view that is now nested rather than top-level.
- Do not change what any view DOES. This is navigation only.
- No em dashes anywhere (CLAUDE.md standing rule 6).
- A What's New entry is required (standing rule 9): this is the most visible change users will ever see. Write it in plain language and tell them where the moved items went.
- Commit per standing rule 1, update PROJECT-LOG.md per standing rule 2.

## After

Append a PROJECT-LOG.md entry (By: Claude Code) covering: the audit and what Dylan signed off on, which items were demoted and where they went, whether you took option (a) or (b) on the clone architecture and why, the hover-vs-click decision, and the mobile pattern you chose. Then give Dylan a smoke list: every one of the 18 destinations reachable, admin gating intact, deep links intact, keyboard nav working, and the rail usable at 390px.
