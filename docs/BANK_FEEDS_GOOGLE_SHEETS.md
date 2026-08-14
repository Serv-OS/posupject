# Bank feeds — Monzo Business via Google Sheets (live, free)

The live bank feed reads transactions from a **Google Sheet that Monzo Business auto-exports
to in real time**, then maps them into the same reconcile screen (`bank_transactions` →
match to bills/expenses). Read-only; no payments. Chosen because there is **no free
self-serve Open Banking API for Monzo Business** (Enable Banking has no UK; Monzo's own API
is personal-only; Plaid/TrueLayer are contract/paid). The Enable Banking adapter
(`_shared/enablebanking.ts`) is parked on disk for any future EEA use.

## How it works
- Monzo Business (Pro/Team) → **Auto-export → Google Sheets** appends every transaction live.
- A Google **service account** reads that sheet (shared read-only with the service account).
- `bank-connect` (action `init`) validates the sheet + records one connection + one account.
- `bank-sync` (daily cron + Refresh button) reads the sheet, maps rows, upserts on
  `(gc_account_id, dedup_key)` — re-reading the whole sheet never duplicates.

## One-time setup (owner)
1. **Monzo:** app → Account → **Auto-exports** → export transactions to a new Google Sheet
   (requires Monzo Business **Pro** or **Team**). Note the spreadsheet — open it and copy its
   **id** from the URL: `https://docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit`.
2. **Google Cloud** (console.cloud.google.com):
   - Create/choose a project → **APIs & Services → Enable APIs** → enable **Google Sheets API**.
   - **Credentials → Create credentials → Service account** → create it.
   - On the service account → **Keys → Add key → JSON** → download the key file.
3. **Share the sheet** with the service account's email
   (`...@<project>.iam.gserviceaccount.com`) as **Viewer**.

## Supabase secrets (set on BOTH clones)
Edge Function secrets, per project:
- `GSHEETS_SA_KEY` = the **entire contents** of the downloaded service-account JSON
- `GSHEETS_BANK_SHEET_ID` = the spreadsheet id from step 1
- `GSHEETS_BANK_RANGE` *(optional)* = e.g. `Transactions!A:Z` (default `A:Z` = first tab)
- `GSHEETS_BANK_CURRENCY` *(optional)* = default `GBP`

## Use
In the app (owner) → **Finance → Bank feed → Connect bank** → pick
"Monzo Business (Google Sheets)". It validates the sheet and creates the account; hit
**Refresh** (or wait for the daily cron) to pull transactions. Then Match / Create bill / Ignore.

## Column mapping (order-independent, by header name)
Matches Monzo's export headers: `Transaction ID` → dedup key; `Date` (DD/MM/YYYY or ISO);
`Amount` (already signed, money-out negative) — or `Money In`/`Money Out` if there's no
Amount column; `Currency`; `Name` → payee; `Notes and #tags`/`Description` → description.
If Monzo's columns differ, adjust `COLS` in `_shared/gsheets.ts` (+ the mirror in
`src/lib/bankRecon.js`). The raw row is stored in `bank_transactions.raw` for debugging.

## Notes
- No 90-day SCA / consent expiry (it's a sheet, not an Open Banking consent).
- Balance shown = running sum of imported rows (Monzo export has no balance column).
- Security: the sheet is shared **only** with the service account, and the SA private key
  lives only in Supabase secrets — never the client.
