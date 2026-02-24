# Ohio Rate Watch — Scraper

Data pipeline for [ohioratewatch.com](https://ohioratewatch.com).  
Monitors PUCO DIS and EIA API for Ohio utility rate changes.

---

## Data Sources

### 1. PUCO DIS (Primary)
- **URL:** https://dis.puc.state.oh.us
- **What:** Every rate filing for every Ohio utility (electric + gas)
- **Frequency:** Nightly
- **Method:** Playwright (site blocks plain HTTP)
- **File:** `puco-scraper.js`

### 2. EIA API (Supporting)
- **URL:** https://api.eia.gov/v2/electricity/retail-sales/data/
- **What:** Monthly Ohio retail electricity rates by sector
- **Frequency:** Monthly (data lags ~2 months)
- **Method:** REST API (free, requires key)
- **File:** `eia-scraper.js`

---

## Setup

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Set your EIA API key (free at api.eia.gov)
export EIA_API_KEY=your_key_here
```

---

## Running

```bash
# Scrape PUCO for yesterday's filings
npm run puco

# Scrape PUCO for last 7 days (first run / catch-up)
npm run test:puco

# Fetch EIA rate data + detect changes
npm run eia
```

---

## Output Format

Each filing from PUCO scraper returns:

```json
{
  "docketNumber": "24-0123-GA-TAR",
  "company": "Columbia Gas of Ohio",
  "description": "Application to Modify Gas Cost Recovery Rate",
  "filingDate": "2024-11-15",
  "effectiveDate": "2024-12-01",
  "url": "https://dis.puc.state.oh.us/CaseRecord.aspx?...",
  "keyword": "GCR",
  "scrapedAt": "2024-11-15T23:00:00.000Z"
}
```

---

## Target Utilities

| Utility | Type | Regulator |
|---|---|---|
| AEP Ohio | Electric | PUCO |
| Ohio Edison / FirstEnergy | Electric | PUCO |
| Cleveland Electric | Electric | PUCO |
| Toledo Edison | Electric | PUCO |
| Duke Energy Ohio | Electric + Gas | PUCO |
| AES Ohio (Dayton) | Electric | PUCO |
| Columbia Gas of Ohio | Gas | PUCO |
| Dominion Energy Ohio | Gas | PUCO |

---

## Rate Change Types

| Type | Frequency | Filed With |
|---|---|---|
| Base rate changes | Annual (rate case) | PUCO |
| Gas Cost Recovery (GCR) | Monthly | PUCO |
| Fuel Adjustment Rider | Quarterly | PUCO |
| Energy Cost Recovery | Quarterly | PUCO |
| Delivery/distribution riders | Annual | PUCO |

---

## Important Notes

- **Polite scraping:** PUCO scraper runs once per night max, blocks images, adds 1-2s delays
- **No API key needed for PUCO:** Public government data, scraping is legally defensible
- **EIA API key:** Free at https://api.eia.gov — sign up takes 2 minutes
- **Don't run from residential IPs repeatedly** — use a static cloud IP (Railway/Render assigns one)
