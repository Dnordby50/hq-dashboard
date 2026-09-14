'use strict';

// Public page metadata only. Availability and booking remain live API calls.
const FALLBACK_ORIGIN = 'https://prescottepoxy.netlify.app';
const PRIVATE_ROBOTS = 'noindex, nofollow';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function siteOrigin(siteUrl) {
  try {
    const url = new URL(siteUrl);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
  } catch (_) { /* use the configured production fallback */ }
  return FALLBACK_ORIGIN;
}

function bookingDiscovery({ brand = {}, form = null, siteUrl, publicBooking = false, preview = false, embed = false } = {}) {
  const hidden = { head: '', robots: PRIVATE_ROBOTS, canonicalUrl: null };
  if (publicBooking !== true || preview || embed || !form || form.active === false) return hidden;

  // Use the loaded form's slug, never a request path, host, or manage token.
  const slug = text(form.slug).toLowerCase() || 'pec';
  if (!/^[a-z0-9-]+$/.test(slug)) return hidden;
  const origin = siteOrigin(siteUrl);
  const canonicalUrl = `${origin}/book${slug === 'pec' ? '' : `/${slug}`}`;
  const businessName = text(brand.business_name);
  const type = Array.isArray(form.appt_types) ? form.appt_types[0] : null;
  const serviceName = text(type && type.label) || 'Appointment';
  const title = text(form.headline) || (businessName ? `Book with ${businessName}` : 'Book an appointment');
  const description = text(form.intro_text) || 'Choose an appointment time and enter your contact details.';
  const service = { '@type': 'Service', name: serviceName, url: canonicalUrl };
  if (businessName) {
    service.provider = { '@type': 'Organization', name: businessName };
    if (text(brand.phone)) service.provider.telephone = text(brand.phone);
  }
  const page = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${canonicalUrl}#webpage`,
    url: canonicalUrl,
    name: title,
    description,
    mainEntity: service,
  };
  const structured = JSON.stringify(page).replace(/[<>&\u2028\u2029]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return {
    canonicalUrl,
    robots: 'index, follow',
    head: `<link rel="canonical" href="${escapeAttribute(canonicalUrl)}">\n<meta name="description" content="${escapeAttribute(description)}">\n<script type="application/ld+json">${structured}</script>`,
  };
}

module.exports = { bookingDiscovery };
