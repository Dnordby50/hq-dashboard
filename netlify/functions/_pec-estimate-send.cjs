'use strict';

const { estimatePricingSendBlockers } = require('../../production/estimate-send-readiness.cjs');

// Prompt 106: the choice pick and the per-line choice flags ride along so the
// pricing rule and the choice-group send gate see the same rows.
const PRICING_SEND_COLUMNS = 'id,is_custom,price,calc_price,gp_pct,commission_pct,price_override_reason,pricing_snapshot,choice_picked_line_id';
const PRICING_LINE_COLUMNS = 'id,label,total,qty,unit_cost,estimate_area_id,is_optional,selected_by_customer,choice_group,is_recommended';
const PRICING_SETTING_KEYS = ['estimator_floor_gp_pct', 'line_pricing_gp_floor_pct', 'line_pricing_block_below_floor', 'line_pricing_reason_threshold_pct', 'line_pricing_reason_threshold_dollars'];

async function estimatePricingSendError(sb, estimate) {
  const rows = await sb('GET', `/settings?key=in.(${PRICING_SETTING_KEYS.join(',')})&select=key,value`);
  const settings = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
  const blockers = estimatePricingSendBlockers(estimate, settings);
  return blockers.length ? blockers.map(blocker => blocker.msg).join('\n') : null;
}

module.exports = { estimatePricingSendError, PRICING_SEND_COLUMNS, PRICING_LINE_COLUMNS };
