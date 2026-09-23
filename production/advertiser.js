// Limited advertiser workspace. All reads use the company-scoped, read-only RPC.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => value === null ? 'Unavailable' : new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:0}).format(value);
export function createAdvertiserView({supabase, getUser, signOut}) {
  let root, timer, epoch = 0, userId, from, to, brand, page = 0, tab = 'leads';
  const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  async function load() {
    if (!root) return;
    const current = ++epoch, uid = userId;
    const results = root.querySelector('[data-results]');
    results.innerHTML = '<p role="status">Loading leads and sales…</p>';
    try {
      const {data, error} = await supabase.rpc('pec_advertiser_report', {p_from:from,p_to:to,p_brand:brand,p_page:page});
      if (current !== epoch || !root || getUser()?.id !== uid) return;
      if (error) throw error;
      if (!data || !Array.isArray(data.leads) || !Array.isArray(data.sales) || !Array.isArray(data.sources)) throw new Error('Report unavailable.');
      const rows = tab === 'leads' ? data.leads : data.sales;
      const count = tab === 'leads' ? data.lead_count : data.sale_count;
      results.innerHTML = `
        <div class="adv-stats">
          <div><span>Leads received</span><strong>${esc(data.lead_count)}</strong></div>
          <div><span>Sales accepted</span><strong>${esc(data.sale_count)}</strong></div>
          <div><span>Current contract value</span><strong>${esc(money(data.sales_value))}</strong></div>
        </div>
        <p class="adv-note">Leads use the original inquiry date. Sales use the job’s acceptance date and current contract value, including later changes. This is not collected revenue.</p>
        ${data.undated_leads || data.undated_sales ? `<p role="status" class="adv-warning">${esc(data.undated_leads)} lead(s) and ${esc(data.undated_sales)} sale(s) have no original date and are excluded from date totals.</p>` : ''}
        <details class="adv-card"><summary>Lead sources and campaigns</summary><div class="adv-table"><table><thead><tr><th>Source</th><th>Campaign</th><th>Leads</th><th>Sales</th></tr></thead><tbody>${data.sources.map(row => `<tr><td>${esc(row.source)}</td><td>${esc(row.campaign || 'None recorded')}</td><td>${esc(row.leads)}</td><td>${esc(row.sales)}</td></tr>`).join('') || '<tr><td colspan="4">No activity in this date range.</td></tr>'}</tbody></table></div><p class="adv-note">Lead and sale dates are counted independently. These counts are not a cohort conversion rate.</p></details>
        <section class="adv-card">
          <div class="adv-tabs" aria-label="Report"><button data-tab="leads" aria-pressed="${tab === 'leads'}">Leads</button><button data-tab="sales" aria-pressed="${tab === 'sales'}">Sales</button></div>
          <div class="adv-table"><table><thead><tr><th>${tab === 'leads' ? 'Inquiry date' : 'Accepted date'}</th><th>Name</th><th>Source</th><th>Campaign</th><th>${tab === 'leads' ? 'Stage' : 'Contract value'}</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.date)}</td><td>${esc(row.name)}</td><td>${esc(row.source)}</td><td>${esc(row.campaign || 'None recorded')}</td><td>${esc(tab === 'leads' ? String(row.stage || 'Unknown').replaceAll('_',' ') : money(row.amount))}</td></tr>`).join('') || '<tr><td colspan="5">No records in this date range.</td></tr>'}</tbody></table></div>
          <div class="adv-pagination"><button data-prev ${page === 0 ? 'disabled' : ''}>Previous</button><span>${count ? `${page*100+1}–${Math.min((page+1)*100,count)} of ${count}` : '0 records'}</span><button data-next ${(page+1)*100 >= count ? 'disabled' : ''}>Next</button></div>
        </section>`;
      results.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab; page = 0; void load(); }));
      results.querySelector('[data-prev]').addEventListener('click', () => { page--; void load(); });
      results.querySelector('[data-next]').addEventListener('click', () => { page++; void load(); });
    } catch (error) {
      if (current !== epoch || !root || getUser()?.id !== uid) return;
      results.innerHTML = '<p role="alert">Leads and sales could not be loaded. Your access may have changed. Refresh or sign in again.</p>';
    }
  }
  function unmount() {
    epoch++; clearInterval(timer); timer = null; root?.remove(); root = null; userId = null;
    document.body.classList.remove('advertiser-mode');
  }
  function mount() {
    const user = getUser();
    if (!user || user.role !== 'advertiser') { unmount(); return; }
    document.body.classList.add('advertiser-mode');
    if (root && userId === user.id) { void load(); return; }
    root?.remove(); clearInterval(timer); epoch++;
    userId = user.id; to = today(); from = to.slice(0,8)+'01'; brand = user.company === 'FTP' ? 'FTP' : 'PEC'; page = 0;
    root = document.createElement('main'); root.id = 'advertiserRoot';
    root.innerHTML = `<header><div><span class="adv-brand">TOPCOAT · ADVERTISER</span><h1>Leads and sales</h1><p>${esc(user.name || user.email)} · View-only access</p></div><button data-signout>Sign out</button></header>
      <form class="adv-filters"><label>From<input type="date" name="from" value="${from}" required></label><label>Through<input type="date" name="to" value="${to}" required></label>
      <label>Company<select name="brand">${user.company !== 'FTP' ? '<option value="PEC">Prescott Epoxy</option>' : ''}${['FTP','both'].includes(user.company) ? '<option value="FTP">Finishing Touch</option>' : ''}</select></label><button type="submit">Refresh</button></form><div data-results aria-live="polite"></div>`;
    document.body.append(root);
    root.querySelector('[data-signout]').addEventListener('click', () => { void signOut(); });
    root.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget;
      const nextFrom = form.elements.from.value, nextTo = form.elements.to.value;
      if (nextTo < nextFrom || (Date.parse(nextTo)-Date.parse(nextFrom))/86400000 > 366) {
        root.querySelector('[data-results]').innerHTML = '<p role="alert">Choose a date range of up to one year, with the end date on or after the start.</p>';
        return;
      }
      from = nextFrom; to = nextTo; brand = form.elements.brand.value; page = 0; void load();
    });
    timer = setInterval(() => { if (!document.hidden) void load(); }, 60000);
    void load();
  }
  return {mount,unmount};
}
