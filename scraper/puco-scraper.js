/**
 * PUCO DIS Scraper — Ohio Rate Watch
 * 
 * Scrapes the PUCO DIS Daily Activity Report for new rate-related filings.
 * Uses playwright-extra + stealth plugin to bypass F5 BIG-IP bot protection.
 * 
 * Strategy: Load homepage first (warms session), then navigate to DailyReport.
 * Runs once per night — polite, single-session, fresh browser each time.
 * 
 * Usage: node puco-scraper.js [--days 1]
 * Output: Array of filing objects (JSON to stdout)
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const PUCO_BASE = 'https://dis.puc.state.oh.us';

// Rate keywords to filter filings (case-insensitive)
const RATE_KEYWORDS = [
  'tariff', 'rate', 'gcr', 'ecr', 'far',
  'rider', 'surcharge', 'adjustment', 'fuel',
  'increase', 'decrease', 'supply',
];

// Ohio utilities we care about
const TARGET_COMPANIES = [
  'aep', 'ohio power', 'appalachian',
  'ohio edison', 'firstenergy', 'cleveland electric', 'toledo edison',
  'duke energy', 'aes ohio', 'dayton power',
  'columbia gas', 'dominion energy',
  'centerpoint',
];

/**
 * Determine if a filing is rate-related based on title/company.
 */
function isRateRelated(company = '', description = '') {
  const combined = `${company} ${description}`.toLowerCase();
  return (
    RATE_KEYWORDS.some((kw) => combined.includes(kw)) ||
    TARGET_COMPANIES.some((co) => combined.includes(co))
  );
}

/**
 * Scrape PUCO DIS Daily Reports for the last N days.
 */
async function scrapePUCO(daysBack = 1) {
  console.error(`[PUCO] Starting scrape — last ${daysBack} day(s)`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Block images and fonts to speed up — but NOT scripts (needed for WAF bypass)
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  const allFilings = [];

  try {
    // Step 1: Warm up with homepage (establishes session cookies + passes WAF)
    console.error('[PUCO] Loading homepage to establish session...');
    await page.goto(PUCO_BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500 + Math.random() * 1000); // Randomized human-like delay

    // Step 2: Scrape each DailyReport link (Link=0 = latest, Link=1 = previous, etc.)
    for (let link = 0; link < daysBack; link++) {
      const reportUrl = `${PUCO_BASE}/DailyReport.aspx?Link=${link}`;
      console.error(`[PUCO] Fetching daily report: Link=${link}`);

      // Navigate by clicking from within the session rather than hard URL
      await page.goto(reportUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000 + Math.random() * 500);

      // Check if we got the WAF challenge page instead of content
      const title = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
      
      if (bodyText.includes('rejected') || bodyText.includes('support ID')) {
        console.error(`[PUCO] WAF blocked Link=${link} — skipping`);
        continue;
      }

      // Extract filings from the page
      const filings = await page.evaluate((base) => {
        const rows = [];
        
        // DIS uses tables for the daily report
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const trs = table.querySelectorAll('tr');
          for (const tr of trs) {
            const cells = tr.querySelectorAll('td');
            if (cells.length < 2) continue;

            const cellTexts = [...cells].map((td) => td.textContent?.trim() || '');
            const links = [...tr.querySelectorAll('a')].map((a) => ({
              text: a.textContent?.trim(),
              href: a.href.startsWith('http') ? a.href : base + '/' + a.href.replace(/^\//, ''),
            }));

            if (cellTexts.join(' ').length > 10) {
              rows.push({ cells: cellTexts, links });
            }
          }
        }

        // Also check for definition lists or paragraphs with case info
        const caseLinks = [...document.querySelectorAll('a[href*="CaseRecord"], a[href*="ViewDoc"]')]
          .map((a) => ({
            text: a.textContent?.trim(),
            href: a.href,
            context: a.closest('li, tr, p, div')?.textContent?.trim().substring(0, 200),
          }));

        return { rows, caseLinks };
      }, PUCO_BASE);

      console.error(`[PUCO] Link=${link}: ${filings.rows.length} table rows, ${filings.caseLinks.length} case links`);

      // Parse table rows into filing objects
      for (const row of filings.rows) {
        const combined = row.cells.join(' ');
        const caseLink = row.links.find((l) => l.href.includes('CaseRecord'));

        const filing = {
          docketNumber: row.cells[0] || '',
          company: row.cells[1] || '',
          description: row.cells[2] || row.cells[1] || '',
          filingDate: row.cells[3] || '',
          url: caseLink?.href || null,
          reportLink: link,
          scrapedAt: new Date().toISOString(),
        };

        if (isRateRelated(filing.company, filing.description)) {
          allFilings.push(filing);
        }
      }

      // Also capture any direct case links
      for (const cl of filings.caseLinks) {
        if (isRateRelated('', cl.context || cl.text)) {
          allFilings.push({
            docketNumber: cl.text || '',
            description: cl.context || '',
            url: cl.href,
            reportLink: link,
            scrapedAt: new Date().toISOString(),
          });
        }
      }

      // Polite delay between pages
      if (link < daysBack - 1) {
        await page.waitForTimeout(3000 + Math.random() * 2000);
      }
    }

    // Deduplicate by docketNumber + URL
    const seen = new Set();
    const unique = allFilings.filter((f) => {
      const key = f.docketNumber || f.url || JSON.stringify(f);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.error(`[PUCO] Done — ${unique.length} rate-related filings found`);
    return unique;

  } catch (err) {
    console.error('[PUCO] Fatal error:', err.message);
    return [];
  } finally {
    await browser.close();
  }
}

// CLI entry point
const arg = process.argv.find((a) => a.startsWith('--days'));
const daysBack = arg ? parseInt(arg.split('=')[1] || process.argv[process.argv.indexOf(arg) + 1] || '1', 10) : 1;

scrapePUCO(daysBack).then((filings) => {
  // Output clean JSON to stdout (errors go to stderr above)
  process.stdout.write(JSON.stringify(filings, null, 2) + '\n');
});

export { scrapePUCO };
