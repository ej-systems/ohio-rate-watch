import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'rates-history.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scraped_at TEXT NOT NULL,
        category TEXT,
        territory_id INTEGER,
        territory_name TEXT,
        rate_code INTEGER,
        sco_rate REAL,
        supplier_name TEXT,
        price REAL,
        rate_type TEXT,
        term_months INTEGER,
        etf TEXT,
        monthly_fee REAL,
        renewable_pct REAL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_territory_date
        ON rate_snapshots(territory_id, scraped_at);
      CREATE INDEX IF NOT EXISTS idx_snapshots_supplier
        ON rate_snapshots(supplier_name, territory_id, scraped_at);
    `);
  }
  return db;
}

/**
 * Insert all supplier rows from a full scrape result (array of rate pages).
 */
export function insertSnapshot(rateData) {
  const d = getDb();
  const insert = d.prepare(`
    INSERT INTO rate_snapshots
      (scraped_at, category, territory_id, territory_name, rate_code,
       sco_rate, supplier_name, price, rate_type, term_months, etf, monthly_fee, renewable_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = d.transaction((pages) => {
    let count = 0;
    for (const page of pages) {
      const scrapedAt = page.scrapedAt || new Date().toISOString();
      for (const s of (page.suppliers || [])) {
        insert.run(
          scrapedAt,
          page.category || null,
          page.territoryId || null,
          page.territoryName || null,
          page.rateCode || null,
          page.defaultRate || null,
          s.name || null,
          s.price || null,
          s.rateType || null,
          s.termMonths || null,
          s.etf || null,
          s.monthlyFee || null,
          s.renewablePct || null
        );
        count++;
      }
    }
    return count;
  });

  const count = insertMany(rateData);
  return count;
}

/**
 * Get all rows for a territory over the last N days.
 */
export function getHistory(category, territoryId, days = 30) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM rate_snapshots
    WHERE category = ? AND territory_id = ?
      AND scraped_at >= datetime('now', '-' || ? || ' days')
    ORDER BY scraped_at ASC
  `).all(category, territoryId, days);
}

/**
 * Get SCO rate over time for a territory.
 */
export function getSCOHistory(category, territoryId, days = 30) {
  const d = getDb();
  return d.prepare(`
    SELECT DISTINCT date(scraped_at) as date, sco_rate as rate
    FROM rate_snapshots
    WHERE category = ? AND territory_id = ?
      AND sco_rate IS NOT NULL
      AND scraped_at >= datetime('now', '-' || ? || ' days')
    ORDER BY date ASC
  `).all(category, territoryId, days);
}

/**
 * Get price history for a specific supplier in a territory.
 */
export function getSupplierHistory(supplierName, territoryId, days = 30) {
  const d = getDb();
  return d.prepare(`
    SELECT date(scraped_at) as date, price, rate_type, term_months
    FROM rate_snapshots
    WHERE supplier_name = ? AND territory_id = ?
      AND scraped_at >= datetime('now', '-' || ? || ' days')
    ORDER BY date ASC
  `).all(supplierName, territoryId, days);
}

/**
 * Summary stats: min/max/avg for fixed and variable suppliers over a period.
 */
export function getSummary(territoryId, days = 7) {
  const d = getDb();
  return d.prepare(`
    SELECT
      rate_type,
      MIN(price) as min_price,
      MAX(price) as max_price,
      ROUND(AVG(price), 4) as avg_price,
      COUNT(DISTINCT supplier_name) as supplier_count
    FROM rate_snapshots
    WHERE territory_id = ?
      AND scraped_at >= datetime('now', '-' || ? || ' days')
      AND price IS NOT NULL
    GROUP BY rate_type
  `).all(territoryId, days);
}

// ---------------------------------------------------------------------------
// supplier_offers table — one row per offer per day
// ---------------------------------------------------------------------------
function ensureSupplierOffersTable() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS supplier_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scraped_date TEXT NOT NULL,
      category TEXT NOT NULL,
      territory_id INTEGER NOT NULL,
      rate_code INTEGER NOT NULL,
      offer_id TEXT,
      supplier_name TEXT NOT NULL,
      company_name TEXT,
      price REAL,
      rate_type TEXT,
      term_months INTEGER,
      etf REAL,
      monthly_fee REAL,
      is_intro INTEGER DEFAULT 0,
      is_promo INTEGER DEFAULT 0,
      is_bundle_required INTEGER DEFAULT 0,
      offer_details TEXT,
      promo_details TEXT,
      intro_details TEXT,
      sign_up_url TEXT,
      phone TEXT,
      website TEXT,
      inserted_at TEXT DEFAULT (datetime('now')),
      UNIQUE(scraped_date, offer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_offers_date_cat
      ON supplier_offers(scraped_date, category, territory_id, rate_code);
    CREATE INDEX IF NOT EXISTS idx_supplier_offers_supplier
      ON supplier_offers(supplier_name, territory_id, scraped_date);
  `);
}

