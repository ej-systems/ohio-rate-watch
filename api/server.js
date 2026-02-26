/**
 * Ohio Rate Watch — Waitlist API
 * Sends confirmation email to subscriber + notification to hello@ohioratewatch.com
 * Logs all signups to /var/log/ratewatch/signups.csv
 */

import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PORT = process.env.PORT || 3001;
const LOG_FILE = '/var/log/ratewatch/signups.csv';
const DB_PATH = path.join(__dirname, 'data', 'rates-history.db');

if (!RESEND_API_KEY) {
  console.error('ERROR: RESEND_API_KEY env var required');
  process.exit(1);
}

// Ensure log directory exists
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp,email,zip\n');
}

// Lazy DB connection for chart data
let _db;
function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
  }
  return _db;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Ohio Rate Watch <hello@ohioratewatch.com>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

async function handleSignup(email, zip) {
  const zipText = zip ? ` (${zip})` : '';

  // 1. Confirmation to subscriber
  await sendEmail(
    email,
    "You're on the list — Ohio Rate Watch",
    `
    <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
      <img src="https://ohioratewatch.com/logo.png" alt="Ohio Rate Watch" style="height:40px;margin-bottom:24px;" onerror="this.style.display='none'">
      <h2 style="color:#1565c0;margin-bottom:8px;">You're on the list! 🎉</h2>
      <p style="color:#444;line-height:1.6;">Thanks for signing up for <strong>Ohio Rate Watch</strong>. We'll alert you when natural gas rates change in your area${zipText} — in plain English, no jargon.</p>
      <div style="background:#e8f5e9;border-left:4px solid #2e7d32;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0;">
        <strong style="color:#1b5e20;">Quick fact:</strong>
        <p style="color:#2e7d32;margin:8px 0 0;">Columbia Gas customers paying the default rate ($1.071/ccf) could be saving 50%+ by switching to a competing supplier right now.</p>
      </div>
      <p style="color:#444;line-height:1.6;">We'll email you when something worth acting on happens. No spam, ever.</p>
      <p style="color:#999;font-size:0.82rem;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">
        Ohio Rate Watch · A project of EJ Systems LLC · Cleveland, Ohio<br>
        <a href="tel:8334317283" style="color:#1565c0;">833.431.RATE</a> · 
        <a href="https://ohioratewatch.com" style="color:#1565c0;">ohioratewatch.com</a> · 
        <a href="https://ohioratewatch.com/unsubscribe" style="color:#999;">Unsubscribe</a>
      </p>
    </div>
    `
  );

  // 2. Notification to owner
  await sendEmail(
    'hello@ohioratewatch.com',
    `New signup: ${email}${zipText}`,
    `<p>New waitlist signup:<br><strong>${email}</strong>${zipText ? `<br>Zip: ${zip}` : ''}<br>${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>`
  );

  // 3. Log to CSV
  const row = `${new Date().toISOString()},${email},${zip || ''}\n`;
  fs.appendFileSync(LOG_FILE, row);
}


// Simple in-memory rate limiter: max 5 signups per IP per hour
const ipSignupLog = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const window = 60 * 60 * 1000; // 1 hour
  const max = 5;
  const hits = (ipSignupLog.get(ip) || []).filter(t => now - t < window);
  if (hits.length >= max) return true;
  hits.push(now);
  ipSignupLog.set(ip, hits);
  return false;
}

/**
 * Build chart data from real DB queries.
 * Returns { columbiaGasSco, enbridgeGasSco, centerpointSco, henryHub, bestFixed, events }
 */
