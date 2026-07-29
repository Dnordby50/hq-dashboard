// Enhancify financing block (prompt 58 Part F), shared by the public estimate
// and public invoice pages. Settings-backed and OFF by default: with
// financing_enabled unset or 'false' every caller gets '' and the pages render
// byte-identical to before. The embed shape chosen is an IFRAME URL
// (financing_embed_url), not a script tag: a settings row must never be able
// to inject arbitrary script into a customer page, and an iframe degrades to
// nothing if the vendor is down while the plain apply link still works.
//
// Customer-facing copy lives here: plain language, no em dashes (standing
// rule 6), and any dollar figure is an ESTIMATE with "subject to credit
// approval" attached. A published monthly payment is a claim PEC owns.

const FINANCING_KEYS = [
  'financing_enabled', 'financing_provider_name', 'financing_embed_url',
  'financing_apply_url', 'financing_apr_pct', 'financing_term_months',
  'financing_min_amount',
];

const escF = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usdF = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// One settings read per request; every failure path returns the disabled
// default so a settings hiccup can never break a customer page.
async function loadFinancingSettings(sb) {
  const def = { enabled: false, provider: 'Enhancify', embedUrl: '', applyUrl: '', aprPct: null, termMonths: null, minAmount: 0 };
  try {
    const rows = await sb('GET', `/settings?key=in.(${FINANCING_KEYS.join(',')})&select=key,value`);
    const map = Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.key, r.value]));
    const httpsUrl = (v) => /^https:\/\//i.test(String(v || '').trim()) ? String(v).trim() : '';
    const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const apr = Number(map.financing_apr_pct);
    return {
      enabled: map.financing_enabled === 'true',
      provider: String(map.financing_provider_name || 'Enhancify').trim() || 'Enhancify',
      embedUrl: httpsUrl(map.financing_embed_url),
      applyUrl: httpsUrl(map.financing_apply_url),
      // 0% APR is a real promo rate, so >= 0 (unlike term, which must be > 0).
      aprPct: (map.financing_apr_pct != null && String(map.financing_apr_pct).trim() !== '' && Number.isFinite(apr) && apr >= 0) ? apr : null,
      termMonths: posNum(map.financing_term_months),
      minAmount: posNum(map.financing_min_amount) || 0,
    };
  } catch (_) { return def; }
}

// Standard amortization: P * r / (1 - (1+r)^-n) with r = APR/12; 0% APR is a
// straight P/n split. Display-only; nothing downstream stores this.
function monthlyPayment(principal, aprPct, termMonths) {
  const P = Number(principal), n = Number(termMonths);
  if (!(P > 0) || !(n > 0)) return null;
  const r = Number(aprPct) / 100 / 12;
  const m = r > 0 ? (P * r) / (1 - Math.pow(1 + r, -n)) : P / n;
  return Math.round(m * 100) / 100;
}

// The block itself. Empty string when disabled, when the amount is missing or
// under financing_min_amount, or when there is nothing actionable to offer
// (no embed and no apply link). Both states of decision 12 live here: rate +
// term set -> estimated monthly payment; either blank -> plain call to action.
// opts.accent tints the apply button to the page's brand accent.
function financingBlockHtml(fin, amount, opts = {}) {
  if (!fin || !fin.enabled) return '';
  const amt = Number(amount) || 0;
  if (!(amt > 0) || (fin.minAmount && amt < fin.minAmount)) return '';
  if (!fin.embedUrl && !fin.applyUrl) return '';
  const monthly = (fin.aprPct != null && fin.termMonths) ? monthlyPayment(amt, fin.aprPct, fin.termMonths) : null;
  const accent = opts.accent || '#D8531C';
  const provider = escF(fin.provider);
  const aprTxt = fin.aprPct != null ? String(Math.round(fin.aprPct * 100) / 100) : '';
  return `
    <div class="card pad" style="margin-top:18px" id="financingCard">
      <div class="eyebrow">Financing available</div>
      <h3 class="sec" style="margin:6px 0 10px">${monthly != null
        ? `From ${usdF(monthly)}/mo with ${provider}`
        : `Pay over time with ${provider}`}</h3>
      <div style="font-size:13.5px;color:#6b7280;line-height:1.6">${monthly != null
        ? `Estimated payment on ${usdF(amt)} at ${escF(aprTxt)}% APR for ${escF(fin.termMonths)} months. This is an estimate only, not an offer of credit or an approval. Actual rates and terms come from the lender and are subject to credit approval.`
        : `Spread the cost into monthly payments instead of paying all at once. Rates and terms come from the lender and are subject to credit approval.`}</div>
      ${fin.embedUrl ? `<iframe src="${escF(fin.embedUrl)}" title="${provider} financing" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation" style="width:100%;border:0;border-radius:10px;margin-top:14px;min-height:320px;background:#fff"></iframe>` : ''}
      ${fin.applyUrl ? `<a href="${escF(fin.applyUrl)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:14px;background:${escF(accent)};color:#fff;font-weight:700;font-size:14px;padding:11px 22px;border-radius:10px;text-decoration:none">Check my financing options</a>` : ''}
    </div>`;
}

module.exports = { FINANCING_KEYS, loadFinancingSettings, monthlyPayment, financingBlockHtml };
