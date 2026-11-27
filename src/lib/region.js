// Client-side region helpers for trading in the UK and the US at once.
// The server-side twin lives in supabase/functions/_shared/region.ts — the
// support_regions table is the shared source of truth for both.

import { supabase } from './supabase';

let _regions = null;
let _inflight = null;

/** Active support_regions rows, cached for the session. [] on any failure so
 *  every consumer degrades to single-region UK behaviour. */
export async function loadRegions() {
  if (_regions) return _regions;
  if (!_inflight) {
    _inflight = supabase.from('support_regions').select('*').eq('active', true)
      .then(({ data }) => { _regions = data || []; return _regions; })
      .catch(() => { _regions = []; return _regions; });
  }
  return _inflight;
}
export const clearRegionCache = () => { _regions = null; _inflight = null; };

/** 'US' for +1-shaped numbers, 'UK' for +44/0-shaped, null when unknown. */
export function regionOfPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (String(raw).trim().startsWith('+1')) return 'US';
  if (String(raw).trim().startsWith('+44')) return 'UK';
  if (d.length === 11 && d.startsWith('1') && /[2-9]/.test(d[1])) return 'US';
  if (d.length === 10 && /[2-9]/.test(d[0]) && !d.startsWith('7')) return 'US';
  if (d.startsWith('44') || d.startsWith('0') || (d.length === 10 && d.startsWith('7'))) return 'UK';
  return null;
}

/** Currency a document for this company should default to. */
export const currencyForCountry = (country) => (String(country || '').toUpperCase() === 'US' ? 'USD' : 'GBP');

const REGION_TZ = { UK: 'Europe/London', US: 'America/Los_Angeles' };

/** "Their local time" for a phone number — e.g. '09:42 (Pacific)'. Null when
 *  the region can't be told, so callers can simply not render the chip. */
export function localTimeForPhone(raw, regions) {
  const code = regionOfPhone(raw);
  if (!code) return null;
  const tz = (regions || []).find((r) => r.code === code)?.business_timezone || REGION_TZ[code];
  try {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const zone = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || tz;
    // The US spans four time zones and the number alone cannot pick one, so
    // the US chip shows OUR US office clock, labelled as such, rather than
    // asserting a New York caller is on Pacific time.
    return { code, tz, time, zone, label: code === 'US' ? `${time} ${zone} (US office time)` : `${time} ${zone}` };
  } catch {
    return null;
  }
}

// toE164 moved to phoneFormat.js so pure modules (the onboarding form
// definition and its tests) can use it without importing the Supabase client.
// Re-exported here so every existing `import { toE164 } from '…/region'` works.
export { toE164 } from './phoneFormat';

/** The legal line a company invoice must carry (UK: Companies Act 2006 s82
 *  and the Company Names Regulations want the registered number and, with VAT,
 *  the VAT number; US: the EIN is customary on B2B invoices). Empty fields are
 *  left out; no fields, no line. */
export function registrationLine(r) {
  if (!r) return null;
  const co = String(r.company_number || '').trim();
  const tax = String(r.tax_number || '').trim();
  const us = r.currency === 'USD' || r.code === 'US';
  const parts = us
    ? [co ? `File no. ${co}` : '', tax ? `EIN ${tax}` : '']
    : [co ? `Registered in England and Wales no. ${co}` : '', tax ? `VAT no. ${tax}` : ''];
  const line = parts.filter(Boolean).join(' · ');
  return line || null;
}

/** The company's own address, with its registration line under it, so every
 *  document that prints the address (PDFs, public pages, quotes) carries it.
 *  Once a company has its own name, the global address is NOT borrowed: the
 *  global one is the other company's, and a UK invoice printed the Delaware
 *  address (26 Nov 2026). */
function sellerAddress(r, base) {
  const own = String(r.business_address || '').trim();
  const named = String(r.business_name || '').trim();
  const addr = own || (named ? '' : String(base.business_address || '').trim());
  return [addr, registrationLine(r)].filter(Boolean).join('\n') || null;
}

/** Who is billing: the invoice currency picks the company (USD = the US
 *  company, GBP = the UK one). The region's name, address, email, phone,
 *  terms and footer win; anything empty falls back to the global settings.
 *  Same rule as invoiceSeller in supabase/functions/_shared/region.ts. */
export function mergeSeller(settings, regions, currency) {
  const base = settings || {};
  const cur = currency === 'USD' ? 'USD' : 'GBP';
  const r = (regions || []).find((x) => x.currency === cur);
  if (!r) return base;
  const pick = (a, b) => (a === null || a === undefined || String(a).trim() === '' ? b : a);
  return {
    ...base,
    region_code: r.code,
    business_name: pick(r.business_name, base.business_name),
    business_address: sellerAddress(r, base),
    business_email: pick(r.business_email, base.business_email),
    business_phone: pick(r.business_phone, base.business_phone),
    invoice_terms: pick(r.invoice_terms, base.invoice_terms),
    quote_terms: pick(r.quote_terms, base.quote_terms),
    invoice_footer: pick(r.invoice_footer, base.invoice_footer ?? null),
      company_number: r.company_number || null,
      tax_number: r.tax_number || null,
      registration: registrationLine(r),
  };
}
