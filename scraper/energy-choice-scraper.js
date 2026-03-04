/**
 * Energy Choice Ohio Scraper — Ohio Rate Watch
 * 
 * Fetches supplier data via PUCO's hidden XML export (ASP.NET PostBack).
 * Much more reliable than HTML table parsing.
 * 
 * Covers all Ohio utility territories and rate codes for:
 *   - Natural Gas (4 territories × 2 rate codes)
 *   - Electric (territories discovered dynamically)
 * 
 * Usage: node energy-choice-scraper.js
 * Output: JSON array of current rate snapshots
 */

import { XMLParser } from 'fast-xml-parser';
import { Agent } from 'undici';

const BASE_URL = 'https://www.energychoice.ohio.gov';

// Scoped TLS bypass: energychoice.ohio.gov uses a cert not in Node's built-in CA store.
// Use a custom agent only for requests to that host instead of disabling TLS globally.
const pucoAgent = new Agent({ connect: { rejectUnauthorized: false } });

// Ohio natural gas utility territories served by PUCO Energy Choice.
// Three use the Standard Choice Offer (SCO) system:
//   - Columbia Gas of Ohio (id 8)
//   - Enbridge Gas Ohio (id 1)
//   - CenterPoint Energy Ohio (id 11)
// Duke Energy Ohio (id 10) uses Gas Cost Recovery (GCR) pricing,
// but is transitioning to SCO in April 2026.
// Note: Enbridge reports rates in $/MCF; others use $/CCF (1 MCF = 10 CCF).
const GAS_TERRITORIES = [
  { id: 1, name: 'Enbridge Gas Ohio' },
  { id: 8, name: 'Columbia Gas of Ohio' },
  { id: 10, name: 'Duke Energy Ohio' },
  { id: 11, name: 'CenterPoint Energy Ohio' },
];

const RATE_CODES = [1, 2];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/**
 * Parse a dollar string like "$150.00" or "$0.00" into a number.
 */
