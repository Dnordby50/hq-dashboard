// Editable cells and source provenance for the private MBP working copy.
// Input values are never embedded here. This module has no browser, network, or storage access.
import { calculateMbp } from './owner-mbp.js';

export class MbpInputEditError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.name = 'MbpInputEditError'; this.path = path; }
}
const fail = (path, message) => { throw new MbpInputEditError(path, message); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const DAY = 86400000;
const definitions = {
  sales: {
    annual: {
      newSales: { label: 'New sales', type: 'money', min: 0, address: 'C5' },
      carryOver: { label: 'Carry over sales', type: 'money', min: 0, nullable: true, address: 'C6' },
      recurring: { label: 'Recurring contracts', type: 'money', min: 0, nullable: true, address: 'C7' },
      leadConversion: { label: 'Lead conversion', type: 'percent', min: 0, max: 1, address: 'K4' },
      salesRatio: { label: 'Sales ratio', type: 'percent', min: 0, max: 1, address: 'K5' },
      averageJobSize: { label: 'Average job size', type: 'money', min: 0, exclusiveMin: true, address: 'K6' },
    },
    weekly: {
      leads: { label: 'Leads', type: 'number', min: 0, integer: true, actual: true, column: 'D' },
      estimates: { label: 'Estimates', type: 'number', min: 0, integer: true, actual: true, column: 'J' },
      jobsBooked: { label: 'Jobs booked', type: 'number', min: 0, integer: true, actual: true, column: 'V' },
      bookedDollars: { label: 'Dollars booked', type: 'money', actual: true, column: 'AB' },
      weight: { label: 'Booked plan allocation', type: 'percent', min: 0, max: 1, column: 'AH' },
      leadConversionOverride: { label: 'Lead conversion override', type: 'percent', min: 0, max: 1, nullable: true, column: 'AL' },
      salesRatioOverride: { label: 'Sales ratio override', type: 'percent', min: 0, max: 1, nullable: true, column: 'AO' },
    },
  },
  revenue: {
    annual: {
      annualProduced: { label: 'Annual produced revenue', type: 'money', min: 0, address: 'C4' },
      chargeRate: { label: 'Production charge rate', type: 'money', min: 0, exclusiveMin: true, address: 'C6' },
    },
    weekly: {
      producedDollars: { label: 'Dollars produced', type: 'money', actual: true, column: 'D' },
      laborHours: { label: 'Hours produced', type: 'number', min: 0, actual: true, column: 'K' },
      custom: { label: 'Custom actual', type: 'number', actual: true, column: 'X' },
      weight: { label: 'Produced plan allocation', type: 'percent', min: 0, max: 1, column: 'P' },
      customPlan: { label: 'Custom weekly plan', type: 'number', nullable: true, column: 'W' },
    },
  },
};
const totalFields = {
  plan: { label: 'TOTAL custom plan', type: 'number', nullable: true, column: 'W' },
  actual: { label: 'TOTAL custom actual', type: 'number', nullable: true, actual: true, column: 'X' },
};
const LIVE = new Set(['leads', 'estimates', 'jobsBooked', 'bookedDollars', 'producedDollars', 'laborHours']);
function inputOf(value) {
  if (!isRecord(value)) fail('mbp', 'expected an MBP input or working document');
  const input = own(value, 'mbp') ? value.mbp : value;
  if (!isRecord(input) || !Array.isArray(input.lines) || !Array.isArray(input.weekEndings)) fail('mbp', 'expected the original MBP input structure');
  return input;
}
function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(path, 'expected an ISO timestamp');
  return value;
}
function dateKey(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(path, 'expected a date');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || date.getUTCDay() !== 0) fail(path, 'expected a Sunday week-ending date');
  return value;
}
function descriptor(input, lineId, kind, weekEnding, field) {
  if (!['sales', 'revenue'].includes(kind)) fail('key', 'this is not an editable MBP field');
  const annual = weekEnding === 'annual';
  const weekIndex = annual ? -1 : input.weekEndings.indexOf(weekEnding);
  if (!annual && weekIndex < 0) fail('key', 'week is outside the saved calendar');
  const total = lineId === 'total';
  if (total && (kind !== 'revenue' || annual)) fail('key', 'TOTAL calculated values are read only');
  if (!total && !input.lines.some(line => line.id === lineId)) fail('key', 'unknown business line');
  const options = total ? totalFields : definitions[kind][annual ? 'annual' : 'weekly'];
  if (!own(options, field)) fail('key', 'this field is calculated or unavailable for editing');
  const definition = options[field];
  const sourceAddress = definition.address || `${definition.column}${weekIndex + (kind === 'sales' ? 12 : 11)}`;
  return {
    key: `${lineId}/${kind}/${weekEnding}/${field}`,
    lineId, kind, scope: total ? 'total-custom' : annual ? 'annual' : 'weekly', weekEnding, field,
    label: definition.label, type: definition.type, nullable: Boolean(definition.nullable || definition.actual),
    ...(definition.min !== undefined ? { min: definition.min } : {}),
    ...(definition.max !== undefined ? { max: definition.max } : {}),
    integer: Boolean(definition.integer), exclusiveMin: Boolean(definition.exclusiveMin),
    sourceColumn: sourceAddress.match(/^[A-Z]+/)[0], sourceAddress,
    actual: Boolean(definition.actual), live: lineId === 'epoxy' && !annual && Boolean(definition.actual) && LIVE.has(field),
  };
}
function resolve(input, key) {
  if (typeof key !== 'string' || key.length > 180) fail('key', 'expected an editable field key');
  const pieces = key.split('/');
  if (pieces.length !== 4 || pieces.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) fail('key', 'invalid editable field key');
  const result = descriptor(input, ...pieces);
  if (result.key !== key) fail('key', 'invalid editable field key');
  return result;
}
function read(input, field) {
  if (field.lineId === 'total') return input.totalRevenueCustom?.find(row => row.weekEnding === field.weekEnding)?.[field.field] ?? null;
  const plan = input.lines.find(line => line.id === field.lineId)[field.kind];
  if (field.scope === 'annual') return plan[field.field] ?? null;
  const row = plan.weekly.find(item => item.weekEnding === field.weekEnding);
  return (field.actual ? row.actual?.[field.field] : row[field.field]) ?? null;
}
function write(input, field, value) {
  if (field.lineId === 'total') {
    if (!input.totalRevenueCustom) input.totalRevenueCustom = input.weekEndings.map(weekEnding => ({ weekEnding, plan: null, actual: null }));
    input.totalRevenueCustom.find(row => row.weekEnding === field.weekEnding)[field.field] = value; return;
  }
  const plan = input.lines.find(line => line.id === field.lineId)[field.kind];
  if (field.scope === 'annual') { plan[field.field] = value; return; }
  const row = plan.weekly.find(item => item.weekEnding === field.weekEnding);
  if (field.actual) { row.actual ||= {}; row.actual[field.field] = value; }
  else row[field.field] = value;
}
function validateValue(value, field, path) {
  if (value === null && field.nullable) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, field.nullable ? 'enter a finite number or leave blank' : 'a finite number is required');
  if (field.integer && !Number.isInteger(value)) fail(path, 'enter a whole number');
  if ((field.min !== undefined && (value < field.min || field.exclusiveMin && value === field.min)) || field.max !== undefined && value > field.max) fail(path, 'value is outside the permitted range');
}
function validatedBody(body) {
  if (!isRecord(body) || !own(body, 'mbp')) fail('body', 'expected a working document with mbp');
  const input = inputOf(body); calculateMbp(input);
  if (body.mbpCellState !== undefined) {
    if (!isRecord(body.mbpCellState) || Object.keys(body.mbpCellState).length > 15000) fail('mbpCellState', 'invalid input history');
    for (const [key, state] of Object.entries(body.mbpCellState)) {
      const field = resolve(input, key), path = `mbpCellState.${key}`;
      if (!isRecord(state)) fail(path, 'expected field history');
      if (state.origin !== undefined && !['manual', 'topcoat'].includes(state.origin)) fail(path, 'invalid input origin');
      if (state.origin === 'topcoat' && !field.live) fail(path, 'only PEC source actuals can come from TopCoat');
      if (state.origin) timestamp(state.updatedAt, `${path}.updatedAt`);
      if (state.sourceAvailable !== undefined && typeof state.sourceAvailable !== 'boolean') fail(path, 'invalid source availability');
      if (own(state, 'sourceValue')) {
        if (!field.live) fail(path, 'source values are restricted to PEC actuals');
        validateValue(state.sourceValue, field, `${path}.sourceValue`);
      }
      if (state.sourceUpdatedAt !== undefined) timestamp(state.sourceUpdatedAt, `${path}.sourceUpdatedAt`);
      if (state.sourceAvailable === true && (!own(state, 'sourceValue') || state.sourceValue === null || !state.sourceUpdatedAt)) fail(path, 'available source value is missing');
    }
  }
  if (body.mbpLiveState !== undefined) {
    if (!isRecord(body.mbpLiveState)) fail('mbpLiveState', 'invalid source status');
    timestamp(body.mbpLiveState.queriedAt, 'mbpLiveState.queriedAt');
  }
  return input;
}

