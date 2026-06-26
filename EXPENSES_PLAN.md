# Expenses, Bills & VAT-Reclaim module — locked plan

Adds capture of money going **out** of the business (supplier bills, staff mileage,
staff expense claims) alongside the existing invoicing, with a UK VAT-reclaim aid.
Built phase-by-phase; pause for review between phases. Applies to **posupject** and
**posupcrm** (the two UK VAT-registered clones).

## Decisions (signed off)
- **Money type:** NUMERIC **pounds** (match the existing invoices/quotes/products model) — *not* integer pence. Accuracy risk contained in `src/lib/money.js` (half-up 2dp, unit-tested). Deliberate deviation from the brief's integer-pence ask.
- **Roles:** reuse existing `owner`/`editor`/`viewer` (no role-enum migration). **owner = Admin**, **editor = Approver**, everyone submits & sees only their **own** claims via per-row ownership (the `time_entries` RLS pattern).
- **Tests:** vitest stood up greenfield (Phase 1), scoped to the pure money/VAT/mileage logic.
- **Suppliers:** reuse & **extend `inv_suppliers`** (no second supplier list).
- **Reversibility:** each forward migration ships with a paired `*_down.sql` DROP script (repo has no rollback tooling).
- **Multi-deploy:** develop on posupject; DB migrations applied to **both** clone projects as we go; frontend mirrored to posupcrm at a consolidation checkpoint.
- **UK-VAT gating:** `support_settings.tax_regime = 'UK_VAT'` (exposed via `public_branding`; read by `branding.js` → `isUkVat()`).
- **Payees:** staff with logins (a `profiles` row). Non-login contractors are a noted future gap.

## Reuse map (no duplication)
companies/contacts/locations/deals (FKs + `associations`) · `inv_suppliers` (extend) ·
mirror `invoices`/`invoice_line_items` for bills · clone `recurring_invoices` + `invoice-recurring`
for recurring bills · private `attachments` bucket + `AttachmentsCard.jsx` for receipts ·
`notifications` → `notify-dispatch` for approve/paid alerts · `ReportingDashboard` `exportCSV`
+ `invoicePdf.js` for reports · `current_user_role()` RLS.

## Phases
- **1 — Foundations** ✅ in progress: vitest + CI test job; `src/lib/money.js` (+ tests); `support_settings.tax_regime` + `isUkVat()`; migration scaffolding (`057` + `_down`); these docs.
- **2 — Rates & categories:** `tax_rates` (VAT bands, date-effective) + `expense_categories` (nominal codes, vat_treatment) — re-verify rates vs GOV.UK before seeding; admin screen.
- **3 — Suppliers + Bills:** extend `inv_suppliers`; `bills`+`bill_line_items` (mirror invoices); BillsPanel/BillBuilder; receipts; Finance nav group (role-gated); pay-tracking + DEAL/ONGOING cost context.
- **4 — Staff expenses + Mileage + approvals:** `expenses`/`expense_line_items` + `mileage_claims` with self-or-approver RLS; AMAP tiers (45p→55p @ 6 Apr 2026, 10k-mile threshold, passenger 5p); submit→approve→reject→paid + audit log + notifications; mandatory receipts.
- **5 — Recurring bills + cron:** `recurring_bills` + `expense-recurring` edge fn + daily `pg_cron`.
- **6 — VAT return + reporting + harden:** VAT-period reclaim report (flags missing VAT invoices) + MTD-ready export, gated to UK_VAT; reports in ReportingDashboard; RLS audit; ship to both clones.

## Money model note
Amounts are pounds in `numeric` columns. All money/VAT maths goes through `src/lib/money.js`
(`computeVat`, `computeTotals`, `vatFractionOfGross`, half-up `round2`). Do not inline reduce-math.
