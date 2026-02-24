/**
 * EIA API Scraper — Ohio Rate Watch
 * 
 * Fetches Ohio retail electricity rates from the EIA API.
 * Free API — just needs an API key from api.eia.gov.
 * Returns monthly average rates by utility sector.
 * 
 * Usage: node eia-scraper.js
 * Env:   EIA_API_KEY=your_key_here
 */

const EIA_BASE = 'https://api.eia.gov/v2';
const OHIO_STATE_CODE = 'OH';

/**
 * Fetch Ohio retail electricity rates (monthly, by sector).
 * Data lags ~2 months — useful for historical context + trend alerts.
 */
async function fetchOhioElectricRates() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('EIA_API_KEY env var required. Get one free at api.eia.gov');

  const url = new URL(`${EIA_BASE}/electricity/retail-sales/data/`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('frequency', 'monthly');
  url.searchParams.set('data[0]', 'price');           // retail price in cents/kWh
  url.searchParams.set('data[1]', 'revenue');          // total revenue
  url.searchParams.set('data[2]', 'sales');            // total sales in MWh
  url.searchParams.set('facets[stateid][]', OHIO_STATE_CODE);
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', '24');                // last 24 months

  console.log('[EIA] Fetching Ohio electricity rates...');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`EIA API error: ${res.status}`);

  const json = await res.json();
  const data = json.response?.data ?? [];

  // Group by sector (residential, commercial, industrial)
  const bySector = {};
  for (const row of data) {
    const sector = row.sectorName || row.sectorid || 'all';
    if (!bySector[sector]) bySector[sector] = [];
    bySector[sector].push({
      period: row.period,           // YYYY-MM
      priceCentsPerKwh: row.price,  // cents/kWh
      revenue: row.revenue,         // thousand dollars
      salesMwh: row.sales,          // megawatthours
    });
  }

  console.log(`[EIA] Retrieved ${data.length} rate records across ${Object.keys(bySector).length} sectors`);
  return bySector;
}

/**
 * Detect significant rate changes vs prior month.
 * Returns array of alerts for changes above threshold.
 */
function detectRateChanges(bySector, thresholdPct = 3.0) {
  const alerts = [];

  for (const [sector, records] of Object.entries(bySector)) {
    if (records.length < 2) continue;

    // Records are newest-first
    const current = records[0];
    const prior = records[1];

    if (!current.priceCentsPerKwh || !prior.priceCentsPerKwh) continue;

    const changePct =
      ((current.priceCentsPerKwh - prior.priceCentsPerKwh) / prior.priceCentsPerKwh) * 100;

    if (Math.abs(changePct) >= thresholdPct) {
      alerts.push({
        source: 'EIA',
        sector,
        period: current.period,
        priorPeriod: prior.period,
        currentRate: current.priceCentsPerKwh,
        priorRate: prior.priceCentsPerKwh,
        changePct: changePct.toFixed(2),
        direction: changePct > 0 ? 'increase' : 'decrease',
        summary: `Ohio ${sector} electricity rates ${changePct > 0 ? 'up' : 'down'} ${Math.abs(changePct).toFixed(1)}% ` +
                 `(${prior.priceCentsPerKwh}¢ → ${current.priceCentsPerKwh}¢/kWh, ${prior.period} → ${current.period})`,
      });
    }
  }

  return alerts;
}

// CLI entry point
(async () => {
  const rates = await fetchOhioElectricRates();
  const alerts = detectRateChanges(rates);

  console.log('\n--- Rate Change Alerts ---');
  if (alerts.length === 0) {
    console.log('No significant changes detected (threshold: 3%)');
  } else {
    for (const alert of alerts) {
      console.log(`⚡ ${alert.summary}`);
    }
  }
})();

export { fetchOhioElectricRates, detectRateChanges };
