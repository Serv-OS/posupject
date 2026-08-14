// Google Sheets bank-feed adapter (read-only), shared by bank-connect + bank-sync.
// Use case: Monzo Business auto-exports every transaction to a Google Sheet in real time;
// we read that sheet server-side and map rows into bank_transactions. No bank API, no AISP,
// no 90-day SCA. Auth = a Google service-account JWT exchanged for an access token.
// Secrets (Edge Function env only):
//   GSHEETS_SA_KEY        full service-account JSON (has client_email + private_key)
//   GSHEETS_BANK_SHEET_ID the spreadsheet id (from its URL)
//   GSHEETS_BANK_RANGE    optional A1 range incl. header row (default 'A:Z' = first tab)
//   GSHEETS_BANK_CURRENCY optional default currency (default 'GBP')
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

// --- base64url + PKCS8 import (service-account keys are always PKCS8) ----------
const b64urlFromBytes = (bytes: Uint8Array): string => {
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlFromString = (str: string): string => b64urlFromBytes(new TextEncoder().encode(str));
const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

let _sa: { client_email: string; private_key: string } | null = null;
const sa = () => {
  if (_sa) return _sa;
  const raw = Deno.env.get("GSHEETS_SA_KEY");
  if (!raw) throw new Error("GSHEETS_SA_KEY not set");
  let j: any;
  try { j = JSON.parse(raw); } catch { throw new Error("GSHEETS_SA_KEY is not valid JSON"); }
  if (!j.client_email || !j.private_key) throw new Error("GSHEETS_SA_KEY missing client_email/private_key");
  _sa = { client_email: j.client_email, private_key: j.private_key };
  return _sa;
};

let _key: CryptoKey | null = null;
const privateKey = async (): Promise<CryptoKey> => {
  if (_key) return _key;
  const pem = sa().private_key;   // PKCS8 "-----BEGIN PRIVATE KEY-----" (newlines already real after JSON.parse)
  const der = b64ToBytes(pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, ""));
  _key = await crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return _key;
};

// --- access token (sign a JWT, exchange it, cache until ~exp) ------------------
let _tok: { token: string; exp: number } | null = null;
async function gToken(): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  if (_tok && _tok.exp - 60 > nowS) return _tok.token;
  const { client_email } = sa();
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowS, exp: nowS + 3600 };
  const input = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, await privateKey(), new TextEncoder().encode(input));
  const assertion = `${input}.${b64urlFromBytes(new Uint8Array(sig))}`;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new Error(`Google token failed: ${r.status} ${JSON.stringify(body)}`);
  _tok = { token: body.access_token, exp: nowS + Number(body.expires_in || 3600) };
  return _tok.token;
}

// --- read the sheet -----------------------------------------------------------
export async function readSheet(sheetId: string, range?: string): Promise<{ ok: boolean; status: number; rows: string[][]; error?: any }> {
  const token = await gToken();
  const rng = encodeURIComponent(range || Deno.env.get("GSHEETS_BANK_RANGE") || "A:Z");
  const r = await fetch(`${SHEETS}/${sheetId}/values/${rng}?majorDimension=ROWS`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, rows: [], error: body };
  return { ok: true, status: r.status, rows: body.values || [] };
}

// --- row mapping (canonical mirror lives in src/lib/bankRecon.js for vitest) ---
// Match Monzo's export columns by HEADER NAME (order-independent). Monzo's single
// "Amount" column is already signed (negative = money out).
const norm = (s: string) => String(s || "").trim().toLowerCase();
const COLS: Record<string, string[]> = {
  txnId: ["transaction id", "id"],
  date: ["date"],
  time: ["time"],
  type: ["type"],
  name: ["name", "merchant", "counterparty", "payee"],
  amount: ["amount"],
  moneyOut: ["money out", "out"],
  moneyIn: ["money in", "in"],
  currency: ["currency"],
  category: ["category"],
  notes: ["notes and #tags", "notes", "note"],
  description: ["description", "reference"],
};
export function headerIndex(headers: string[]): Record<string, number> {
  const h = headers.map(norm);
  const idx: Record<string, number> = {};
  for (const [k, names] of Object.entries(COLS)) {
    for (const n of names) { const i = h.indexOf(n); if (i >= 0) { idx[k] = i; break; } }
  }
  return idx;
}
// Accepts DD/MM/YYYY, YYYY-MM-DD, or anything Date can parse -> YYYY-MM-DD.
export function parseSheetDate(v: string): string | null {
  const s = String(v || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);   // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const numOr0 = (v: any) => { const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
// Map one sheet row -> bank_transactions shape. idx from headerIndex(headers).
export function mapSheetRow(idx: Record<string, number>, row: string[], defCur = "GBP"): null | { dedup_key: string; status: string; booking_date: string | null; value_date: string | null; amount: number; currency: string; payee: string | null; description: string | null } {
  const get = (k: string) => (idx[k] != null ? row[idx[k]] : undefined);
  const date = parseSheetDate(get("date") as string);
  // amount: prefer signed "Amount"; else moneyIn - moneyOut
  let amount: number;
  if (idx.amount != null && String(get("amount") ?? "").trim() !== "") amount = numOr0(get("amount"));
  else amount = numOr0(get("moneyIn")) - Math.abs(numOr0(get("moneyOut")));
  const txnId = String(get("txnId") ?? "").trim();
  const name = (get("name") as string) || null;
  const notes = (get("notes") as string) || (get("description") as string) || null;
  const dedup = txnId ? "m:" + txnId
    : "h:" + [date || "", get("time") || "", amount, name || "", String(notes || "").slice(0, 40)].join("|");
  if (!date && !txnId && !amount) return null;   // blank/spacer row
  return {
    dedup_key: dedup, status: "booked", booking_date: date, value_date: null,
    amount, currency: (get("currency") as string) || defCur, payee: name, description: notes,
  };
}

export const corsJson = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" } });
