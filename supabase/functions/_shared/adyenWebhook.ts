// Deciding whether an Adyen notification is real, and what it means.
//
// Everything here is pure, so the rules that decide whether we take money are
// tested (src/lib/adyen.test.js) rather than trusted. The receiver itself is
// adyen-webhook/index.ts.
//
// The signature is computed over FIELDS in a fixed order, not over the raw
// body, and it lives inside each item at additionalData.hmacSignature. There
// is no signature header on a standard webhook.
//   pspReference:originalReference:merchantAccountCode:merchantReference:value:currency:eventCode:success
// https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures

/** Adyen sends booleans as the STRINGS "true" and "false". `if (x)` is a bug. */
export const isTrue = (v: unknown) => String(v) === "true";

export function signedPayload(item: any): string {
  const parts = [
    item?.pspReference,
    item?.originalReference,   // absent on a plain authorisation, so two colons
    item?.merchantAccountCode,
    item?.merchantReference,
    item?.amount?.value,       // bare integer in minor units: 29880, not 298.80
    item?.amount?.currency,
    item?.eventCode,
    item?.success,
  ].map((v) => (v === null || v === undefined ? "" : String(v)));
  // Adyen documents only the colon joining; their own libraries also escape a
  // ':' or '\' inside a value. The two are identical unless a value contains
  // one, and our references are [0-9a-f-] so ours never can. We sign the
  // escaped form and accept the plain one too (verifyItem).
  return parts.map((v) => v.replace(/\\/g, "\\\\").replace(/:/g, "\\:")).join(":");
}

export const plainSignedPayload = (item: any): string => {
  const parts = [
    item?.pspReference, item?.originalReference, item?.merchantAccountCode, item?.merchantReference,
    item?.amount?.value, item?.amount?.currency, item?.eventCode, item?.success,
  ].map((v) => (v === null || v === undefined ? "" : String(v)));
  return parts.join(":");
};

/** The Customer Area issues the key as hex. The KEY IS THE BYTES, not the text. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = String(hex || "").trim();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("adyen: the HMAC key is not a hex string (the Customer Area issues 64 hex characters)");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sign(payload: string, hexKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", hexToBytes(hexKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

const sameString = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * True only when the item carries a signature that one of our keys produces.
 * A MISSING signature is a failure, never a pass: that is what an unsigned
 * forgery looks like, and it is also what a webhook with HMAC switched off in
 * the Customer Area looks like, which we want to hear about.
 * Several keys are accepted so a key rotation does not drop live payments.
 */
export async function verifyItem(item: any, hexKeys: string[]): Promise<boolean> {
  const got = item?.additionalData?.hmacSignature;
  if (!got || !hexKeys.length) return false;
  const candidates = [signedPayload(item), plainSignedPayload(item)];
  for (const k of hexKeys) {
    for (const p of candidates) {
      try { if (sameString(await sign(p, k), String(got))) return true; } catch { /* a bad key must not throw the request away */ }
    }
  }
  return false;
}

/** inv-<uuid>: only [0-9a-f-], so it can never contain the signing delimiter. */
export const invoiceReference = (invoiceId: string) => `inv-${invoiceId}`;

export function invoiceIdFromReference(reference: unknown): string | null {
  const m = /^inv-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(String(reference || ""));
  return m ? m[1] : null;
}

export type Decision =
  | { action: "pay"; invoiceId: string; amount: number; currency: string; psp: string }
  | { action: "note"; note: string }
  | { action: "ignore"; why: string };

/**
 * What a notification means for our books.
 *
 * AUTHORISATION with success true is the money: Pay by Link captures
 * automatically, and an automatic capture sends NO capture notification, so
 * waiting for CAPTURE would wait for ever.
 * A failed attempt is not an error: the shopper can try again on the same
 * link, so several of these are normal.
 */
export function decide(item: any): Decision {
  const code = String(item?.eventCode || "");
  const ok = isTrue(item?.success);
  const psp = String(item?.pspReference || "");
  const invoiceId = invoiceIdFromReference(item?.merchantReference);
  const value = Number(item?.amount?.value);
  const currency = String(item?.amount?.currency || "");

  if (code === "AUTHORISATION") {
    if (!ok) return { action: "note", note: `Card payment attempt failed: ${item?.reason || "no reason given"}` };
    if (!invoiceId) return { action: "ignore", why: `merchantReference is not one of ours: ${item?.merchantReference}` };
    if (!Number.isFinite(value) || value <= 0) return { action: "ignore", why: "no amount on the notification" };
    return { action: "pay", invoiceId, amount: Math.round(value) / 100, currency, psp };
  }
  if (code === "OFFER_CLOSED") return { action: "note", note: "The customer opened the payment page and left without paying." };
  if (code === "CANCELLATION") return { action: "note", note: "The payment was cancelled." };
  if (code === "REFUND" || code === "REFUND_FAILED" || code === "REFUNDED_REVERSED" || code === "CHARGEBACK" ||
      code === "NOTIFICATION_OF_CHARGEBACK" || code === "CHARGEBACK_REVERSED" || code === "CAPTURE_FAILED") {
    return { action: "note", note: `${code}${ok ? "" : " (failed)"}` };
  }
  return { action: "ignore", why: `nothing to do for ${code || "an item with no eventCode"}` };
}
