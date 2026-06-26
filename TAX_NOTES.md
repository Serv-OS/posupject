# Tax / VAT compliance notes (UK_VAT deployments)

These figures are a **preparation aid, not a filed return and not tax advice**. The
business and its accountant remain responsible for what is submitted to HMRC. The app
does **not** file to HMRC.

## Guardrails (enforced in code)
- **No hardcoded rates.** VAT bands, AMAP mileage rates, advisory fuel rates and fuel
  scale charges live in date-effective, admin-editable tables (Phase 2+). The app always
  resolves the rate whose effective window contains the expense/journey date. The legacy
  `tax_rate DEFAULT 20` literals are being replaced, not extended.
- **Snapshot the rate.** The applied VAT rate/amount is stored on each record so historic
  figures don't move when rates later change.
- **Flag, don't drop.** Anything failing a reclaim condition (no supplier VAT number, no
  valid VAT invoice held, non-reclaimable category) is flagged as *not yet reclaimable* —
  never silently included or removed.
- **Input VAT ≠ VAT charged.** Reclaimable input VAT is tracked separately
  (`vat_reclaimable` / `vat_reclaim_amount`) because some input VAT is blocked/partial
  (e.g. business entertainment, certain motor expenses).
- **Retention.** VAT records are kept ≥ 6 years — soft-delete/archive only, never hard-delete.
- **MTD posture.** Keep an unbroken digital trail from source receipt → expense → VAT figure.
  Provide a structured export (CSV/XLSX/JSON) for MTD-compatible filing software / the
  accountant. No direct HMRC submission unless a later phase explicitly adds an MTD API.

## VAT on mileage (fuel element)
Where a fuel VAT receipt is held: fuel element = business miles × advisory fuel rate (AFR);
reclaimable VAT = fuel element × 1/6 (the VAT fraction of a 20% gross amount —
`vatFractionOfGross(gross, 20)` in `src/lib/money.js`). Requires a covering fuel VAT receipt.

## Rates to re-verify against GOV.UK at seed time (Phase 2)
- VAT: standard 20%, reduced 5%, zero 0% (+ exempt / outside-scope markers).
- AMAP cars/vans: 45p first 10,000 business miles / 25p thereafter; **55p** first-10k from
  6 Apr 2026 (seed both effective periods). Motorcycle 24p, bicycle 20p, passenger +5p.
  10,000-mile threshold is per tax year (6 Apr–5 Apr) per employee.
- Advisory Fuel Rates: by fuel type + engine band, change ~quarterly (1 Mar/Jun/Sep/Dec).
- Fuel scale charges: by CO₂ band, change ~annually.
Cite the GOV.UK source URL next to each seed row.

## UI disclaimer
Every VAT report/export footer must state: *"Preparation aid only — not a filed VAT return
or tax advice. Verify figures with your accountant before submitting to HMRC."*