function buildChartData(longterm = false) {
  const db = getDb();

  function getScoSeries(territory_id) {
    return db.prepare(`
      SELECT strftime('%Y-%m', date) as month, rate
      FROM rate_history
      WHERE territory_id = ? AND type = 'sco'
      ORDER BY date ASC
    `).all(territory_id).map(r => ({ date: r.month, value: r.rate }));
  }

  const hhStart = longterm ? '2000-01-01' : '2018-01-01';
  const henryHub = db.prepare(`
    SELECT strftime('%Y-%m', scraped_at) as month,
           ROUND(AVG(price) / 10.0, 4) as value
    FROM rate_snapshots
    WHERE supplier_name = 'Henry Hub Spot Price'
      AND price IS NOT NULL
      AND scraped_at >= ?
    GROUP BY month
    ORDER BY month ASC
  `).all(hhStart).map(r => ({ date: r.month, value: r.value }));

  const bestFixedRow = db.prepare(`
    SELECT MIN(price) as best
    FROM rate_snapshots
    WHERE rate_type = 'fixed'
      AND price IS NOT NULL
      AND price > 0.1
      AND category = 'NaturalGas'
      AND scraped_at >= datetime('now', '-7 days')
  `).get();
  const bestFixed = bestFixedRow?.best ? Math.round(bestFixedRow.best * 1000) / 1000 : 0.499;

  const result = {
    columbiaGasSco: getScoSeries(8),
    enbridgeGasSco: getScoSeries(1),
    centerpointSco: getScoSeries(11),
    henryHub,
    bestFixed,
    events: [
      { date: '2021-04', label: 'Post-Uri Spike', icon: '❄️' },
      { date: '2022-04', label: 'Russia-Ukraine', icon: '💥' },
      { date: '2022-10', label: 'Storm Elliott', icon: '❄️' },
      { date: '2025-10', label: 'PUCO RPA Increase', icon: '📋' },
    ],
  };

  if (longterm) {
    // EIA Ohio Residential 2000–2017 as pre-SCO reference baseline
    result.eiaOhioRef = db.prepare(`
      SELECT strftime('%Y-%m', scraped_at) as month,
             ROUND(AVG(sco_rate), 4) as value
      FROM rate_snapshots
      WHERE territory_id = 0
        AND rate_type = 'reference'
        AND sco_rate IS NOT NULL
        AND scraped_at >= '2000-01-01'
        AND scraped_at < '2018-01-01'
      GROUP BY month
      ORDER BY month ASC
    `).all().map(r => ({ date: r.month, value: r.value }));

    result.pucoBoundary = '2018-01';
    result.events = [
      { date: '2005-09', label: 'Katrina/Rita Spike', icon: '🌀' },
      { date: '2008-07', label: '2008 Price Peak', icon: '📈' },
      { date: '2012-04', label: 'Shale Gas Lows', icon: '⛏️' },
      { date: '2021-04', label: 'Post-Uri Spike', icon: '❄️' },
      { date: '2022-10', label: 'Energy Crisis Peak', icon: '💥' },
      { date: '2025-10', label: 'PUCO RPA Increase', icon: '📋' },
    ];
  }

  return result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Historical chart data endpoint — real PUCO SCO data from DB
  if (req.method === 'GET' && url.pathname === '/api/history/chart-data') {
    try {
      const longterm = url.searchParams.get('range') === 'longterm';
      const chartData = buildChartData(longterm);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify(chartData));
    } catch (err) {
      console.error('[chart-data] DB error:', err.message);
      res.writeHead(500, corsHeaders());
      res.end(JSON.stringify({ error: 'Failed to load chart data' }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/rates') {
    const territory = parseInt(url.searchParams.get('territory') || '8');
    const category = url.searchParams.get('category') || 'NaturalGas';
    
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/rates-latest.json'), 'utf8'));
      const entry = data.find(x => x.territoryId === territory && x.category === category);
      
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Territory not found' }));
        return;
      }
      
      const isMCF = territory === 1;
      const suppliers = (entry.suppliers || []).map(s => ({
        ...s,
        price: isMCF && s.price ? Math.round(s.price / 10 * 10000) / 10000 : s.price,
        priceUnit: 'ccf',
        originalPrice: isMCF ? s.price : null,
        originalUnit: isMCF ? 'mcf' : null,
      }));
      
      const result = {
        territoryId: territory,
        category,
        scrapedAt: entry.scrapedAt,
        defaultRate: entry.defaultRate,
        defaultRateText: entry.defaultRateText,
        suppliers,
        totalCount: suppliers.length,
        isMCFConverted: isMCF,
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const signups = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').length - 1;
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, signups }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/subscribe') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        if (isRateLimited(ip)) {
          res.writeHead(429, corsHeaders());
          res.end(JSON.stringify({ error: 'Too many requests. Please try again later.' }));
          return;
        }

        const { email, zip } = JSON.parse(body);

        if (!email || !email.includes('@') || !email.includes('.')) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ error: 'Valid email required' }));
          return;
        }

        await handleSignup(email.toLowerCase().trim(), zip?.trim() || '');

        console.log(`[signup] ${email} ${zip || ''} ${new Date().toISOString()}`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, message: "You're on the list!" }));
      } catch (err) {
        console.error('[error]', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ error: 'Something went wrong, please try again.' }));
      }
    });
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ohio Rate Watch API on port ${PORT}`);
});