// Call on module load
try { ensureSupplierOffersTable(); } catch (_) { /* db may not exist yet */ }

const BUNDLE_PATTERNS = /bundle|gas\s*&\s*electric|gas\s+and\s+electric/i;

function detectBundle(offerDetails, promoDetails) {
  return BUNDLE_PATTERNS.test(offerDetails || '') || BUNDLE_PATTERNS.test(promoDetails || '') ? 1 : 0;
}

/**
 * Insert all supplier offers for a given date from scraper output.
 * Uses INSERT OR IGNORE for idempotency.
 */
export function insertSupplierOffers(date, results) {
  const d = getDb();
  ensureSupplierOffersTable();
  const insert = d.prepare(`
    INSERT OR IGNORE INTO supplier_offers
      (scraped_date, category, territory_id, rate_code, offer_id,
       supplier_name, company_name, price, rate_type, term_months,
       etf, monthly_fee, is_intro, is_promo, is_bundle_required,
       offer_details, promo_details, intro_details, sign_up_url, phone, website)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = d.transaction((pages) => {
    let count = 0;
    for (const page of pages) {
      for (const s of (page.suppliers || [])) {
        insert.run(
          date,
          page.category || null,
          page.territoryId || null,
          page.rateCode || null,
          s.offerId || null,
          s.name || null,
          s.companyName || null,
          s.price ?? null,
          s.rateType || null,
          s.termMonths ?? null,
          s.earlyTerminationFee ?? null,
          s.monthlyFee ?? null,
          s.introPrice ? 1 : 0,
          s.hasPromo ? 1 : 0,
          detectBundle(s.offerDetails, s.promoDetails),
          s.offerDetails || null,
          s.promoDetails || null,
          s.introDetails || null,
          s.signUpUrl || null,
          s.phone || null,
          s.website || null
        );
        count++;
      }
    }
    return count;
  });

  return insertMany(results);
}

/**
 * Get today's offers filtered by category/territory/rateCode.
 */
export function getTodayOffers(date, category, territoryId, rateCode) {
  const d = getDb();
  ensureSupplierOffersTable();
  return d.prepare(`
    SELECT * FROM supplier_offers
    WHERE scraped_date = ? AND category = ? AND territory_id = ? AND rate_code = ?
    ORDER BY price ASC
  `).all(date, category, territoryId, rateCode);
}

/**
 * Price history for a specific supplier (by name) in a territory.
 */
export function getOfferHistory(supplierName, category, territoryId, rateCode, days = 30) {
  const d = getDb();
  ensureSupplierOffersTable();
  return d.prepare(`
    SELECT scraped_date, price, rate_type, term_months
    FROM supplier_offers
    WHERE supplier_name = ? AND category = ? AND territory_id = ? AND rate_code = ?
      AND scraped_date >= date('now', '-' || ? || ' days')
    ORDER BY scraped_date ASC
  `).all(supplierName, category, territoryId, rateCode, days);
}

/**
 * Best fixed rate excluding intro, bundle-only, zero/negative prices, and high monthly fees.
 */
export function getBestFixedRate(category, territoryId, rateCode, date) {
  const d = getDb();
  ensureSupplierOffersTable();
  const row = d.prepare(`
    SELECT MIN(price) as best
    FROM supplier_offers
    WHERE category = ? AND territory_id = ? AND rate_code = ?
      AND scraped_date = ?
      AND rate_type = 'fixed'
      AND price > 0
      AND is_intro = 0
      AND is_bundle_required = 0
      AND (monthly_fee IS NULL OR monthly_fee <= 5)
  `).get(category, territoryId, rateCode, date);
  return row?.best ?? null;
}

export default { insertSnapshot, getHistory, getSCOHistory, getSupplierHistory, getSummary,
  insertSupplierOffers, getTodayOffers, getOfferHistory, getBestFixedRate };
