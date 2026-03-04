/**
 * Ohio Rate Watch — Daily cron handler
 * Extracted from server.js POST /api/cron/daily-check
 *
 * Usage:
 *   import { runDailyCheck } from './lib/cron-handler.js';
 *   const result = await runDailyCheck(pool, { sendEmailFn, dataDir });
 */

import fs from 'fs';
import path from 'path';
import { sendEmail as defaultSendEmail } from './shared.js';

// ---- Simple CSV parser for PUCO Tableau data ----
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

/**
 * Run the full daily scrape + store pipeline.
 *
 * @param {import('pg').Pool} pool  — Postgres connection pool
 * @param {Object}            opts
 * @param {Function}         [opts.sendEmailFn]  — email sender (defaults to shared.sendEmail)
 * @param {string}            opts.dataDir        — path to data/ directory
 * @returns {{ pagesScraped, offersStored, cityBillCount, trendCount, errors, significantChanges, currentRates }}
 */
export async function runDailyCheck(pool, { sendEmailFn, dataDir }) {
  const sendMail = sendEmailFn || defaultSendEmail;
  const startTime = Date.now();
  const errors = [];
  let pagesScraped = 0, snapshotRows = 0, offersStored = 0;
  let cityBillCount = 0, trendCount = 0;
  let significantChanges = 0, totalChanges = 0;
  let dbSnapshots = '?', dbOffers = '?', dbHistory = '?';
  let currentRates = [];

  try {
    console.log('[cron] Daily check running');
    const { scrapeAllRates, detectChanges } = await import('../scraper/energy-choice-scraper.js');
    const { insertSnapshot, insertSupplierOffers, setPool } = await import('../lib/history-store.js');
    setPool(pool); // ensure history-store uses the same pool (with SSL if needed)

    const current = await scrapeAllRates();
    currentRates = current;
    pagesScraped = current.length;
    console.log(`[cron] Scraped ${current.length} rate pages`);

    // Check for missing SCO rates on gas territories
    const GAS_TERRITORY_IDS = [1, 8, 10, 11];
    const missingSCO = current
      .filter(p => p.category === 'NaturalGas' && p.rateCode === 1 && GAS_TERRITORY_IDS.includes(p.territoryId) && p.defaultRate == null)
      .map(p => p.territoryName || `Territory ${p.territoryId}`);
    if (missingSCO.length > 0) {
      const msg = `SCO rate extraction failed for: ${missingSCO.join(', ')}`;
      console.error(`[cron] WARNING: ${msg}`);
      errors.push(msg);
    }

    // Save latest to file
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'rates-latest.json'), JSON.stringify(current, null, 2));

    // Store snapshots to PostgreSQL
    try {
      snapshotRows = await insertSnapshot(current);
      console.log(`[cron] Stored ${snapshotRows} snapshot rows`);
    } catch (err) {
      console.error('[cron] WARNING: Failed to store snapshots:', err.message);
      errors.push(`Snapshot insert: ${err.message}`);
    }

    // Store supplier offers
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

    // Baseline comparison + owner email alerts
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
          await sendMail(
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
    const baselineFile2 = path.join(dataDir, 'rates-baseline.json');
    fs.writeFileSync(baselineFile2, JSON.stringify(current, null, 2));

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

  return { pagesScraped, offersStored, cityBillCount, trendCount, errors, significantChanges, currentRates };
}
