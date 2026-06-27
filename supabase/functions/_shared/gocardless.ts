// GoCardless Bank Account Data (read-only AIS) helpers, shared by bank-connect + bank-sync.
// Base host is bankaccountdata.gocardless.com (NOT api.gocardless.com — that's Payments).
// Every path needs a trailing slash. Credentials come from Edge Function secrets only.
const BASE = "https://bankaccountdata.gocardless.com/api/v2";

// Fresh access token per invocation (tokens last 24h; for short-lived fn calls this is
// simplest + avoids persisting tokens). secret_id/secret_key from env.
export async function gcToken(): Promise<string> {
  const r = await fetch(`${BASE}/token/new/`, {
    method: "POST",
    headers: { accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      secret_id: Deno.env.get("GOCARDLESS_SECRET_ID"),
      secret_key: Deno.env.get("GOCARDLESS_SECRET_KEY"),
    }),
  });
  if (!r.ok) throw new Error(`GoCardless token failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access as string;
}

export async function gc(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body, headers: r.headers };
}

// transactionAmount.amount arrives as a STRING — parse explicitly.
export function gcDedupKey(t: any): string {
  if (t.transactionId) return "t:" + t.transactionId;
  if (t.internalTransactionId) return "i:" + t.internalTransactionId;
  const a = t.transactionAmount || {};
  return "h:" + [t.bookingDate || "", t.valueDate || "", a.amount || "", a.currency || "", (t.remittanceInformationUnstructured || "").slice(0, 60)].join("|");
}

export const corsJson = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" } });
