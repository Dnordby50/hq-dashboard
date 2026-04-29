// PEC PM Module 1: Apps Script POST handler for the existing CONFIG.SHEETS_PROXY
// web app.
//
// HOW TO INSTALL (handoff to Dylan):
//   1. Open the existing Apps Script project that hosts CONFIG.SHEETS_PROXY
//      (the one whose /exec URL is referenced in index.html around line 1575).
//   2. Append the code in this file to the project. KEEP your existing
//      doGet handler. Add doPost.
//   3. In Project Settings -> Script Properties, add a property named
//      SCRIPT_SECRET with a long random value. Copy that same value into the
//      Netlify env var PEC_SHEETS_PROXY_SECRET.
//   4. Deploy -> Manage Deployments -> Edit current Web App deployment ->
//      New Version. Keep "Execute as: Me" and "Who has access: Anyone".
//      The /exec URL stays the same.
//   5. Test the doPost handler from the Netlify Function pec-prod-sync-sheet
//      against a COPY of the production Sheet (not the production Sheet) the
//      first time. The sheet id is provided in the POST body.
//
// SHEET LAYOUT (columns A through O, header row at row 1):
//   A Install Date    B Proposal #    C Job Name      D System Type
//   E Sq Footage      F Material      G Supplier      H Color
//   I Qty Needed      J Backstock Qty K Order Qty     L Use backstock?
//   M Backstock Notes (NEW ORDER SHEET) / Date Completed (COMPLETED JOBS)
//   N Ordered?        O Delivered and Pulled to shelf?
//
// On a multi-row job block, only the FIRST row carries A through E. Subsequent
// rows leave A through E blank.

