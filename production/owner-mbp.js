// Owner MBP calculation foundation. Pure ESM: no database, browser state, or I/O.
// Do not embed an owner's workbook or actuals in this public static module.
// See owner-mbp.md for the input contract and source-cell correspondence.

export const MBP_VERSION = '2026-09-07.1';

export class MbpInputError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'MbpInputError';
    this.path = path;
  }
}

const DAY = 86400000;
const SALES_ACTUALS = { D: 'leads', J: 'estimates', V: 'jobsBooked', AB: 'bookedDollars' };
const REVENUE_ACTUALS = { D: 'producedDollars', K: 'laborHours', X: 'custom' };
const SALES_CUMULATIVES = { E: 'C', F: 'D', K: 'I', L: 'J', W: 'U', X: 'V', AC: 'AA', AD: 'AB', AI: 'AH' };
const REVENUE_CUMULATIVES = { E: 'C', F: 'D', L: 'J', M: 'K', Q: 'P', Y: 'W', Z: 'X' };
const SALES_FOOTER = ['C', 'D', 'I', 'J', 'U', 'V', 'AA', 'AB'];
const REVENUE_FOOTER = ['C', 'D', 'J', 'K', 'W', 'X'];

function fail(path, message) { throw new MbpInputError(path, message); }
function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value;
}
function number(value, path, { min = -Infinity, max = Infinity, integer = false, optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  if (value < min || value > max || (integer && !Number.isInteger(value))) fail(path, 'number is outside the permitted range');
  return value;
}
function positive(value, path) {
  number(value, path, { min: 0 });
  if (value === 0) fail(path, 'must be greater than zero');
  return value;
}
function date(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(path, 'expected YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(path, 'invalid date');
  return parsed;
}
function sum(values) { return values.reduce((total, value) => total + (value ?? 0), 0); }
// Missing actuals behave like Excel SUM, but an invalid required plan propagates.
function planSum(values) { return values.some(value => value === null) ? null : sum(values); }
function divide(numerator, denominator) {
  return numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
}
function actualRatio(numerator, denominator) { return divide(numerator ?? 0, denominator); }
function mean(values) {
  const present = values.filter(value => value !== null);
  return present.length ? sum(present) / present.length : null;
}
function coverage(entered, expected) {
  return { entered, expected, state: entered === expected ? 'complete' : entered === 0 ? 'missing' : 'partial' };
}

function calendarFrom(input) {
  number(input.year, 'year', { min: 1900, max: 9999, integer: true });
  if (!Array.isArray(input.weekEndings) || ![52, 53].includes(input.weekEndings.length)) {
    fail('weekEndings', 'provide the explicit 52 or 53 source week-ending dates');
  }
  let previous;
  return input.weekEndings.map((value, index) => {
    const parsed = date(value, `weekEndings[${index}]`);
    if (parsed.getUTCFullYear() !== input.year || parsed.getUTCDay() !== 0) fail(`weekEndings[${index}]`, 'expected a Sunday in the plan year');
    if (index === 0 && parsed.getUTCMonth() !== 0) fail('weekEndings[0]', 'the annual plan must start in January');
    if (previous !== undefined && parsed.getTime() - previous !== 7 * DAY) fail(`weekEndings[${index}]`, 'weeks must be unique, consecutive, and chronological');
    previous = parsed.getTime();
    return { week: index + 1, weekEnding: value, quarter: Math.min(4, Math.floor(index / 13) + 1) };
  });
}

function keyedRows(rows, calendar, path) {
  if (!Array.isArray(rows) || rows.length !== calendar.length) fail(path, 'one keyed row is required for every source week');
  const allowed = new Set(calendar.map(week => week.weekEnding));
  const byDate = new Map();
  rows.forEach((row, index) => {
    record(row, `${path}[${index}]`);
    if (!allowed.has(row.weekEnding) || byDate.has(row.weekEnding)) fail(`${path}[${index}].weekEnding`, 'unknown or duplicate week');
    byDate.set(row.weekEnding, row);
  });
  return calendar.map(week => byDate.get(week.weekEnding));
}

function weeklyInputs(rows, calendar, path) {
  const ordered = keyedRows(rows, calendar, path);
  rows.forEach((row, index) => number(row.weight, `${path}[${index}].weight`, { min: 0, max: 1 }));
  if (Math.abs(sum(rows.map(row => row.weight)) - 1) > 1e-8) fail(`${path}.weight`, 'annual seasonal allocations must sum to 1; they are never silently normalized');
  return ordered;
}

function readActuals(row, fields, path) {
  const actual = row.actual == null ? {} : record(row.actual, `${path}.actual`);
  const v = {}, present = {};
  for (const [column, field] of Object.entries(fields)) {
    const count = ['leads', 'estimates', 'jobsBooked'].includes(field);
    v[column] = number(actual[field], `${path}.actual.${field}`, {
      optional: true, min: count || field === 'laborHours' ? 0 : -Infinity, integer: count,
    });
    present[column] = coverage(v[column] === null ? 0 : 1, 1);
  }
  return { v, coverage: present };
}

function calculateSales(line, calendar) {
  const path = `lines.${line.id}.sales`, input = record(line.sales, path);
  if (input.claimsEnabled != null && input.claimsEnabled !== false) fail(`${path}.claimsEnabled`, 'only the source workbook\'s active Typical sales scenario is supported');
  const newSales = number(input.newSales, `${path}.newSales`, { min: 0 });
  const carryOver = number(input.carryOver, `${path}.carryOver`, { min: 0, optional: true });
  const recurring = number(input.recurring, `${path}.recurring`, { min: 0, optional: true });
  const conversion = number(input.leadConversion, `${path}.leadConversion`, { min: 0, max: 1 });
  const closeRate = number(input.salesRatio, `${path}.salesRatio`, { min: 0, max: 1 });
  const jobSize = positive(input.averageJobSize, `${path}.averageJobSize`);
  const issues = [];
  const rows = weeklyInputs(input.weekly, calendar, `${path}.weekly`).map((row, index) => {
    const weekPath = `${path}.${row.weekEnding}`;
    const leadOverride = number(row.leadConversionOverride, `${weekPath}.leadConversionOverride`, { optional: true, min: 0, max: 1 });
    const closeOverride = number(row.salesRatioOverride, `${weekPath}.salesRatioOverride`, { optional: true, min: 0, max: 1 });
    const read = readActuals(row, SALES_ACTUALS, weekPath);
    const booked = newSales * row.weight;
    const jobs = newSales / jobSize * row.weight;
    const estimates = divide(jobs, closeOverride ?? closeRate);
    const leads = divide(estimates, leadOverride ?? conversion);
    // A deliberate zero override must not fall back to the base assumption.
    if ((closeOverride ?? closeRate) === 0) issues.push({ weekEnding: row.weekEnding, column: 'I', code: 'zero_sales_ratio' });
    if ((leadOverride ?? conversion) === 0) issues.push({ weekEnding: row.weekEnding, column: 'C', code: 'zero_lead_conversion' });
    return { ...calendar[index], ...read, v: {
      ...read.v, C: leads, I: estimates, U: jobs, AA: booked, AH: row.weight,
      AJ: conversion, AL: leadOverride, AM: closeRate, AO: closeOverride, AP: jobSize,
    } };
  });
  return {
    kind: 'sales', businessLineId: line.id, label: line.label, sourceTabName: `SP - (Wk) ${line.label}`,
    top: { C4: sum([newSales, carryOver, recurring]), C5: newSales, C6: carryOver, C7: recurring, K4: conversion, K5: closeRate, K6: jobSize },
    rows, issues,
  };
}

function calculateRevenue(line, calendar) {
  const path = `lines.${line.id}.revenue`, input = record(line.revenue, path);
  const annual = number(input.annualProduced, `${path}.annualProduced`, { min: 0 });
  const rate = positive(input.chargeRate, `${path}.chargeRate`);
  const rows = weeklyInputs(input.weekly, calendar, `${path}.weekly`).map((row, index) => {
    const weekPath = `${path}.${row.weekEnding}`;
    const read = readActuals(row, REVENUE_ACTUALS, weekPath);
    const produced = annual * row.weight;
    return { ...calendar[index], ...read, v: {
      ...read.v, C: produced, J: produced / rate, P: row.weight, R: rate,
      W: number(row.customPlan, `${weekPath}.customPlan`, { optional: true }),
    } };
  });
  return {
    kind: 'revenue', businessLineId: line.id, label: line.label, sourceTabName: `RP - (Wk) ${line.label}`,
    top: { C4: annual, C6: rate }, rows, issues: [],
  };
}

function combine(sheets, calendar, kind, customRows) {
  const sales = kind === 'sales';
  const actualColumns = Object.keys(sales ? SALES_ACTUALS : REVENUE_ACTUALS);
  const planColumns = sales ? ['C', 'I', 'U', 'AA'] : ['C', 'J'];
  const top = { C4: sum(sheets.map(sheet => sheet.top.C4)) };
  if (sales) for (const column of ['C5', 'C6', 'C7']) top[column] = sum(sheets.map(sheet => sheet.top[column]));
  const rows = calendar.map((week, index) => {
    const parts = sheets.map(sheet => sheet.rows[index]);
    const v = {}, present = {};
    for (const column of planColumns) v[column] = planSum(parts.map(row => row.v[column]));
    for (const column of actualColumns) {
      // Preserve TOTAL's SUM behavior, but never interpret a formula zero as an entry.
      v[column] = sum(parts.map(row => row.v[column]));
      present[column] = coverage(sum(parts.map(row => row.coverage[column].entered)), parts.length);
    }
    if (sales) {
      v.AH = divide(v.AA, top.C5);
      v.AJ = divide(v.I, v.C);
      v.AM = divide(v.U, v.I);
      // Original TOTAL AL/AO marker formulas reference retired Name tabs.
      // Preserve overrides on each line; do not reproduce those stale references.
      v.AL = null; v.AO = null;
    } else {
      v.P = divide(v.C, top.C4);
      v.R = divide(v.C, v.J);
      // The source TOTAL Custom Option is independent, not a sum of brand
      // custom fields (those may represent entirely different measures).
      v.W = customRows[index].plan;
      v.X = customRows[index].actual;
      present.X = coverage(v.X === null ? 0 : 1, 1);
    }
    return { ...week, v, coverage: present };
  });
  if (sales) {
    top.K4 = divide(planSum(rows.map(row => row.v.I)), planSum(rows.map(row => row.v.C)));
    top.K5 = divide(planSum(rows.map(row => row.v.U)), planSum(rows.map(row => row.v.I)));
    top.K6 = divide(planSum(rows.map(row => row.v.AA)), planSum(rows.map(row => row.v.U)));
    // Source AP is the annual TOTAL job-size assumption, not a weekly average.
    rows.forEach(row => { row.v.AP = top.K6; });
  } else {
    top.C6 = divide(planSum(rows.map(row => row.v.C)), planSum(rows.map(row => row.v.J)));
  }
  return {
    kind, businessLineId: 'total', label: 'TOTAL',
    sourceTabName: sales ? 'Sales Plan - (Wk) TOTAL' : 'Revenue Produced - (Wk) TOTAL',
    top, rows, issues: sheets.flatMap(sheet => sheet.issues.map(issue => ({ ...issue, businessLineId: sheet.businessLineId }))),
  };
}

function finish(sheet, asOfIndex) {
  const sales = sheet.kind === 'sales';
  const cumulatives = sales ? SALES_CUMULATIVES : REVENUE_CUMULATIVES;
  const fields = sales ? SALES_ACTUALS : REVENUE_ACTUALS;
  const optionalPlan = sales ? [] : ['W'];
  const running = {}, entered = {}, expected = {};
  sheet.rows.forEach((row, index) => {
    row.sourceRow = index + (sales ? 12 : 11);
    row.cumulativeCoverage = {};
    for (const [target, column] of Object.entries(cumulatives)) {
      const missingIsZero = column in fields || optionalPlan.includes(column);
      running[target] = missingIsZero
        ? (running[target] ?? 0) + (row.v[column] ?? 0)
        : planSum([index === 0 ? 0 : running[target], row.v[column]]);
      row.v[target] = running[target];
    }
    for (const column of Object.keys(fields)) {
      entered[column] = (entered[column] ?? 0) + row.coverage[column].entered;
      expected[column] = (expected[column] ?? 0) + row.coverage[column].expected;
      row.cumulativeCoverage[column] = coverage(entered[column], expected[column]);
    }
    if (sales) {
      row.v.AE = row.v.AC === null ? null : row.v.AD - row.v.AC;
      row.v.AK = actualRatio(row.v.J, row.v.D);
      row.v.AN = actualRatio(row.v.V, row.v.J);
      row.v.AQ = actualRatio(row.v.AB, row.v.V);
      row.v.AR = divide(row.v.AD, row.v.X);
    } else {
      row.v.G = row.v.E === null ? null : row.v.F - row.v.E;
      row.v.S = actualRatio(row.v.D, row.v.K);
      row.v.T = divide(row.v.F, row.v.M);
    }
  });
  sheet.footer = {};
  for (const column of sales ? SALES_FOOTER : REVENUE_FOOTER) {
    const values = sheet.rows.map(row => row.v[column]);
    sheet.footer[column] = column in fields || optionalPlan.includes(column) ? sum(values) : planSum(values);
  }
  if (sales) {
    sheet.top.L4 = divide(sheet.footer.J, sheet.footer.D);
    sheet.top.L5 = divide(sheet.footer.V, sheet.footer.J);
    sheet.top.L6 = divide(sheet.footer.AB, sheet.footer.V);
    for (const column of ['AK', 'AN', 'AQ']) sheet.footer[column] = mean(sheet.rows.map(row => row.v[column]));
  } else sheet.top.D6 = divide(sheet.footer.D, sheet.footer.K);

  const asOf = sheet.rows[asOfIndex];
  const moneyColumn = sales ? 'AB' : 'D';
  const cumulativeMoney = sales ? 'AD' : 'F';
  const cumulativePlan = sales ? 'AC' : 'E';
  const cumulativeWeight = sales ? 'AI' : 'Q';
  const annualized = divide(asOf.v[cumulativeMoney], asOf.v[cumulativeWeight]);
  if (sales) {
    sheet.top.E5 = annualized; sheet.top.E6 = sheet.top.C6; sheet.top.E7 = sheet.top.C7;
    sheet.top.E4 = annualized === null ? null : sum([annualized, sheet.top.E6, sheet.top.E7]);
  } else sheet.top.D4 = annualized;
  sheet.summary = {
    asOfWeekEnding: asOf.weekEnding,
    recordedThroughWeek: asOf.v[cumulativeMoney],
    planThroughWeek: asOf.v[cumulativePlan],
    gapThroughWeek: asOf.v[cumulativePlan] === null ? null : asOf.v[cumulativeMoney] - asOf.v[cumulativePlan],
    coverage: { ...asOf.cumulativeCoverage },
    trend: { value: annualized, coverage: { ...asOf.cumulativeCoverage[moneyColumn] }, kind: 'seasonal_annualization' },
    // These include all entered source weeks, as Excel's annual footer does.
    // The as-of summary above deliberately excludes later entries.
    annualCoverage: { ...sheet.rows.at(-1).cumulativeCoverage },
  };
  // Finite inputs can still overflow during division or aggregation. Never let
  // JSON serialization turn an overflow into a seemingly ordinary blank cell.
  for (const [location, cells] of [
    ['top', sheet.top], ['footer', sheet.footer],
    ...sheet.rows.map(row => [row.weekEnding, row.v]),
  ]) {
    for (const [column, value] of Object.entries(cells)) {
      if (value !== null && !Number.isFinite(value)) fail(`${sheet.kind}.${sheet.businessLineId}.${location}.${column}`, 'calculation exceeded the finite numeric range');
    }
  }
  return sheet;
}

/**
 * Recalculate the active Typical-sales and produced-revenue MBP grids.
 * All dates/actuals/goals are supplied by the caller. No live company mapping,
 * source freshness, authorization, accounting recognition, or persistence is
 * implied. Result cell values MUST be displayed with their coverage metadata.
 */
export function calculateMbp(input) {
  record(input, 'input');
  if (input.schemaVersion !== 1) fail('schemaVersion', 'expected version 1');
  const calendar = calendarFrom(input);
  const asOfIndex = calendar.findIndex(week => week.weekEnding === input.asOfWeekEnding);
  if (asOfIndex < 0) fail('asOfWeekEnding', 'select an explicit source week; there is no implicit current date');
  if (!Array.isArray(input.lines) || input.lines.length === 0) fail('lines', 'at least one business line is required');
  const ids = new Set();
  for (const [index, line] of input.lines.entries()) {
    record(line, `lines[${index}]`);
    if (typeof line.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(line.id) || line.id === 'total' || ids.has(line.id)) fail(`lines[${index}].id`, 'use a unique business-line ID; total is reserved');
    if (typeof line.label !== 'string' || !line.label.trim()) fail(`lines[${index}].label`, 'a display label is required');
    ids.add(line.id);
  }
  const sales = input.lines.map(line => calculateSales(line, calendar));
  const revenue = input.lines.map(line => calculateRevenue(line, calendar));
  const customRows = input.totalRevenueCustom == null
    ? calendar.map(() => ({ plan: null, actual: null }))
    : keyedRows(input.totalRevenueCustom, calendar, 'totalRevenueCustom').map((row, index) => ({
      plan: number(row.plan, `totalRevenueCustom[${index}].plan`, { optional: true }),
      actual: number(row.actual, `totalRevenueCustom[${index}].actual`, { optional: true }),
    }));
  const sheets = [combine(sales, calendar, 'sales'), ...sales, combine(revenue, calendar, 'revenue', customRows), ...revenue]
    .map(sheet => finish(sheet, asOfIndex));
  return { schemaVersion: 1, calculatorVersion: MBP_VERSION, year: input.year, calendar, sheets };
}
