import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load DATABASE_URL from .env if not in environment
let DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  const envPath = path.join(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    const envFile = readFileSync(envPath, 'utf8');
    DATABASE_URL = envFile.match(/DATABASE_URL=(.*)/)?.[1]?.trim();
  }
}
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// Ensure tables exist on first use
let _initialized = false;
async function ensureSchema() {
  if (_initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_snapshots (
      id SERIAL PRIMARY KEY,
      scraped_at TEXT NOT NULL,
      category TEXT,
      territory_id INTEGER,
      territory_name TEXT,
      rate_code TEXT,
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

    CREATE TABLE IF NOT EXISTS supplier_offers (
      id SERIAL PRIMARY KEY,
      scraped_date TEXT NOT NULL,
      category TEXT NOT NULL,
      territory_id INTEGER NOT NULL,
      rate_code TEXT NOT NULL,
      offer_id TEXT,
      supplier_name TEXT,
      company_name TEXT,
      price REAL,
      rate_type TEXT,
      term_months INTEGER,
      etf REAL,
      monthly_fee REAL,
      is_intro BOOLEAN DEFAULT FALSE,
      is_promo BOOLEAN DEFAULT FALSE,
      is_bundle_required BOOLEAN DEFAULT FALSE,
      is_renewable BOOLEAN DEFAULT FALSE,
      renewable_type TEXT,
      offer_details TEXT,
      promo_details TEXT,
      intro_details TEXT,
      sign_up_url TEXT,
      phone TEXT,
      website TEXT,
      inserted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(scraped_date, offer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_offers_date_cat
      ON supplier_offers(scraped_date, category, territory_id, rate_code);
    CREATE INDEX IF NOT EXISTS idx_supplier_offers_supplier
      ON supplier_offers(supplier_name, territory_id, scraped_date);

    CREATE TABLE IF NOT EXISTS rate_history (
      id SERIAL PRIMARY KEY,
      territory_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      rate REAL NOT NULL,
      source TEXT DEFAULT 'PUCO',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(territory_id, date, type)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_history_territory_date
      ON rate_history(territory_id, date);
  `);
  _initialized = true;
}

export function getPool() {
  return pool;
}

const BUNDLE_PATTERNS = /bundle|gas\s*&\s*electric|gas\s+and\s+electric/i;
const RENEWABLE_KEYWORDS = /(carbon neutral|carbon offset|carbon credit|100%.*renewable|greener life|green.*option|environmentally conscious|tree.*plant)/i;

function detectBundle(offerDetails, promoDetails) {
  return BUNDLE_PATTERNS.test(offerDetails || '') || BUNDLE_PATTERNS.test(promoDetails || '');
}

function detectRenewable(offerDetails, promoDetails) {
  const combined = (offerDetails || '') + ' ' + (promoDetails || '');
  if (RENEWABLE_KEYWORDS.test(combined)) {
    // Determine type
    if (/100%.*carbon neutral|carbon neutral|shipley.*carbon/i.test(combined)) return 'Carbon Neutral (100%)';
    if (/50%.*offset|50%.*carbon/i.test(combined)) return 'Carbon Offset (50%)';
    if (/greener life/i.test(combined)) return 'Greener Life';
    if (/tree|plant/i.test(combined)) return 'Carbon Offset (Trees)';
    return 'Renewable/Green';
  }
  return null;
}

/**
 * Insert all supplier rows from a full scrape result (array of rate pages).
 */
export async function insertSnapshot(rateData) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let count = 0;
    for (const page of rateData) {
      const scrapedAt = page.scrapedAt || new Date().toISOString();
      for (const s of (page.suppliers || [])) {
        await client.query(`
          INSERT INTO rate_snapshots
            (scraped_at, category, territory_id, territory_name, rate_code,
             sco_rate, supplier_name, price, rate_type, term_months, etf, monthly_fee, renewable_pct)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
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
        ]);
        count++;
      }
    }
    await client.query('COMMIT');
    return count;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Insert all supplier offers for a given date from scraper output.
 */
export async function insertSupplierOffers(date, results) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let count = 0;
    for (const page of results) {
      for (const s of (page.suppliers || [])) {
        const renewableType = detectRenewable(s.offerDetails, s.promoDetails);
        await client.query(`
          INSERT INTO supplier_offers
            (scraped_date, category, territory_id, rate_code, offer_id,
             supplier_name, company_name, price, rate_type, term_months,
             etf, monthly_fee, is_intro, is_promo, is_bundle_required,
             is_renewable, renewable_type,
             offer_details, promo_details, intro_details, sign_up_url, phone, website)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
          ON CONFLICT DO NOTHING
        `, [
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
          s.introPrice ? true : false,
          s.hasPromo ? true : false,
          detectBundle(s.offerDetails, s.promoDetails),
          renewableType ? true : false,
          renewableType,
          s.offerDetails || null,
          s.promoDetails || null,
          s.introDetails || null,
          s.signUpUrl || null,
          s.phone || null,
          s.website || null
        ]);
        count++;
      }
    }
    await client.query('COMMIT');
    return count;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Get today's offers filtered by category/territory/rateCode.
 */
export async function getTodayOffers(date, category, territoryId, rateCode) {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT * FROM supplier_offers
    WHERE scraped_date = $1 AND category = $2 AND territory_id = $3 AND rate_code = $4
    ORDER BY price ASC
  `, [date, category, territoryId, rateCode]);
  return rows;
}

/**
 * Price history for a specific supplier in a territory.
 */
export async function getOfferHistory(supplierName, category, territoryId, rateCode, days = 30) {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT scraped_date, price, rate_type, term_months
    FROM supplier_offers
    WHERE supplier_name = $1 AND category = $2 AND territory_id = $3 AND rate_code = $4
      AND scraped_date >= (CURRENT_DATE - ($5 || ' days')::INTERVAL)::TEXT
    ORDER BY scraped_date ASC
  `, [supplierName, category, territoryId, rateCode, days]);
  return rows;
}

/**
 * Best fixed rate excluding intro, bundle-only, zero/negative prices, and high monthly fees.
 */
export async function getBestFixedRate(category, territoryId, rateCode, date) {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT MIN(price) as best
    FROM supplier_offers
    WHERE category = $1 AND territory_id = $2 AND rate_code = $3
      AND scraped_date = $4
      AND rate_type = 'fixed'
      AND price > 0
      AND is_intro = FALSE
      AND is_bundle_required = FALSE
      AND (monthly_fee IS NULL OR monthly_fee <= 5)
  `, [category, territoryId, rateCode, date]);
  return rows[0]?.best ?? null;
}

/**
 * Get all rows for a territory over the last N days.
 */
export async function getHistory(category, territoryId, days = 30) {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT * FROM rate_snapshots
    WHERE category = $1 AND territory_id = $2
      AND scraped_at >= (NOW() - ($3 || ' days')::INTERVAL)::TEXT
    ORDER BY scraped_at ASC
  `, [category, territoryId, days]);
  return rows;
}

