/**
 * Energy Choice Ohio Scraper — Ohio Rate Watch
 * 
 * Scrapes energychoice.ohio.gov for current retail supplier rates.
 * Plain curl/fetch works — no Playwright needed, data is in HTML.
 * 
 * Covers all Ohio utility territories and rate codes for:
 *   - Natural Gas (4 territories × 2 rate codes)
 *   - Electric (territories TBD)
 * 
 * Usage: node energy-choice-scraper.js
 * Output: JSON array of current rate snapshots
 */

const BASE_URL = 'https://www.energychoice.ohio.gov';

// All known Natural Gas territories from the category page
const GAS_TERRITORIES = [
  { id: 1, name: 'Columbia Gas of Ohio (East)' },
  { id: 8, name: 'Columbia Gas of Ohio (West)' },
  { id: 10, name: 'Duke Energy Ohio' },
  { id: 11, name: 'Dominion/Enbridge Gas Ohio' },
];

const ELECTRIC_TERRITORIES = [
  // Will be populated after scraping the electric category page
];

const RATE_CODES = [1, 2]; // Residential (1) and Small Commercial (2)

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Fetch a single Energy Choice comparison page and parse it.
 */
async function fetchRatePage(category, territoryId, rateCode) {
  const url = `${BASE_URL}/ApplesToApplesComparision.aspx?Category=${category}&TerritoryId=${territoryId}&RateCode=${rateCode}`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();

  const result = {
    source: 'EnergyChoiceOhio',
    url,
    category,
    territoryId,
    rateCode,
    scrapedAt: new Date().toISOString(),
    defaultRate: null,      // SCO/standard offer rate
    defaultRateText: null,  // Raw effective date text
    suppliers: [],
  };

  // Decode HTML entities
  const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

  // --- Parse default/SCO rate from narrative text ---
  // The SCO rate is split across multiple nested HTML tags (strong/span styling) — strip tags first
  // Extract the relevant section around "SCO rate is" or "Standard Offer"
  const scoSection = (() => {
    const idx = html.indexOf('SCO rate is');
    if (idx === -1) return '';
    return html.substring(idx, idx + 800)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ');
  })();

  const scoMatch = scoSection.match(/\$([\d.]+)\s*per\s*ccf\s*-\s*Effective\s*([^.]+)/i);
  if (scoMatch) {
    result.defaultRate = parseFloat(scoMatch[1]);
    result.defaultRateText = decode(scoMatch[2]);
  }

  // Also look for kWh pricing (electric)
  const kwhSection = (() => {
    const idx = html.indexOf('standard offer');
    if (idx === -1) return '';
    return html.substring(idx, idx + 800).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  })();
  const kwhMatch = kwhSection.match(/\$([\d.]+)\s*per\s*kWh\s*-?\s*Effective\s*([^.]+)/i);
  if (kwhMatch) {
    result.defaultRate = parseFloat(kwhMatch[1]);
    result.defaultRateText = decode(kwhMatch[2]);
  }

  // --- Parse supplier rate table ---
  // Structure: <td><span class='retail-title'>NAME...</span>...offer details...</td><td>PRICE</td><td>RateType</td>...
  // Rows are separated by <span class='retail-title'>
  const rowPattern = /<span class='retail-title'>([\s\S]*?)<\/span>[\s\S]*?<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;

  let rm;
  while ((rm = rowPattern.exec(html)) !== null) {
    // Company name is the first text node before the first <p>
    const rawName = rm[1].replace(/<p[\s\S]*$/, '').replace(/<[^>]+>/g, '').trim();
    const price = parseFloat(rm[2]);
    const rateTypeHtml = rm[3];

    // Rate type from the next <td>
    const rateType = /fixed/i.test(rateTypeHtml) ? 'fixed'
      : /variable/i.test(rateTypeHtml) ? 'variable'
      : 'unknown';

    // Extract term length from the row (look ahead a bit)
    const rowContext = html.substring(rm.index, rm.index + 800);
    const termMatch = rowContext.match(/(\d+)\s*(?:mo\.|months?)/i);
    const termMonths = termMatch ? parseInt(termMatch[1], 10) : null;

    result.suppliers.push({
      name: rawName,
      price: isNaN(price) ? null : price,
      rateType,
      termMonths,
    });
  }

  return result;
}

/**
 * Discover electric territory IDs from the category page.
 */
