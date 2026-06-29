# TopCoat CRM Help (first-pass draft)

This document is the grounding knowledge for the in-app Help assistant (the bottom-right Help button). It explains what each view does, where features live, and how to do the common tasks.

It was drafted by reading the app, so treat it as a FIRST PASS. Dylan: correct anything wrong and add what is missing. The Help assistant reads this file at runtime, so edits here change its answers (after a redeploy).

Last reviewed by a human: NOT YET (drafted by Claude Code, 2026-06-28).

---

## Where things are (navigation)

The left sidebar is the main menu. Views are grouped into sections:

- **Overview**: Dashboard, Metrics
- **Sales**: Customers, Jobs, Jobs pipeline (and Estimator beta, owner only)
- **Production**: Ordering, Job Schedule, Next Day Schedule
- **Finance**: Invoicing, Job Costing, Bonus Report, Commission
- **Admin**: Price & Material Catalog, DripJobs Sync Health, Settings, Help

The **Cockpit** (the "Daily flow" card at the bottom of the sidebar, button "Open Cockpit") is a separate workspace with three tabs: Dashboard, Execution, and JARVIS (an AI strategy assistant). It is reached only from that card, not from the menu list.

The **top bar** has global search (search jobs by customer, address, or phone), a Refresh button (re-renders the current view with fresh data), a notification bell, and your account menu (logout).

Some views are admin only (Job Costing, Bonus Report, Commission, Price & Material Catalog, DripJobs Sync Health, Settings). If you do not see one, your account does not have access; ask Dylan.

---

## What each view does

### Overview

- **Dashboard**: The CRM home overview. Quick read on the current state of the business.
- **Metrics**: Sales and revenue analytics. Filter by time window and by salesperson. Includes accounts-receivable figures and drill-downs (click a metric to see the underlying jobs).

### Sales

- **Customers**: The customer list. Search by name. Open a customer to see their details and jobs.
- **Jobs**: The job list (the sales and operations record for each job). Search by customer, address, or phone. Click a job to open its detail.
- **Jobs pipeline**: Jobs organized by stage, so you can see what is in each part of the pipeline.
- **Estimator (Beta)**: A separate estimating tool. Owner only for now (hidden unless your email is on the allowed list in Settings).

### Production

- **Ordering**: Material ordering for production. Build and track what needs to be ordered for jobs.
- **Job Schedule**: The production calendar. Shows scheduled jobs by day, with crews and areas. Use "+ Add Job" to add a job that did not come through automatically (a manual entry).
- **Next Day Schedule**: A focused view of what is scheduled for the next working day, for crew planning.

### Finance

- **Invoicing**: Invoices and accounts receivable. Open an invoice to view it, and use "Download PDF" to save or print it.
- **Job Costing** (admin/office): Where a job's real costs, materials, crew hours, and revenue are entered to calculate gross profit and the crew bonus. See the task below.
- **Bonus Report** (admin): The crew bonus payouts ledger. Shows bonuses earned per job and crew.
- **Commission** (admin): Salesperson commission. Filter by date range and salesperson; track payouts.

### Admin

- **Price & Material Catalog** (admin): The catalog of products and materials with pricing, used by estimating, ordering, and costing.
- **DripJobs Sync Health** (admin): The status of the DripJobs integration (the source of jobs that flow in automatically). Use it to confirm jobs are syncing.
- **Settings** (admin): App configuration and staff/user management (add or remove staff accounts, set roles and access).
- **Help**: An in-app reference page.

---

## How to do common tasks

### Find and open a job
Use the search box in the top bar (search by customer name, address, or phone), or open the **Jobs** view and search there. Click a job row to open its detail.

### Cost a job (Job Costing)
1. Open **Job Costing** and find the job (Active tab lists jobs that still need costing plus a search box).
2. Open the job's costing detail. Enter the real numbers in the cards: **Costs**, **Materials** (including actual used), **Crew hours** (hours per crew member), and **Notes**. Enter the job's revenue if it is not already set.
3. Entering crew hours drives the bonus calculation and the GP/hr and REV/hr figures. The bonus pool is based on the labor budget minus actual loaded labor.
4. If you are office staff (not an admin), click **Submit for review**. The costing then locks (so the numbers do not change while under review) and waits for Dylan. You can **Withdraw** to reopen it.
5. An admin reviews submitted jobs in the "Submitted for review" queue on the Active tab, then clicks **Finalize**. Finalizing records the crew bonus to the ledger. Admins can also **Send back** a submission to the submitter.
6. Only finalizing makes the bonus payable. A finalized job can be re-opened by an admin if something needs to change.

### Create or send an invoice
Open **Invoicing**, find the job or invoice, open it, and use **Download PDF** to save or print it for the customer.

### Schedule a job
Open **Job Schedule** to see the calendar. Most jobs appear automatically once a proposal is accepted. If a job did not flow through automatically, use **+ Add Job** to create a manual schedule entry (pick the customer, crew, area, and day). Use **Next Day Schedule** for a clean next-day crew view.

### Order materials
Open **Ordering** and build the order for the job from the catalog. The **Price & Material Catalog** (admin) is where the products and pricing behind ordering and costing are maintained.

### Add or find a customer
Open **Customers** to search the customer list and open a customer record. New customers usually arrive with their jobs; manual additions happen during the job or schedule flows.

### Run a commission or bonus report
**Commission** (admin) shows salesperson commission over a date range, with payouts. **Bonus Report** (admin) shows crew bonus payouts earned from finalized job costing.

### Refresh data / something looks stale
Click **Refresh** in the top bar to re-render the current view with fresh data. If the app ever seems stuck, a hard refresh of the browser also helps.

### Manage staff accounts
Open **Settings** (admin) and go to the Users area to add staff, set their role, and control which views they can see.

---

## Notes for the assistant

- This is a help-and-orientation assistant. It explains how to do things and where features are. It does not perform actions or change data.
- If something is not covered here or in the SOPs, say so plainly and suggest the user check with Dylan, rather than guessing about this specific app.
