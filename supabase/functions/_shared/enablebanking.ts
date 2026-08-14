// Enable Banking (read-only AIS) helpers, shared by bank-connect + bank-sync.
// Data-plane base is api.enablebanking.com. Unlike GoCardless there is NO token
// endpoint and NO client secret: every call is authorised by a short-lived RS256 JWT
// that WE mint + sign with OUR RSA private key. The JWT *is* the bearer credential.
// Secrets (ENABLEBANKING_APP_ID = JWT kid, ENABLEBANKING_PRIVATE_KEY = the .pem) live
// in Edge Function env only — never in the DB or the client.
const API = "https://api.enablebanking.com";

// --- base64 / base64url ---------------------------------------------------
const b64urlFromBytes = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlFromString = (str: string): string => b64urlFromBytes(new TextEncoder().encode(str));
const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// --- private key import (PKCS8 preferred; PKCS1 auto-wrapped) --------------
// DER length encoding for the ASN.1 wrapper we build when given a PKCS1 key.
const asn1Len = (n: number): number[] => {
  if (n < 0x80) return [n];
  const out: number[] = [];
  let v = n;
  while (v > 0) { out.unshift(v & 0xff); v >>= 8; }
  return [0x80 | out.length, ...out];
};
// Wrap a raw PKCS1 RSAPrivateKey DER in a PKCS8 PrivateKeyInfo so crypto.subtle
// (which only imports "pkcs8") can read OpenSSL `genrsa` keys too.
const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]; // SEQ{ rsaEncryption OID, NULL }
  const version = [0x02, 0x01, 0x00]; // INTEGER 0
  const octet = [0x04, ...asn1Len(pkcs1.length), ...Array.from(pkcs1)]; // OCTET STRING { pkcs1 }
  const body = [...version, ...algId, ...octet];
  return new Uint8Array([0x30, ...asn1Len(body.length), ...body]); // SEQUENCE { ... }
};
const pemToPkcs8Der = (pem: string): Uint8Array => {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  if (!b64) throw new Error("ENABLEBANKING_PRIVATE_KEY is empty or not PEM");
  const der = b64ToBytes(b64);
  return isPkcs1 ? pkcs1ToPkcs8(der) : der;
};

let _key: CryptoKey | null = null;
const privateKey = async (): Promise<CryptoKey> => {
  if (_key) return _key;
  const pem = Deno.env.get("ENABLEBANKING_PRIVATE_KEY");
  if (!pem) throw new Error("ENABLEBANKING_PRIVATE_KEY not set");
  const der = pemToPkcs8Der(pem);
  _key = await crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return _key;
};

// --- JWT (self-signed, cached until ~exp) ---------------------------------
// header: { typ:JWT, alg:RS256, kid:<APP_ID> }; claims: iss=enablebanking.com (literal,
// NOT the app id), aud=api.enablebanking.com, iat, exp. Docs cap exp at iat+86400; we use 1h.
let _jwt: { token: string; exp: number } | null = null;
export async function ebJwt(): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  if (_jwt && _jwt.exp - 60 > nowS) return _jwt.token;
  const appId = Deno.env.get("ENABLEBANKING_APP_ID");
  if (!appId) throw new Error("ENABLEBANKING_APP_ID not set");
  const exp = nowS + 3600;
  const header = { typ: "JWT", alg: "RS256", kid: appId };
  const claims = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: nowS, exp };
  const input = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, await privateKey(), new TextEncoder().encode(input));
  const token = `${input}.${b64urlFromBytes(new Uint8Array(sig))}`;
  _jwt = { token, exp };
  return token;
}

// --- API wrapper ----------------------------------------------------------
export async function eb(path: string, init: RequestInit = {}) {
  const jwt = await ebJwt();
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body, headers: r.headers };
}

// --- transaction mapping (canonical; mirrored as pure JS in src/lib/bankRecon.js) ---
// entry_reference is the bank's unique tx id -> dedup key. Fall back to a content hash.
export function ebDedupKey(t: any): string {
  if (t.entry_reference) return "e:" + t.entry_reference;
  const a = t.transaction_amount || {};
  const rem = Array.isArray(t.remittance_information) ? t.remittance_information.join(" ") : (t.remittance_information || "");
  return "h:" + [t.booking_date || "", t.value_date || "", a.amount || "", a.currency || "", t.credit_debit_indicator || "", String(rem).slice(0, 60)].join("|");
}
// amount arrives as a POSITIVE string; the sign lives in credit_debit_indicator
// (CRDT = money in / +, DBIT = money out / -). bank_transactions stores it signed.
export function ebSignedAmount(t: any): number {
  const raw = Math.abs(Number(t.transaction_amount?.amount || 0));
  return t.credit_debit_indicator === "DBIT" ? -raw : raw;
}
// Normalise one Enable Banking transaction into a bank_transactions row shape.
export function ebMapTransaction(t: any): { dedup_key: string; status: string; booking_date: string | null; value_date: string | null; amount: number; currency: string | null; payee: string | null; description: string | null } {
  const rem = Array.isArray(t.remittance_information) ? t.remittance_information.join(" ") : (t.remittance_information || null);
  const cdi = t.credit_debit_indicator;
  // Payee = the *other* party: for money out (DBIT) that's the creditor; for money in the debtor.
  const payee = (cdi === "DBIT" ? t.creditor?.name : t.debtor?.name) || t.creditor?.name || t.debtor?.name || null;
  return {
    dedup_key: ebDedupKey(t),
    status: t.status === "PEND" ? "pending" : "booked",
    booking_date: t.booking_date || null,
    value_date: t.value_date || null,
    amount: ebSignedAmount(t),
    currency: t.transaction_amount?.currency || null,
    payee,
    description: rem,
  };
}

export const corsJson = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" } });
