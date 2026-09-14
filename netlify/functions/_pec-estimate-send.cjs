'use strict';

const { estimatePricingSendBlockers } = require('../../production/estimate-send-readiness.cjs');

const PRICING_SEND_COLUMNS = 'id,is_custom,price,calc_price,gp_pct,commission_pct,price_override_reason,pricing_snapshot';
const PRICING_LINE_COLUMNS = 'label,total,qty,unit_cost,estimate_area_id,is_optional,selected_by_customer';
const PRICING_SETTING_KEYS = ['estimator_floor_gp_pct', 'line_pricing_gp_floor_pct', 'line_pricing_block_below_floor', 'line_pricing_reason_threshold_pct', 'line_pricing_reason_threshold_dollars'];

async function estimatePricingSendError(sb, estimate) {
  const rows = await sb('GET', `/settings?key=in.(${PRICING_SETTING_KEYS.join(',')})&select=key,value`);
  const settings = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
  const blockers = estimatePricingSendBlockers(estimate, settings);
  return blockers.length ? blockers.map(blocker => blocker.msg).join('\n') : null;
}

module.exports = { estimatePricingSendError, PRICING_SEND_COLUMNS, PRICING_LINE_COLUMNS };
