// Netlify Function: SOP Chatbot Claude API proxy
// Keeps ANTHROPIC_API_KEY server-side (set in Netlify env vars).
// POST /.netlify/functions/sop-chat
// Body: { system: string, messages: [{role, content}], model?: string, max_tokens?: number }
//
// SECURITY: this is a relay to the Anthropic API billed to our key. It used to
// be UNAUTHENTICATED, so anyone on the internet could POST arbitrary prompts
// (choosing model + max_tokens) and run up the bill / use it as a free Claude
// proxy. It now requires a logged-in staff JWT (requireStaff), and max_tokens is
// clamped to a ceiling so a single call cannot request an unbounded completion.
// Renamed .js -> .cjs so it is unambiguously CommonJS under package "type":"module".

const { requireStaff } = require('./_pec-supabase.cjs');

const MAX_TOKENS_CEILING = 4096;

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = await requireStaff(event);
  if (!auth.ok) {
    return { statusCode: auth.status, headers: corsHeaders, body: JSON.stringify({ error: auth.error }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { system, messages, model, max_tokens } = body;
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing system or messages' })
    };
  }

  const cappedMaxTokens = Math.min(Number(max_tokens) || 1024, MAX_TOKENS_CEILING);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: cappedMaxTokens,
        system,
        messages
      })
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: data.error || data })
      };
    }
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message || 'Upstream error' })
    };
  }
};
