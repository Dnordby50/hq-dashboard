# Apps Script Setup (Tasks + Coach Logging + Brain Dump)

Your HQ Dashboard proxy script needs to be updated to handle task syncing, brain dump writes, and coach logging.

## Update the Apps Script

1. Go to script.google.com and open the "HQ Dashboard Proxy" project
2. Replace ALL the code with this:

```javascript
function doGet(e) {
  var id = e.parameter.id;
  var range = e.parameter.range;
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getRange(range);
  var values = sheet.getValues();
  return ContentService.createTextOutput(JSON.stringify(values))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.openById('1445T0CPavFCWEj2soegc599nCZrbWLgDsCnjQGChI74');

  // TASK SYNC: replaces entire Tasks sheet with current task list
  if (data.action === 'syncTasks') {
    var sheet = ss.getSheetByName('Tasks');
    if (!sheet) {
      sheet = ss.insertSheet('Tasks');
    }
    // Clear and rewrite
    sheet.clear();
    sheet.appendRow(['ID', 'Text', 'Done', 'Source', 'Created']);
    sheet.getRange('1:1').setFontWeight('bold');
    if (data.tasks && data.tasks.length) {
      var rows = data.tasks.map(function(t) {
        return [t.id, t.text, String(t.done), t.source, t.created];
      });
      sheet.getRange(2, 1, rows.length, 5).setValues(rows);
    }
  }

  // BRAIN DUMP
  if (data.action === 'braindump') {
    var bdSheet = ss.getSheetByName('BrainDump');
    if (!bdSheet) {
      bdSheet = ss.insertSheet('BrainDump');
      bdSheet.appendRow(['Timestamp', 'Item', 'Synced to Obsidian']);
      bdSheet.getRange('1:1').setFontWeight('bold');
    }
    bdSheet.appendRow([data.timestamp, data.text, 'No']);
  }

  // COACH LOG
  if (data.action === 'coachlog' || data.transcript) {
    var log = ss.getSheetByName('CoachLog');
    if (!log) {
      log = ss.insertSheet('CoachLog');
      log.appendRow(['Timestamp', 'Transcript']);
      log.getRange('1:1').setFontWeight('bold');
    }
    log.appendRow([data.timestamp, data.transcript]);
  }

  return ContentService.createTextOutput('OK');
}
```

3. Click Save
4. Click Deploy > Manage deployments > Edit (pencil icon) > Version: New version > Deploy

IMPORTANT: You must create a NEW version when you update the code. Just saving is not enough.

## What This Does

- **Tasks** sync to a "Tasks" tab. Every add/complete/delete pushes the full task list to the sheet. Every page load reads from it. Works across all devices.
- **Brain dump** items save to a "BrainDump" tab
- **Coach logs** save to a "CoachLog" tab
- The Obsidian sync script reads from BrainDump and appends to your Open Loops file
