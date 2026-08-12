/* How a deal's money is read, in one place.
 *
 * Deals carry five value fields and most rows fill only some of them. The
 * passed-in one-time deals are recorded with just the headline `value`;
 * structured deals break out hardware/services (one-off) and SaaS/payments
 * (recurring). Reporting has to read all of these consistently, so the rules
 * live here and are pinned by tests — not re-derived in every screen.
 *
 * Rules:
 *  - recurring = saas_arr + payments_arr, always.
 *  - one-off  = hardware + services when broken out; otherwise the headline
 *    `value` — but only when there is no recurring component, because on
 *    recurring deals the headline usually restates the ARR and counting it
 *    as one-off would double it.
 *  - total    = one-off + recurring, falling back to the headline when both
 *    are empty.
 */

export function oneOffValue(d) {
  const broken = (d.hardware_value || 0) + (d.services_value || 0);
  if (broken > 0) return broken;
  const rec = (d.saas_arr || 0) + (d.payments_arr || 0);
  return rec > 0 ? 0 : (d.value || 0);
}

export function recurringValue(d) {
  return (d.saas_arr || 0) + (d.payments_arr || 0);
}

export function totalValue(d) {
  return (oneOffValue(d) + recurringValue(d)) || (d.value || 0);
}
