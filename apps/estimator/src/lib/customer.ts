// Split customer identity (build 23, phase 1). The form captures a
// Residential/Commercial toggle, split name / company, and a split address;
// the combined estimates.customer_name / customer_address columns are KEPT
// and recomposed from these fields on every save, as a safety net for any
// downstream reader still on the combined columns.

export type CustomerForm = {
  // "Commercial" is defined as "has a company name"; the toggle and the
  // company field are two views of the same fact. Stored separately anyway
  // (customer_is_commercial) so a commercial job under a person's name stays
  // possible later without a migration.
  isCommercial: boolean;
  firstName: string;
  lastName: string;
  company: string;
  phone: string;
  email: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
};

export const emptyCustomer: CustomerForm = {
  isCommercial: false,
  firstName: '',
  lastName: '',
  company: '',
  phone: '',
  email: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  zip: '',
};

const t = (s: string | null | undefined) => (s ?? '').trim();

// The composed safety-net name: company when commercial (with the contact in
// parentheses when one was captured), else "First Last".
export function composeCustomerName(c: CustomerForm): string | null {
  const person = [t(c.firstName), t(c.lastName)].filter(Boolean).join(' ');
  if (c.isCommercial || t(c.company)) {
    const company = t(c.company);
    if (!company) return person || null;
    return person ? `${company} (${person})` : company;
  }
  return person || null;
}

export function composeCustomerAddress(c: CustomerForm): string | null {
  return [t(c.address1), t(c.address2), t(c.city), t(c.state), t(c.zip)].filter(Boolean).join(', ') || null;
}

// Fallback splitters for rows that predate the split columns (or the SQL
// backfill): same naive rules as 2026-07-15_estimate_customer_backfill.sql,
// applied client-side at load so editing an old estimate still fills the
// form. The combined originals are never modified; they get recomposed from
// whatever the rep confirms in the split fields on the next save.
export function splitLegacyName(name: string | null): { firstName: string; lastName: string } {
  const n = t(name);
  if (!n) return { firstName: '', lastName: '' };
  const sp = n.indexOf(' ');
  if (sp < 0) return { firstName: n, lastName: '' };
  return { firstName: n.slice(0, sp), lastName: n.slice(sp + 1).trim() };
}

// Legacy address goes WHOLE into address1: it stays visible, hand-editable,
// and recomposes to itself, so nothing is lost. (The SQL backfill does the
// real comma parsing; this only covers rows it has not reached.)
export function splitLegacyAddress(address: string | null): { address1: string } {
  return { address1: t(address) };
}
