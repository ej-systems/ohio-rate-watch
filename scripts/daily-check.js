#!/usr/bin/env node
/**
 * Ohio Rate Watch — Daily Rate Check & Alert Script
 *
 * Runs the Energy Choice scraper, compares with stored baseline,
 * and emails all subscribers when rates change.
 *
 * Usage:
 *   node scripts/daily-check.js [--force-alert] [--dry-run]
 *
 * --force-alert  : Send alerts even if no changes detected (testing)
 * --dry-run      : Show what would be sent without sending emails
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { insertSnapshot, insertSupplierOffers } from '../lib/history-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const BASELINE_FILE = path.join(ROOT, 'data', 'rates-baseline.json');
const LATEST_FILE   = path.join(ROOT, 'data', 'rates-latest.json');
const SIGNUPS_FILE  = process.env.SIGNUPS_FILE || '/var/log/ratewatch/signups.csv';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const FORCE_ALERT = process.argv.includes('--force-alert');
const DRY_RUN     = process.argv.includes('--dry-run');

const log = (...args) => console.error(`[${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// PUCO City Bills Scraper
// ---------------------------------------------------------------------------
const COMPANY_TO_KEY = {
  'Columbia Gas of Ohio': 'columbia',
  'The East Ohio Gas Company dba Enbridge Gas Ohio': 'enbridge',
  'CenterPoint': 'centerpoint',
  'Vectren': 'centerpoint',
  'Duke Energy of Ohio': 'duke',
};

function mapCompanyToKey(companyName) {
  for (const [pattern, key] of Object.entries(COMPANY_TO_KEY)) {
    if (companyName.includes(pattern)) return key;
  }
  return null;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).filter(Boolean).map(line => {
    // Simple CSV parse (handles basic cases, no quoted commas expected in this data)
    const values = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ''; });
    return obj;
  });
}

async function scrapeCityBills() {
  const { default: pg } = await import('pg');
  const { readFileSync, existsSync } = await import('fs');
  
  let DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    const envPath = path.join(ROOT, '.env');
    if (existsSync(envPath)) {
      const envFile = readFileSync(envPath, 'utf8');
      DATABASE_URL = envFile.match(/DATABASE_URL=(.*)/)?.[1]?.trim();
    }
  }
  if (!DATABASE_URL) {
    log('WARNING: No DATABASE_URL for city bills scraper');
    return 0;
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // Ensure table exists
    await pool.query(`
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
    `);

    const reportMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

    // Fetch BillbyCity CSV
    log('Fetching PUCO BillbyCity CSV...');
    const billRes = await fetch('https://analytics.das.ohio.gov/t/PUCPUB/views/UtilityRateSurvey/BillbyCity.csv');
    if (!billRes.ok) throw new Error(`BillbyCity fetch failed: ${billRes.status}`);
    const billText = await billRes.text();
    const billRows = parseCSV(billText);
    log(`Parsed ${billRows.length} BillbyCity rows`);

    // Filter to Gas rows and map
    const gasRows = billRows.filter(r => r['Utility Type'] === 'Gas');
    log(`Found ${gasRows.length} Gas rows`);

    // Fetch UnitCost CSV
    log('Fetching PUCO UnitCost CSV...');
    const unitRes = await fetch('https://analytics.das.ohio.gov/t/PUCPUB/views/UtilityRateSurvey/UnitCost.csv');
    let unitCostMap = {}; // companyName -> { supplyCost, perMcf }
    if (unitRes.ok) {
      const unitText = await unitRes.text();
      const unitRows = parseCSV(unitText);
      log(`Parsed ${unitRows.length} UnitCost rows`);
      
      // Look for Gas Cost rows
      for (const row of unitRows) {
        const header = row['Unit Cost Header'] || '';
        if (header.includes('Gas Cost')) {
          const company = row['Company Name'] || '';
          const perUnit = parseFloat((row['Per Unit of Usage'] || '').replace(/[$,]/g, ''));
          if (company && !isNaN(perUnit)) {
            unitCostMap[company] = {
              perMcf: perUnit,
              supplyCost: perUnit * 10, // 10 Mcf monthly usage
            };
          }
        }
      }
      log(`Unit cost data for ${Object.keys(unitCostMap).length} companies`);
    } else {
      log('WARNING: UnitCost fetch failed, continuing without unit costs');
    }

    // Upsert into city_bills
    let upserted = 0;
    for (const row of gasRows) {
      const city = row['City'] || '';
      const company = row['Company Name'] || '';
      const county = row['County'] || '';
      const utilityKey = mapCompanyToKey(company);
      if (!utilityKey || !city) continue;

      const totalCurrent = parseFloat((row['Total_Current'] || '').replace(/[$,]/g, ''));
      const totalPrior = parseFloat((row['Total_Prior'] || '').replace(/[$,]/g, ''));
      const pctChange = parseFloat((row['% Change Total'] || '').replace(/[%,]/g, ''));
      const unitData = unitCostMap[company] || {};

      await pool.query(`
        INSERT INTO city_bills (report_month, city, county, utility_key, company_name, gas_bill_total, gas_bill_prior, gas_pct_change, gas_supply_cost, gas_per_mcf)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (report_month, city, utility_key) DO UPDATE SET
          county = EXCLUDED.county,
          company_name = EXCLUDED.company_name,
          gas_bill_total = EXCLUDED.gas_bill_total,
          gas_bill_prior = EXCLUDED.gas_bill_prior,
          gas_pct_change = EXCLUDED.gas_pct_change,
          gas_supply_cost = EXCLUDED.gas_supply_cost,
          gas_per_mcf = EXCLUDED.gas_per_mcf,
          scraped_at = NOW()
      `, [
        reportMonth, city, county, utilityKey, company,
        isNaN(totalCurrent) ? null : totalCurrent,
        isNaN(totalPrior) ? null : totalPrior,
        isNaN(pctChange) ? null : pctChange,
        unitData.supplyCost || null,
        unitData.perMcf || null,
      ]);
      upserted++;
    }

    log(`Upserted ${upserted} city bill rows for ${reportMonth}`);

    // Also scrape ScheduleTrends historical data
    try {
      log('Fetching PUCO ScheduleTrends CSV...');
      const trendRes = await fetch('https://analytics.das.ohio.gov/t/PUCPUB/views/UtilityRateSurvey/ScheduleTrends.csv');
      if (!trendRes.ok) throw new Error(`ScheduleTrends: ${trendRes.status}`);
      const trendRows = parseCSV(await trendRes.text());
      log(`Parsed ${trendRows.length} ScheduleTrends rows`);

      await pool.query(`
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
      `);

      let trendCount = 0;
      for (const row of trendRows) {
        const city = (row['City Name'] || '').trim();
        const monthLabel = (row['Month of Rate Month'] || '').trim();
        const rawDate = (row['Report Date'] || '').trim();
        const county = (row['County'] || '').trim();
        const totalCharge = parseFloat((row['Total Charge'] || '').replace(/[$,]/g, ''));
        const localTaxStr = (row['Avg. Local Tax'] || '').replace(/[%,]/g, '');
        const localTax = parseFloat(localTaxStr);

        if (!city || !rawDate) continue;
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
      log(`Upserted ${trendCount} schedule trend rows`);
    } catch (err) {
      log('WARNING: ScheduleTrends scraper failed:', err.message);
    }

    return upserted;
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Load subscribers from CSV (legacy fallback)
// ---------------------------------------------------------------------------
function loadSubscribers() {
  if (!fs.existsSync(SIGNUPS_FILE)) {
    log('No signups file found at', SIGNUPS_FILE);
    return [];
  }
  const lines = fs.readFileSync(SIGNUPS_FILE, 'utf8').trim().split('\n');
  return lines.slice(1)
    .filter(Boolean)
    .map(line => {
      const [timestamp, email, zip] = line.split(',');
      return { timestamp: timestamp?.trim(), email: email?.trim(), zip: zip?.trim() };
    })
    .filter(s => s.email && s.email.includes('@'));
}

function dedupeSubscribers(subscribers) {
  const seen = new Map();
  for (const s of subscribers) {
    seen.set(s.email, s);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Territory config
// ---------------------------------------------------------------------------
const TERRITORY_CONFIG = {
  columbia:     { id: 8,  name: 'Columbia Gas of Ohio' },
  enbridge:     { id: 1,  name: 'Enbridge Gas Ohio' },
  centerpoint:  { id: 11, name: 'CenterPoint Energy Ohio' },
  duke:         { id: 10, name: 'Duke Energy Ohio' },
};

// ---------------------------------------------------------------------------
// Build personalized alert email
// ---------------------------------------------------------------------------
function buildPersonalAlertEmail(sub, bestOffer, savingsPct, baseline, utilityName, monthlySavings) {
  const baselineLabel = sub.current_rate
    ? `Your reported rate: $${sub.current_rate.toFixed(3)}/ccf`
    : `${utilityName} default (SCO) rate`;

  return `
  <div style="font-family:-apple-system,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#f8f9fa;">
    <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
      <img src="https://ohioratewatch.com/logo.png" alt="Ohio Rate Watch" style="height:40px;margin-bottom:24px;" onerror="this.style.display='none'">
      <h2 style="color:#1565c0;margin-bottom:8px;">💡 You could save ${savingsPct}% on your gas bill</h2>
      <p style="color:#444;line-height:1.6;">We found a better rate for <strong>${utilityName}</strong> customers.</p>

      <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:10px;padding:20px;margin:20px 0;">
        <div style="font-size:0.85rem;color:#666;margin-bottom:4px;">Your baseline: ${baselineLabel}</div>
        <div style="font-size:0.85rem;color:#666;margin-bottom:12px;">Baseline rate: <strong>$${baseline.toFixed(3)}/ccf</strong></div>
        <div style="font-size:1.4rem;font-weight:900;color:#16a34a;margin-bottom:4px;">$${bestOffer.price.toFixed(3)}/ccf</div>
        <div style="font-size:0.9rem;color:#374151;"><strong>${bestOffer.supplier_name}</strong> · ${bestOffer.term_months || '?'}-month fixed · ${bestOffer.etf ? '$' + bestOffer.etf + ' ETF' : 'No ETF'}</div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #bbf7d0;font-size:0.9rem;color:#166534;">
          <strong>Estimated savings: ~$${monthlySavings.toFixed(0)}/month</strong> <span style="color:#6b7280;font-size:0.8rem;">(based on 10 Mcf/month usage)</span>
        </div>
      </div>

      ${bestOffer.sign_up_url ? `<div style="text-align:center;margin:24px 0;"><a href="${bestOffer.sign_up_url}" style="display:inline-block;background:#16a34a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">View This Offer →</a></div>` : ''}

      <p style="color:#555;font-size:0.88rem;line-height:1.6;">
        <a href="https://ohioratewatch.com" style="color:#1565c0;font-weight:600;">See all plans on Ohio Rate Watch →</a>
      </p>

      <p style="color:#888;font-size:0.8rem;margin-top:24px;line-height:1.5;">
        Always verify current rates directly with the supplier before enrolling.
      </p>
      <p style="color:#999;font-size:0.78rem;margin-top:20px;border-top:1px solid #eee;padding-top:16px;">
        Ohio Rate Watch · A project of EJ Systems LLC · Cleveland, Ohio<br>
        <a href="tel:8334317283" style="color:#1565c0;">833.431.RATE</a> ·
        <a href="https://ohioratewatch.com" style="color:#1565c0;">ohioratewatch.com</a> ·
        <a href="https://ohioratewatch.com/unsubscribe?token=${sub.unsubscribe_token}" style="color:#999;">Unsubscribe</a>
      </p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Send subscriber alerts based on DB subscribers + current rates
// ---------------------------------------------------------------------------
async function sendSubscriberAlerts(dbPool, currentRates) {
  const territories = Object.entries(TERRITORY_CONFIG);

  for (const [tKey, tConfig] of territories) {
    // Find SCO rate for this territory
    const territoryPage = currentRates.find(p => p.territoryId === tConfig.id && p.category === 'NaturalGas');
    const scoRate = territoryPage?.defaultRate || null;

    // Find best fixed rate (no bundle, no intro) from DB for today
    const today = new Date().toISOString().slice(0, 10);
    const { rows: offerRows } = await dbPool.query(`
      SELECT supplier_name, price, term_months, etf, sign_up_url
      FROM supplier_offers
      WHERE territory_id = $1 AND category = 'NaturalGas' AND rate_code = '1'
        AND rate_type = 'fixed' AND is_intro = FALSE
        AND price > 0.1
        AND scraped_date = $2
        AND (offer_details NOT ILIKE '%bundle%' AND offer_details NOT ILIKE '%electric%gas%' AND offer_details NOT ILIKE '%gas%electric%')
      ORDER BY price ASC LIMIT 1
    `, [tConfig.id, today]);

    if (offerRows.length === 0) {
      log(`[alerts] No fixed offers found for ${tKey} on ${today}, skipping`);
      continue;
    }
    const bestOffer = offerRows[0];

    // Get confirmed subscribers for this territory
    const { rows: subs } = await dbPool.query(
      'SELECT * FROM subscribers WHERE confirmed = TRUE AND (territory = $1 OR territory IS NULL)',
      [tKey]
    );

    log(`[alerts] ${tKey}: SCO=${scoRate}, best=$${bestOffer.price}, ${subs.length} subscribers`);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    for (const sub of subs) {
      // For null-territory subs, only send if this is their first territory pass (use columbia as default)
      if (!sub.territory && tKey !== 'columbia') continue;

      const baseline = sub.current_rate || scoRate;
      if (!baseline || baseline <= 0) continue;

      const savingsPct = Math.round((1 - bestOffer.price / baseline) * 100);
      if (savingsPct < (sub.min_savings_pct || 15)) continue;

      // Throttle: skip if alerted recently and rate hasn't changed much
      if (sub.last_alerted_at) {
        const lastAlerted = new Date(sub.last_alerted_at);
        if (lastAlerted > sevenDaysAgo) continue;
        if (sub.last_alerted_rate) {
          const rateDiff = Math.abs(bestOffer.price - sub.last_alerted_rate) / sub.last_alerted_rate;
          if (rateDiff <= 0.03) continue;
        }
      }

      const monthlySavings = (baseline - bestOffer.price) * 100; // 10 Mcf = 100 ccf

      try {
        const subject = `💡 You could save ${savingsPct}% on your gas bill — Ohio Rate Watch`;
        const html = buildPersonalAlertEmail(sub, bestOffer, savingsPct, baseline, tConfig.name, monthlySavings);
        await sendEmail(sub.email, subject, html);

        await dbPool.query(
          'UPDATE subscribers SET last_alerted_at = NOW(), last_alerted_rate = $1 WHERE id = $2',
          [bestOffer.price, sub.id]
        );
        log(`[alerts] Sent alert to ${sub.email} (${tKey}, save ${savingsPct}%)`);
        await new Promise(r => setTimeout(r, 500)); // rate limit
      } catch (err) {
        log(`[alerts] Failed to send to ${sub.email}: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Send email via Resend
// ---------------------------------------------------------------------------
async function sendEmail(to, subject, html) {
  if (DRY_RUN) {
    log(`[DRY RUN] Would send to ${to}: ${subject}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Ohio Rate Watch <hello@ohioratewatch.com>',
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Build alert email HTML for a subscriber
// ---------------------------------------------------------------------------
function buildAlertEmail(changes, subscriber) {
  const zipText = subscriber.zip ? ` in your area (${subscriber.zip})` : '';

  const changeRows = changes.map(c => {
    const direction = c.changePct > 0 ? '📈 Up' : '📉 Down';
    const pct = Math.abs(c.changePct).toFixed(1);
    const savings = c.currRate < c.prevRate
      ? `<span style="color:#2e7d32;font-weight:bold;">You could save more now — rates dropped.</span>`
      : `<span style="color:#c62828;">Rates went up — worth checking alternatives.</span>`;

    return `
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px 20px;margin:12px 0;background:#fff;">
      <div style="font-weight:700;color:#1a1a2e;font-size:1rem;">${c.territory}</div>
      ${c.type === 'default_rate' ? `<div style="color:#555;font-size:0.85rem;margin:4px 0;">Default (SCO) Rate</div>` : `<div style="color:#555;font-size:0.85rem;margin:4px 0;">Supplier: ${c.supplier}</div>`}
      <div style="margin:8px 0;">
        <span style="text-decoration:line-through;color:#999;">$${c.prevRate}/unit</span>
        <span style="margin:0 8px;color:#555;">→</span>
        <span style="font-size:1.1rem;font-weight:700;color:${c.currRate < c.prevRate ? '#2e7d32' : '#c62828'};">$${c.currRate}/unit</span>
        <span style="margin-left:8px;font-size:0.85rem;color:#666;">${direction} ${pct}%</span>
      </div>
      ${c.effectiveText ? `<div style="color:#666;font-size:0.8rem;">Effective: ${c.effectiveText}</div>` : ''}
      <div style="margin-top:8px;">${savings}</div>
    </div>`;
  }).join('');

  return `
  <div style="font-family:-apple-system,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#f8f9fa;">
    <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
      <img src="https://ohioratewatch.com/logo.png" alt="Ohio Rate Watch" style="height:40px;margin-bottom:24px;" onerror="this.style.display='none'">
      <h2 style="color:#1565c0;margin-bottom:8px;">⚡ Rate Alert${zipText}</h2>
      <p style="color:#444;line-height:1.6;margin-bottom:20px;">
        We detected <strong>${changes.length} rate change${changes.length > 1 ? 's' : ''}</strong> in Ohio utility rates. 
        Here's what changed:
      </p>
      ${changeRows}
      <div style="margin-top:24px;text-align:center;">
        <a href="https://energychoice.ohio.gov" 
           style="display:inline-block;background:#1565c0;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;">
          Compare All Suppliers →
        </a>
      </div>
      <p style="color:#888;font-size:0.8rem;margin-top:24px;line-height:1.5;">
        This alert was generated automatically by monitoring PUCO Energy Choice Ohio data.<br>
        Always verify current rates directly at 
        <a href="https://energychoice.ohio.gov" style="color:#1565c0;">energychoice.ohio.gov</a> 
        before switching suppliers.
      </p>
      <p style="color:#999;font-size:0.78rem;margin-top:20px;border-top:1px solid #eee;padding-top:16px;">
        Ohio Rate Watch · A project of EJ Systems LLC · Cleveland, Ohio<br>
        <a href="tel:8334317283" style="color:#1565c0;">833.431.RATE</a> · 
        <a href="https://ohioratewatch.com" style="color:#1565c0;">ohioratewatch.com</a> · 
        <a href="https://ohioratewatch.com/unsubscribe" style="color:#999;">Unsubscribe</a>
      </p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DB helpers for scrape_runs and rate_events
// ---------------------------------------------------------------------------
let _pool = null;
function getPool() {
  if (!_pool) {
    let DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      const { readFileSync, existsSync } = fs;
      const envPath = path.join(ROOT, '.env');
      if (existsSync(envPath)) {
        const envFile = readFileSync(envPath, 'utf8');
        DATABASE_URL = envFile.match(/DATABASE_URL=(.*)/)?.[1]?.trim();
      }
    }
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    _pool = new pg.Pool({ connectionString: DATABASE_URL });
  }
  return _pool;
}

async function startScrapeRun() {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO scrape_runs (status) VALUES ('running') RETURNING id`,
    );
    return rows[0].id;
  } catch (err) {
    log('WARNING: Could not record scrape_run start:', err.message);
    return null;
  }
}

async function finishScrapeRun(runId, status, rowCount, errorMessage = null) {
  if (!runId) return;
  try {
    await getPool().query(
      `UPDATE scrape_runs SET finished_at=NOW(), status=$1, row_count=$2, error_message=$3 WHERE id=$4`,
      [status, rowCount, errorMessage, runId],
    );
  } catch (err) {
    log('WARNING: Could not update scrape_run:', err.message);
  }
}

async function getSevenDayMedian() {
  try {
    const { rows } = await getPool().query(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY row_count) AS median
      FROM scrape_runs
      WHERE status = 'success' AND started_at > NOW() - INTERVAL '7 days'
    `);
    return rows[0]?.median || null;
  } catch {
    return null;
  }
}

async function recordRateEvents(runId, changes) {
  if (!runId || !changes.length) return;
  try {
    for (const c of changes) {
      const eventType = c.type === 'new_offer' ? 'new_offer'
        : c.type === 'removed_offer' ? 'removed_offer'
        : 'rate_change';
      const changeAbs = (c.currRate != null && c.prevRate != null)
        ? parseFloat((c.currRate - c.prevRate).toFixed(6)) : null;
      const changePct = c.changePct != null ? parseFloat(c.changePct) : null;
      await getPool().query(`
        INSERT INTO rate_events
          (scrape_run_id, supplier_name, event_type, old_rate, new_rate, change_abs, change_pct)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [runId, c.supplier || c.territory || null, eventType,
          c.prevRate || null, c.currRate || null, changeAbs, changePct]);
    }
    log(`Recorded ${changes.length} rate_events for run ${runId}`);
  } catch (err) {
    log('WARNING: Could not record rate_events:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Discord webhook helper
// ---------------------------------------------------------------------------
async function sendDiscordAlert(message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    log('WARNING: Discord webhook failed:', err.message);
  }
}

async function main() {
  log('Ohio Rate Watch daily check starting...');

  if (!RESEND_API_KEY && !DRY_RUN) {
    log('ERROR: RESEND_API_KEY env var required');
    process.exit(1);
  }

  // Ensure data directory exists
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

  // Start tracking this scrape run
  const runId = await startScrapeRun();

  // Run the scraper
  log('Running energy choice scraper...');
  const { scrapeAllRates, detectChanges } = await import('../scraper/energy-choice-scraper.js');
  let current;
  try {
    current = await scrapeAllRates();
  } catch (err) {
    log('ERROR: Scraper threw:', err.message);
    await finishScrapeRun(runId, 'failed', 0, err.message);
    await sendDiscordAlert(`⚠️ **Ohio Rate Watch scraper FAILED**\nError: ${err.message}`);
    process.exit(1);
  }

  // Count total offers across all territories
  const totalOffers = current.reduce((sum, page) => sum + (page.suppliers?.length || 0), 0);
  log(`Scraper returned ${current.length} rate pages, ~${totalOffers} offers`);

  // Validation gate: compare against 7-day median
  const median = await getSevenDayMedian();
  const minAcceptable = median ? Math.floor(median * 0.3) : 30;
  if (totalOffers < minAcceptable) {
    const msg = `Row count ${totalOffers} is below 30% of 7-day median (${median?.toFixed(0) || 'unknown'}). Skipping DB write.`;
    log('VALIDATION FAILED:', msg);
    await finishScrapeRun(runId, 'invalid', totalOffers, msg);
    await sendDiscordAlert(`⚠️ **Ohio Rate Watch scrape validation failed**\n${msg}`);
    process.exit(1);
  }

  // Save latest snapshot
  fs.writeFileSync(LATEST_FILE, JSON.stringify(current, null, 2));
  log(`Saved ${current.length} rate pages to rates-latest.json`);

  // Store to historical PostgreSQL database
  try {
    const rowCount = await insertSnapshot(current);
    log(`Stored ${rowCount} supplier rows in history database`);
  } catch (err) {
    log("WARNING: Failed to store history:", err.message);
  }

  // Store to supplier_offers table (one row per offer per day)
  let offerCount = 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    offerCount = await insertSupplierOffers(today, current);
    log(`Stored ${offerCount} offers in supplier_offers table for ${today}`);
  } catch (err) {
    log("WARNING: Failed to store supplier offers:", err.message);
  }

  await finishScrapeRun(runId, 'success', offerCount);

  // Load baseline for comparison
  let changes = [];
  if (fs.existsSync(BASELINE_FILE)) {
    const previous = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const allChanges = detectChanges(previous, current);

    // Filter noise: only meaningful changes
    // - Default/SCO rate: any change
    // - Supplier rates: >5% change and >$0.01 absolute difference
    changes = allChanges.filter(c => {
      if (c.type === 'default_rate') return true;
      const absDiff = Math.abs(c.currRate - c.prevRate);
      const pctDiff = Math.abs(parseFloat(c.changePct));
      return pctDiff >= 5 && absDiff >= 0.01;
    });

    // Cap at top 20 most significant changes for email readability
    changes.sort((a, b) => Math.abs(parseFloat(b.changePct)) - Math.abs(parseFloat(a.changePct)));
    const totalChanges = changes.length;
    if (changes.length > 20) changes = changes.slice(0, 20);
    if (totalChanges > 20) log(`Showing top 20 of ${totalChanges} significant changes`);

    log(`Detected ${allChanges.length} total changes, ${totalChanges} significant (>${5}%), showing top ${changes.length}`);
    await recordRateEvents(runId, changes);
  } else {
    log('No baseline found — saving current as baseline (no alerts this run)');
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2));
  }

  // Override for testing
  if (FORCE_ALERT && changes.length === 0) {
    log('--force-alert: injecting test change');
    changes = [{
      type: 'default_rate',
      territory: 'Columbia Gas of Ohio (West) [TEST]',
      category: 'NaturalGas',
      prevRate: 1.071,
      currRate: 0.899,
      changePct: -16.06,
      effectiveText: 'March 1 through April 1, 2026',
      summary: 'TEST: Columbia Gas West default rate dropped',
    }];
  }

  if (changes.length === 0) {
    log('No changes detected. No alerts sent.');
    process.exit(0);
  }

  // Log changes
  log('Changes found:');
  for (const c of changes) log(' -', c.summary);

  // Update baseline with new rates
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2));
  log('Baseline updated');

  // Send personalized subscriber alerts from DB
  try {
    log('Running personalized subscriber alerts...');
    await sendSubscriberAlerts(getPool(), current);
    log('Subscriber alerts complete');
  } catch (err) {
    log('WARNING: Subscriber alerts failed:', err.message);
  }

  // Scrape PUCO city bills
  try {
    const cityBillCount = await scrapeCityBills();
    log(`City bills scraper: ${cityBillCount} rows upserted`);
  } catch (err) {
    log('WARNING: City bills scraper failed:', err.message);
  }

  // Also notify owner
  try {
    await sendEmail(
      'hello@ohioratewatch.com',
      `[Alert Run] ${changes.length} changes, ${sent}/${subscribers.length} subscribers notified`,
      `<p>Daily check complete.<br><br>Changes: ${changes.map(c => c.summary).join('<br>')}<br><br>Subscribers notified: ${sent}/${subscribers.length}<br>Failed: ${failed}</p>`
    );
  } catch (err) {
    log('Failed to send owner notification:', err.message);
  }
}

main().catch(err => {
  log('FATAL:', err.message);
  process.exit(1);
});
