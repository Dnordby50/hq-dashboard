# HQ Dashboard Setup

## 1. Google Sheets API Key

1. Go to console.cloud.google.com
2. Create a project (or use existing)
3. Enable "Google Sheets API"
4. Go to Credentials > Create Credentials > API Key
5. Restrict the key to Google Sheets API only
6. Copy the key

Then make sure each Google Sheet is shared:
- Open each sheet > Share > "Anyone with the link" > Viewer

Sheet IDs already configured in the file:
- Booked Jobs: 1oNMMiuPmtrmu-x9Vxcy4kz0xxzQV00WNCGvk35rGLr4
- Dashboard Data: 1445T0CPavFCWEj2soegc599nCZrbWLgDsCnjQGChI74
- MBP 2026: 1vlumbi2mh_mjtmO1ZiTxMy0BTXbtNCNV-FOM-LVZ_s0

## 2. Anthropic API Key

1. Go to console.anthropic.com
2. Create an API key
3. Copy the key

## 3. Add Keys to Dashboard

Open dashboard.html and find the CONFIG block at the top of the script section. Replace:

    SHEETS_API_KEY: 'YOUR_GOOGLE_SHEETS_API_KEY'
    ANTHROPIC_API_KEY: 'YOUR_ANTHROPIC_API_KEY'

## 4. Password Protection

Give your web host these two files:
- .htaccess (update the AuthUserFile path to match your server)
- Generate .htpasswd with: htpasswd -c .htpasswd dylan

Your web guy will know what to do with these.

## 5. Deploy

Upload dashboard.html to your web host. That's it. Single file, no build step.

## 6. Test Locally

Just open dashboard.html in a browser. The coach and Sheets data will work if the API keys are set. No server needed.
