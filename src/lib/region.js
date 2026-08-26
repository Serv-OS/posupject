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

/** Normalise free-typed input to E.164 for dialling/SMS. Mirrors the server's
 *  _shared/phone.ts toE164 — see the rule ordering comments below. */
export function toE164(raw, defaultCountry = 'GB') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  // '+44 (0)7576…' → the written trunk zero goes.
  const noTrunk = trimmed.replace(/^\+(\d+)\s*\(0\)/, '+$1');
  // US punctuation decides the country before the digits do — NANP area codes
  // can start with 7 (702, 713, 718…), so '(713) 555-0123' must never go +44.
  if (/^\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]?\d{4}$/.test(trimmed) ||
      /^[2-9]\d{2}[.-]\d{3}[.-]\d{4}$/.test(trimmed)) {
    return '+1' + trimmed.replace(/\D/g, '');
  }
  const n = noTrunk.replace(/[\s().-]/g, '');
  if (!n) return null;
  if (n.startsWith('+')) {
    const fixed = /^\+440\d{10}$/.test(n) ? '+44' + n.slice(4) : n;
    return /^\+\d{7,15}$/.test(fixed) ? fixed : null;
  }
  const d = n.replace(/\D/g, '');
  if (n.startsWith('00')) return d.length >= 9 ? '+' + d.slice(2) : null;
  if (d.startsWith('44') && d.length === 12) return '+' + d;
  if (d.startsWith('0') && d.length === 11) return '+44' + d.slice(1);
  if (d.length === 11 && d.startsWith('1') && /[2-9]/.test(d[1])) return '+' + d;
  if (d.length === 10) {
    // Bare 10 digits starting 7 is ambiguous (UK mobile minus its 0 vs a 7xx
    // US area code) — the caller's defaultCountry decides.
    if (d.startsWith('7')) return defaultCountry === 'US' ? '+1' + d : '+44' + d;
    if (/[2-9]/.test(d[0])) return '+1' + d;
  }
  if (defaultCountry === 'US' && d.length >= 7) return '+1' + d;
  return null;
}
