// Netlify Function: Google Sheets reverse proxy.
// GET  /.netlify/functions/sheets-proxy?id=<sheetId>&range=<range>  -> sheet read
// POST /.netlify/functions/sheets-proxy  (JSON body)               -> sheet write
//
// Why this exists: the browser cannot call the Google Apps Script /exec URL
// directly. Apps Script responses do not carry an Access-Control-Allow-Origin
// header, so cross-origin GET reads fail CORS and surface as "failed to fetch"
// in the dashboard (booked sales / booked jobs, tasks, etc.). This function
// runs server-side, where CORS does not apply, forwards the request to Apps
// Script, and returns the result from the dashboard's own origin.
//
// The Apps Script deployment (v5) keeps serving unchanged; only the path the
// browser hits moved. The /exec URL is the same value that used to live in
// CONFIG.SHEETS_PROXY in index.html, so it is not a new secret.

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvM8U5sKn6B8gKWHG7-JD-fPFyquOlbpjQjDiRDSOUJD2P8XVIKuREGaKkFHCdum-KRA/exec';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    let res;
    if (event.httpMethod === 'POST') {
      res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: event.body || '{}',
      });
    } else {
      const params = event.queryStringParameters || {};
      const qs = Object.keys(params)
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');
      res = await fetch(APPS_SCRIPT_URL + (qs ? `?${qs}` : ''));
    }
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'sheets-proxy fetch failed: ' + (err && err.message ? err.message : String(err)) }),
    };
  }
};
