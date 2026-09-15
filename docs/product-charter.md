# TopCoat product charter

Operating direction consolidated 2026-09-14 from the documented PEC-first plan and current features. A change in direction belongs in an explicit owner decision, not an agent's assumption.

## Purpose

TopCoat is the CRM and operations platform for Prescott Epoxy Company and Finishing Touch Painting. It helps staff win suitable work, price it accurately, schedule and deliver it reliably, collect payment, and understand job profitability. Private owner planning connects trustworthy operating results to editable plans and accountable commitments, reducing daily dependence on Dylan.

Prove PEC end to end, then adapt the same core workflows to FTP. Broader commercialization is a separate decision, not an assumed requirement for today's builds.

## Core flow and boundaries

- Lead and source -> appointment -> estimate -> acceptance -> production -> completion -> invoice/payment -> review and follow-up. Improve the whole affected workflow, including integrations and customer outputs.
- Sales and office staff need clear next actions; crews need accurate work, material, and schedule details; the owner needs honest financial results and private plans. Keep essential summaries visible in their daily screens.
- The single private owner workspace is currently **Growth and Development** (`owner-studio`, previously discussed as My Eyes Only). Preserve editable MBP, yearly budgets/actuals, rocks, and reviews; do not build a duplicate owner cockpit.
- Keep PEC and FTP data, branding, source coverage, and permissions explicit. Do not assume PEC's calculations or automatic actuals apply to FTP.
- Business rules and arithmetic are deterministic and auditable. AI may explain, draft, and prioritize relevant authorized information; it does not decide payments, booking availability, permissions, or financial truth.
- Retain drafts, source records, manual overrides including blank/zero, historical years, and revision safeguards. Saving unfinished work is distinct from readiness to send.

## Before building

Name the role, recurring problem, measurable behavior, existing owning module, must-preserve information, and acceptance checks. Use existing settings and approved financial policy; do not invent margin, discount, commission, or approval thresholds. Prefer the smallest complete change and gradual module extraction. A substantial visual redesign needs an approved preview.

Code and live evidence establish what exists; accepted decisions establish what should exist. `features.json` routes investigation, `SCHEMA.md` describes data, and dated logs explain history. Older phase dates and vault notes are not proof of current deployment or current business roles.