export function validateMbpInputState(body) { validatedBody(body); return body; }

/** Source input descriptors, including independent TOTAL revenue custom cells. */
export function mbpInputFields(bodyOrMbp) {
  const input = inputOf(bodyOrMbp); calculateMbp(input);
  const fields = [];
  for (const line of input.lines) for (const kind of ['sales', 'revenue']) {
    for (const field of Object.keys(definitions[kind].annual)) fields.push(descriptor(input, line.id, kind, 'annual', field));
    for (const weekEnding of input.weekEndings) for (const field of Object.keys(definitions[kind].weekly)) fields.push(descriptor(input, line.id, kind, weekEnding, field));
  }
  for (const weekEnding of input.weekEndings) for (const field of Object.keys(totalFields)) fields.push(descriptor(input, 'total', 'revenue', weekEnding, field));
  return fields.map(field => ({ ...field, value: read(input, field) }));
}
export function getMbpInput(bodyOrMbp, key) {
  const input = inputOf(bodyOrMbp); return read(input, resolve(input, key));
}

/** Apply a complete edit batch, then validate weights and all derived calculations. */
export function applyMbpEdits(body, edits, editedAt) {
  const input = validatedBody(body); timestamp(editedAt, 'timestamp');
  if (!Array.isArray(edits) || edits.length > 15000) fail('edits', 'expected a bounded list of field changes');
  const next = structuredClone(body), keys = new Set();
  for (const [index, edit] of edits.entries()) {
    const path = `edits[${index}]`;
    if (!isRecord(edit)) fail(path, 'expected a field edit');
    const field = resolve(input, edit.key);
    if (keys.has(field.key)) fail(path, 'the same field is edited more than once');
    keys.add(field.key);
    const prior = next.mbpCellState?.[field.key];
    if (edit.mode === 'topcoat') {
      if (own(edit, 'value')) fail(path, 'Use TopCoat does not accept a replacement value');
      if (!field.live || prior?.sourceAvailable !== true || !own(prior, 'sourceValue') || prior.sourceValue === null || !prior.sourceUpdatedAt) fail(path, 'a currently available TopCoat value is required');
      validateValue(prior.sourceValue, field, path);
      write(next.mbp, field, prior.sourceValue);
      next.mbpCellState[field.key] = { ...prior, origin: 'topcoat', updatedAt: editedAt };
      continue;
    }
    if (edit.mode !== undefined && edit.mode !== 'manual') fail(path, 'unknown edit mode');
    if (!own(edit, 'value')) fail(path, 'an edited value is required');
    validateValue(edit.value, field, path);
    // Merely opening and saving a field must not change its provenance or precision.
    if (read(next.mbp, field) === edit.value) continue;
    write(next.mbp, field, edit.value);
    next.mbpCellState ||= {};
    next.mbpCellState[field.key] = { ...prior, origin: 'manual', updatedAt: editedAt };
  }
  validatedBody(next); return next;
}