function parseDollar(s) {
  if (s == null) return null;
  const str = String(s).replace(/[$,]/g, '').trim();
  if (/no/i.test(str)) return 0;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

/**
 * Fetch a single Energy Choice comparison page via XML export.
 */
async function fetchRatePage(category, territoryId, rateCode) {
  const pageUrl = `${BASE_URL}/ApplesToApplesComparision.aspx?Category=${category}&TerritoryId=${territoryId}&RateCode=${rateCode}`;

  // Step 1: GET the page to obtain ASP.NET state tokens + cookies
  const r1 = await fetch(pageUrl, { headers: HEADERS, dispatcher: pucoAgent });
  if (!r1.ok) throw new Error(`HTTP ${r1.status} for ${pageUrl}`);
  const cookie = r1.headers.get('set-cookie') || '';
  const html = await r1.text();

  const vs = html.match(/id="__VIEWSTATE" value="([^"]+)"/)?.[1] || '';
  const evv = html.match(/id="__EVENTVALIDATION" value="([^"]+)"/)?.[1] || '';
  const vsg = html.match(/id="__VIEWSTATEGENERATOR" value="([^"]+)"/)?.[1] || '';

  // Parse SCO/GCR/default rate from HTML (best-effort — not always present)
  // Strips HTML first to avoid tag artifacts splitting words (e.g. "rate i s")
  let defaultRate = null;
  let defaultRateText = null;

  const cleanHtml = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

  // Match default rate from PUCO page text. Handles two pricing systems:
  //   - SCO (Standard Choice Offer): Columbia, Enbridge, CenterPoint
  //   - GCR (Gas Cost Recovery): Duke Energy (transitioning to SCO April 2026)
  // Tolerates extra spaces from HTML tag stripping (e.g. "i s" from "<b>i</b>s").
  // Matches both CCF and MCF units (Enbridge reports in MCF; 1 MCF = 10 CCF).
  const ratePattern = /(?:SCO|GCR)\s+rate\s+i\s*s\s+\$([\d.]+)\s*per\s*(?:ccf|mcf)\s*-\s*Effective\s*([^.]+)/gi;
  let rateMatch;
  while ((rateMatch = ratePattern.exec(cleanHtml)) !== null) {
    const rate = parseFloat(rateMatch[1]);
    // Skip the eligibility blurb on Enbridge (Territory 1) — look for
    // the match that contains an actual effective date, not descriptive text.
    // A valid rate will be < $50/ccf (the eligibility paragraph has no rate).
    if (rate > 0 && rate < 50) {
      defaultRate = rate;
      defaultRateText = rateMatch[2].trim();
      break;
    }
  }

  // Electric PTC fallback (uses pre-cleaned HTML)
  if (defaultRate === null) {
    const stdIdx = cleanHtml.toLowerCase().indexOf('standard offer');
    if (stdIdx !== -1) {
      const kwhSection = cleanHtml.substring(stdIdx, stdIdx + 800);
      const kwhMatch = kwhSection.match(/\$([\d.]+)\s*per\s*kWh\s*-?\s*Effective\s*([^.]+)/i);
      if (kwhMatch) {
        defaultRate = parseFloat(kwhMatch[1]);
        defaultRateText = kwhMatch[2].trim();
      }
    }
  }

  // Step 2: POST to trigger XML export
  const body = new URLSearchParams({
    '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$lnkExportToExcel',
    '__EVENTARGUMENT': '',
    '__VIEWSTATE': vs,
    '__VIEWSTATEGENERATOR': vsg,
    '__EVENTVALIDATION': evv,
  });

  const r2 = await fetch(pageUrl, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie,
      'Referer': pageUrl,
    },
    body: body.toString(),
    dispatcher: pucoAgent,
  });

  if (!r2.ok) throw new Error(`XML export HTTP ${r2.status} for ${pageUrl}`);
  const xml = await r2.text();

  // Step 3: Parse XML
  let offers;
  try {
    const parsed = xmlParser.parse(xml);
    if (!parsed.Offers?.Offer) {
      return {
        source: 'EnergyChoiceOhio',
        url: pageUrl,
        category,
        territoryId,
        rateCode,
        scrapedAt: new Date().toISOString(),
        defaultRate,
        defaultRateText,
        suppliers: [],
      };
    }
    offers = Array.isArray(parsed.Offers.Offer) ? parsed.Offers.Offer : [parsed.Offers.Offer];
  } catch (err) {
    console.error(`[EnergyChoice] XML parse error for ${category} territory=${territoryId} rc=${rateCode}: ${err.message}`);
    return {
      source: 'EnergyChoiceOhio',
      url: pageUrl,
      category,
      territoryId,
      rateCode,
      scrapedAt: new Date().toISOString(),
      defaultRate,
      defaultRateText,
      suppliers: [],
      error: `XML parse failed: ${err.message}`,
    };
  }

  // Step 4: Map offers to supplier objects
  const suppliers = offers.map(offer => {
    const info = offer.SupplierInfo || {};
    const links = offer.SupplierLinks || {};
    const intro = offer.IntroductoryOffer || {};
    const promo = offer.PromotionalOffer || {};

    const price = parseFloat(offer.Price);
    const rateTypeRaw = String(offer.RateType || '');
    const rateType = /fixed/i.test(rateTypeRaw) ? 'fixed'
      : /variable/i.test(rateTypeRaw) ? 'variable'
      : 'unknown';

    const termMonths = parseInt(offer.TermLength, 10) || null;

    return {
      name: info['@_SupplierCompanyName'] || 'Unknown',
      companyName: info['@_CompanyName'] || null,
      price: isNaN(price) ? null : price,
      rateType,
      termMonths,
      renewablePct: 0, // Not in XML export; default 0
      introPrice: /yes/i.test(intro['@_IsIntroductoryOffer'] || ''),
      earlyTerminationFee: parseDollar(offer.EarlyTerminationFee),
      monthlyFee: parseDollar(offer.MonthlyFee),
      hasPromo: /yes/i.test(promo['@_IsPromotionalOffer'] || ''),
      offerDetails: offer.OfferDetails || null,
      promoDetails: promo['@_Details'] || null,
      introDetails: intro['@_Details'] || null,
      // New fields from XML
      phone: info['@_SupplierPhone'] || null,
      website: info['@_SupplierWebSiteUrl'] || null,
      signUpUrl: links['@_SignUpNowURL'] || null,
      termsUrl: links['@_TermsOfServiceURL'] || null,
      offerId: offer['@_ID'] || null,
    };
  });

  return {
    source: 'EnergyChoiceOhio',
    url: pageUrl,
    category,
    territoryId,
    rateCode,
    scrapedAt: new Date().toISOString(),
    defaultRate,
    defaultRateText,
    suppliers,
  };
}

/**
 * Discover electric territory IDs from the category page.
 */
async function discoverElectricTerritories() {
  const url = `${BASE_URL}/ApplesToApplesCategory.aspx?Category=Electric`;
  const res = await fetch(url, { headers: HEADERS, dispatcher: pucoAgent });
  const html = await res.text();

  const ids = new Set();
  const matches = html.matchAll(/TerritoryId=(\d+)/g);
  for (const m of matches) ids.add(parseInt(m[1], 10));

  return [...ids].map((id) => ({ id, name: `Electric Territory ${id}` }));
}