const PEC_NEW_ORDER_TAB   = 'NEW ORDER SHEET';
const PEC_COMPLETED_TAB   = 'COMPLETED JOBS';
const PEC_UNSCHEDULED_TAG = 'UNSCHEDULED';
const PEC_NUM_COLS        = 15;

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return _pecJson({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const expected = PropertiesService.getScriptProperties().getProperty('SCRIPT_SECRET');
  if (!expected || body.secret !== expected) {
    return _pecJson({ ok: false, error: 'Forbidden' }, 403);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return _pecJson({ ok: false, error: 'Sheet busy, retry in a moment' }, 503);
  }
  try {
    switch (body.action) {
      case 'syncJob':
        return _pecSyncJob(body);
      case 'moveJobToCompleted':
        return _pecMoveJobToCompleted(body);
      case 'ping':
        return _pecJson({ ok: true, pong: true });
      default:
        return _pecJson({ ok: false, error: `Unknown action ${body.action}` }, 400);
    }
  } catch (err) {
    return _pecJson({ ok: false, error: String(err && err.message || err) }, 500);
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// syncJob
//   body: {
//     sheet_id, proposal_number, install_date (YYYY-MM-DD or null),
//     job_name, system_type_summary, sqft_total,
//     lines: [{ material, supplier, color, qty_needed, backstock_qty,
//                order_qty, use_backstock, backstock_notes,
//                ordered, delivered }]
//   }
//   Behavior:
//   1. Find existing rows on NEW ORDER SHEET with col B = proposal_number; delete.
//   2. Build the new block (first row carries leading metadata).
//   3. Insert in chronological order by install_date; unscheduled jobs go
//      below an UNSCHEDULED divider row (created if missing).
// ----------------------------------------------------------------------------
function _pecSyncJob(body) {
  const ss = SpreadsheetApp.openById(body.sheet_id);
  const sh = ss.getSheetByName(PEC_NEW_ORDER_TAB);
  if (!sh) throw new Error(`Tab "${PEC_NEW_ORDER_TAB}" not found in sheet ${body.sheet_id}`);

  const proposal = String(body.proposal_number);
  if (!proposal) throw new Error('proposal_number required');

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (lines.length === 0) throw new Error('lines must be a non-empty array');

  _pecDeleteRowsByProposal(sh, proposal);

  const block = _pecBuildBlock(body, lines);
  const insertAt = _pecFindInsertionRow(sh, body.install_date);
  sh.insertRowsBefore(insertAt, block.length);
  sh.getRange(insertAt, 1, block.length, PEC_NUM_COLS).setValues(block);

  return _pecJson({
    ok: true,
    proposal_number: proposal,
    rows_written: block.length,
    inserted_at_row: insertAt,
  });
}

// ----------------------------------------------------------------------------
// moveJobToCompleted
//   body: { sheet_id, proposal_number, completed_date (YYYY-MM-DD) }
//   Behavior:
//   1. Capture rows on NEW ORDER SHEET with col B = proposal_number.
//   2. Delete those rows.
//   3. Append to COMPLETED JOBS, overwriting col M with completed_date.
// ----------------------------------------------------------------------------
function _pecMoveJobToCompleted(body) {
  const ss = SpreadsheetApp.openById(body.sheet_id);
  const newSh = ss.getSheetByName(PEC_NEW_ORDER_TAB);
  const doneSh = ss.getSheetByName(PEC_COMPLETED_TAB);
  if (!newSh) throw new Error(`Tab "${PEC_NEW_ORDER_TAB}" not found`);
  if (!doneSh) throw new Error(`Tab "${PEC_COMPLETED_TAB}" not found`);

  const proposal = String(body.proposal_number);
  if (!proposal) throw new Error('proposal_number required');
  const completedDate = String(body.completed_date || _pecTodayIso());

  const rows = _pecCollectRowsByProposal(newSh, proposal);
  if (rows.length === 0) {
    // Idempotent: if already moved, just succeed with a note.
    return _pecJson({
      ok: true,
      proposal_number: proposal,
      moved: 0,
      note: 'no rows on NEW ORDER SHEET; already moved or never synced',
    });
  }

  // Replace col M (index 12) with the completed date.
  const stamped = rows.map((row) => {
    const copy = row.slice();
    copy[12] = completedDate;
    return copy;
  });

  doneSh.getRange(doneSh.getLastRow() + 1, 1, stamped.length, PEC_NUM_COLS).setValues(stamped);
  _pecDeleteRowsByProposal(newSh, proposal);

  return _pecJson({
    ok: true,
    proposal_number: proposal,
    moved: stamped.length,
    completed_date: completedDate,
  });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function _pecBuildBlock(body, lines) {
  const installA = body.install_date ? String(body.install_date) : '';
  const block = lines.map((line, idx) => {
    const isFirst = idx === 0;
    return [
      isFirst ? installA : '',                    // A Install Date
      isFirst ? String(body.proposal_number) : '',// B Proposal #
      isFirst ? String(body.job_name || '') : '', // C Job Name
      isFirst ? String(body.system_type_summary || '') : '', // D System Type
      isFirst ? (body.sqft_total != null ? Number(body.sqft_total) : '') : '', // E Sq Footage
      String(line.material || ''),                // F Material
      String(line.supplier || ''),                // G Supplier
      String(line.color || ''),                   // H Color
      Number(line.qty_needed || 0),               // I Qty Needed
      Number(line.backstock_qty || 0),            // J Backstock Qty
      Number(line.order_qty || 0),                // K Order Qty
      line.use_backstock ? 'Yes' : '',            // L Use backstock?
      String(line.backstock_notes || ''),         // M Backstock Notes
      line.ordered ? 'Yes' : '',                  // N Ordered?
      line.delivered ? 'Yes' : '',                // O Delivered
    ];
  });
  return block;
}

function _pecCollectRowsByProposal(sh, proposal) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, PEC_NUM_COLS).getValues();
  // A job's "block" starts on a row with col B = proposal and runs until the
  // next row that has any of A..E populated (i.e., the next block's leading row).
  const blocks = [];
  let current = null;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const colB = String(row[1] || '').trim();
    const hasLeading = !!(row[0] || row[1] || row[2] || row[3] || row[4]);
    if (hasLeading) {
      // Close the previous block if it was the target.
      if (current) blocks.push(current);
      current = colB === proposal ? { startIndex: i, rows: [row] } : null;
    } else if (current) {
      current.rows.push(row);
    }
  }
  if (current) blocks.push(current);
  return blocks.flatMap((b) => b.rows);
}

function _pecDeleteRowsByProposal(sh, proposal) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const values = sh.getRange(2, 1, lastRow - 1, PEC_NUM_COLS).getValues();
  // Identify continuous blocks that belong to this proposal. A block starts on
  // any row whose A..E has data; subsequent blank-A..E rows belong to the
  // previous block.
  const toDeleteSheetRows = [];
  let inMatchingBlock = false;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const colB = String(row[1] || '').trim();
    const hasLeading = !!(row[0] || row[1] || row[2] || row[3] || row[4]);
    if (hasLeading) {
      inMatchingBlock = colB === proposal;
    }
    if (inMatchingBlock) {
      toDeleteSheetRows.push(i + 2); // +2 because i=0 corresponds to sheet row 2
    }
  }
  // Delete from bottom up so indices remain valid.
  for (let j = toDeleteSheetRows.length - 1; j >= 0; j--) {
    sh.deleteRow(toDeleteSheetRows[j]);
  }
  return toDeleteSheetRows.length;
}