async function discoverElectricTerritories() {
  const url = `${BASE_URL}/ApplesToApplesCategory.aspx?Category=Electric`;
  const res = await fetch(url, { headers: HEADERS });
  const html = await res.text();

  const ids = new Set();
  const matches = html.matchAll(/TerritoryId=(\d+)/g);
  for (const m of matches) ids.add(parseInt(m[1], 10));

  return [...ids].map((id) => ({ id, name: `Electric Territory ${id}` }));
}

/**
 * Scrape all Ohio territory/rate combinations.
 */
async function scrapeAllRates() {
  console.error('[EnergyChoice] Starting full Ohio rate scrape...');

  const allResults = [];

  // Discover electric territories dynamically
  const electricTerritories = await discoverElectricTerritories();
  console.error(`[EnergyChoice] Found ${electricTerritories.length} electric territories`);

  const jobs = [
    ...GAS_TERRITORIES.flatMap((t) =>
      RATE_CODES.map((rc) => ({ category: 'NaturalGas', ...t, rateCode: rc }))
    ),
    ...electricTerritories.flatMap((t) =>
      RATE_CODES.map((rc) => ({ category: 'Electric', ...t, rateCode: rc }))
    ),
  ];

  for (const job of jobs) {
    try {
      console.error(`[EnergyChoice] Fetching ${job.category} territory=${job.id} rateCode=${job.rateCode}...`);
      const result = await fetchRatePage(job.category, job.id, job.rateCode);
      result.territoryName = job.name;
      allResults.push(result);

      // Polite delay between requests
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));
    } catch (err) {
      console.error(`[EnergyChoice] Error for territory ${job.id}: ${err.message}`);
    }
  }

  console.error(`[EnergyChoice] Done — ${allResults.length} rate pages scraped`);
  return allResults;
}

/**
 * Detect rate changes by comparing new snapshot with stored baseline.
 * Pass in previous results (loaded from disk) and new results.
 */
function detectChanges(previous, current) {
  const changes = [];

  for (const curr of current) {
    const key = `${curr.category}:${curr.territoryId}:${curr.rateCode}`;
    const prev = previous.find(
      (p) => p.category === curr.category && p.territoryId === curr.territoryId && p.rateCode === curr.rateCode
    );

    if (!prev) continue;

    // Check default rate change
    if (prev.defaultRate !== null && curr.defaultRate !== null && prev.defaultRate !== curr.defaultRate) {
      const changePct = ((curr.defaultRate - prev.defaultRate) / prev.defaultRate * 100).toFixed(2);
      changes.push({
        type: 'default_rate',
        key,
        territory: curr.territoryName || `Territory ${curr.territoryId}`,
        category: curr.category,
        prevRate: prev.defaultRate,
        currRate: curr.defaultRate,
        changePct,
        effectiveText: curr.defaultRateText,
        summary: `${curr.territoryName || curr.category} default rate changed: $${prev.defaultRate} → $${curr.defaultRate}/unit (${changePct > 0 ? '+' : ''}${changePct}%)`,
      });
    }

    // Check supplier rate changes
    for (const currSupplier of curr.suppliers) {
      const prevSupplier = prev.suppliers?.find((s) => s.name === currSupplier.name);
      if (!prevSupplier || prevSupplier.price === null || currSupplier.price === null) continue;

      if (prevSupplier.price !== currSupplier.price) {
        const changePct = ((currSupplier.price - prevSupplier.price) / prevSupplier.price * 100).toFixed(2);
        changes.push({
          type: 'supplier_rate',
          key,
          territory: curr.territoryName || `Territory ${curr.territoryId}`,
          category: curr.category,
          supplier: currSupplier.name,
          prevRate: prevSupplier.price,
          currRate: currSupplier.price,
          changePct,
          summary: `${currSupplier.name} (${curr.territoryName}): $${prevSupplier.price} → $${currSupplier.price}/unit (${changePct > 0 ? '+' : ''}${changePct}%)`,
        });
      }
    }
  }

  return changes;
}

// CLI entry point (only runs when executed directly, not when imported)
// Node.js v25 has strict TLS by default — energychoice.ohio.gov uses an intermediate cert
// that the built-in CA store doesn't include. Use --use-system-ca or set NODE_TLS_REJECT_UNAUTHORIZED=0 for dev.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.includes('energy-choice-scraper')) {
  const results = await scrapeAllRates();
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}

export { scrapeAllRates, fetchRatePage, detectChanges };