/**
 * Scrape all Ohio territory/rate combinations.
 */
async function scrapeAllRates({ includeElectric = false } = {}) {
  console.error('[EnergyChoice] Starting full Ohio rate scrape (XML export)...');

  const allResults = [];

  const jobs = [
    ...GAS_TERRITORIES.flatMap((t) =>
      RATE_CODES.map((rc) => ({ category: 'NaturalGas', ...t, rateCode: rc }))
    ),
  ];

  if (includeElectric || process.env.SCRAPE_ELECTRIC === '1') {
    const electricTerritories = await discoverElectricTerritories();
    console.error(`[EnergyChoice] Found ${electricTerritories.length} electric territories`);
    jobs.push(...electricTerritories.flatMap((t) =>
      RATE_CODES.map((rc) => ({ category: 'Electric', ...t, rateCode: rc }))
    ));
  } else {
    console.error('[EnergyChoice] Skipping electric territories (set SCRAPE_ELECTRIC=1 to include)');
  }

  for (const job of jobs) {
    const label = `${job.category} territory=${job.id} rateCode=${job.rateCode}`;
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.error(`[EnergyChoice] Fetching ${label}${attempt > 1 ? ' (retry)' : ''}...`);
        result = await fetchRatePage(job.category, job.id, job.rateCode);
        break; // success
      } catch (err) {
        console.error(`[EnergyChoice] Attempt ${attempt} failed for ${label}: ${err.message}`);
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 5000)); // 5s backoff before retry
        }
      }
    }
    if (result) {
      result.territoryName = job.name;
      allResults.push(result);
    }

    // Polite delay between requests
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));
  }

  console.error(`[EnergyChoice] Done — ${allResults.length} rate pages scraped`);
  return allResults;
}

/**
 * Detect rate changes by comparing new snapshot with stored baseline.
 */
function detectChanges(previous, current) {
  const changes = [];

  for (const curr of current) {
    const prev = previous.find(
      (p) => p.category === curr.category && p.territoryId === curr.territoryId && p.rateCode === curr.rateCode
    );

    if (!prev) continue;

    if (prev.defaultRate !== null && curr.defaultRate !== null && prev.defaultRate !== curr.defaultRate) {
      const changePct = ((curr.defaultRate - prev.defaultRate) / prev.defaultRate * 100).toFixed(2);
      changes.push({
        type: 'default_rate',
        key: `${curr.category}:${curr.territoryId}:${curr.rateCode}`,
        territory: curr.territoryName || `Territory ${curr.territoryId}`,
        category: curr.category,
        prevRate: prev.defaultRate,
        currRate: curr.defaultRate,
        changePct,
        effectiveText: curr.defaultRateText,
        summary: `${curr.territoryName || curr.category} default rate changed: $${prev.defaultRate} → $${curr.defaultRate}/unit (${changePct > 0 ? '+' : ''}${changePct}%)`,
      });
    }

    for (const currSupplier of curr.suppliers) {
      const prevSupplier = prev.suppliers?.find((s) => s.name === currSupplier.name && s.termMonths === currSupplier.termMonths && s.rateType === currSupplier.rateType);
      if (!prevSupplier || prevSupplier.price === null || currSupplier.price === null) continue;

      if (prevSupplier.price !== currSupplier.price) {
        const changePct = ((currSupplier.price - prevSupplier.price) / prevSupplier.price * 100).toFixed(2);
        changes.push({
          type: 'supplier_rate',
          key: `${curr.category}:${curr.territoryId}:${curr.rateCode}`,
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

    // Detect removed offers (existed in previous but missing from current)
    for (const prevSupplier of (prev.suppliers || [])) {
      if (prevSupplier.price === null) continue;
      const stillExists = curr.suppliers.find(
        (s) => s.name === prevSupplier.name && s.termMonths === prevSupplier.termMonths && s.rateType === prevSupplier.rateType
      );
      if (!stillExists) {
        changes.push({
          type: 'removed_offer',
          key: `${curr.category}:${curr.territoryId}:${curr.rateCode}`,
          territory: curr.territoryName || `Territory ${curr.territoryId}`,
          category: curr.category,
          supplier: prevSupplier.name,
          prevRate: prevSupplier.price,
          currRate: null,
          changePct: null,
          summary: `${prevSupplier.name} (${curr.territoryName}): offer removed (was $${prevSupplier.price}/unit, ${prevSupplier.termMonths || '?'}mo ${prevSupplier.rateType})`,
        });
      }
    }
  }

  return changes;
}

// CLI entry point
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.includes('energy-choice-scraper')) {
  const results = await scrapeAllRates();
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}

export { scrapeAllRates, fetchRatePage, detectChanges };
