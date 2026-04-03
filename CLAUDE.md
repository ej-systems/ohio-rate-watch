# CLAUDE.md — Ohio Rate Watch

> **Last Updated:** 2026-04-02
> **Global rules at ~/.claude/CLAUDE.md apply automatically.** This file adds project-specific context only.

## Project Overview

| Field | Value |
|-------|-------|
| Name | Ohio Rate Watch |
| GitLab URL | `http://10.10.10.218/jim/ohio-rate-watch` |
| GitHub Mirror | `github.com/ej-systems/ohio-rate-watch` |
| Stack | Node.js 22 (vanilla http), PostgreSQL (Railway), Resend email, Cloudflare CDN |
| Deployed At | Railway (server) + Cloudflare (CDN) |
| Obsidian Page | `[[Ohio-Rate-Watch]]` |
| Status | Active |
| Entity | EJ Systems LLC — ohioratewatch.com |

Free gas rate comparison tool for Ohio consumers. Scrapes PUCO Energy Choice portal daily, sends personalized email alerts when rates drop. AGPL-3.0, no affiliate links, no commissions.

## Project-Specific Context

### Pages

- `index.html` — Main rate comparison + signup form
- `learn.html` — Educational content + interactive county map
- `methodology.html` — About, data sources, limitations
- `calculator.html` — Rate calculator tool
- `cities.html` — City directory (68 Ohio cities)
- `city.html` — Individual city rate page template

### API Endpoints

**Public:**
- `GET /api/rates` — Supplier offers by territory/category
- `GET /api/rates/savings` — Average savings metrics
- `GET /api/rates/city-benchmark` — City bill benchmarks
- `GET /api/rates/city-history/:slug` — City historical bills

**Subscriber:**
- `POST /api/signup` — Email + ZIP + optional personal rate
- `GET /api/confirm?token=...` — Email confirmation
- `GET /api/unsubscribe?token=...` — One-click unsubscribe

**Admin:**
- `POST /api/cron/daily-check` — Trigger scrape (requires `x-cron-secret` header)
- `GET /api/admin/stats` — Scraper health dashboard

### Database Tables

| Table | Purpose |
|---|---|
| `supplier_offers` | Daily supplier rate snapshots |
| `rate_snapshots` | Historical rate data for charts |
| `sco_rates` | SCO/GCR default rates per territory |
| `subscribers` | Email alert signups + tokens |
| `rate_events` | Change tracking (new/removed/changed) |
| `scrape_runs` | Audit trail (status, row count, errors) |
| `city_bills` | PUCO monthly bill benchmarks (68 cities) |
| `city_bill_history` | 10-year monthly bill trends |

Schema is auto-created by `lib/history-store.js:ensureSchema()`.

### Gas Territories

| Utility | ID | Area | Pricing |
|---|---|---|---|
| Columbia Gas | 8 | Most of Ohio | SCO |
| Enbridge Gas | 1 | NE Ohio / Cleveland | SCO |
| CenterPoint Energy | 11 | SW Ohio / Dayton | SCO |
| Duke Energy | 10 | SW Ohio / Cincinnati | GCR → SCO (Apr 2026) |

Enbridge reports rates in $/MCF; others use $/CCF (1 MCF = 10 CCF).

### Alert Logic

1. Best fixed rate (no bundle, no intro) < baseline by ≥ `min_savings_pct` (default 15%)
2. Baseline = subscriber's personal rate OR utility's SCO/GCR
3. Cooldown = 7 days since last alert
4. Change threshold = best rate moved >3% since last alert

### Environment Variables

```
DATABASE_URL          — PostgreSQL connection string (Railway)
RESEND_API_KEY        — Email provider
CRON_SECRET           — Auth for /api/cron/daily-check
DISCORD_WEBHOOK_URL   — Status alerts (optional)
EIA_API_KEY           — Henry Hub prices (optional)
PORT                  — HTTP port (Railway auto-sets)
```

### Development

```bash
npm install
cp .env.example .env   # Fill in DATABASE_URL, RESEND_API_KEY
node server.js          # Start server
```

**Testing the scraper:**
```bash
node scripts/daily-check.js --dry-run              # No emails sent
node scripts/daily-check.js --force-alert --dry-run # Force alerts, no emails
```

### Deployment

- **Railway**: Auto-deploys from `main` branch. Config in `railway.json`.
- **GitHub Actions**: `.github/workflows/daily-scraper.yml` runs 6x daily (every 6 hours UTC).
- **Postgres**: Railway TCP proxy at `maglev.proxy.rlwy.net:33107` (no SSL).

## Key Files

| Path | Purpose |
|------|---------|
| `server.js` | HTTP API server (~1,050 lines, all endpoints) |
| `lib/shared.js` | CORS headers, sendEmail, rate limiting, territory constants |
| `lib/cron-handler.js` | Core scrape pipeline (scrape → validate → store → alert) |
| `lib/history-store.js` | DB schema, table creation, insert/query helpers |
| `scripts/daily-check.js` | CLI entry: scrape + subscriber alerts + contract reminders |
| `scripts/backfill-eia-history.js` | Load historical EIA Henry Hub prices |
| `scripts/backfill-puco-sco.js` | Load historical PUCO SCO rates |
| `scraper/energy-choice-scraper.js` | PUCO PostBack/XML scraper (4 territories × 2 rate codes) |
| `zip-territory.json` | ZIP code → utility territory mapping (1,253 ZIPs) |
| `ohio-counties.geojson` | County boundaries for /learn map |

## Related Obsidian Pages

- `[[Ohio-Rate-Watch]]`
