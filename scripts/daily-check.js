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

// Bypass energychoice.ohio.gov cert not in Node.js built-in CA store
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
// Load subscribers from CSV
// ---------------------------------------------------------------------------
function loadSubscribers() {
  if (!fs.existsSync(SIGNUPS_FILE)) {
    log('No signups file found at', SIGNUPS_FILE);
    return [];
  }
  const lines = fs.readFileSync(SIGNUPS_FILE, 'utf8').trim().split('\n');
  // Skip header row
  return lines.slice(1)
    .filter(Boolean)
    .map(line => {
      const [timestamp, email, zip] = line.split(',');
      return { timestamp: timestamp?.trim(), email: email?.trim(), zip: zip?.trim() };
    })
    .filter(s => s.email && s.email.includes('@'));
}

// ---------------------------------------------------------------------------
// Deduplicate subscribers (keep latest signup per email)
// ---------------------------------------------------------------------------
function dedupeSubscribers(subscribers) {
  const seen = new Map();
  for (const s of subscribers) {
    seen.set(s.email, s); // later entries overwrite earlier
  }
  return [...seen.values()];
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
async function main() {
  log('Ohio Rate Watch daily check starting...');

  if (!RESEND_API_KEY && !DRY_RUN) {
    log('ERROR: RESEND_API_KEY env var required');
    process.exit(1);
  }

  // Ensure data directory exists
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

  // Run the scraper
  log('Running energy choice scraper...');
  const { scrapeAllRates, detectChanges } = await import('../scraper/energy-choice-scraper.js');
  const current = await scrapeAllRates();

  // Save latest snapshot
  fs.writeFileSync(LATEST_FILE, JSON.stringify(current, null, 2));
  log(`Saved ${current.length} rate pages to rates-latest.json`);

  // Store to historical SQLite database
  try {
    const rowCount = insertSnapshot(current);
    log(`Stored ${rowCount} supplier rows in history database`);
  } catch (err) {
    log("WARNING: Failed to store history:", err.message);
  }

  // Store to supplier_offers table (one row per offer per day)
  try {
    const today = new Date().toISOString().slice(0, 10);
    const offerCount = insertSupplierOffers(today, current);
    log(`Stored ${offerCount} offers in supplier_offers table for ${today}`);
  } catch (err) {
    log("WARNING: Failed to store supplier offers:", err.message);
  }

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

  // Load and dedupe subscribers
  const subscribers = dedupeSubscribers(loadSubscribers());
  log(`Sending alerts to ${subscribers.length} subscribers...`);

  if (subscribers.length === 0) {
    log('No subscribers to notify.');
    process.exit(0);
  }

  // Send alerts
  let sent = 0, failed = 0;
  for (const sub of subscribers) {
    try {
      const subject = `⚡ Rate Alert: ${changes.length} change${changes.length > 1 ? 's' : ''} detected — Ohio Rate Watch`;
      const html = buildAlertEmail(changes, sub);
      await sendEmail(sub.email, subject, html);
      sent++;
      // Polite rate limit: 2 emails/second
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      log(`Failed to send to ${sub.email}: ${err.message}`);
      failed++;
    }
  }

  log(`Alert run complete: ${sent} sent, ${failed} failed`);

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