function currentWeek(queriedAt) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(queriedAt));
  const item = type => parts.find(part => part.type === type).value;
  const date = new Date(`${item('year')}-${item('month')}-${item('day')}T00:00:00Z`);
  return new Date(date.getTime() + (7 - date.getUTCDay()) % 7 * DAY).toISOString().slice(0, 10);
}
/** Refresh eligible PEC actuals; manual and untracked imported values remain intact. */
export function applyMbpLive(body, feed) {
  validatedBody(body);
  if (!isRecord(feed)) fail('feed', 'expected a verified TopCoat feed');
  timestamp(feed.queriedAt, 'feed.queriedAt');
  if (feed.throughWeek !== null) dateKey(feed.throughWeek, 'feed.throughWeek');
  if (!Array.isArray(feed.weeks) || feed.weeks.length > 53) fail('feed.weeks', 'expected at most 53 source weeks');
  if (feed.warnings !== undefined && (!Array.isArray(feed.warnings) || feed.warnings.length > 100 || feed.warnings.some(value => typeof value !== 'string' || value.length > 2000))) fail('feed.warnings', 'invalid source warnings');
  const byWeek = new Map();
  for (const [index, row] of feed.weeks.entries()) {
    const path = `feed.weeks[${index}]`;
    if (!isRecord(row) || !isRecord(row.actual) || !isRecord(row.available)) fail(path, 'expected source values and availability');
    dateKey(row.weekEnding, `${path}.weekEnding`);
    if (byWeek.has(row.weekEnding)) fail(path, 'duplicate source week');
    for (const [field, available] of Object.entries(row.available)) if (!LIVE.has(field) || typeof available !== 'boolean') fail(path, 'invalid source availability');
    byWeek.set(row.weekEnding, row);
  }
  const next = structuredClone(body);
  // Out-of-order responses cannot replace a newer source snapshot or its availability.
  if (body.mbpLiveState && Date.parse(feed.queriedAt) < Date.parse(body.mbpLiveState.queriedAt)) return next;
  const current = currentWeek(feed.queriedAt);
  const throughWeek = feed.throughWeek === null ? null : feed.throughWeek < current ? feed.throughWeek : current;
  next.mbpLiveState = { queriedAt: feed.queriedAt, throughWeek, warnings: [...(feed.warnings || [])] };
  for (const field of mbpInputFields(next).filter(field => field.live)) {
    const source = throughWeek !== null && field.weekEnding <= throughWeek ? byWeek.get(field.weekEnding) : null;
    const prior = next.mbpCellState?.[field.key];
    if (prior?.sourceUpdatedAt && Date.parse(prior.sourceUpdatedAt) > Date.parse(feed.queriedAt)) continue;
    const available = source?.available[field.field] === true;
    if (!available) {
      if (prior && (own(prior, 'sourceValue') || prior.sourceAvailable !== undefined)) next.mbpCellState[field.key] = { ...prior, sourceAvailable: false, sourceUpdatedAt: feed.queriedAt };
      continue;
    }
    const sourceValue = source.actual[field.field];
    if (sourceValue === null || sourceValue === undefined) fail(`feed.${field.key}`, 'available source fields need a numeric value');
    validateValue(sourceValue, field, `feed.${field.key}`);
    next.mbpCellState ||= {};
    const state = { ...prior, sourceValue, sourceUpdatedAt: feed.queriedAt, sourceAvailable: true };
    const previous = read(next.mbp, field);
    if (prior?.origin === 'topcoat' || !prior?.origin && previous === null) {
      write(next.mbp, field, sourceValue);
      state.origin = 'topcoat'; state.updatedAt = feed.queriedAt;
    }
    next.mbpCellState[field.key] = state;
  }
  validatedBody(next); return next;
}
