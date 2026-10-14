// Adyen, for the money ServOS takes on its own quotes and invoices.
//
// Pay by Link, not a hosted session: one server call returns a url, the quote
// page redirects to it, and the link can live for weeks, which is what an
// emailed quote needs. Hosted Checkout sessions die after an hour.
//
// Everything here is pure except the three calls that talk to Adyen, so the
// rules that bite (minor units, the live path, the signing string) are covered
// by tests in src/lib/adyen.test.js rather than discovered in production.
//
// Set per instance, as Supabase secrets, never in the database:
//   ADYEN_API_KEY          the web service credential's key, x-API-key
//   ADYEN_MERCHANT_ACCOUNT the merchant account these payments belong to
//   ADYEN_ENV              "test" (default) or "live"
//   ADYEN_LIVE_PREFIX      live only: from Customer Area, Developers, API URLs
//   ADYEN_HMAC_KEY         the webhook's HMAC key, for the signature check
//   ADYEN_WEBHOOK_USER / ADYEN_WEBHOOK_PASSWORD   the webhook's basic auth

const API_VERSION = "v71";

/** Pennies, as an integer. £298.80 is 29880, never 298.8 and never a string. */
export function minorUnits(amount: number | string): number {
  // Number('') and Number(null) are both 0. A blank amount must never become a
  // zero charge, so it is refused before the conversion.
  if (amount === null || amount === undefined || String(amount).trim() === "") {
    throw new Error("adyen: amount is missing");
  }
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`adyen: amount is not a number: ${amount}`);
  // Binary floats cut both ways: 29.07 * 100 is 2906.9999999999995 (a penny
  // short) and 1.005 * 100 is 100.49999999999999 (a penny short the other
  // way). Settling the product to 6 decimals first removes the noise, then the
  // rounding is the one we mean.
  return Math.round(Number((n * 100).toFixed(6)));
}

/** Back to pounds for our own books. */
export const fromMinorUnits = (value: number) => Math.round(Number(value)) / 100;

/**
 * The Checkout host. Live is NOT the test host with a word swapped: it carries
 * the merchant's own prefix AND an extra /checkout/ segment. Building it by
 * string replacement is the classic way to get a 404 on go live day.
 */
export function checkoutBase(env: string | undefined, livePrefix: string | undefined): string {
  if ((env || "test").toLowerCase() !== "live") return `https://checkout-test.adyen.com/${API_VERSION}`;
  const prefix = (livePrefix || "").trim();
  if (!prefix) throw new Error("adyen: ADYEN_LIVE_PREFIX is required in live (Customer Area, Developers, API URLs)");
  return `https://${prefix}-checkout-live.adyenpayments.com/checkout/${API_VERSION}`;
}

export type AdyenConfig = {
  apiKey: string; merchantAccount: string; env: string; livePrefix?: string;
  /** Where OUR money lands. On a reseller platform, without this the funds sit
   *  on the platform's liable account, which is not ours. */
  balanceAccount?: string;
  /** false hands the Adyen processing cost to the platform's liable account,
   *  which on a reseller platform means the reseller pays for our sales. */
  feesOnUs?: boolean;
};

/** Read the environment, or say plainly that Adyen is not set up here yet. */
export function adyenConfig(): AdyenConfig | null {
  const apiKey = Deno.env.get("ADYEN_API_KEY");
  const merchantAccount = Deno.env.get("ADYEN_MERCHANT_ACCOUNT");
  if (!apiKey || !merchantAccount) return null;
  return {
    apiKey, merchantAccount,
    env: (Deno.env.get("ADYEN_ENV") || "test").toLowerCase(),
    livePrefix: Deno.env.get("ADYEN_LIVE_PREFIX") || undefined,
    balanceAccount: Deno.env.get("ADYEN_BALANCE_ACCOUNT") || undefined,
    feesOnUs: (Deno.env.get("ADYEN_FEES_ON_US") || "true").toLowerCase() !== "false",
  };
}

