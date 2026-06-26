import { supabase } from './supabase';

// White-label theming. The design system resolves its primary/secondary colours
// from CSS variables (--c-primary / --c-uv), so we can re-theme the whole app at
// runtime by overriding those vars from each instance's support_settings row.

// "#15C26A" -> "21 194 106" (the space-separated triplet the rgb(var()) pattern needs)
function hexToTriplet(hex) {
  if (!hex) return null;
  let m = String(hex).trim().replace('#', '');
  if (m.length === 3) m = m.split('').map(c => c + c).join('');
  if (m.length !== 6) return null;
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return `${r} ${g} ${b}`;
}

// Darken a hex by a ratio, return a triplet (used for the *-deep shade)
function darkenTriplet(hex, amt = 0.13) {
  const t = hexToTriplet(hex);
  if (!t) return null;
  const [r, g, b] = t.split(' ').map(Number);
  const d = v => Math.max(0, Math.round(v * (1 - amt)));
  return `${d(r)} ${d(g)} ${d(b)}`;
}

// Apply a settings object immediately (used on load and for live preview on save)
export function applyBrandingValues(s = {}) {
  const root = document.documentElement;
  const primary = hexToTriplet(s.primary_color);
  if (primary) {
    root.style.setProperty('--c-primary', primary);
    const deep = darkenTriplet(s.primary_color);
    if (deep) root.style.setProperty('--c-primary-deep', deep);
  }
  const secondary = hexToTriplet(s.secondary_color);
  if (secondary) {
    root.style.setProperty('--c-uv', secondary);
    const deep = darkenTriplet(s.secondary_color);
    if (deep) root.style.setProperty('--c-uv-deep', deep);
  }
  const name = s.app_name || s.business_name;
  if (name) document.title = name;
}

// Per-deployment tax regime (e.g. 'UK_VAT'), cached at load. Gates UK-only Finance
// features (VAT reclaim, MTD export) so non-UK clones aren't forced into UK tax logic.
let _taxRegime = null;
export function taxRegime() { return _taxRegime; }
export function isUkVat() { return _taxRegime === 'UK_VAT'; }

// Fetch this instance's branding and apply it. Safe if columns don't exist yet.
export async function loadBranding() {
  try {
    const { data } = await supabase
      .from('public_branding')
      .select('app_name, business_name, primary_color, secondary_color, tax_regime')
      .maybeSingle();
    if (data) { applyBrandingValues(data); _taxRegime = data.tax_regime ?? null; }
  } catch {
    /* columns may not exist on older instances — keep compiled defaults */
  }
}
