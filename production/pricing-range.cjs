'use strict';
// Instant Pricing: the ballpark range math (pure module, no I/O).
// Used by netlify/functions/pec-pricing.cjs; tested by pricing-range.test.cjs.
//
// The range is deliberately generous in the customer's favor on display:
// the low bound FLOORS to the rounding step and the high bound CEILS, so the
// shown bracket always contains the raw sqft * rate products. A per-type
// minimum job price lifts both bounds (small jobs have a real mobilization
// floor) and can never invert the range.

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// computePriceRange({ sqft, rateLow, rateHigh, minPrice, roundTo, minSqft, maxSqft })
//   -> { ok: true, low, high } | { ok: false, error }
// error values: 'BAD_SQFT' | 'SQFT_TOO_SMALL' | 'SQFT_TOO_LARGE' | 'BAD_RATES'
function computePriceRange(opts) {
  const o = opts || {};
  const sqft = num(o.sqft);
  const rateLow = num(o.rateLow);
  const rateHigh = num(o.rateHigh);
  const minPrice = num(o.minPrice);
  const roundTo = num(o.roundTo) > 0 ? num(o.roundTo) : 1;
  const minSqft = num(o.minSqft);
  const maxSqft = num(o.maxSqft);

  if (sqft == null || sqft <= 0) return { ok: false, error: 'BAD_SQFT' };
  if (minSqft != null && sqft < minSqft) return { ok: false, error: 'SQFT_TOO_SMALL' };
  if (maxSqft != null && sqft > maxSqft) return { ok: false, error: 'SQFT_TOO_LARGE' };
  if (rateLow == null || rateHigh == null || rateLow < 0 || rateHigh < rateLow) {
    return { ok: false, error: 'BAD_RATES' };
  }

  let low = Math.floor((sqft * rateLow) / roundTo) * roundTo;
  let high = Math.ceil((sqft * rateHigh) / roundTo) * roundTo;
  if (minPrice != null && minPrice > 0) {
    low = Math.max(low, minPrice);
    high = Math.max(high, low);
  }
  return { ok: true, low, high };
}

// Whole dollars, US grouping: fmtMoney(5250) -> '$5,250'. Cents never show on
// a ballpark.
function fmtMoney(n) {
  const v = num(n);
  if (v == null) return '$0';
  return '$' + Math.round(v).toLocaleString('en-US');
}

// Substitutes {low} / {high} in Settings-editable copy. Unknown tokens are
// left alone so a typo in Settings degrades visibly instead of vanishing.
function renderRevealCopy(template, low, high) {
  return String(template == null ? '' : template)
    .replaceAll('{low}', fmtMoney(low))
    .replaceAll('{high}', fmtMoney(high));
}

module.exports = { computePriceRange, fmtMoney, renderRevealCopy };
