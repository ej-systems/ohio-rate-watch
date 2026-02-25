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

export default { insertSnapshot, getHistory, getSCOHistory, getSupplierHistory, getSummary };
