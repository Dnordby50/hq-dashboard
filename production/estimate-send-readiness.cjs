'use strict';

// Send-only pricing policy. The estimator saves these inputs even while a
// price is unfinished; server sends and the dashboard use this same rule.
// Keep the self-contained browser mirror in index.html byte-identical.
function estimatePricingSendBlockers(est, settings = {}) {
  const finite = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const configured = (key, fallback) => finite(settings[key]) ?? fallback;
  const round = value => Math.round(value * 100) / 100;
  const items = Array.isArray(est.estimate_line_items) ? est.estimate_line_items : (Array.isArray(est.line_items) ? est.line_items : []);
  const snapshot = est.pricing_snapshot && est.pricing_snapshot.send_readiness;
  const saved = snapshot && snapshot.version === 1 ? snapshot : null;
  if (est.is_custom === true || (saved && saved.isCustom === true)) return [];
  // Choice group (prompt 106): exactly ONE choice line counts in any total.
  // The valid pick (estimates.choice_picked_line_id), else the recommended
  // line, else the cheapest; the minimum selection uses the cheapest. Same
  // rule as production/optional-lines.cjs countedChoice, inlined so this
  // file stays self-contained for its browser mirror.
  const choiceKey = li => li && typeof li.choice_group === 'string' && li.choice_group.trim() ? li.choice_group.trim() : null;
  const choices = items.filter(li => choiceKey(li));
  const cheapestChoice = choices.reduce((best, li) => (best == null || (finite(li.total) ?? 0) < (finite(best.total) ?? 0) ? li : best), null);
  const pickedId = est.choice_picked_line_id != null ? String(est.choice_picked_line_id) : null;
  const countedChoice = choices.find(li => String(li.id) === pickedId) || choices.find(li => li.is_recommended === true) || cheapestChoice;
  const countsIn = li => !choiceKey(li) || li === countedChoice;
  const areaItems = items.filter(li => li && li.estimate_area_id && countsIn(li));
  const discountItems = items.filter(li => li && !li.estimate_area_id && !li.addon_id && finite(li.total) < 0);
  const discountTotal = round(discountItems.reduce((sum, li) => sum + Number(li.total), 0));
  const calculated = saved ? finite(saved.calcTotal) : finite(est.calc_price);
  const sell = saved ? finite(saved.finalSell) : (areaItems.length ? round(areaItems.reduce((sum, li) => sum + (finite(li.total) ?? 0), 0)) : finite(est.price));
  const blockers = [];
  // A fully discounted draft has no defined GP percentage. Keep it saved,
  // but do not let null GP silently bypass the send-only pricing checks.
  if (sell != null && sell <= 0) {
    blockers.push({ msg: 'Set a price above $0 before sending. Your estimate changes are saved.' });
  }
  const threshold = Math.max((calculated ?? 0) * configured('line_pricing_reason_threshold_pct', 2) / 100, configured('line_pricing_reason_threshold_dollars', 100));
  // finalSell is the system portion, so standalone discounts are not in it.
  // Count every offered discount, including an optional line left unticked.
  // Legacy no-area totals already contain their required discount lines.
  const reasonSell = !saved && !areaItems.length && discountItems.length
    ? round(items.filter(li => li && countsIn(li) && !discountItems.includes(li)).reduce((sum, li) => sum + (finite(li.total) ?? 0), 0))
    : sell;
  const shortfall = round((calculated != null && reasonSell != null ? calculated - reasonSell : 0) - discountTotal);
  if ((discountItems.length || (calculated != null && reasonSell != null)) && shortfall > threshold + 1e-9 && !String(est.price_override_reason || '').trim()) {
    blockers.push({ msg: 'Add a reason for the price change before sending. Your estimate changes are saved.' });
  }
  let gpPct = saved ? finite(saved.combinedGpPct) : null;
  let lines = saved && Array.isArray(saved.lines) ? saved.lines : [];
  if (!saved) {
    // Legacy rows predate the snapshot. Area costs include commission;
    // add-on costs store materials only, matching the estimator's math.
    const opening = items.filter(li => li && countsIn(li) && (!li.is_optional || li.selected_by_customer === true));
    const total = round(opening.reduce((sum, li) => sum + (finite(li.total) ?? 0), 0));
    const commission = finite(est.commission_pct);
    if (areaItems.length && total > 0 && opening.every(li => finite(li.unit_cost) != null && (li.estimate_area_id || commission != null))) {
      const gp = round(opening.reduce((sum, li) => sum + (finite(li.total) ?? 0) - (finite(li.qty) ?? 1) * Number(li.unit_cost) - (li.estimate_area_id ? 0 : Number(li.total) * commission / 100), 0));
      gpPct = gp / total;
    } else if (!items.some(li => li && li.is_optional === true)) {
      gpPct = finite(est.gp_pct);
    }
    lines = areaItems.filter(li => finite(li.total) > 0 && finite(li.unit_cost) != null).map(li => ({
      label: li.label || 'Line', gpPct: (Number(li.total) - (finite(li.qty) ?? 1) * Number(li.unit_cost)) / Number(li.total),
    }));
  }
  if (discountItems.length) {
    // A customer may decline every optional upsell and take every discount.
    // Recompute that selection from rows, rather than subtracting a discount
    // from combinedGpPct, which already includes selected discount lines.
    const minimum = items.filter(li => li && (choiceKey(li) ? li === cheapestChoice : (!li.is_optional || finite(li.total) < 0)));
    const total = round(minimum.reduce((sum, li) => sum + (finite(li.total) ?? 0), 0));
    const commission = finite(est.commission_pct);
    if (total <= 0) {
      if (!(sell != null && sell <= 0)) blockers.push({ msg: 'Set a price above $0 for every allowed selection before sending. Your estimate changes are saved.' });
      gpPct = null;
    } else if (minimum.every(li => finite(li.total) != null && finite(li.unit_cost) != null && (li.estimate_area_id || commission != null))) {
      const gp = round(minimum.reduce((sum, li) => sum + Number(li.total) - (finite(li.qty) ?? 1) * Number(li.unit_cost) - (li.estimate_area_id ? 0 : Number(li.total) * commission / 100), 0));
      const minimumGpPct = gp / total;
      gpPct = gpPct == null ? minimumGpPct : Math.min(gpPct, minimumGpPct);
    } else {
      gpPct = null;
      blockers.push({ msg: 'Finish pricing every line before sending. Your estimate changes are saved.' });
    }
  }
  const floor = configured('estimator_floor_gp_pct', 40);
  if (gpPct != null && gpPct * 100 < floor - 0.05) {
    blockers.push({ msg: `Gross profit is ${(gpPct * 100).toFixed(1)}%, below the ${floor}% floor. Adjust the price before sending. Your changes are saved.` });
  }
  if (String(settings.line_pricing_block_below_floor ?? 'false').toLowerCase() === 'true') {
    const lineFloor = configured('line_pricing_gp_floor_pct', floor) || floor;
    for (const line of lines) {
      const lineGp = finite(line.gpPct);
      if (lineGp != null && lineGp * 100 < lineFloor - 0.05) blockers.push({ msg: `"${line.label || 'Line'}" has ${(lineGp * 100).toFixed(1)}% gross profit, below the ${lineFloor}% line floor. Adjust this line before sending. Your changes are saved.` });
    }
  }
  return blockers;
}

module.exports = { estimatePricingSendBlockers };
