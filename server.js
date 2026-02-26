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
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PORT = process.env.PORT || 3001;
const LOG_FILE = '/var/log/ratewatch/signups.csv';

// Load DATABASE_URL from .env if not in environment
let DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  const envPath = path.join(__dirname, '.env');
  if (existsSync(envPath)) {
    const envFile = readFileSync(envPath, 'utf8');
    DATABASE_URL = envFile.match(/DATABASE_URL=(.*)/)?.[1]?.trim();
  }
}

if (!RESEND_API_KEY) {
  console.error('ERROR: RESEND_API_KEY env var required');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var required');
  process.exit(1);
}

// Ensure log directory exists
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp,email,zip\n');
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// Run schema migrations on startup (idempotent)
pool.query(`
  ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS is_renewable BOOLEAN DEFAULT FALSE;
  ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS renewable_type TEXT;
`).then(() => console.log('[db] schema migrations ok')).catch(e => console.error('[db] migration error:', e.message));

function allHeaders(headers = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://api.resend.com",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    ...headers,
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

  await sendEmail(
    'hello@ohioratewatch.com',
    `New signup: ${email}${zipText}`,
    `<p>New waitlist signup:<br><strong>${email}</strong>${zipText ? `<br>Zip: ${zip}` : ''}<br>${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>`
  );

  const row = `${new Date().toISOString()},${email},${zip || ''}\n`;
  fs.appendFileSync(LOG_FILE, row);
}

const ipSignupLog = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const window = 60 * 60 * 1000;
  const max = 5;
  const hits = (ipSignupLog.get(ip) || []).filter(t => now - t < window);
  if (hits.length >= max) return true;
  hits.push(now);
  ipSignupLog.set(ip, hits);
  return false;
}

/**
 * Build chart data from real DB queries (async).
 */
