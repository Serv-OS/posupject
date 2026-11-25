// Monzo Developer API adapter (bank feed, read only).
//
// Peter, 25 Nov 2026: POSUP banks with Monzo Business. The Developer API is for
// "your own account or a small set of users you explicitly allow", which is
// exactly this: one owner connecting the company's own account. Tested in the
// playground the same day: /accounts lists the uk_business account and
// /transactions reads it.
//
// Rules from https://docs.monzo.com that shape this file:
//   - OAuth: auth.monzo.com -> code -> POST /oauth2/token. The token does
//     nothing until the user approves the access in the Monzo app (SCA).
//   - Access tokens last ~6 hours. Confidential clients get a refresh token.
//     A refresh is ONE TIME: the old refresh token dies and a new pair comes
//     back, so the new pair must be saved before anything else happens.
//   - For 5 minutes after approval the full history can be read; after that
//     only the last 90 days. So the first import happens straight after the
//     approval, and a daily sync never falls more than 90 days behind.
//   - Amounts are integer minor units, negative = money out.
//   - A transaction with settled == "" is authorised but not yet complete.
//   - Webhook transaction.created has no signature, so it is only ever used
//     as a nudge to sync; we never trust its body.

export const MONZO_API = "https://api.monzo.com";
export const MONZO_AUTH = "https://auth.monzo.com/";

type Obj = Record<string, any>;

export type MonzoTokens = { access_token: string; refresh_token: string | null; expires_in: number; user_id?: string };

export function authUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(MONZO_AUTH);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenCall(params: Record<string, string>): Promise<MonzoTokens> {
  const r = await fetch(`${MONZO_API}/oauth2/token`, { method: "POST", body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Monzo token: ${j.message || j.error || r.status}`);
  return { access_token: j.access_token, refresh_token: j.refresh_token || null, expires_in: Number(j.expires_in || 21600), user_id: j.user_id };
}

export const exchangeCode = (clientId: string, secret: string, redirectUri: string, code: string) =>
  tokenCall({ grant_type: "authorization_code", client_id: clientId, client_secret: secret, redirect_uri: redirectUri, code });

export const refreshTokens = (clientId: string, secret: string, refreshToken: string) =>
  tokenCall({ grant_type: "refresh_token", client_id: clientId, client_secret: secret, refresh_token: refreshToken });

export class MonzoError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
/** The user has not approved the access in the Monzo app yet. */
export const needsApproval = (e: unknown) => e instanceof MonzoError && e.status === 403 && /insufficient_permissions/.test(e.code);

export async function monzoGet(token: string, path: string, params?: [string, string][]): Promise<Obj> {
  const u = new URL(MONZO_API + path);
  for (const [k, v] of params || []) u.searchParams.append(k, v);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new MonzoError(r.status, String(j.code || ""), `Monzo ${path}: ${j.message || r.status}`);
  return j;
}

export async function monzoPost(token: string, path: string, form: Record<string, string>): Promise<Obj> {
  const r = await fetch(MONZO_API + path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: new URLSearchParams(form) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new MonzoError(r.status, String(j.code || ""), `Monzo ${path}: ${j.message || r.status}`);
  return j;
}

/** Open accounts, business first. */
export async function listAccounts(token: string): Promise<Obj[]> {
  const j = await monzoGet(token, "/accounts");
  return (j.accounts || []).filter((a: Obj) => !a.closed)
    .sort((a: Obj, b: Obj) => Number(b.type === "uk_business") - Number(a.type === "uk_business"));
}

/** Every transaction after `since` (an RFC 3339 time or a tx id), oldest
 *  first, 100 a page, following the last id. Stops at maxPages so one call
 *  can never run away. */
export async function listTransactions(token: string, accountId: string, since: string | null, maxPages = 60): Promise<Obj[]> {
  const out: Obj[] = [];
  let cursor = since;
  for (let page = 0; page < maxPages; page++) {
    const params: [string, string][] = [["account_id", accountId], ["limit", "100"], ["expand[]", "merchant"]];
    if (cursor) params.push(["since", cursor]);
    const j = await monzoGet(token, "/transactions", params);
    const txs: Obj[] = j.transactions || [];
    out.push(...txs);
    if (txs.length < 100) break;
    cursor = txs[txs.length - 1].id;
  }
  return out;
}

// ── Mapping (pure, mirrored in src/lib/bankRecon.js for the tests) ────────────

/** One Monzo transaction as a bank_transactions row, or null for one that
 *  never moved money (declined, or a zero amount such as a card check). */
export function mapMonzoTransaction(t: Obj): Obj | null {
  if (!t || !t.id || t.decline_reason) return null;
  const pence = Number(t.amount || 0);
  if (!pence) return null;
  const merchant = t.merchant && typeof t.merchant === "object" ? t.merchant : null;
  const counterparty = t.counterparty && typeof t.counterparty === "object" ? t.counterparty : null;
  const payee = merchant?.name || counterparty?.name || counterparty?.preferred_name || t.description || null;
  const ref = [t.notes, t.metadata?.notes, counterparty ? t.description : null]
    .map((x) => String(x ?? "").trim()).filter(Boolean);
  const day = (s: unknown) => (typeof s === "string" && s.length >= 10 ? s.slice(0, 10) : null);
  return {
    dedup_key: "mz:" + t.id,
    status: t.settled ? "booked" : "pending",
    booking_date: day(t.created),
    value_date: day(t.settled) || null,
    amount: Math.round(pence) / 100,
    currency: t.currency || "GBP",
    payee,
    description: [...new Set(ref)].join(" · ") || t.description || null,
  };
}
