# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] - 2026-02-24

### Added
- Initial release: Ohio Rate Watch — free, open-source natural gas rate comparison tool for Ohio consumers
- Daily scraper pulling certified supplier rates from the PUCO Energy Choice portal (`energychoice.ohio.gov`) via PostBack/XML
- Support for all four Ohio gas territories: Columbia Gas (ID 8), Enbridge Gas Ohio/Dominion (ID 1), CenterPoint Energy/Vectren (ID 11), and Duke Energy Ohio (ID 10)
- Rate display sorted by price only — no ranking manipulation or featured listings
- Rate details including ETF, monthly fees, term length, bundle requirements, and renewable status
- Historical rate tracking with PostgreSQL storage (`supplier_offers`, `rate_events`, `scrape_runs` tables)
- Email alert system via Resend: subscribers sign up with email + ZIP, receive personalized alerts when fixed rates drop below their threshold (default 15%)
- Double opt-in confirmation flow with unsubscribe token support
- PUCO city bill benchmark data (`city_bills`, `city_bill_history` tables)
- ZIP-to-utility mapping for 1,253 Ohio ZIPs (`zip-territory.json`)
- Node.js HTTP API server (`server.js`) with rate limiting and CORS
- Three public pages: main rate comparison (`index.html`), educational content with county map (`learn.html`), and methodology (`methodology.html`)
- GitHub Actions workflow for automated daily scraping every 6 hours
- CLI entry point (`scripts/daily-check.js`) with `--dry-run` and `--force-alert` flags for testing
- Deployed on Railway with PostgreSQL; DNS/CDN via Cloudflare
- AGPL-3.0 license

### Fixed
- SCO/GCR rate extraction for all four gas territories
- SSL configuration for Railway Postgres external connections
- SCO vs GCR pricing system documented in methodology