async function buildChartData(longterm = false) {
  async function getScoSeries(territory_id) {
    const { rows } = await pool.query(`
      SELECT to_char(date::date, 'YYYY-MM') as month, rate
      FROM rate_history
      WHERE territory_id = $1 AND type = 'sco'
      ORDER BY date ASC
    `, [territory_id]);
    return rows.map(r => ({ date: r.month, value: r.rate }));
  }

  const hhStart = longterm ? '2000-01-01' : '2018-01-01';
  const hhResult = await pool.query(`
    SELECT to_char(scraped_at::date, 'YYYY-MM') as month,
           ROUND((AVG(price) / 10.0)::numeric, 4) as value
    FROM rate_snapshots
    WHERE supplier_name = 'Henry Hub Spot Price'
      AND price IS NOT NULL
      AND scraped_at >= $1
    GROUP BY month
    ORDER BY month ASC
  `, [hhStart]);
  const henryHub = hhResult.rows.map(r => ({ date: r.month, value: parseFloat(r.value) }));

  const bestFixedResult = await pool.query(`
    SELECT MIN(price) as best
    FROM rate_snapshots
    WHERE rate_type = 'fixed'
      AND price IS NOT NULL
      AND price > 0.1
      AND category = 'NaturalGas'
      AND scraped_at >= (NOW() - INTERVAL '7 days')::TEXT
  `);
  const bestFixed = bestFixedResult.rows[0]?.best
    ? Math.round(bestFixedResult.rows[0].best * 1000) / 1000
    : 0.499;

  const result = {
    columbiaGasSco: await getScoSeries(8),
    enbridgeGasSco: await getScoSeries(1),
    centerpointSco: await getScoSeries(11),
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
    const eiaResult = await pool.query(`
      SELECT to_char(scraped_at::date, 'YYYY-MM') as month,
             ROUND(AVG(sco_rate)::numeric, 4) as value
      FROM rate_snapshots
      WHERE territory_id = 0
        AND rate_type = 'reference'
        AND sco_rate IS NOT NULL
        AND scraped_at >= '2000-01-01'
        AND scraped_at < '2018-01-01'
      GROUP BY month
      ORDER BY month ASC
    `);
    result.eiaOhioRef = eiaResult.rows.map(r => ({ date: r.month, value: parseFloat(r.value) }));
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
    res.writeHead(204, allHeaders());
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history/chart-data') {
    try {
      const longterm = url.searchParams.get('range') === 'longterm';
      const chartData = await buildChartData(longterm);
      res.writeHead(200, allHeaders());
      res.end(JSON.stringify(chartData));
    } catch (err) {
      console.error('[chart-data] DB error:', err.message);
      res.writeHead(500, allHeaders());
      res.end(JSON.stringify({ error: 'Failed to load chart data' }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const signups = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').length - 1;
    res.writeHead(200, allHeaders());
    res.end(JSON.stringify({ ok: true, signups }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/rates') {
    const territory = parseInt(url.searchParams.get('territory') || '8');
    const category = url.searchParams.get('category') || 'NaturalGas';
    const rateCode = url.searchParams.get('rateCode') || '1';
    const today = new Date().toISOString().slice(0, 10);

    try {
      // Query supplier_offers from PostgreSQL
      const { rows: dbOffers } = await pool.query(`
        SELECT 
          supplier_name, company_name, price, rate_type, term_months,
          etf, monthly_fee, is_intro, is_promo, offer_details,
          promo_details, intro_details, sign_up_url, phone, website, offer_id,
          is_renewable, renewable_type
        FROM supplier_offers
        WHERE territory_id = $1 
          AND category = $2 
          AND rate_code = $3
          AND scraped_date = $4
        ORDER BY price ASC
      `, [territory, category, rateCode, today]);

      if (dbOffers.length > 0) {
        const isMCF = territory === 1;
        const suppliers = dbOffers.map(o => ({
          name: o.supplier_name,
          companyName: o.company_name,
          price: isMCF && o.price ? Math.round(o.price / 10 * 10000) / 10000 : o.price,
          priceUnit: 'ccf',
          originalPrice: isMCF ? o.price : null,
          originalUnit: isMCF ? 'mcf' : null,
          rateType: o.rate_type,
          termMonths: o.term_months,
          earlyTerminationFee: o.etf,
          monthlyFee: o.monthly_fee,
          introPrice: o.is_intro === true,
          hasPromo: o.is_promo === true,
          isRenewable: o.is_renewable === true,
          renewableType: o.renewable_type,
          offerDetails: o.offer_details,
          promoDetails: o.promo_details,
          introDetails: o.intro_details,
          signUpUrl: o.sign_up_url,
          phone: o.phone,
          website: o.website,
          offerId: o.offer_id,
        }));

        const result = {
          territoryId: territory,
          category,
          rateCode,
          scrapedAt: today,
          defaultRate: null,
          defaultRateText: null,
          suppliers,
          totalCount: suppliers.length,
          isMCFConverted: isMCF,
          source: 'db',
        };

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
        res.end(JSON.stringify(result));
        return;
      }

      // Fallback if no data for today
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300'
      });
      res.end(JSON.stringify({
        territoryId: territory,
        category,
        rateCode,
        scrapedAt: today,
        suppliers: [],
        totalCount: 0,
        source: 'empty'
      }));
    } catch (err) {
      console.error('[api/rates] error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/subscribe') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        if (isRateLimited(ip)) {
          res.writeHead(429, allHeaders());
          res.end(JSON.stringify({ error: 'Too many requests. Please try again later.' }));
          return;
        }

        const { email, zip } = JSON.parse(body);

        if (!email || !email.includes('@') || !email.includes('.')) {
          res.writeHead(400, allHeaders());
          res.end(JSON.stringify({ error: 'Valid email required' }));
          return;
        }

        await handleSignup(email.toLowerCase().trim(), zip?.trim() || '');

        console.log(`[signup] ${email} ${zip || ''} ${new Date().toISOString()}`);
        res.writeHead(200, allHeaders());
        res.end(JSON.stringify({ ok: true, message: "You're on the list!" }));
      } catch (err) {
        console.error('[error]', err.message);
        res.writeHead(500, allHeaders());
        res.end(JSON.stringify({ error: 'Something went wrong, please try again.' }));
      }
    });
    return;
  }

  // ---- Cron endpoint for daily scraper ----
  if (req.method === 'POST' && url.pathname === '/api/cron/daily-check') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['x-cron-secret'] || '';
    if (!cronSecret || authHeader !== cronSecret) {
      res.writeHead(401, allHeaders());
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Run scraper in background, return immediately
    res.writeHead(200, allHeaders());
    res.end(JSON.stringify({ ok: true, message: 'Daily check started' }));

    // Execute the scraper logic
    (async () => {
      const startTime = Date.now();
      const errors = [];
      let pagesScraped = 0, snapshotRows = 0, offersStored = 0;
      let significantChanges = 0, totalChanges = 0;
      let dbSnapshots = '?', dbOffers = '?', dbHistory = '?';

      try {
        console.log('[cron] Daily check triggered via HTTP');
        const { scrapeAllRates, detectChanges } = await import('./scraper/energy-choice-scraper.js');
        const { insertSnapshot, insertSupplierOffers } = await import('./lib/history-store.js');

        // Bypass cert issues
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        const current = await scrapeAllRates();
        pagesScraped = current.length;
        console.log(`[cron] Scraped ${current.length} rate pages`);

        // Save latest to file (ephemeral but useful within container lifecycle)
        const dataDir = path.join(__dirname, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'rates-latest.json'), JSON.stringify(current, null, 2));

        // Store to PostgreSQL
        try {
          snapshotRows = await insertSnapshot(current);
          console.log(`[cron] Stored ${snapshotRows} snapshot rows`);
        } catch (err) {
          console.error('[cron] WARNING: Failed to store snapshots:', err.message);
          errors.push(`Snapshot insert: ${err.message}`);
        }

        try {
          const today = new Date().toISOString().slice(0, 10);
          offersStored = await insertSupplierOffers(today, current);
          console.log(`[cron] Stored ${offersStored} offers for ${today}`);
        } catch (err) {
          console.error('[cron] WARNING: Failed to store offers:', err.message);
          errors.push(`Offer insert: ${err.message}`);
        }

        // Get DB row counts
        try {
          const r1 = await pool.query('SELECT COUNT(*) as cnt FROM rate_snapshots');
          const r2 = await pool.query('SELECT COUNT(*) as cnt FROM supplier_offers');
          const r3 = await pool.query('SELECT COUNT(*) as cnt FROM rate_history');
          dbSnapshots = Number(r1.rows[0].cnt).toLocaleString();
          dbOffers = Number(r2.rows[0].cnt).toLocaleString();
          dbHistory = Number(r3.rows[0].cnt).toLocaleString();
        } catch (err) {
          errors.push(`Row count query: ${err.message}`);
        }

        // Baseline comparison + email alerts
        const baselineFile = path.join(dataDir, 'rates-baseline.json');
        if (fs.existsSync(baselineFile)) {
          const previous = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
          const allChanges = detectChanges(previous, current);
          totalChanges = allChanges.length;
          const significant = allChanges.filter(c => {
            if (c.type === 'default_rate') return true;
            const absDiff = Math.abs(c.currRate - c.prevRate);
            const pctDiff = Math.abs(parseFloat(c.changePct));
            return pctDiff >= 5 && absDiff >= 0.01;
          });
          significantChanges = significant.length;
          console.log(`[cron] ${totalChanges} total changes, ${significantChanges} significant`);

          if (significant.length > 0 && process.env.RESEND_API_KEY) {
            try {
              const top = significant.slice(0, 10).map(c => c.summary).join('<br>');
              await sendEmail(
                'hello@ohioratewatch.com',
                `[Rate Alert] ${significant.length} significant changes detected`,
                `<p>Daily scraper found ${significant.length} significant rate changes:<br><br>${top}</p>`
              );
              console.log('[cron] Owner notification sent');
            } catch (err) {
              console.error('[cron] Failed to send owner notification:', err.message);
              errors.push(`Owner email: ${err.message}`);
            }
          }
        } else {
          console.log('[cron] No baseline found, creating initial baseline');
        }

        // Update baseline
        fs.writeFileSync(baselineFile, JSON.stringify(current, null, 2));
        console.log('[cron] Daily check complete');
      } catch (err) {
        console.error('[cron] FATAL:', err.message);
        errors.push(`FATAL: ${err.message}`);
      }

      // Post summary to Discord webhook
      const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
      if (webhookUrl) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
        const status = errors.length === 0 ? '✅' : '⚠️';

        const embed = {
          title: `${status} Daily Scraper Report`,
          color: errors.length === 0 ? 0x2e7d32 : 0xff9800,
          fields: [
            { name: '🕐 Timestamp', value: now, inline: true },
            { name: '⏱️ Duration', value: `${elapsed}s`, inline: true },
            { name: '📄 Pages Scraped', value: `${pagesScraped}`, inline: true },
            { name: '📸 Snapshot Rows Added', value: `${snapshotRows.toLocaleString()}`, inline: true },
            { name: '📋 Offers Stored', value: `${offersStored.toLocaleString()}`, inline: true },
            { name: '🔄 Rate Changes', value: `${totalChanges} total, ${significantChanges} significant`, inline: true },
            { name: '🗃️ DB: rate_snapshots', value: dbSnapshots, inline: true },
            { name: '🗃️ DB: supplier_offers', value: dbOffers, inline: true },
            { name: '🗃️ DB: rate_history', value: dbHistory, inline: true },
          ],
          footer: { text: 'Ohio Rate Watch · Railway' },
          timestamp: new Date().toISOString(),
        };

        if (errors.length > 0) {
          embed.fields.push({
            name: '❌ Errors',
            value: errors.map(e => `• ${e}`).join('\n').slice(0, 1024),
            inline: false,
          });
        }

        try {
          const whRes = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
          });
          if (!whRes.ok) console.error('[cron] Discord webhook error:', whRes.status, await whRes.text());
          else console.log('[cron] Discord webhook sent');
        } catch (err) {
          console.error('[cron] Discord webhook failed:', err.message);
        }
      }
    })();
    return;
  }

  // Static file serving
  const MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.xml': 'application/xml', '.txt': 'text/plain', '.geojson': 'application/json',
  };

  let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
  // Try .html extension for extensionless paths
  if (!path.extname(filePath) && existsSync(filePath + '.html')) {
    filePath = filePath + '.html';
  }

  try {
    if (existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);
      res.writeHead(200, allHeaders({ 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' }));
      res.end(content);
      return;
    }
  } catch (e) { /* fall through to 404 */ }

  res.writeHead(404, allHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ohio Rate Watch on port ${PORT}`);
});
