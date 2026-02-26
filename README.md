# Ohio Rate Watch

**[ohioratewatch.com](https://ohioratewatch.com)** — A free, open-source tool that helps Ohio natural gas customers compare supplier rates and avoid overpaying on their gas bill.

> Ohio Rate Watch is not affiliated with the Public Utilities Commission of Ohio (PUCO), any natural gas utility, or any supplier. We do not receive commissions. Rates are sorted by price only. No featured listings. Ever.

---

## What It Does

Ohio's natural gas market is deregulated — customers can choose their supplier. But the official PUCO comparison tool is difficult to use, and most people don't realize they can save money by switching.

Ohio Rate Watch:

- Pulls certified supplier rates daily from [energychoice.ohio.gov](https://energychoice.ohio.gov)
- Displays them sorted by price — no ranking manipulation
- Shows early termination fees, monthly fees, term length, and bundle requirements upfront
- Tracks historical rates for trend analysis
- Sends free email alerts when rates drop meaningfully for a subscriber's utility

---

## Data Source

All rate data comes from the **Ohio PUCO Energy Choice portal** (`energychoice.ohio.gov`) — the official state-run supplier comparison database. We do not create, modify, or editorialize rate data.

Average monthly bill benchmarks are sourced from the [PUCO Ohio Utility Rate Survey](https://www.puco.ohio.gov/utilities/electricity/resources/ohio-utility-rate-survey), updated monthly.

See [docs/methodology.md](docs/methodology.md) for full details on scraping, validation, and alert logic.

---

## Utilities Covered

| Territory | Utility | Territory ID |
|-----------|---------|-------------|
| Columbia Gas of Ohio | Natural gas delivery, most of Ohio | 8 |
| Enbridge Gas Ohio (Dominion) | Northeast Ohio / Cleveland area | 1 |
| CenterPoint Energy (Vectren) | Southwest Ohio / Dayton area | 11 |
| Duke Energy Ohio | Cincinnati area | 10 |

---

## Stack

- **Backend:** Node.js / Express
- **Database:** PostgreSQL
- **Frontend:** Vanilla HTML/CSS/JS — no frameworks, no trackers
- **Hosting:** [Railway](https://railway.app)
- **Email:** [Resend](https://resend.com)
- **DNS/CDN:** Cloudflare

---

## Running Locally

### Prerequisites

- Node.js 18+
- PostgreSQL 14+

### Setup

```bash
git clone https://github.com/ej-systems/ohio-rate-watch.git
cd ohio-rate-watch
npm install
cp .env.example .env
# Fill in your values in .env
```

### Environment Variables

See [.env.example](.env.example) for all required variables.

### Start the server

```bash
node server.js
```

### Run the scraper manually

```bash
node scripts/daily-check.js --dry-run
```

### Run with forced alert (testing)

```bash
node scripts/daily-check.js --force-alert --dry-run
```

---

## Project Structure

```
ohio-rate-watch/
├── server.js                  # Express API server
├── index.html                 # Main rate comparison page
├── learn.html                 # Educational content + county map
├── methodology.html           # About & methodology page
├── scraper/
│   └── energy-choice-scraper.js   # PUCO scraper (PostBack/XML)
├── scripts/
│   └── daily-check.js         # Daily scrape + diff + alert fanout
├── lib/
│   └── history-store.js       # DB insert/query helpers
├── docs/
│   └── methodology.md         # Full data methodology
├── .env.example               # Required environment variables
└── zip-territory.json         # ZIP → utility mapping (1,253 Ohio ZIPs)
```

---

## Database Schema (Key Tables)

```sql
-- Daily supplier offers
supplier_offers (scraped_date, territory_id, category, rate_code,
                 supplier_name, price, rate_type, term_months, etf,
                 monthly_fee, is_intro, is_promo, is_bundle_required,
                 is_renewable, renewable_type, offer_details, sign_up_url)

-- PUCO city bill benchmarks
city_bills (report_month, city, utility_key, gas_bill_total, gas_pct_change, ...)

-- 10-year monthly bill history
city_bill_history (report_date, city, total_charge, ...)

-- Scrape run tracking + validation
scrape_runs (started_at, finished_at, status, row_count, error_message)

-- Rate change events
rate_events (detected_at, supplier_name, event_type, old_rate, new_rate, change_pct)

-- Subscribers (email alerts)
subscribers (email, zip, territory, current_rate, min_savings_pct,
             confirmed, unsubscribe_token, last_alerted_at)
```

---

## Alert System

Subscribers sign up with email + ZIP (+ optional current rate from their bill). The system:

1. Looks up their utility from ZIP code
2. Sends a confirmation email — no alerts until confirmed
3. After each daily scrape, checks if the best available fixed rate is below their baseline (personal rate or SCO default) by their threshold (default 15%)
4. Sends a personalized alert if threshold is met and no alert was sent in the last 7 days

---

## License

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)

If you deploy a modified version of this publicly, you must publish your source code under the same license. This is intentional — it keeps forks of this civic project open and accountable.

---

## Non-Affiliation

Ohio Rate Watch is not affiliated with the Public Utilities Commission of Ohio (PUCO), Columbia Gas, Enbridge Gas Ohio, CenterPoint Energy, Duke Energy Ohio, or any natural gas supplier. This is an independent consumer tool.

---

## Contributing

Issues and pull requests are welcome. Please open an issue before submitting large changes.
