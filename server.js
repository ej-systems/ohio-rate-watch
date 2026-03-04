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
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PORT = process.env.PORT || 3001;
const LOG_FILE = '/var/log/ratewatch/signups.csv';

// Load DATABASE_URL from .env if not in environment.
// In production (Railway), DATABASE_URL is set via env vars — .env is never deployed.
// This fallback is for local development only. .env is listed in .gitignore.
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

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

let savingsSummaryCache = null; // { ts, data } — cached for 1 hour

// Share pool with history-store module
import { setPool as setHistoryPool } from './lib/history-store.js';
setHistoryPool(pool);

// Load ZIP → territory mapping
const zipTerritoryMap = JSON.parse(readFileSync(path.join(__dirname, 'zip-territory.json'), 'utf8'));
const TERRITORY_IDS = { columbia: 8, enbridge: 1, centerpoint: 11, duke: 10 };
const TERRITORY_NAMES = { columbia: 'Columbia Gas of Ohio', enbridge: 'Enbridge Gas Ohio', centerpoint: 'CenterPoint Energy Ohio', duke: 'Duke Energy Ohio' };

// Run schema migrations on startup (idempotent)
pool.query(`
  ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS is_renewable BOOLEAN DEFAULT FALSE;
  ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS renewable_type TEXT;
`).then(() => console.log('[db] schema migrations ok')).catch(e => console.error('[db] migration error:', e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    zip TEXT,
    territory TEXT,
    territory_id INTEGER,
    current_rate REAL,
    min_savings_pct INTEGER DEFAULT 15,
    confirmed BOOLEAN DEFAULT FALSE,
    unsubscribe_token TEXT UNIQUE NOT NULL,
    confirm_token TEXT UNIQUE,
    last_alerted_at TIMESTAMPTZ,
    last_alerted_rate REAL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(email)
  );
  CREATE INDEX IF NOT EXISTS idx_subscribers_territory ON subscribers(territory) WHERE confirmed = TRUE;
`).then(() => console.log('[db] subscribers table ok'))
  .then(() => pool.query(`
    ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS contract_expires DATE;
  `))
  .then(() => console.log('[db] subscribers contract_expires migration ok'))
  .catch(e => console.error('[db] subscribers migration error:', e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS city_bills (
    id SERIAL PRIMARY KEY,
    report_month TEXT NOT NULL,
    city TEXT NOT NULL,
    county TEXT,
    utility_key TEXT NOT NULL,
    company_name TEXT,
    gas_bill_total REAL,
    gas_bill_prior REAL,
    gas_pct_change REAL,
    gas_supply_cost REAL,
    gas_per_mcf REAL,
    scraped_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(report_month, city, utility_key)
  );
`).then(() => console.log('[db] city_bills table ok')).catch(e => console.error('[db] city_bills migration error:', e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS city_bill_history (
    id SERIAL PRIMARY KEY,
    report_date TEXT NOT NULL,
    month_label TEXT NOT NULL,
    city TEXT NOT NULL,
    county TEXT,
    total_charge REAL,
    local_tax REAL,
    scraped_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(report_date, city)
  );
  CREATE INDEX IF NOT EXISTS idx_city_bill_history_city ON city_bill_history(LOWER(city));
`).then(() => console.log('[db] city_bill_history table ok')).catch(e => console.error('[db] city_bill_history migration error:', e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS scrape_runs (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    row_count INTEGER,
    error_message TEXT
  );
`).then(() => console.log('[db] scrape_runs table ok')).catch(e => console.error('[db] scrape_runs migration error:', e.message));

pool.query(`
  ALTER TABLE scrape_runs DROP COLUMN IF EXISTS territory_id;
  ALTER TABLE scrape_runs DROP COLUMN IF EXISTS category;
  ALTER TABLE scrape_runs DROP COLUMN IF EXISTS rate_code;
  ALTER TABLE scrape_runs DROP COLUMN IF EXISTS payload_hash;
`).then(() => console.log('[db] scrape_runs cleanup ok')).catch(e => console.error('[db] scrape_runs cleanup error:', e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS rate_events (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scrape_run_id INTEGER REFERENCES scrape_runs(id),
    territory_id INTEGER,
    category TEXT,
    rate_code TEXT,
    supplier_name TEXT,
    event_type TEXT NOT NULL,
    old_rate REAL,
    new_rate REAL,
    change_abs REAL,
    change_pct REAL,
    term_months INTEGER,
    rate_type TEXT
  );
`).then(() => console.log('[db] rate_events table ok')).catch(e => console.error('[db] rate_events migration error:', e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS sco_rates (
    id SERIAL PRIMARY KEY,
    scraped_date TEXT NOT NULL,
    territory_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    rate_code TEXT NOT NULL DEFAULT '1',
    default_rate REAL,
    default_rate_text TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(scraped_date, territory_id, category, rate_code)
  );
`).then(() => console.log('[db] sco_rates table ok')).catch(e => console.error('[db] sco_rates migration error:', e.message));

function allHeaders(headers = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; img-src 'self' data: https:; font-src 'self' https://cdn.jsdelivr.net https://unpkg.com; connect-src 'self' https://api.resend.com https://nominatim.openstreetmap.org;",
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

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    try {
      // Use most recent scraped_date (avoids UTC/ET mismatch showing 0 after midnight UTC)
      const { rows: dateRows } = await pool.query(`SELECT MAX(scraped_date) AS latest FROM supplier_offers`);
      const latest = dateRows[0]?.latest || new Date().toISOString().slice(0, 10);
      const { rows } = await pool.query(
        `SELECT COUNT(*) as total_offers,
                COUNT(DISTINCT supplier_name) as unique_suppliers,
                MAX(price) as max_price,
                MIN(price) FILTER (WHERE price > 0) as min_price
         FROM supplier_offers WHERE scraped_date = $1`, [latest]);
      const r = rows[0];
      res.writeHead(200, allHeaders());
      res.end(JSON.stringify({
        totalOffers: Number(r.total_offers),
        uniqueSuppliers: Number(r.unique_suppliers),
        scrapedDate: latest,
      }));
    } catch (err) {
      res.writeHead(500, allHeaders());
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── /api/savings-summary ────────────────────────────────────────────────
  // Returns weighted average annual savings across all 4 gas territories
  // using 1000 CCF/year typical residential usage.
  if (req.method === 'GET' && url.pathname === '/api/savings-summary') {
    // Serve from cache if fresh (1 hour)
    const now = Date.now();
    if (savingsSummaryCache && now - savingsSummaryCache.ts < 3600_000) {
      res.writeHead(200, { ...allHeaders(), 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify(savingsSummaryCache.data));
      return;
    }
    try {
      // Approximate customer-count weights (Columbia ~60%, Enbridge ~20%, CenterPoint ~10%, Duke ~10%)
      const territories = [
        { id: 8, weight: 0.60 },  // Columbia Gas
        { id: 1, weight: 0.20 },  // Enbridge
        { id: 11, weight: 0.10 }, // CenterPoint
        { id: 10, weight: 0.10 }, // Duke
      ];
      let weightedSavings = 0;
      for (const t of territories) {
        // Get latest SCO rate
        const { rows: scoRows } = await pool.query(`
          SELECT default_rate FROM sco_rates
          WHERE territory_id = $1 AND category = 'NaturalGas' AND rate_code = '1'
          ORDER BY scraped_date DESC LIMIT 1
        `, [t.id]);
        const scoRate = scoRows[0]?.default_rate;
        if (!scoRate) continue;

        // Get best non-bundle, non-intro fixed rate
        const { rows: dateRows } = await pool.query(`
          SELECT scraped_date FROM supplier_offers
          WHERE territory_id = $1 AND category = 'NaturalGas' AND rate_code = '1'
          ORDER BY scraped_date DESC LIMIT 1
        `, [t.id]);
        if (!dateRows.length) continue;

        const isMCF = t.id === 1;
        const { rows: offerRows } = await pool.query(`
          SELECT price FROM supplier_offers
          WHERE territory_id = $1 AND category = 'NaturalGas' AND rate_code = '1'
            AND scraped_date = $2 AND rate_type = 'fixed' AND price > 0
            AND (is_intro IS NOT TRUE)
            AND (offer_details NOT ILIKE '%bundle%' AND offer_details NOT ILIKE '%electric%gas%'
                 AND COALESCE(promo_details,'') NOT ILIKE '%bundle%')
          ORDER BY price ASC LIMIT 1
        `, [t.id, dateRows[0].scraped_date]);
        if (!offerRows.length) continue;

        let bestPrice = offerRows[0].price;
        if (isMCF) bestPrice = bestPrice / 10; // convert MCF→CCF

        const annualSavings = (scoRate - bestPrice) * 1000; // 1000 CCF/year
        if (annualSavings > 0) weightedSavings += annualSavings * t.weight;
      }

      const { rows: updRows } = await pool.query(`SELECT MAX(scraped_date)::text AS latest FROM supplier_offers WHERE category = 'NaturalGas'`);
      const result = { averageAnnualSavings: Math.round(weightedSavings), lastUpdated: updRows[0]?.latest || null };
      savingsSummaryCache = { ts: now, data: result };
      res.writeHead(200, { ...allHeaders(), 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[api] savings-summary error:', err.message);
      res.writeHead(500, allHeaders());
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/rates') {
    const territory = parseInt(url.searchParams.get('territory') || '8');
    const category = url.searchParams.get('category') || 'NaturalGas';
    const rateCode = url.searchParams.get('rateCode') || '1';
    const today = new Date().toISOString().slice(0, 10);

    try {
      // Query supplier_offers from PostgreSQL
      // Find the most recent available scraped_date (prefer today, fall back to latest)
      const { rows: dateRows } = await pool.query(`
        SELECT scraped_date FROM supplier_offers
        WHERE territory_id = $1 AND category = $2 AND rate_code = $3
        ORDER BY scraped_date DESC LIMIT 1
      `, [territory, category, rateCode]);
      const bestDate = dateRows.length > 0 ? dateRows[0].scraped_date : today;

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
      `, [territory, category, rateCode, bestDate]);

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

        // Look up SCO rate from sco_rates table
        let scoRate = null, scoText = null;
        try {
          const { rows: scoRows } = await pool.query(`
            SELECT default_rate, default_rate_text FROM sco_rates
            WHERE territory_id = $1 AND category = $2 AND rate_code = $3
            ORDER BY scraped_date DESC LIMIT 1
          `, [territory, category, rateCode]);
          if (scoRows.length > 0) {
            scoRate = scoRows[0].default_rate;
            scoText = scoRows[0].default_rate_text;
          }
        } catch (scoErr) {
          console.error('[api] SCO lookup error:', scoErr.message);
        }

        const result = {
          territoryId: territory,
          category,
          rateCode,
          scrapedAt: bestDate,
          defaultRate: scoRate,
          defaultRateText: scoText,
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

        const { email, zip, min_savings_pct, contract_expires } = JSON.parse(body);

        if (!email || !email.includes('@') || !email.includes('.')) {
          res.writeHead(400, allHeaders());
          res.end(JSON.stringify({ error: 'Valid email required' }));
          return;
        }

        const cleanEmail = email.toLowerCase().trim();
        const cleanZip = zip?.trim() || null;
        const minPct = min_savings_pct ? parseInt(min_savings_pct) : 15;
        const contractDate = contract_expires || null; // ISO date string e.g. "2026-12-01"

        // ZIP → territory lookup — default to Columbia Gas if ZIP not recognized
        const territory = cleanZip ? (zipTerritoryMap[cleanZip] || 'columbia') : 'columbia';
        const territoryId = TERRITORY_IDS[territory] || 8;

        const unsubToken = crypto.randomUUID();
        const confirmToken = crypto.randomUUID();

        // Insert into DB
        await pool.query(`
          INSERT INTO subscribers (email, zip, territory, territory_id, min_savings_pct, unsubscribe_token, confirm_token, contract_expires)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (email) DO UPDATE SET
            zip = COALESCE(EXCLUDED.zip, subscribers.zip),
            territory = COALESCE(EXCLUDED.territory, subscribers.territory),
            territory_id = COALESCE(EXCLUDED.territory_id, subscribers.territory_id),
            min_savings_pct = EXCLUDED.min_savings_pct,
            contract_expires = COALESCE(EXCLUDED.contract_expires, subscribers.contract_expires),
            confirm_token = CASE WHEN subscribers.confirmed THEN subscribers.confirm_token ELSE EXCLUDED.confirm_token END,
            confirmed = subscribers.confirmed
        `, [cleanEmail, cleanZip, territory, territoryId, minPct, unsubToken, confirmToken, contractDate]);

        // Get the confirm_token (may differ if already confirmed)
        const { rows } = await pool.query('SELECT confirm_token, confirmed FROM subscribers WHERE email = $1', [cleanEmail]);
        const sub = rows[0];

        // Send confirmation email if not already confirmed
        if (!sub.confirmed && sub.confirm_token) {
          const utilityName = territory ? TERRITORY_NAMES[territory] : null;
          const utilityLine = utilityName ? `<p style="color:#444;line-height:1.6;">Based on your ZIP code, we'll watch <strong>${utilityName}</strong> rates for you.</p>` : '';
          await sendEmail(cleanEmail, 'Confirm your Ohio Rate Watch alerts', `
            <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
              <img src="https://ohioratewatch.com/logo.png" alt="Ohio Rate Watch" style="height:40px;margin-bottom:24px;" onerror="this.style.display='none'">
              <h2 style="color:#1565c0;margin-bottom:8px;">Confirm your alerts</h2>
              <p style="color:#444;line-height:1.6;">Thanks for signing up for <strong>Ohio Rate Watch</strong>.</p>
              ${utilityLine}
              <p style="color:#444;line-height:1.6;">Click below to confirm — we won't send alerts until you do.</p>
              <div style="text-align:center;margin:28px 0;">
                <a href="https://ohioratewatch.com/confirm?token=${sub.confirm_token}" style="display:inline-block;background:#1565c0;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">Confirm My Alerts →</a>
              </div>
              <p style="color:#999;font-size:0.82rem;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">If you didn't sign up, just ignore this email.<br><br>Ohio Rate Watch · A project of EJ Systems LLC · Cleveland, Ohio</p>
            </div>
          `);
        }

        // Notify owner
        await sendEmail(
          'hello@ohioratewatch.com',
          `New signup: ${cleanEmail}${cleanZip ? ` (${cleanZip})` : ''}`,
          `<p>New signup:<br><strong>${cleanEmail}</strong>${cleanZip ? `<br>Zip: ${cleanZip}` : ''}<br>Territory: ${territory}${contractDate ? `<br>Contract expires: ${contractDate}` : ''}<br>${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>`
        );

        // CSV backup
        const row = `${new Date().toISOString()},${cleanEmail},${cleanZip || ''}\n`;
        fs.appendFileSync(LOG_FILE, row);

        console.log(`[signup] ${cleanEmail} ${cleanZip || ''} territory=${territory || 'unknown'} ${new Date().toISOString()}`);
        res.writeHead(200, allHeaders());
        res.end(JSON.stringify({ ok: true, success: true, territory: territory || null, message: "You're on the list!" }));
      } catch (err) {
        console.error('[error]', err.message);
        res.writeHead(500, allHeaders());
        res.end(JSON.stringify({ error: 'Something went wrong, please try again.' }));
      }
    });
    return;
  }

  // Confirmation endpoint
  if (req.method === 'GET' && url.pathname === '/confirm') {
    const token = url.searchParams.get('token');
    let html;
    if (token) {
      const { rows: confirmedRows } = await pool.query('UPDATE subscribers SET confirmed = TRUE, confirm_token = NULL WHERE confirm_token = $1 RETURNING email, territory, unsubscribe_token', [token]);
      if (confirmedRows.length > 0) {
        // Send welcome email (fire-and-forget)
        {
          const confirmed = confirmedRows[0];
          const utilityName = confirmed.territory ? (TERRITORY_NAMES[confirmed.territory] || confirmed.territory) : 'your area';
          const unsubUrl = `https://ohioratewatch.com/unsubscribe?token=${confirmed.unsubscribe_token}`;
          sendEmail(confirmed.email, 'Welcome to Ohio Rate Watch', `
            <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
              <img src="https://ohioratewatch.com/logo.png" alt="Ohio Rate Watch" style="height:40px;margin-bottom:24px;" onerror="this.style.display='none'">
              <h2 style="color:#1565c0;margin-bottom:8px;">You're all set!</h2>
              <p style="color:#444;line-height:1.6;">We'll watch <strong>${utilityName}</strong> gas rates for you every day. Here's what to expect:</p>
              <ul style="color:#444;line-height:1.8;">
                <li>We check rates daily against the default rate most Ohioans pay</li>
                <li>You'll only hear from us when savings are 15%+ — no spam</li>
                <li>Emails show savings in monthly dollars so it's easy to compare</li>
              </ul>
              <p style="color:#444;line-height:1.6;">In the meantime, <a href="https://ohioratewatch.com" style="color:#1565c0;font-weight:600;">check current rates</a> anytime.</p>
              <p style="color:#999;font-size:0.78rem;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">
                Ohio Rate Watch · A project of EJ Systems LLC · Cleveland, Ohio<br>
                <a href="tel:8334317283" style="color:#1565c0;">833.431.RATE</a> ·
                <a href="https://ohioratewatch.com" style="color:#1565c0;">ohioratewatch.com</a> ·
                <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
              </p>
            </div>
          `).catch(err => console.error('[welcome-email] Failed:', err.message));
        }
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirmed — Ohio Rate Watch</title></head><body style="font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f8f9fa;margin:0;"><div style="background:#fff;border-radius:14px;padding:48px 40px;max-width:480px;text-align:center;box-shadow:0 2px 20px rgba(0,0,0,0.08);"><div style="font-size:3rem;margin-bottom:16px;">✅</div><h1 style="color:#1565c0;font-size:1.5rem;margin-bottom:12px;">You're confirmed!</h1><p style="color:#555;line-height:1.6;margin-bottom:24px;">We'll email you when rates drop in your area. No spam, ever.</p><a href="https://ohioratewatch.com" style="display:inline-block;background:#1565c0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;">← Back to Ohio Rate Watch</a></div></body></html>`;
      } else {
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invalid Link — Ohio Rate Watch</title></head><body style="font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f8f9fa;margin:0;"><div style="background:#fff;border-radius:14px;padding:48px 40px;max-width:480px;text-align:center;box-shadow:0 2px 20px rgba(0,0,0,0.08);"><h1 style="color:#666;font-size:1.3rem;margin-bottom:12px;">This link has already been used or is invalid.</h1><p style="color:#999;margin-bottom:24px;">If you've already confirmed, you're all set!</p><a href="https://ohioratewatch.com" style="display:inline-block;background:#1565c0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;">← Back to Ohio Rate Watch</a></div></body></html>`;
      }
    } else {
      html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invalid Link — Ohio Rate Watch</title></head><body style="font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f8f9fa;margin:0;"><div style="background:#fff;border-radius:14px;padding:48px 40px;max-width:480px;text-align:center;box-shadow:0 2px 20px rgba(0,0,0,0.08);"><h1 style="color:#666;font-size:1.3rem;">Missing confirmation token.</h1><a href="https://ohioratewatch.com" style="display:inline-block;margin-top:20px;background:#1565c0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;">← Back to Ohio Rate Watch</a></div></body></html>`;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', ...allHeaders({ 'Content-Type': 'text/html' }) });
    res.end(html);
    return;
  }

  // Unsubscribe endpoint
  if (req.method === 'GET' && url.pathname === '/unsubscribe') {
    const token = url.searchParams.get('token');
    let html;
    if (token) {
      const { rowCount } = await pool.query('DELETE FROM subscribers WHERE unsubscribe_token = $1', [token]);
      if (rowCount > 0) {
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Ohio Rate Watch</title></head><body style="font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f8f9fa;margin:0;"><div style="background:#fff;border-radius:14px;padding:48px 40px;max-width:480px;text-align:center;box-shadow:0 2px 20px rgba(0,0,0,0.08);"><h1 style="color:#555;font-size:1.3rem;margin-bottom:12px;">You've been unsubscribed.</h1><p style="color:#999;line-height:1.6;margin-bottom:24px;">We're sorry to see you go. You can always sign up again if you change your mind.</p><a href="https://ohioratewatch.com" style="display:inline-block;background:#1565c0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;">← Back to Ohio Rate Watch</a></div></body></html>`;
      } else {
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Ohio Rate Watch</title></head><body style="font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f8f9fa;margin:0;"><div style="background:#fff;border-radius:14px;padding:48px 40px;max-width:480px;text-align:center;box-shadow:0 2px 20px rgba(0,0,0,0.08);"><h1 style="color:#555;font-size:1.3rem;margin-bottom:12px;">Already unsubscribed.</h1><p style="color:#999;margin-bottom:24px;">This link has already been used or is no longer valid.</p><a href="https://ohioratewatch.com" style="display:inline-block;background:#1565c0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;">← Back to Ohio Rate Watch</a></div></body></html>`;
      }
    } else {
      html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe — Ohio Rate Watch</title></head><body style="font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f8f9fa;margin:0;"><div style="background:#fff;border-radius:14px;padding:48px 40px;max-width:480px;text-align:center;box-shadow:0 2px 20px rgba(0,0,0,0.08);"><h1 style="color:#555;font-size:1.3rem;">Missing unsubscribe token.</h1><a href="https://ohioratewatch.com" style="display:inline-block;margin-top:20px;background:#1565c0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;">← Back to Ohio Rate Watch</a></div></body></html>`;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', ...allHeaders({ 'Content-Type': 'text/html' }) });
    res.end(html);
    return;
  }

  // ---- Cron endpoint for daily scraper ----
  if (req.method === 'POST' && url.pathname === '/api/cron/daily-check') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['x-cron-secret'] || '';
    const secretValid = cronSecret &&
      authHeader.length === cronSecret.length &&
      crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(cronSecret));
    if (!secretValid) {
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
      let cityBillCount = 0, trendCount = 0;
      let significantChanges = 0, totalChanges = 0;
      let dbSnapshots = '?', dbOffers = '?', dbHistory = '?';

      try {
        console.log('[cron] Daily check triggered via HTTP');
        const { scrapeAllRates, detectChanges } = await import('./scraper/energy-choice-scraper.js');
        const { insertSnapshot, insertSupplierOffers } = await import('./lib/history-store.js');

        const current = await scrapeAllRates();
        pagesScraped = current.length;
        console.log(`[cron] Scraped ${current.length} rate pages`);

        // Check for missing SCO rates on gas territories (fragile HTML regex)
        const GAS_TERRITORY_IDS = [1, 8, 10, 11];
        const missingSCO = current
          .filter(p => p.category === 'NaturalGas' && p.rateCode === 1 && GAS_TERRITORY_IDS.includes(p.territoryId) && p.defaultRate == null)
          .map(p => p.territoryName || `Territory ${p.territoryId}`);
        if (missingSCO.length > 0) {
          const msg = `SCO rate extraction failed for: ${missingSCO.join(', ')}`;
          console.error(`[cron] WARNING: ${msg}`);
          errors.push(msg);
        }

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

          // Store SCO/default rates per territory
          for (const page of current) {
            if (page.defaultRate != null) {
              try {
                await pool.query(`
                  INSERT INTO sco_rates (scraped_date, territory_id, category, rate_code, default_rate, default_rate_text)
                  VALUES ($1, $2, $3, $4, $5, $6)
                  ON CONFLICT (scraped_date, territory_id, category, rate_code) DO UPDATE SET
                    default_rate = EXCLUDED.default_rate,
                    default_rate_text = EXCLUDED.default_rate_text,
                    updated_at = NOW()
                `, [today, page.territoryId, page.category, page.rateCode, page.defaultRate, page.defaultRateText]);
              } catch (scoErr) {
                console.error(`[cron] WARNING: SCO rate insert failed for territory ${page.territoryId}:`, scoErr.message);
              }
            }
          }
        } catch (err) {
          console.error('[cron] WARNING: Failed to store offers:', err.message);
          errors.push(`Offer insert: ${err.message}`);
        }

        // Shared CSV parser for PUCO Tableau data
        function parseCSVSimple(text) {
          const lines = text.trim().split('\n');
          if (lines.length < 2) return [];
          const headers = lines[0].split(',').map(h => h.trim());
          return lines.slice(1).filter(Boolean).map(line => {
            const values = line.split(',').map(v => v.trim());
            const obj = {};
            headers.forEach((h, i) => { obj[h] = values[i] || ''; });
            return obj;
          });
        }

        // Scrape PUCO city bills
        try {
          const COMPANY_TO_KEY = {
            'Columbia Gas of Ohio': 'columbia',
            'The East Ohio Gas Company dba Enbridge Gas Ohio': 'enbridge',
            'CenterPoint': 'centerpoint',
            'Vectren': 'centerpoint',
            'Duke Energy of Ohio': 'duke',
          };
          function mapCompanyToKey(name) {
            for (const [p, k] of Object.entries(COMPANY_TO_KEY)) {
              if (name.includes(p)) return k;
            }
            return null;
          }
          const reportMonth = new Date().toISOString().slice(0, 7);
          const billRes = await fetch('https://analytics.das.ohio.gov/t/PUCPUB/views/UtilityRateSurvey/BillbyCity.csv');
          if (!billRes.ok) throw new Error(`BillbyCity: ${billRes.status}`);
          const billRows = parseCSVSimple(await billRes.text()).filter(r => r['Utility Type'] === 'Gas');

          const unitRes = await fetch('https://analytics.das.ohio.gov/t/PUCPUB/views/UtilityRateSurvey/UnitCost.csv');
          let unitCostMap = {};
          if (unitRes.ok) {
            for (const row of parseCSVSimple(await unitRes.text())) {
              if ((row['Unit Cost Header'] || '').includes('Gas Cost')) {
                const co = row['Company Name'] || '';
                const pu = parseFloat((row['Per Unit of Usage'] || '').replace(/[$,]/g, ''));
                if (co && !isNaN(pu)) unitCostMap[co] = { perMcf: pu, supplyCost: pu * 10 };
              }
            }
          }

          for (const row of billRows) {
            const city = row['City'], company = row['Company Name'], county = row['County'];
            const uk = mapCompanyToKey(company || '');
            if (!uk || !city) continue;
            const tc = parseFloat((row['Total_Current'] || '').replace(/[$,]/g, ''));
            const tp = parseFloat((row['Total_Prior'] || '').replace(/[$,]/g, ''));
            const pc = parseFloat((row['% Change Total'] || '').replace(/[%,]/g, ''));
            const ud = unitCostMap[company] || {};
            await pool.query(`
              INSERT INTO city_bills (report_month, city, county, utility_key, company_name, gas_bill_total, gas_bill_prior, gas_pct_change, gas_supply_cost, gas_per_mcf)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
              ON CONFLICT (report_month, city, utility_key) DO UPDATE SET
                county=EXCLUDED.county, company_name=EXCLUDED.company_name,
                gas_bill_total=EXCLUDED.gas_bill_total, gas_bill_prior=EXCLUDED.gas_bill_prior,
                gas_pct_change=EXCLUDED.gas_pct_change, gas_supply_cost=EXCLUDED.gas_supply_cost,
                gas_per_mcf=EXCLUDED.gas_per_mcf, scraped_at=NOW()
            `, [reportMonth, city, county, uk, company,
                isNaN(tc)?null:tc, isNaN(tp)?null:tp, isNaN(pc)?null:pc,
                ud.supplyCost||null, ud.perMcf||null]);
            cityBillCount++;
          }
          console.log(`[cron] Upserted ${cityBillCount} city bill rows`);
        } catch (err) {
          console.error('[cron] City bills scraper error:', err.message);
          errors.push(`City bills: ${err.message}`);
        }

        // Scrape PUCO ScheduleTrends (historical bill data)
        try {
          const trendRes = await fetch('https://analytics.das.ohio.gov/t/PUCPUB/views/UtilityRateSurvey/ScheduleTrends.csv');
          if (!trendRes.ok) throw new Error(`ScheduleTrends: ${trendRes.status}`);
          const trendRows = parseCSVSimple(await trendRes.text());
          console.log(`[cron] ScheduleTrends: ${trendRows.length} rows`);

          for (const row of trendRows) {
            const city = (row['City Name'] || '').trim();
            const monthLabel = (row['Month of Rate Month'] || '').trim();
            const rawDate = (row['Report Date'] || '').trim();
            const county = (row['County'] || '').trim();
            const totalCharge = parseFloat((row['Total Charge'] || '').replace(/[$,]/g, ''));
            const localTaxStr = (row['Avg. Local Tax'] || '').replace(/[%,]/g, '');
            const localTax = parseFloat(localTaxStr);

            if (!city || !rawDate) continue;

            // Parse date from "9/5/2025" → "2025-09-05"
            const dateParts = rawDate.split('/');
            if (dateParts.length !== 3) continue;
            const reportDate = `${dateParts[2]}-${dateParts[0].padStart(2,'0')}-${dateParts[1].padStart(2,'0')}`;

            await pool.query(`
              INSERT INTO city_bill_history (report_date, month_label, city, county, total_charge, local_tax)
              VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (report_date, city) DO UPDATE SET
                month_label=EXCLUDED.month_label, county=EXCLUDED.county,
                total_charge=EXCLUDED.total_charge, local_tax=EXCLUDED.local_tax, scraped_at=NOW()
            `, [reportDate, monthLabel, city, county,
                isNaN(totalCharge)?null:totalCharge, isNaN(localTax)?null:localTax]);
            trendCount++;
          }
          console.log(`[cron] Upserted ${trendCount} schedule trend rows`);
        } catch (err) {
          console.error('[cron] ScheduleTrends scraper error:', err.message);
          errors.push(`ScheduleTrends: ${err.message}`);
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

        // Prune rate_snapshots older than 90 days
        try {
          const { rowCount } = await pool.query(`DELETE FROM rate_snapshots WHERE scraped_at::date < (CURRENT_DATE - INTERVAL '90 days')`);
          if (rowCount > 0) console.log(`[cron] Pruned ${rowCount} rate_snapshots older than 90 days`);
        } catch (err) {
          console.error('[cron] WARNING: Snapshot cleanup failed:', err.message);
        }

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
            { name: '🏘️ City Bills', value: `${cityBillCount}`, inline: true },
            { name: '📈 Bill Trends', value: `${trendCount}`, inline: true },
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

  // ---- City Bills API ----
  if (req.method === 'GET' && url.pathname === '/api/city-bills') {
    try {
      const TERRITORY_TO_KEY = { '8': 'columbia', '1': 'enbridge', '11': 'centerpoint', '10': 'duke' };
      const KEY_TO_KEY = { columbia: 'columbia', enbridge: 'enbridge', centerpoint: 'centerpoint', duke: 'duke' };
      let utilityKey = null;
      const tParam = url.searchParams.get('territory');
      if (tParam) {
        utilityKey = TERRITORY_TO_KEY[tParam] || KEY_TO_KEY[tParam] || tParam;
      }

      let query, params;
      if (utilityKey) {
        query = `SELECT report_month, city, county, utility_key, gas_bill_total, gas_bill_prior, gas_pct_change, gas_supply_cost, gas_per_mcf
                 FROM city_bills WHERE utility_key = $1
                 AND report_month = (SELECT MAX(report_month) FROM city_bills WHERE utility_key = $1)
                 ORDER BY gas_bill_total DESC`;
        params = [utilityKey];
      } else {
        query = `SELECT report_month, city, county, utility_key, gas_bill_total, gas_bill_prior, gas_pct_change, gas_supply_cost, gas_per_mcf
                 FROM city_bills
                 WHERE report_month = (SELECT MAX(report_month) FROM city_bills)
                 ORDER BY utility_key, gas_bill_total DESC`;
        params = [];
      }

      const { rows } = await pool.query(query, params);
      const reportMonth = rows.length > 0 ? rows[0].report_month : null;
      res.writeHead(200, allHeaders({ 'Cache-Control': 'public, max-age=3600' }));
      res.end(JSON.stringify({
        reportMonth,
        utility: utilityKey || 'all',
        cities: rows.map(r => ({
          city: r.city,
          county: r.county,
          gasBillTotal: r.gas_bill_total,
          gasBillPrior: r.gas_bill_prior,
          gasPctChange: r.gas_pct_change,
          gasSupplyCost: r.gas_supply_cost,
          gasPerMcf: r.gas_per_mcf,
        })),
      }));
    } catch (err) {
      console.error('[api/city-bills] error:', err.message);
      res.writeHead(500, allHeaders());
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ---- City Bill History API ----
  if (req.method === 'GET' && url.pathname === '/api/city-history') {
    try {
      const city = url.searchParams.get('city');
      if (!city) {
        res.writeHead(400, allHeaders());
        res.end(JSON.stringify({ error: 'city parameter required' }));
        return;
      }
      const { rows } = await pool.query(`
        SELECT report_date, month_label, city, county, total_charge, local_tax
        FROM city_bill_history
        WHERE LOWER(city) = LOWER($1)
        ORDER BY report_date ASC
      `, [city]);
      res.writeHead(200, allHeaders({ 'Cache-Control': 'public, max-age=3600' }));
      res.end(JSON.stringify({
        city: city,
        history: rows.map(r => ({
          reportDate: r.report_date,
          monthLabel: r.month_label,
          county: r.county,
          totalCharge: r.total_charge,
          localTax: r.local_tax,
        })),
      }));
    } catch (err) {
      console.error('[api/city-history] error:', err.message);
      res.writeHead(500, allHeaders());
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ---- Combined City API ----
  if (req.method === 'GET' && url.pathname.startsWith('/api/city/')) {
    try {
      const slug = decodeURIComponent(url.pathname.split('/api/city/')[1] || '');
      const cityName = slug.replace(/-/g, ' ');
      if (!cityName) {
        res.writeHead(400, allHeaders());
        res.end(JSON.stringify({ error: 'City name required' }));
        return;
      }

      // 1. Get latest city_bills rows for this city
      const { rows: billRows } = await pool.query(`
        SELECT city, county, utility_key, company_name, gas_bill_total, gas_bill_prior,
               gas_pct_change, gas_supply_cost, gas_per_mcf, report_month
        FROM city_bills
        WHERE LOWER(city) = LOWER($1)
          AND report_month = (SELECT MAX(report_month) FROM city_bills WHERE LOWER(city) = LOWER($1))
        ORDER BY utility_key
      `, [cityName]);

      if (billRows.length === 0) {
        res.writeHead(404, allHeaders());
        res.end(JSON.stringify({ error: 'City not found' }));
        return;
      }

      const reportMonth = billRows[0].report_month;
      const canonicalCity = billRows[0].city;
      const county = billRows[0].county;

      // 2. For each utility, get best offers and SCO rate
      const utilities = [];
      for (const row of billRows) {
        const territoryId = TERRITORY_IDS[row.utility_key];
        if (!territoryId) continue;

        // Best fixed offers (non-intro, price > 0), bundle-required plans sorted last
        const { rows: offers } = await pool.query(`
          SELECT supplier_name, price, term_months, sign_up_url, etf, is_bundle_required
          FROM supplier_offers
          WHERE territory_id = $1
            AND category = 'NaturalGas'
            AND rate_code = '1'
            AND rate_type = 'fixed'
            AND price > 0
            AND (is_intro = FALSE OR is_intro IS NULL)
            AND scraped_date = (SELECT MAX(scraped_date) FROM supplier_offers WHERE territory_id = $1 AND category = 'NaturalGas')
          ORDER BY is_bundle_required ASC, price ASC
          LIMIT 10
        `, [territoryId]);

        // Convert Enbridge MCF prices to CCF
        const convertedOffers = offers.map(o => ({
          supplierName: o.supplier_name,
          price: territoryId === 1 ? Math.round((o.price / 10) * 10000) / 10000 : o.price,
          termMonths: o.term_months,
          signUpUrl: o.sign_up_url,
          etf: o.etf || 0,
          requiresBundle: o.is_bundle_required === true,
        }));

        // SCO rate
        const { rows: scoRows } = await pool.query(`
          SELECT default_rate, default_rate_text
          FROM sco_rates
          WHERE territory_id = $1 AND category = 'NaturalGas' AND rate_code = '1'
          AND scraped_date = (SELECT MAX(scraped_date) FROM sco_rates WHERE territory_id = $1 AND category = 'NaturalGas')
          LIMIT 1
        `, [territoryId]);

        const sco = scoRows[0] || {};

        utilities.push({
          utilityKey: row.utility_key,
          utilityName: row.company_name || TERRITORY_NAMES[row.utility_key] || row.utility_key,
          territoryId,
          gasBillTotal: row.gas_bill_total,
          gasBillPrior: row.gas_bill_prior,
          gasPctChange: row.gas_pct_change,
          gasSupplyCost: row.gas_supply_cost,
          gasPerMcf: row.gas_per_mcf,
          scoRate: sco.default_rate || null,
          scoRateText: sco.default_rate_text || null,
          bestOffers: convertedOffers,
        });
      }

      // Find most recent supplier_offers scraped_date for the "last updated" display
      const { rows: latestDateRows } = await pool.query(`
        SELECT MAX(scraped_date)::text AS latest FROM supplier_offers WHERE category = 'NaturalGas'
      `);
      const ratesUpdated = latestDateRows[0]?.latest || new Date().toISOString().slice(0, 10);

      res.writeHead(200, allHeaders({ 'Cache-Control': 'public, max-age=3600' }));
      res.end(JSON.stringify({
        city: canonicalCity,
        county,
        reportMonth,
        utilities,
        ratesUpdated,
      }));
    } catch (err) {
      console.error('[api/city] error:', err.message);
      res.writeHead(500, allHeaders());
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ---- City landing page route ----
  if (req.method === 'GET' && url.pathname.startsWith('/city/') && !url.pathname.startsWith('/city-')) {
    try {
      const cityHtml = readFileSync(path.join(__dirname, 'city.html'));
      res.writeHead(200, allHeaders({ 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=3600' }));
      res.end(cityHtml);
    } catch (err) {
      res.writeHead(500, allHeaders({ 'Content-Type': 'text/html' }));
      res.end('<h1>Server Error</h1>');
    }
    return;
  }

  // ---- Dynamic Sitemap ----
  if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT LOWER(city) as city
        FROM city_bills
        WHERE report_month = (SELECT MAX(report_month) FROM city_bills)
        ORDER BY city
      `);
      const today = new Date().toISOString().slice(0, 10);
      const staticPages = ['', '/learn', '/methodology', '/calculator', '/cities'];
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
      xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
      for (const p of staticPages) {
        xml += `  <url><loc>https://ohioratewatch.com${p}</loc><lastmod>${today}</lastmod><priority>1.0</priority><changefreq>daily</changefreq></url>\n`;
      }
      for (const r of rows) {
        const slug = r.city.replace(/\s+/g, '-');
        xml += `  <url><loc>https://ohioratewatch.com/city/${slug}</loc><lastmod>${today}</lastmod><priority>0.7</priority><changefreq>weekly</changefreq></url>\n`;
      }
      xml += '</urlset>';
      res.writeHead(200, allHeaders({ 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' }));
      res.end(xml);
      return;
    } catch (err) {
      // Fall through to static file serving (may have a static sitemap.xml)
      console.error('[sitemap] error:', err.message);
    }
  }

  // Static file serving
  const MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.xml': 'application/xml', '.txt': 'text/plain', '.geojson': 'application/json',
  };

  let filePath = path.resolve(path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname));
  // Path traversal guard
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, allHeaders());
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }
  // Try .html extension for extensionless paths
  if (!path.extname(filePath) && existsSync(filePath + '.html')) {
    filePath = filePath + '.html';
  }

  // GET /api/admin/subscriber-stats (protected)
  if (req.method === 'GET' && url.pathname === '/api/admin/subscriber-stats') {
    const secret = req.headers['x-cron-secret'] || '';
    const cronSecret = process.env.CRON_SECRET;
    const secretValid = cronSecret &&
      secret.length === cronSecret.length &&
      crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(cronSecret));
    if (!secretValid) {
      res.writeHead(403, allHeaders()); res.end(JSON.stringify({ error: 'Forbidden' })); return;
    }
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE confirmed=true) as confirmed,
          COUNT(*) FILTER (WHERE confirmed=false) as pending
        FROM subscribers
      `);
      const { rows: byTerritory } = await pool.query(`
        SELECT COALESCE(territory,'unknown') as territory, COUNT(*) as cnt
        FROM subscribers WHERE confirmed=true GROUP BY territory ORDER BY cnt DESC
      `);
      res.writeHead(200, allHeaders());
      res.end(JSON.stringify({ ...rows[0], byTerritory }));
    } catch (err) {
      res.writeHead(500, allHeaders()); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/scrape-status
  if (req.method === 'GET' && url.pathname === '/api/scrape-status') {
    try {
      // Try scrape_runs first; fall back to supplier_offers scraped_date
      const { rows: runRows } = await pool.query(`
        SELECT
          MAX(CASE WHEN status = 'success' THEN started_at END) AS last_success,
          MAX(started_at) AS last_run,
          (SELECT status FROM scrape_runs ORDER BY id DESC LIMIT 1) AS status,
          (SELECT row_count FROM scrape_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1) AS row_count
        FROM scrape_runs
      `);
      const r = runRows[0] || {};
      let lastSuccess = r.last_success ? new Date(r.last_success) : null;
      let rowCount = r.row_count || null;
      let status = r.status || null;

      // Fallback: derive from supplier_offers if scrape_runs is empty
      if (!lastSuccess) {
        const { rows: offerRows } = await pool.query(`
          SELECT MAX(scraped_date) AS last_date, COUNT(*) AS row_count
          FROM supplier_offers
          WHERE scraped_date = (SELECT MAX(scraped_date) FROM supplier_offers)
        `);
        const o = offerRows[0] || {};
        if (o.last_date) {
          // scraped_date is TEXT 'YYYY-MM-DD' — treat as noon ET of that day
          lastSuccess = new Date(o.last_date + 'T17:00:00Z');
          rowCount = parseInt(o.row_count) || null;
          status = 'success';
        }
      }

      const hoursSince = lastSuccess ? ((Date.now() - lastSuccess.getTime()) / 3600000).toFixed(1) : null;
      res.writeHead(200, allHeaders());
      res.end(JSON.stringify({
        lastSuccess: lastSuccess ? lastSuccess.toISOString() : null,
        lastRun: r.last_run ? new Date(r.last_run).toISOString() : null,
        status: status || 'unknown',
        rowCount,
        hoursSinceUpdate: hoursSince ? parseFloat(hoursSince) : null,
      }));
    } catch (err) {
      res.writeHead(500, allHeaders());
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
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
