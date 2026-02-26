# Ohio Rate Watch — Data Methodology

This document describes how Ohio Rate Watch collects, validates, stores, and uses natural gas rate data.

---

## Data Source

All supplier rate data is pulled from **energychoice.ohio.gov** — the official Ohio PUCO Energy Choice portal operated by the Public Utilities Commission of Ohio.

The portal publishes certified natural gas supplier rates for all licensed suppliers in each utility territory. We access this data via a PostBack/XML export endpoint — no screen scraping, no browser automation needed for supplier rates.

Average monthly bill benchmarks by city are sourced from the [PUCO Ohio Utility Rate Survey Tableau dashboard](https://analytics.das.ohio.gov/t/PUCPUB/views/UtilityRateSurvey/), updated monthly. Raw CSV endpoints are used directly.

---

## Update Schedule

- Supplier rates: scraped once daily at approximately **2:00 AM ET**
- City bill benchmarks: refreshed on each daily scrape run
- Historical trend data (ScheduleTrends): refreshed on each daily scrape run

---

## Scrape Validation

Every scrape run is recorded in the `scrape_runs` table with status, row count, and timing.

Before writing new data to the database, we validate:

1. **Row count check** — The number of offers returned must be ≥ 30% of the 7-day rolling median. If a scrape returns significantly fewer results than expected (e.g., upstream formatting change, partial failure), the previous day's data is preserved and an internal alert fires.
2. **Key field presence** — Supplier name, rate, territory, and rate type must be present.

If validation fails:
- No database write occurs — previous data stays live
- A Discord alert fires with diagnostic details
- The scrape run is marked `invalid` in `scrape_runs`

This means rate data on the site may occasionally be 1–2 days old if upstream issues occur. The "Last updated" timestamp on the rate table always reflects the actual scrape date.

---

## What We Store

For each supplier offer, we store:

| Field | Description |
|-------|-------------|
| `scraped_date` | Date the offer was scraped (YYYY-MM-DD) |
| `territory_id` | PUCO territory ID (1, 8, 10, 11) |
| `supplier_name` | Supplier company name |
| `price` | Rate in $/ccf |
| `rate_type` | `fixed` or `variable` |
| `term_months` | Contract length in months |
| `etf` | Early termination fee ($) |
| `monthly_fee` | Monthly service fee ($) |
| `is_intro` | True if rate is promotional/introductory |
| `is_bundle_required` | True if enrollment requires electric bundling |
| `is_renewable` | True if offer includes carbon offset/renewable component |
| `renewable_type` | Classification: "Carbon Neutral (100%)", "Carbon Offset (50%)", etc. |
| `offer_details` | Raw offer description text from PUCO |
| `sign_up_url` | Link to PUCO offer page |

We retain all historical daily snapshots. Nothing is deleted.

---

## Ranking Logic

Supplier offers are displayed sorted by **price ascending** — cheapest first — within two categories: fixed-rate plans and variable-rate plans.

**No exceptions. No promoted listings. No affiliate relationships.**

Additional display rules:
- Bundle-required plans sort to the bottom within their price tier
- Introductory/promotional rates are clearly labeled
- ETF, monthly fees, and term length are shown in the table — not hidden

---

## Alert Triggers

Alerts fire when the following conditions are all met:

1. **Savings threshold met** — The best available fixed rate (no bundle, no intro) is below the subscriber's baseline by at least their threshold (default: 15%)
2. **Baseline** — Either the subscriber's self-reported current rate (entered at signup) or the utility's current SCO (Standard Choice Offer) if no personal rate was provided
3. **Cooldown** — The subscriber has not been alerted in the last 7 days
4. **Rate change** — The best available rate has changed by more than 3% since the last alert sent to this subscriber

Alert content includes:
- Subscriber's utility name
- Their baseline rate
- Best available rate, supplier, term, ETF
- Savings % and estimated monthly dollar savings (assumes 10 Mcf/month usage)
- Direct link to the offer on energychoice.ohio.gov
- Unsubscribe link

---

## Rate Event Tracking

Every meaningful rate change is recorded in the `rate_events` table:
- `new_offer` — a supplier that wasn't in yesterday's scrape appears today
- `removed_offer` — a supplier that was in yesterday's scrape is gone today
- `rate_change` — an existing supplier's rate changed by >5%

This is the audit trail that powers alerts and will power historical rate change graphs.

---

## Renewable Detection

Offers are scanned for renewable/carbon offset language at insert time using keyword matching against `offer_details` and `promo_details`. Classifications:

| Type | Keywords matched |
|------|-----------------|
| Carbon Neutral (100%) | "100% carbon neutral", "carbon neutral" |
| Carbon Offset (50%) | "50% carbon offset", "carbon offset" |
| Greener Life | "greener life" |
| Carbon Offset (Trees) | "tree planting", "carbon credit" |
| Renewable/Green | "100% renewable", "green option" |

This is heuristic — not guaranteed to catch all renewable offers. If in doubt, verify the offer description directly on energychoice.ohio.gov.

---

## ZIP Code → Utility Mapping

`zip-territory.json` maps 1,253 Ohio ZIP codes to utility keys. Built from the Census ZIP-county crosswalk, with manual corrections for split-service counties (Cuyahoga, Summit, Lorain, Medina, Stark).

For split-territory counties where both Columbia Gas and Enbridge serve customers, ZIP codes are mapped to the dominant utility. Customers in these areas should verify their utility on their bill.

---

## Known Limitations

- Rate data reflects what PUCO publishes — if a supplier's listing is inaccurate on energychoice.ohio.gov, it will be inaccurate here
- Introductory rates are labeled based on PUCO's own flags — if PUCO doesn't mark a rate as intro, we may not either
- `ScheduleTrends` data from PUCO's Tableau dashboard is aggregated statewide (no per-utility breakdown)
- Renewable detection is keyword-based and may miss or misclassify some offers
- ZIP→utility mapping may be incorrect for split-territory border areas

---

## What We Don't Do

- We do not receive commissions, referral fees, or any compensation from suppliers
- We do not rank suppliers by anything except price
- We do not have "featured" or "promoted" listings
- We do not sell subscriber data
- We do not use advertising networks or tracking pixels
- We are not affiliated with PUCO, any utility, or any supplier

---

*Last updated: 2026-02-26*