function _pecFindInsertionRow(sh, installDate) {
  const lastRow = sh.getLastRow();
  // First data row is row 2.
  if (lastRow < 2) return 2;

  const values = sh.getRange(2, 1, lastRow - 1, 1).getValues(); // col A only

  if (!installDate) {
    // Unscheduled: insert just below the UNSCHEDULED divider, or create one
    // at the bottom and insert below it.
    let dividerSheetRow = -1;
    for (let i = 0; i < values.length; i++) {
      const a = String(values[i][0] || '').trim().toUpperCase();
      if (a === PEC_UNSCHEDULED_TAG) {
        dividerSheetRow = i + 2;
        break;
      }
    }
    if (dividerSheetRow === -1) {
      // Append a divider row at the bottom, then insert below it.
      const newDividerRow = lastRow + 1;
      sh.getRange(newDividerRow, 1, 1, PEC_NUM_COLS).setValues([_pecDividerRow()]);
      return newDividerRow + 1;
    }
    // Append at the bottom (after any existing unscheduled jobs).
    return lastRow + 1;
  }

  // Scheduled: walk down until we find the first scheduled row whose date is
  // strictly later than this installDate, OR the UNSCHEDULED divider, OR the
  // end of the data range.
  const target = _pecParseDate(installDate);
  for (let i = 0; i < values.length; i++) {
    const a = values[i][0];
    const aStr = String(a || '').trim();
    if (aStr.toUpperCase() === PEC_UNSCHEDULED_TAG) {
      return i + 2; // before the divider
    }
    const rowDate = _pecParseDate(a);
    if (rowDate && rowDate > target) {
      return i + 2;
    }
  }
  // No later row found and no unscheduled section: append at end. But if the
  // last block is unscheduled (no col-A on its leading row), we need to
  // insert above that. _pecDeleteRowsByProposal cleared this block, so we can
  // just append.
  return lastRow + 1;
}

function _pecDividerRow() {
  const row = new Array(PEC_NUM_COLS).fill('');
  row[0] = PEC_UNSCHEDULED_TAG;
  return row;
}

function _pecParseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  if (!s) return null;
  // Accept YYYY-MM-DD or MM/DD/YYYY.
  let d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}

function _pecTodayIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function _pecJson(obj, status) {
  // ContentService doesn't support custom status codes, but doPost responses
  // are JSON either way. The caller checks body.ok.
  const out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}
