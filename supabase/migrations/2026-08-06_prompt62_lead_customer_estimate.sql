-- @artifacts
--   column: public.leads.business_name
--   column: public.leads.archived_at
--   column: public.leads.lost_notes
--   column: public.estimates.customer_id
--   index: estimates_customer_id_idx
--   index: leads_archived_at_idx
-- @end

-- Prompt 62 Part 0: lead/customer name model, archive, lost notes, estimate-to-customer link.
-- WHY: leads gain a business identity (business_name) mirroring customers.company_name;
-- archived_at clears dead leads off the board without deleting or marking them lost;
-- lost_notes separates free text from the picked lost_reason (which stays one of six values);
-- estimates.customer_id lets an estimate start from a customer with no lead at all.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_name text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_notes text;

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id);

CREATE INDEX IF NOT EXISTS estimates_customer_id_idx ON estimates(customer_id);
CREATE INDEX IF NOT EXISTS leads_archived_at_idx ON leads(archived_at);
