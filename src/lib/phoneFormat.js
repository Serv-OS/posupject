// Pure phone number formatting, with no imports.
//
// It lives on its own (rather than in region.js, where it started) because
// region.js imports the Supabase client, and the onboarding form definition and
// its tests need toE164 without dragging a database client along. region.js
// re-exports it, so every existing import keeps working.

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
