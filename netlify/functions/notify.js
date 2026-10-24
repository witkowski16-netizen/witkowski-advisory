// Shared helpers + HTTP endpoint for owner alerts.
// - sendAlert(): texts the business owner through Twilio (registered messaging service).
// - handler: POST endpoint used by the contact/discovery form.
//
// Required Netlify environment variables (never commit these):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID, OWNER_PHONE (E.164, e.g. +13125550123)

const PREFIX = 'Collins 2022 LLC (Witkowski Advisory): ';
const SUFFIX = ' Reply STOP to opt out.';

const buckets = new Map();

// Best-effort in-memory limiter. Serverless instances do not share memory, so this only slows
// casual abuse. The hard backstops are the Anthropic and Twilio spend limits.
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return true;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > 86400000) buckets.delete(k);
    }
  }
  return false;
}

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function clientIp(event) {
  const h = event.headers || {};
  return h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

function originAllowed(event) {
  const h = event.headers || {};
  const src = h.origin || h.referer || '';
  if (!src) return false;
  try {
    const host = new URL(src).hostname;
    return (
      host === 'witkowskiadvisory.com' ||
      host.endsWith('.witkowskiadvisory.com') ||
      host.endsWith('.netlify.app') || // deploy previews
      host === 'localhost'
    );
  } catch (e) {
    return false;
  }
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function sendAlert(text) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID, OWNER_PHONE } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_MESSAGING_SERVICE_SID || !OWNER_PHONE) {
    console.error('Twilio environment variables are not fully set; alert not sent.');
    return { ok: false, reason: 'not_configured' };
  }
  if (!/^\+1\d{10}$/.test(OWNER_PHONE)) {
    console.error('OWNER_PHONE must be E.164 format, for example +13125550123.');
    return { ok: false, reason: 'bad_owner_phone' };
  }
  const body = PREFIX + clean(text, 240) + SUFFIX;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: OWNER_PHONE, MessagingServiceSid: TWILIO_MESSAGING_SERVICE_SID, Body: body }),
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) {
      console.error('Twilio send failed', res.status, (await res.text()).slice(0, 300));
      return { ok: false, reason: 'twilio_error' };
    }
    return { ok: true };
  } catch (e) {
    console.error('Twilio request error', e && e.message);
    return { ok: false, reason: 'network' };
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!originAllowed(event)) return json(403, { error: 'Forbidden' });
  if (rateLimited('form:' + clientIp(event), 5, 60 * 60 * 1000)) return json(429, { error: 'Too many requests' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Bad request' });
  }

  const name = clean(data.name || `${data.firstName || ''} ${data.lastName || ''}`, 60) || 'Unknown';
  const org = clean(data.organization, 80) || 'n/a';
  const email = clean(data.email, 80);
  const topic = clean(data.interest || data.message, 120) || 'not specified';
  if (!email) return json(400, { error: 'Missing email' });

  await sendAlert(`New website inquiry from ${name} at ${org}, ${email}. Topic: ${topic}.`);
  // Always report success so the visitor-facing form is never broken by an alert problem.
  return json(200, { ok: true });
};

exports.sendAlert = sendAlert;
exports.rateLimited = rateLimited;
exports.clean = clean;
exports.clientIp = clientIp;
exports.originAllowed = originAllowed;
exports.json = json;
