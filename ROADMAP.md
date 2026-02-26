# Ohio Rate Watch — Product Roadmap

**Status:** Phase 1 complete (Natural Gas, Free Tier) · Phase 2 in planning

---

## What's Live Today

- Daily rate scraper (energychoice.ohio.gov → PostgreSQL)
- Rate comparison table — 4 gas utilities, fixed + variable plans, sorted by price
- Rate validation gating (scrape_runs + 30% median check)
- Rate events table (new/removed/changed offers)
- Subscriber alert system — email + ZIP + personal rate baseline
- Confirmation + unsubscribe flows
- City bill benchmarks (PUCO Tableau, 68 cities)
- Historical bill trends (2015–present, city_bill_history)
- Educational content (/learn) + methodology page
- AGPL-3.0 open source (github.com/ej-systems/ohio-rate-watch)
- SEO: OG tags, sitemap, structured data, robots.txt

---

## Phase 2 — Electric Choice (Next Major Feature)

Ohio's electric market is also deregulated. PUCO's Energy Choice portal already has electric supplier data — and our scraper already fetches it. The data just isn't surfaced on the site yet.

### Ohio Electric Utilities (PUCO territories)
| Utility | Territory IDs | Service Area |
|---------|--------------|--------------|
| AEP Ohio (Columbus Southern Power) | 3, 4 | Central/SE Ohio |
| The Illuminating Company (CEI) | 5 | NE Ohio / Cleveland |
| Ohio Edison (FirstEnergy) | 6 | NE/NW Ohio |
| Toledo Edison | 7 | NW Ohio |
| Duke Energy Ohio | 10 | SW Ohio / Cincinnati |
| AES/DP&L | 2 | Dayton area |

### What Needs Building
- [ ] Electric rate table page (`/electric`) — same UX as gas, different units (¢/kWh)
- [ ] Electric territory selector (6 utilities vs 4 for gas)
- [ ] Electric PTC (Price to Compare) — equivalent of SCO, utility's default rate
- [ ] Unit normalization — electric is priced in ¢/kWh, not $/ccf
- [ ] Bundle offer logic update — "requires gas enrollment" flips for electric
- [ ] Nav update — add "Electric" tab
- [ ] Subscriber alert support for electric territory
- [ ] ZIP → electric territory mapping (similar to zip-territory.json for gas)
- [ ] City bill benchmarks for electric (PUCO Tableau has electric too)
- [ ] /learn content for electric choice (how it works, what PTC means)

### Key Difference: Electric vs Gas
- Gas: $/ccf (hundred cubic feet), typical bill ~10 Mcf/month
- Electric: ¢/kWh, typical residential usage ~750 kWh/month
- Both have an "intro rate" trap problem
- Electric has more aggressive door-to-door enrollment issues

**Estimated effort:** 1–2 days. Most infrastructure already exists — it's mainly UI + ZIP mapping.

---

## Phase 3 — Premium Tier Foundation

### Features
- [ ] Historical rate trend charts (/learn page) — data exists (city_bill_history 2015+)
- [ ] CSV data export endpoint — 1 endpoint, high perceived value for landlords/PMs
- [ ] Custom % drop threshold at signup (currently hardcoded 15%)
- [ ] "Below your locked rate" alerts — user enters current contract rate
- [ ] Weekly digest email — "here's what happened in your utility territory this week"
- [ ] SMS alerts (Twilio) — premium only

### Monetization Model
- Free: everything on the site today + basic email alerts
- Premium ($3-5/month): custom thresholds, SMS, weekly digest, CSV export, multi-address
- No paywalled data — ever

**Gate:** Don't build premium until 100+ confirmed free subscribers

---

## Phase 4 — Multi-State Expansion

Ohio is one of ~15 deregulated natural gas states. The scraper architecture is generic enough to support other states if their public utility commission has a comparable comparison portal.

### States with similar PUCO-equivalent portals
- Pennsylvania (PAPowerSwitch.com)
- Illinois (pluginillinois.org)
- Texas (PowerToChoose.org — electric only, very active market)
- New York (EnergyShopping.ny.gov)
- New Jersey (NJCleanEnergy.com)

### What Changes Per State
- Base scraper URL + postback parameters
- Territory/utility mapping
- Unit differences (some states use therms, some Mcf, some CCF)
- State-specific disclaimer language
- ZIP → territory mapping

**Model:** Open source "state adapter" pattern — AGPL means if someone builds TexasRateWatch on this codebase, it stays open.

---

## Phase 5 — Data & API Product

- [ ] Public rate API (read-only, rate-limited, free tier)
- [ ] Webhook notifications for rate changes (premium)
- [ ] Bulk data access for researchers / journalists / policy orgs
- [ ] Embeddable rate widget (iFrame or JS snippet for local news sites)

---

## Milestone Summary

| Milestone | Description | Status |
|-----------|-------------|--------|
| M1 | Gas rate comparison live | ✅ Done |
| M2 | Subscriber alerts with personal baseline | ✅ Done |
| M3 | Open source (AGPL-3.0) | ✅ Done |
| M4 | Electric choice support | 🔜 Next |
| M5 | Historical trend charts | 📋 Planned |
| M6 | 100 confirmed subscribers | 🎯 Target |
| M7 | Premium tier launch | 📋 Planned (post-M6) |
| M8 | Second state | 📋 Planned |
| M9 | Public API | 📋 Future |

---

## Guiding Principles (Non-Negotiable)

1. Free tier must be genuinely useful — never paywall rate data
2. No commissions, no referral fees, no featured listings
3. Price-only sorting, always
4. Open source core (AGPL-3.0) — forks must stay open
5. If you wouldn't want it on your own bill, don't build it

---

*Last updated: 2026-02-26*
