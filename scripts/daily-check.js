#!/usr/bin/env node
/**
 * Ohio Rate Watch — Daily Rate Check & Alert Script
 *
 * Runs the full scrape pipeline (via lib/cron-handler.js), then sends
 * personalized subscriber alerts and contract expiration reminders.
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
import { sendEmail as sharedSendEmail } from '../lib/shared.js';
import { runDailyCheck } from '../lib/cron-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FORCE_ALERT = process.argv.includes('--force-alert');
const DRY_RUN     = process.argv.includes('--dry-run');

const log = (...args) => console.error(`[${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// DB pool
// ---------------------------------------------------------------------------
let _pool = null;
function getPool() {
  if (!_pool) {
    let DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      const envPath = path.join(ROOT, '.env');
      if (fs.existsSync(envPath)) {
        const envFile = fs.readFileSync(envPath, 'utf8');
        DATABASE_URL = envFile.match(/DATABASE_URL=(.*)/)?.[1]?.trim();
      }
    }
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    const poolOpts = { connectionString: DATABASE_URL };
    // Railway's public TCP proxy requires SSL; internal connections do not
    if (!DATABASE_URL.includes('.railway.internal')) {
      poolOpts.ssl = { rejectUnauthorized: false };
    }
    _pool = new pg.Pool(poolOpts);
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// Email wrapper (respects --dry-run)
// ---------------------------------------------------------------------------
async function sendEmail(to, subject, html, unsubscribeUrl) {
  if (DRY_RUN) {
    log(`[DRY RUN] Would send to ${to}: ${subject}`);
    return;
  }
  const payload = {
    from: 'Ohio Rate Watch <hello@ohioratewatch.com>',
    to: [to],
    subject,
    html,
  };
  if (unsubscribeUrl) {
    payload.headers = {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
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
const CCF_PER_MONTH = 83; // 1000 CCF/year ÷ 12

function buildPersonalAlertEmail(sub, bestOffer, savingsPct, baseline, utilityName, isNewLow) {
  const defaultMonthly = Math.round(baseline * CCF_PER_MONTH);
  const bestMonthly = Math.round(bestOffer.price * CCF_PER_MONTH);
  const saveMonthly = defaultMonthly - bestMonthly;
  const saveYearly = saveMonthly * 12;

  const newLowBadge = isNewLow
    ? `<div style="display:inline-block;background:#fef3c7;color:#92400e;font-size:0.8rem;font-weight:700;padding:4px 10px;border-radius:6px;margin-bottom:12px;">New all-time low</div>`
    : '';

  return `
  <div style="font-family:-apple-system,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#f8f9fa;">
    <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
      <img src="https://ohioratewatch.com/logo.png" alt="Ohio Rate Watch" style="height:40px;margin-bottom:24px;" onerror="this.style.display='none'">
      <h2 style="color:#1565c0;margin-bottom:8px;">You could save ~$${saveMonthly}/month on gas</h2>
      <p style="color:#444;line-height:1.6;">We found a better plan for <strong>${utilityName}</strong> customers.</p>

      <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:10px;padding:20px;margin:20px 0;">
        ${newLowBadge}
        <div style="font-size:0.85rem;color:#666;margin-bottom:4px;">Most people pay (default rate)</div>
        <div style="font-size:1.1rem;color:#374151;margin-bottom:12px;"><strong>~$${defaultMonthly}/month</strong></div>
        <div style="font-size:0.85rem;color:#666;margin-bottom:4px;">Best available plan</div>
        <div style="font-size:1.4rem;font-weight:900;color:#16a34a;margin-bottom:4px;">~$${bestMonthly}/month</div>
        <div style="font-size:0.9rem;color:#374151;"><strong>${bestOffer.supplier_name}</strong> · ${bestOffer.term_months || '?'}-month fixed · ${bestOffer.etf ? '$' + bestOffer.etf + ' cancellation fee' : 'No cancellation fee'}</div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #bbf7d0;font-size:0.9rem;color:#166534;">
          <strong>Save ~$${saveYearly}/year</strong> <span style="color:#6b7280;font-size:0.8rem;">(based on a typical Ohio home)</span>
        </div>
      </div>

      ${bestOffer.sign_up_url ? `<div style="text-align:center;margin:24px 0;"><a href="${bestOffer.sign_up_url}" style="display:inline-block;background:#16a34a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">View This Plan →</a></div>` : ''}

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
  const today = new Date().toISOString().slice(0, 10);

  for (const [tKey, tConfig] of territories) {
    // Find SCO rate for this territory
    const territoryPage = currentRates.find(p => p.territoryId === tConfig.id && p.category === 'NaturalGas');
    const scoRate = territoryPage?.defaultRate || null;

    // Find best fixed rate (no bundle, no intro) from DB for today
    const { rows: offerRows } = await dbPool.query(`
      SELECT supplier_name, price, term_months, etf, sign_up_url
      FROM supplier_offers
      WHERE territory_id = $1 AND category = 'NaturalGas' AND rate_code = '1'
        AND rate_type = 'fixed' AND is_intro = FALSE
        AND is_bundle_required = FALSE
        AND price > 0.1
        AND scraped_date = $2
      ORDER BY price ASC LIMIT 1
    `, [tConfig.id, today]);

    if (offerRows.length === 0) {
      log(`[alerts] No fixed offers found for ${tKey} on ${today}, skipping`);
      continue;
    }
    const bestOffer = offerRows[0];

    // Check if this is an all-time low for this territory
    const { rows: historyRows } = await dbPool.query(`
      SELECT MIN(price) AS all_time_low
      FROM supplier_offers
      WHERE territory_id = $1 AND category = 'NaturalGas' AND rate_code = '1'
        AND rate_type = 'fixed' AND is_intro = FALSE
        AND is_bundle_required = FALSE
        AND price > 0.1
        AND scraped_date < $2
    `, [tConfig.id, today]);
    const allTimeLow = historyRows[0]?.all_time_low || null;
    const isNewLow = allTimeLow !== null && bestOffer.price < allTimeLow;
    if (isNewLow) {
      log(`[alerts] NEW ALL-TIME LOW for ${tKey}: $${bestOffer.price} (prev low: $${allTimeLow})`);
    }

    // Get confirmed subscribers for this territory only
    const { rows: subs } = await dbPool.query(
      'SELECT * FROM subscribers WHERE confirmed = TRUE AND territory = $1',
      [tKey]
    );

    log(`[alerts] ${tKey}: SCO=${scoRate}, best=$${bestOffer.price}, ${subs.length} subscribers${isNewLow ? ' [NEW LOW]' : ''}`);

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    for (const sub of subs) {
      const baseline = scoRate;
      if (!baseline || baseline <= 0) continue;

      const savingsPct = Math.round((1 - bestOffer.price / baseline) * 100);
      if (savingsPct < (sub.min_savings_pct || 15)) continue;

      // Throttle: skip if alerted recently and rate hasn't changed much
      // Exception: new all-time lows bypass the rate-change gate (still respect cooldown)
      if (sub.last_alerted_at) {
        const lastAlerted = new Date(sub.last_alerted_at);
        if (lastAlerted > threeDaysAgo) continue;
        if (!isNewLow && sub.last_alerted_rate) {
          const rateDiff = Math.abs(bestOffer.price - sub.last_alerted_rate) / sub.last_alerted_rate;
          if (rateDiff <= 0.03) continue;
        }
      }

      const saveMonthly = Math.round((baseline - bestOffer.price) * CCF_PER_MONTH);

      try {
        const subject = isNewLow
          ? `New all-time low gas rate — save ~$${saveMonthly}/month — Ohio Rate Watch`
          : `You could save ~$${saveMonthly}/month on gas — Ohio Rate Watch`;
        const html = buildPersonalAlertEmail(sub, bestOffer, savingsPct, baseline, tConfig.name, isNewLow);
        const unsubUrl = `https://ohioratewatch.com/unsubscribe?token=${sub.unsubscribe_token}`;
        await sendEmail(sub.email, subject, html, unsubUrl);

        await dbPool.query(
          'UPDATE subscribers SET last_alerted_at = NOW(), last_alerted_rate = $1 WHERE id = $2',
          [bestOffer.price, sub.id]
        );
        log(`[alerts] Sent alert to ${sub.email} (${tKey}, save ~$${saveMonthly}/mo${isNewLow ? ', NEW LOW' : ''})`);
        await new Promise(r => setTimeout(r, 500)); // rate limit
      } catch (err) {
        log(`[alerts] Failed to send to ${sub.email}: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Contract expiration reminders — 30 days before contract_expires
// ---------------------------------------------------------------------------
async function sendContractReminders(dbPool) {
  const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // Find subscribers whose contract expires in exactly 30 days (±1 day buffer)
  const { rows: expiring } = await dbPool.query(`
    SELECT *
    FROM subscribers
    WHERE confirmed = TRUE
      AND contract_expires IS NOT NULL
      AND contract_expires BETWEEN $1::date AND ($1::date + INTERVAL '1 day')
  `, [thirtyDaysFromNow]);

  if (expiring.length === 0) {
    log('[contract-reminders] No contracts expiring in 30 days');
    return;
  }

  log(`[contract-reminders] ${expiring.length} subscriber(s) with contracts expiring around ${thirtyDaysFromNow}`);

  for (const sub of expiring) {
    const utilityName = TERRITORY_CONFIG[sub.territory]?.name || 'your utility';
    const expiresDate = new Date(sub.contract_expires).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Find current best offer for their territory
    let bestLine = '';
    const { rows: offers } = await dbPool.query(`
      SELECT supplier_name, price, term_months
      FROM supplier_offers
      WHERE territory_id = $1 AND category = 'NaturalGas' AND rate_code = '1'
        AND rate_type = 'fixed' AND is_intro = FALSE
        AND is_bundle_required = FALSE AND price > 0.1
        AND scraped_date = $2
      ORDER BY price ASC LIMIT 1
    `, [sub.territory_id, today]);

    if (offers.length > 0) {
      const o = offers[0];
      const monthly = Math.round(o.price * CCF_PER_MONTH);
      bestLine = `<p style="color:#444;line-height:1.6;">Right now, the best plan we see is <strong>${o.supplier_name}</strong> at <strong>~$${monthly}/month</strong> (${o.term_months}-month fixed).</p>`;
    }

    const unsubUrl = `https://ohioratewatch.com/unsubscribe?token=${sub.unsubscribe_token}`;
    const emailHtml = `
    <div style="font-family:-apple-system,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#f8f9fa;">
      <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <img src="https://ohioratewatch.com/logo.png" alt="Ohio Rate Watch" style="height:40px;margin-bottom:24px;" onerror="this.style.display='none'">
        <h2 style="color:#1565c0;margin-bottom:8px;">Your gas plan expires ${expiresDate}</h2>
        <p style="color:#444;line-height:1.6;">Your current plan with <strong>${utilityName}</strong> ends in about 30 days. If you don't switch, you'll be moved to the default rate — which is usually more expensive.</p>
        ${bestLine}
        <div style="text-align:center;margin:24px 0;">
          <a href="https://ohioratewatch.com" style="display:inline-block;background:#1565c0;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">Compare Plans Now →</a>
        </div>
        <p style="color:#888;font-size:0.8rem;margin-top:24px;line-height:1.5;">
          We sent this because you told us your contract expires on ${expiresDate}.
        </p>
        <p style="color:#999;font-size:0.78rem;margin-top:20px;border-top:1px solid #eee;padding-top:16px;">
          Ohio Rate Watch · A project of EJ Systems LLC · Cleveland, Ohio<br>
          <a href="tel:8334317283" style="color:#1565c0;">833.431.RATE</a> ·
          <a href="https://ohioratewatch.com" style="color:#1565c0;">ohioratewatch.com</a> ·
          <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
        </p>
      </div>
    </div>`;

    try {
      await sendEmail(sub.email, `Your gas plan expires ${expiresDate} — time to compare`, emailHtml, unsubUrl);
      log(`[contract-reminders] Sent reminder to ${sub.email} (expires ${sub.contract_expires})`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      log(`[contract-reminders] Failed to send to ${sub.email}: ${err.message}`);
    }
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log('Ohio Rate Watch daily check starting...');

  if (!RESEND_API_KEY && !DRY_RUN) {
    log('ERROR: RESEND_API_KEY env var required');
    process.exit(1);
  }

  const pool = getPool();
  const dataDir = path.join(ROOT, 'data');

  // Verify DB connection before running the full pipeline
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    log('DB connection OK:', rows[0]);
  } catch (err) {
    log('DB connection FAILED:', err.message, '| code:', err.code);
    log('DATABASE_URL host:', process.env.DATABASE_URL?.replace(/\/\/.*@/, '//<redacted>@'));
    log('Pool SSL config:', JSON.stringify(pool.options?.ssl || 'none'));
    process.exit(1);
  }

  // Run the core scrape + store pipeline (shared with server.js cron endpoint)
  const result = await runDailyCheck(pool, { sendEmailFn: sharedSendEmail, dataDir });

  log(`Pipeline complete: ${result.pagesScraped} pages, ${result.offersStored} offers, ${result.cityBillCount} city bills, ${result.trendCount} trends`);
  if (result.errors.length > 0) {
    log('Pipeline errors:', result.errors.join('; '));
  }

  // Send personalized subscriber alerts from DB
  try {
    log('Running personalized subscriber alerts...');
    await sendSubscriberAlerts(pool, result.currentRates);
    log('Subscriber alerts complete');
  } catch (err) {
    log('WARNING: Subscriber alerts failed:', err.message);
  }

  // Send contract expiration reminders (runs daily regardless of rate changes)
  try {
    await sendContractReminders(pool);
  } catch (err) {
    log('WARNING: Contract reminders failed:', err.message);
  }

  await pool.end();
}

main().catch(err => {
  log('FATAL:', err.message);
  process.exit(1);
});