async function call(cfg: AdyenConfig, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    "x-API-key": cfg.apiKey,           // never Authorization: Bearer
    "Content-Type": "application/json",
  };
  // Adyen keeps an idempotency key for 7 days, scoped to the company account.
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const r = await fetch(`${checkoutBase(cfg.env, cfg.livePrefix)}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Adyen always sends json; keep the text */ }
  if (!r.ok) {
    // Adyen errors carry message + errorCode; both belong in the log.
    const msg = data?.message || text.slice(0, 300) || `HTTP ${r.status}`;
    throw new Error(`adyen ${method} ${path} failed (${r.status}${data?.errorCode ? ` ${data.errorCode}` : ""}): ${msg}`);
  }
  return data;
}

/**
 * Where the money goes.
 *
 * ONE split: the whole amount to our own balance account. No Commission split:
 * commission on a balance platform always goes to the platform's LIABLE
 * account, which here belongs to the reseller, and Peter's rule (14 Oct) is
 * that ServOS's own sales carry no commission of any kind.
 *
 * The fee split carries no amount on purpose: Adyen only knows the fee after
 * the payment, and naming an account moves the cost there. Without it the cost
 * falls on the reseller's liable account, which would mean they pay for our
 * card sales.
 *
 * A chargeback is deducted from the same account, so a dispute on our sale
 * comes out of our money and not theirs.
 *
 * We never send `store`: a store carries the venue split profile (0.8% + 5p to
 * the liable account) and Adyen applies it to a payment link, which would take
 * commission out of our own invoice.
 */
export function paymentSplits(cfg: AdyenConfig, amount: number, currency: string, reference: string) {
  if (!cfg.balanceAccount) return null;
  const splits: Record<string, unknown>[] = [{
    type: "BalanceAccount",
    account: cfg.balanceAccount,
    amount: { value: minorUnits(amount), currency: (currency || "GBP").toUpperCase() },
    reference: `${reference}-net`,
  }];
  if (cfg.feesOnUs !== false) {
    splits.push({ type: "PaymentFee", account: cfg.balanceAccount, reference: `${reference}-fee` });
  }
  return splits;
}

export type LinkInput = {
  amount: number;            // in pounds/dollars, converted here
  currency: string;          // GBP, USD
  reference: string;         // comes back as merchantReference on the webhook
  description?: string;      // shown on the page, 280 chars
  shopperEmail?: string;
  shopperLocale?: string;
  countryCode?: string;
  returnUrl?: string;
  expiresInDays?: number;    // default 30; Adyen's own default is 24 HOURS
  metadata?: Record<string, string>;
};

/** Create the link the customer pays on. Returns { id, url, expiresAt }. */
export async function createPaymentLink(cfg: AdyenConfig, input: LinkInput) {
  const days = Math.min(Math.max(input.expiresInDays ?? 30, 1), 70);  // Adyen's ceiling is 70 days
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const body: Record<string, unknown> = {
    merchantAccount: cfg.merchantAccount,
    reference: input.reference,
    amount: { currency: (input.currency || "GBP").toUpperCase(), value: minorUnits(input.amount) },
    expiresAt,
    reusable: false,                    // one successful payment per link
  };
  if (input.description) body.description = String(input.description).slice(0, 280);
  if (input.shopperEmail) body.shopperEmail = input.shopperEmail;
  if (input.shopperLocale) body.shopperLocale = input.shopperLocale;
  if (input.countryCode) body.countryCode = input.countryCode;
  if (input.returnUrl) body.returnUrl = input.returnUrl;
  if (input.metadata) body.metadata = input.metadata;
  const splits = paymentSplits(cfg, input.amount, input.currency, input.reference);
  if (splits) {
    body.splits = splits;
    // A dispute on our sale is ours, not the platform's.
    body.platformChargebackLogic = { behavior: "deductFromOneBalanceAccount", targetAccount: cfg.balanceAccount };
  }
  // Keyed on reference AND money. Adyen replays the first response for a key
  // for 7 days, so keying on the invoice alone would hand back last week's
  // link at last week's price after a re-price, a deposit, or a credit note.
  const key = `link-${input.reference}-${minorUnits(input.amount)}-${(input.currency || "GBP").toUpperCase()}`;
  return await call(cfg, "POST", "/paymentLinks", body, key);
}

export const getPaymentLink = (cfg: AdyenConfig, linkId: string) =>
  call(cfg, "GET", `/paymentLinks/${encodeURIComponent(linkId)}`);

/** Kill a link: a voided quote, a re-price, or paid another way. */
export const expirePaymentLink = (cfg: AdyenConfig, linkId: string) =>
  call(cfg, "PATCH", `/paymentLinks/${encodeURIComponent(linkId)}`, { status: "expired" });

/**
 * Refund a payment. The pspReference is the PAYMENT's, from its AUTHORISATION
 * notification, and the refund gets a pspReference of its own in the response:
 * the REFUND webhook arrives under that second one, not this one.
 * The currency MUST be the currency it was taken in.
 */
export const refundPayment = (cfg: AdyenConfig, pspReference: string, amount: number, currency: string, reference: string) =>
  call(cfg, "POST", `/payments/${encodeURIComponent(pspReference)}/refunds`, {
    merchantAccount: cfg.merchantAccount,
    amount: { currency: currency.toUpperCase(), value: minorUnits(amount) },
    reference,
  }, `refund-${reference}`);