/**
 * Get SCO rate over time for a territory.
 */
export async function getSCOHistory(category, territoryId, days = 30) {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT DISTINCT scraped_at::date::text as date, sco_rate as rate
    FROM rate_snapshots
    WHERE category = $1 AND territory_id = $2
      AND sco_rate IS NOT NULL
      AND scraped_at >= (NOW() - ($3 || ' days')::INTERVAL)::TEXT
    ORDER BY date ASC
  `, [category, territoryId, days]);
  return rows;
}

/**
 * Get price history for a specific supplier in a territory.
 */
export async function getSupplierHistory(supplierName, territoryId, days = 30) {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT scraped_at::date::text as date, price, rate_type, term_months
    FROM rate_snapshots
    WHERE supplier_name = $1 AND territory_id = $2
      AND scraped_at >= (NOW() - ($3 || ' days')::INTERVAL)::TEXT
    ORDER BY date ASC
  `, [supplierName, territoryId, days]);
  return rows;
}

/**
 * Summary stats.
 */
export async function getSummary(territoryId, days = 7) {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT
      rate_type,
      MIN(price) as min_price,
      MAX(price) as max_price,
      ROUND(AVG(price)::numeric, 4) as avg_price,
      COUNT(DISTINCT supplier_name) as supplier_count
    FROM rate_snapshots
    WHERE territory_id = $1
      AND scraped_at >= (NOW() - ($2 || ' days')::INTERVAL)::TEXT
      AND price IS NOT NULL
    GROUP BY rate_type
  `, [territoryId, days]);
  return rows;
}

export default { getPool, insertSnapshot, getHistory, getSCOHistory, getSupplierHistory, getSummary,
  insertSupplierOffers, getTodayOffers, getOfferHistory, getBestFixedRate };
