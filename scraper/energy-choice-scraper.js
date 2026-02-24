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

  // --- Parse default/SCO rate from narrative text ---
  // Format: "CGO's SCO rate is $1.071 per ccf - Effective January 30, 2026 through March 1, 2026"
  const scoMatch = html.match(
    /\$([\d.]+)\s*per\s*ccf[^<]*Effective\s*([^<.]+)/i
  );
  if (scoMatch) {
    result.defaultRate = parseFloat(scoMatch[1]);
    result.defaultRateText = scoMatch[2].trim().replace(/&nbsp;/g, ' ');
  }

  // Also look for kWh pricing (electric)
  const kwhMatch = html.match(/\$([\d.]+)\s*per\s*kWh[^<]*Effective\s*([^<.]+)/i);
  if (kwhMatch) {
    result.defaultRate = parseFloat(kwhMatch[1]);
    result.defaultRateText = kwhMatch[2].trim();
  }

  // --- Parse supplier rate table ---
  // Suppliers are in <span class='retail-title'>NAME<p>...</p></span>
  // with price data in adjacent <td> cells
  const supplierPattern = /<span class='retail-title'>([\s\S]*?)<\/span>/g;
  const pricePattern = /showTextInDialog\("Offer Details","([^"]+)"\)/g;

  // Extract all retail-title spans
  const supplierNames = [];
  let sm;
  while ((sm = supplierPattern.exec(html)) !== null) {
    // Strip HTML tags to get company name
    const name = sm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split('\n')[0].trim();
    supplierNames.push(name);
  }

  // Extract all offer detail texts (price info)
  const offerDetails = [];
  let pm;
  while ((pm = pricePattern.exec(html)) !== null) {
    offerDetails.push(pm[1].replace(/<br\/>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }

  // Pair them up (order matches in the HTML)
  for (let i = 0; i < supplierNames.length; i++) {
    const detail = offerDetails[i] || '';

    // Try to extract the price from the offer detail text
    const priceMatch = detail.match(/([\d.]+)\s*(?:\/Ccf|\/ccf|\/kWh|per ccf|per kWh)/i);
    const price = priceMatch ? parseFloat(priceMatch[1]) : null;

    // Extract rate type from the text
    const rateType = /fixed/i.test(detail)
      ? 'fixed'
      : /variable/i.test(detail)
      ? 'variable'
      : 'unknown';

    // Extract term length
    const termMatch = detail.match(/(\d+)\s*(?:month|mo)/i);
    const termMonths = termMatch ? parseInt(termMatch[1], 10) : null;

    result.suppliers.push({
      name: supplierNames[i],
      price,
      rateType,
      termMonths,
      offerDetail: detail.substring(0, 200),
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

// CLI entry point
const results = await scrapeAllRates();
process.stdout.write(JSON.stringify(results, null, 2) + '\n');

export { scrapeAllRates, fetchRatePage, detectChanges };
