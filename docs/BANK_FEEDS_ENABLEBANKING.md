# Bank feeds — Enable Banking (read-only Open Banking)

Lets the owner connect a real bank (Monzo, Starling, Barclays, HSBC, Lloyds, NatWest, Revolut…),
pull transactions, and reconcile them against bills/expenses. **Read-only** — no payments are ever
made. Replaces the earlier GoCardless attempt (their new signups are disabled).

## How auth works (the one real difference vs GoCardless)
Enable Banking has **no client secret and no token endpoint**. Every API call carries a
**short‑lived RS256 JWT** that our edge function signs with **our RSA private key**. We upload the
**public** key to Enable Banking and keep the **private** key as a Supabase secret. The JWT itself
is the credential (`iss=enablebanking.com`, `aud=api.enablebanking.com`, `kid=<application id>`).

## One-time setup (owner)
1. Sign up at **https://enablebanking.com** → Control Panel (`/cp`) → **API applications → Add a new application**.
2. Set:
   - **Application name** (shown to you at the bank consent screen).
   - **Whitelisted redirect URL** = `https://<your app domain>/bank/callback`
     (posupject → `https://posupject.vercel.app/bank/callback`; posupcrm → `https://posupcrm.vercel.app/bank/callback`).
   - **Environment** = start with **Sandbox** to test, then register a **separate Production** app for go-live.
   - **Key**: let it **generate the RSA key pair** in the browser → **download + save the `.pem` immediately**
     (it cannot be re-downloaded; losing it means re-registering).
3. Note the **Application ID** (a UUID) — this is the JWT `kid`.

## Supabase secrets (set on BOTH clones, per environment)
Edge Function secrets (Dashboard → Project → Edge Functions → Secrets), per project:
- `ENABLEBANKING_APP_ID` = the Application ID UUID
- `ENABLEBANKING_PRIVATE_KEY` = the full contents of the `.pem` (keep the `-----BEGIN/END-----` lines and newlines)
- `APP_URL` = the app's own URL (`https://posupject.vercel.app` or `https://posupcrm.vercel.app`)

> The private key may be PKCS8 (`BEGIN PRIVATE KEY`) **or** OpenSSL PKCS1 (`BEGIN RSA PRIVATE KEY`)
> — the edge function auto-wraps PKCS1. If you generate with OpenSSL:
> `openssl genrsa -out private.key 4096 && openssl req -new -x509 -days 365 -key private.key -out public.crt`
> (upload `public.crt`, paste `private.key`).

## Deploy (gated — owner runs these)
```
supabase functions deploy bank-connect --project-ref <ref>   # verify_jwt stays ON (editor/owner only)
supabase functions deploy bank-sync   --project-ref <ref> --no-verify-jwt   # cron + on-demand
```
Apply migration `064_bank_feeds_enablebanking.sql` to each DB.
Schedule `bank-sync` daily (cron) — it also runs on demand from the **Refresh** button.

Sanity check after secrets are set: the first **Connect bank** click calls `/aspsps`; if the JWT is
wrong you'll see an "aspsps failed" error (usually a `kid`/key mismatch).

## What changed vs GoCardless (everything else stays)
- **New:** `_shared/enablebanking.ts` (JWT signing + API wrapper + transaction mapping).
- **Rewritten:** `bank-connect` (`/aspsps` → `/auth` → `/sessions`) and `bank-sync`
  (paginated `/accounts/{uid}/transactions`, sign from `credit_debit_indicator`).
- **Unchanged:** the reconcile engine (`bankRecon.js`), the `bank_*` tables, RLS, and the
  `BankFeedPanel` reconcile UI.
- Accounts are anchored on Enable Banking's **stable `identification_hash`** (stored in
  `gc_account_id`) so re-consent doesn't duplicate accounts; `account_uid` holds the live
  per-session handle used for data calls.

## Consent expiry
Bank consent lasts ~90–180 days with **no silent refresh**. When it lapses the connection shows
`EXPIRED — reconnect`; click **Connect bank** again to re-consent.

## Free tier
Reading the business's **own** accounts runs in Enable Banking's free "Restricted Production"
mode. Connecting *other customers'* banks (a public app) needs a signed contract + KYB.
