'use strict';

// Prompt 75 F1: the ONE "hot estimate" rule, shared by the estimate detail
// block and the pipeline corner badge (mirrored as pecEstimateIsHot in
// index.html; keep the two byte-identical apart from the export line).
//
//   hot = viewCount >= minViews AND lastViewedAt within windowHours of now
//
// Both thresholds live in the settings table (estimate_hot_min_views,
// estimate_hot_window_hours; defaults 3 / 48) so tuning them in Settings >
// Estimates changes every surface with no deploy. Count AND recency on
// purpose: at PEC's send volume a bare "3+ views" rule would flag every
// estimate anyone ever opened; going quiet past the window cools it off
// automatically. Invalid/missing settings fall back to the defaults; a
// missing last-view timestamp is never hot.
function estimateIsHot({ viewCount, lastViewedAt, minViews = 3, windowHours = 48, now = Date.now() } = {}) {
  const min = Number(minViews) > 0 ? Number(minViews) : 3;
  const win = Number(windowHours) > 0 ? Number(windowHours) : 48;
  const n = Number(viewCount) || 0;
  if (n < min) return false;
  const last = typeof lastViewedAt === 'number' ? lastViewedAt : Date.parse(lastViewedAt || '');
  if (!Number.isFinite(last)) return false;
  return (now - last) <= win * 3600 * 1000;
}

module.exports = { estimateIsHot };
