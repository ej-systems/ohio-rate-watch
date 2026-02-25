/**
 * Ohio Rate Watch — Waitlist API
 * Sends confirmation email to subscriber + notification to hello@ohioratewatch.com
 * Logs all signups to /var/log/ratewatch/signups.csv
 */

import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PORT = process.env.PORT || 3001;
const LOG_FILE = '/var/log/ratewatch/signups.csv';

if (!RESEND_API_KEY) {
  console.error('ERROR: RESEND_API_KEY env var required');
  process.exit(1);
}

// Ensure log directory exists
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp,email,zip\n');
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Historical chart data endpoint
  if (req.method === 'GET' && url.pathname === '/api/history/chart-data') {
    const chartData = {
      sco: [
        { date: '2020-01', value: 0.380 },
        { date: '2020-04', value: 0.350 },
        { date: '2020-07', value: 0.330 },
        { date: '2020-10', value: 0.370 },
        { date: '2021-01', value: 0.410 },
        { date: '2021-04', value: 0.470 },
        { date: '2021-07', value: 0.520 },
        { date: '2021-10', value: 0.580 },
        { date: '2022-01', value: 0.650 },
        { date: '2022-04', value: 0.720 },
        { date: '2022-07', value: 0.780 },
        { date: '2022-10', value: 0.880 },
        { date: '2023-01', value: 0.950 },
        { date: '2023-04', value: 0.820 },
        { date: '2023-07', value: 0.710 },
        { date: '2023-10', value: 0.690 },
        { date: '2024-01', value: 0.680 },
        { date: '2024-04', value: 0.660 },
        { date: '2024-07', value: 0.720 },
        { date: '2024-10', value: 0.750 },
        { date: '2025-01', value: 0.790 },
        { date: '2025-04', value: 0.850 },
        { date: '2025-07', value: 0.920 },
        { date: '2025-10', value: 0.980 },
        { date: '2026-01', value: 1.040 },
        { date: '2026-02', value: 1.071 },
      ],
      henryHub: [
        { date: '2020-01', value: 0.210 },
        { date: '2020-04', value: 0.170 },
        { date: '2020-07', value: 0.180 },
        { date: '2020-10', value: 0.290 },
        { date: '2021-01', value: 0.270 },
        { date: '2021-04', value: 0.280 },
        { date: '2021-07', value: 0.370 },
        { date: '2021-10', value: 0.520 },
        { date: '2022-01', value: 0.430 },
        { date: '2022-04', value: 0.640 },
        { date: '2022-07', value: 0.750 },
        { date: '2022-10', value: 0.600 },
        { date: '2023-01', value: 0.350 },
        { date: '2023-04', value: 0.220 },
        { date: '2023-07', value: 0.260 },
        { date: '2023-10', value: 0.290 },
        { date: '2024-01', value: 0.300 },
        { date: '2024-04', value: 0.190 },
        { date: '2024-07', value: 0.230 },
        { date: '2024-10', value: 0.260 },
        { date: '2025-01', value: 0.350 },
        { date: '2025-04', value: 0.380 },
        { date: '2025-07', value: 0.400 },
        { date: '2025-10', value: 0.420 },
        { date: '2026-01', value: 0.440 },
        { date: '2026-02', value: 0.450 },
      ],
      bestFixed: 0.499,
      events: [
        { date: '2021-04', label: 'Post-Uri Spike', icon: '❄️' },
        { date: '2022-04', label: 'Russia-Ukraine', icon: '💥' },
        { date: '2022-10', label: 'Storm Elliott', icon: '❄️' },
        { date: '2025-10', label: 'PUCO RPA Increase', icon: '📋' },
      ],
    };
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify(chartData));
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
