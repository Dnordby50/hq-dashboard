#!/bin/bash
# Syncs brain dump items from Google Sheet to Obsidian Open Loops file
# Run this manually or set up a cron job: crontab -e -> */30 * * * * /path/to/sync-braindump.sh

PROXY_URL="https://script.google.com/macros/s/AKfycbxvM8U5sKn6B8gKWHG7-JD-fPFyquOlbpjQjDiRDSOUJD2P8XVIKuREGaKkFHCdum-KRA/exec"
SHEET_ID="1445T0CPavFCWEj2soegc599nCZrbWLgDsCnjQGChI74"
OBSIDIAN_FILE="/Users/dylannordby/Desktop/HQ/00 - HQ/Open Loops.md"

# Fetch brain dump items that haven't been synced
DATA=$(curl -sL "${PROXY_URL}?id=${SHEET_ID}&range=BrainDump!A:C" 2>/dev/null)

if [ -z "$DATA" ] || [ "$DATA" = "[]" ]; then
  echo "No brain dump data found or BrainDump tab doesn't exist yet."
  exit 0
fi

# Parse JSON and find unsynced items (column C = "No")
ITEMS=$(echo "$DATA" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for i, row in enumerate(data):
    if i == 0: continue  # skip header
    if len(row) >= 3 and row[2] == 'No' and row[1].strip():
        print(f'{i}|{row[1]}')
" 2>/dev/null)

if [ -z "$ITEMS" ]; then
  echo "No new items to sync."
  exit 0
fi

# Append each item to the Brain Dump section of Open Loops
while IFS='|' read -r ROW_NUM ITEM_TEXT; do
  # Insert after the "## Brain Dump" section's existing items
  # Find the line with "---" after Brain Dump section and insert before it
  if grep -q "^- ${ITEM_TEXT}$" "$OBSIDIAN_FILE" 2>/dev/null; then
    echo "Already exists: $ITEM_TEXT"
    continue
  fi

  # Use sed to append after the last bullet in the Brain Dump section
  # Strategy: find "## Brain Dump" section, add item before the next "---"
  python3 -c "
import sys
lines = open('$OBSIDIAN_FILE', 'r').readlines()
in_braindump = False
insert_idx = None
for i, line in enumerate(lines):
    if '## Brain Dump' in line:
        in_braindump = True
        continue
    if in_braindump and line.strip() == '---':
        insert_idx = i
        break
if insert_idx:
    lines.insert(insert_idx, '- $ITEM_TEXT\n')
    open('$OBSIDIAN_FILE', 'w').writelines(lines)
    print(f'Added: $ITEM_TEXT')
else:
    print('Could not find Brain Dump section')
" 2>/dev/null

done <<< "$ITEMS"

echo "Sync complete."
