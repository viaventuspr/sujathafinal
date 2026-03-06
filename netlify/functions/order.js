// ═══════════════════════════════════════════════════════════════
// Netlify Serverless Function — Book Order → Google Sheets
// Stores every order in Google Sheets automatically
//
// Required Netlify Environment Variables:
//   GOOGLE_SERVICE_ACCOUNT_KEY  — base64-encoded service account JSON
//   GOOGLE_SHEET_ID             — the Google Sheet ID from its URL
// ═══════════════════════════════════════════════════════════════

const https = require('https');

// ── JWT / Google Auth (no external packages needed) ─────────────
function base64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function sign(data, privateKey) {
  const crypto = require('crypto');
  return base64url(
    crypto.createSign('RSA-SHA256').update(data).sign(privateKey)
  );
}

async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim  = base64url(Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })));
  const jwt = `${header}.${claim}`;
  const sig = sign(jwt, serviceAccount.private_key);
  const token = `${jwt}.${sig}`;

  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${token}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).access_token); }
        catch(e) { reject(new Error('Token parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function appendToSheet(accessToken, sheetId, values) {
  const body = JSON.stringify({ values: [values] });
  const path = `/v4/spreadsheets/${sheetId}/values/Orders!A:K:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'sheets.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main Handler ────────────────────────────────────────────────
exports.handler = async function(event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const order = JSON.parse(event.body);
    const { name, phone, address, city, book, price, qty, total, payment, notes } = order;

    // Validate required fields
    if (!name || !phone || !book) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Get service account from env
    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const sheetId = process.env.GOOGLE_SHEET_ID;

    if (!saRaw || !sheetId) {
      // If env vars not set, still return success (WhatsApp fallback)
      console.warn('Google Sheets env vars not set — order not recorded in sheet');
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true, warning: 'Sheet not configured' })
      };
    }

    // Decode service account JSON (base64 encoded in env var)
    const serviceAccount = JSON.parse(
      Buffer.from(saRaw, 'base64').toString('utf8')
    );

    // Get Google access token
    const accessToken = await getGoogleAccessToken(serviceAccount);

    // Build the row
    const now = new Date();
    const timestamp = now.toLocaleString('en-GB', { timeZone: 'Asia/Colombo' });
    const orderId = 'ORD-' + Date.now().toString().slice(-6);

    const row = [
      timestamp,          // A: Timestamp
      orderId,            // B: Order ID
      name,               // C: Customer Name
      phone,              // D: Phone
      address || '',      // E: Address
      city || '',         // F: City
      book,               // G: Book Title
      `Rs. ${price}`,     // H: Unit Price
      qty || 1,           // I: Quantity
      `Rs. ${total}`,     // J: Total
      payment || 'Cash on Delivery',  // K: Payment Method
      'NEW',              // L: Status (NEW/CONFIRMED/SHIPPED/DELIVERED)
      notes || ''         // M: Notes
    ];

    // Append to Google Sheet
    await appendToSheet(accessToken, sheetId, row);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: true, orderId })
    };

  } catch (err) {
    console.error('Order function error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Server error', details: err.message })
    };
  }
};
