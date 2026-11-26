// Brex bank feed (ServOS US, Peter 25 Nov 2026: "we are going to have 2 bank
// accounts one for the UK one for the US through Brex").
//
// Brex API facts (developer.brex.com, read 25 Nov 2026):
//  - A user token made in the Brex dashboard (Settings, Developer, Create
//    token) by an account or card admin. Shown once. Scopes we need:
//    accounts.cash.readonly, transactions.cash.readonly,
//    accounts.card.readonly, transactions.card.readonly.
//  - It expires if it is not used for 90 days. Our 30 minute sync uses it,
//    so it stays alive.
//  - https://api.brex.com, Authorization: Bearer <token>.
//  - Money is {amount: integer cents, currency}. Lists page with cursor and
//    next_cursor; posted_at_start filters by date.
//  - Card transactions are settled only (no pending), with merchant.raw_descriptor.
//  - No webhook for new transactions, so the 30 minute sync is the feed.
// The token lives in bank_tokens (service role only), never in the browser.

type Obj = Record<string, any>;
const BASE = "https://api.brex.com";
const DAY = 86400000;

export class BrexError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function brexGet(token: string, path: string, params: [string, string][] = []): Promise<any> {
  const qs = params.length ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  const r = await fetch(`${BASE}${path}${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const text = await r.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!r.ok) {
    const why = j?.message || j?.error || text.slice(0, 200) || r.statusText;
    if (r.status === 401) throw new BrexError(401, "Brex refused the token (it may have been revoked or expired). Make a new one in Brex and connect again.");
    if (r.status === 403) throw new BrexError(403, `Brex says this token cannot read that (${path}). Check the token has the read scopes for accounts and transactions. ${why}`);
    throw new BrexError(r.status, `Brex ${r.status}: ${why}`);
  }
  return j;
}

/** Every page of a Brex list. */
async function brexAll(token: string, path: string, params: [string, string][] = [], maxPages = 50): Promise<Obj[]> {
  const out: Obj[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const p: [string, string][] = [...params, ["limit", "100"]];
    if (cursor) p.push(["cursor", cursor]);
    const j = await brexGet(token, path, p);
    const items = Array.isArray(j) ? j : (j?.items || []);
    out.push(...items);
    cursor = Array.isArray(j) ? null : (j?.next_cursor || null);
    if (!cursor || !items.length) break;
  }
  return out;
}

export const listCashAccounts = (token: string) => brexAll(token, "/v2/accounts/cash", [], 5);
export const listCardAccounts = (token: string) => brexAll(token, "/v2/accounts/card", [], 5);

const cents = (m: Obj | null | undefined) => (m && typeof m.amount === "number" ? m.amount / 100 : null);
const day = (s: unknown) => (typeof s === "string" && s.length >= 10 ? s.slice(0, 10) : null);

// Card lines that bring money back; everything else on a card is spend.
const CARD_IN = new Set(["REFUND", "CHARGEBACK", "REWARDS_CREDIT"]);

/** A Brex card transaction as a bank line. Money out is negative, like Monzo. */
export function mapBrexCard(t: Obj): Obj | null {
  if (!t?.id) return null;
  const v = Math.abs(Number(t.amount?.amount || 0));
  if (!v) return null;
  const into = CARD_IN.has(String(t.type || "").toUpperCase());
  const payee = t.merchant?.raw_descriptor || t.description || null;
  return {
    dedup_key: "bx:" + t.id,
    status: "booked",
    booking_date: day(t.posted_at_date) || day(t.initiated_at_date),
    value_date: day(t.posted_at_date),
    amount: (into ? v : -v) / 100,
    currency: t.amount?.currency || "USD",
    payee,
    description: [t.description && t.description !== payee ? t.description : null, t.type && t.type !== "PURCHASE" ? String(t.type).toLowerCase() : null]
      .filter(Boolean).join(" · ") || null,
  };
}

/** A Brex cash (business account) transaction. Brex signs these: out is negative. */
export function mapBrexCash(t: Obj): Obj | null {
  if (!t?.id) return null;
  const v = Number(t.amount?.amount || 0);
  if (!v) return null;
  const type = String(t.type || "");
  return {
    dedup_key: "bx:" + t.id,
    status: "booked",
    booking_date: day(t.posted_at_date) || day(t.initiated_at_date),
    value_date: day(t.posted_at_date),
    amount: v / 100,
    currency: t.amount?.currency || "USD",
    payee: t.description || null,
    // The type helps the matcher: CARD_COLLECTION is the card bill paid from
    // this account, a move between our own accounts, not a cost.
    description: type && type !== "PAYMENT" ? type.toLowerCase().replace(/_/g, " ") : null,
  };
}

/** Pull one Brex account (cash or card) into bank_transactions.
 *  full: from `fromDate` (first connect); otherwise the last 30 days, which
 *  overlaps every sync so nothing is missed (Brex advise a lookback). */
export async function syncBrexAccount(admin: any, token: string, account: Obj, full = false): Promise<number> {
  // An account with nothing stored yet gets the full two years.
  if (!full) {
    const { count } = await admin.from("bank_transactions").select("id", { count: "exact", head: true }).eq("account_id", account.id);
    if (!count) full = true;
  }
  // Brex refuses posted_at_start with a timezone or milliseconds (400 Bad
  // request, found 25 Nov 2026): it must be plain 2024-11-26T00:00:00.
  const since = new Date(Date.now() - (full ? 730 : 30) * DAY).toISOString().slice(0, 19);
  const isCard = String(account.provider_account_id || "").startsWith("card:");
  const raw = isCard
    ? await brexAll(token, "/v2/transactions/card/primary", [["posted_at_start", since]], full ? 200 : 20)
    : await brexAll(token, `/v2/transactions/cash/${encodeURIComponent(String(account.provider_account_id).replace(/^cash:/, ""))}`, [["posted_at_start", since]], full ? 200 : 20);
  const now = new Date().toISOString();
  const rows = raw.map(isCard ? mapBrexCard : mapBrexCash).filter(Boolean)
    .map((m) => ({ account_id: account.id, gc_account_id: account.gc_account_id, ...m, synced_at: now }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("bank_transactions").upsert(rows.slice(i, i + 500), { onConflict: "gc_account_id,dedup_key" });
    if (error) throw new Error(`save transactions: ${error.message}`);
  }
  return rows.length;
}

/** Balances. Cash: what is in the account. Card: what is owed (shown negative). */
export async function syncBrexBalances(admin: any, token: string, accounts: Obj[]) {
  const now = new Date().toISOString();
  let cash: Obj[] = [], card: Obj[] = [];
  try { cash = await listCashAccounts(token); } catch { /* no cash account or no scope */ }
  try { card = await listCardAccounts(token); } catch { /* no card or no scope */ }
  for (const a of accounts) {
    const pid = String(a.provider_account_id || "");
    let bal: number | null = null;
    if (pid.startsWith("cash:")) bal = cents(cash.find((c) => c.id === pid.slice(5))?.current_balance);
    if (pid.startsWith("card:")) { const b = cents(card[0]?.current_balance); bal = b == null ? null : -Math.abs(b); }
    await admin.from("bank_accounts").update({
      ...(bal != null ? { balance: bal, balance_at: now.slice(0, 10) } : {}), last_synced_at: now, updated_at: now,
    }).eq("id", a.id);
  }
}

/** The stored token; a successful call keeps Brex's 90 day clock running. */
export async function brexToken(admin: any, connectionId: string): Promise<string> {
  const { data } = await admin.from("bank_tokens").select("access_token").eq("connection_id", connectionId).maybeSingle();
  if (!data?.access_token) throw new Error("Not connected to Brex yet.");
  return data.access_token;
}
