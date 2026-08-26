// Region resolution for a business trading in the UK and the US at once.
//
// support_regions holds what differs per region (line, hours+timezone, voice,
// copy, currency, tax, seller identity); support_settings stays the global
// brand and the FALLBACK. effective() merges the two so a region column left
// NULL behaves exactly as the singleton always did — meaning nothing changes
// for a deployment that never configures regions.
//
// Who decides the region:
//   inbound  → the Twilio number that was dialled/texted (webhook To field)
//   outbound → the recipient's country prefix (+1 US, +44 UK)

import { regionOfNumber, sameNumber, toE164 } from "./phone.ts";

export interface SupportRegion {
  code: "UK" | "US";
  label: string;
  country_code: string;
  currency: "GBP" | "USD";
  tax_label: string;
  default_tax_rate: number;
  tax_regime: string | null;
  twilio_number: string | null;
  business_phone: string | null;
  business_timezone: string;
  business_hours_enabled: boolean;
  business_hours: Record<string, { open?: string; close?: string; closed?: boolean }> | null;
  voice_id: string | null;
  voice_greeting: string | null;
  voicemail_prompt: string | null;
  after_hours_voicemail_prompt: string | null;
  auto_reply_sms_message: string | null;
  after_hours_sms_message: string | null;
  business_name: string | null;
  business_address: string | null;
  business_email: string | null;
  active: boolean;
}

// deno-lint-ignore no-explicit-any
type Sb = any;

/** All active regions. Empty array on any failure (missing table, older DB) so
 *  every caller degrades to single-region behaviour instead of erroring. */
export async function loadRegions(supabase: Sb): Promise<SupportRegion[]> {
  try {
    const { data, error } = await supabase.from("support_regions").select("*").eq("active", true);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

/** The region whose line this is — matched on digits, because the singleton's
 *  number was stored with spaces and exact-match against that never worked. */
export function regionForTwilioNumber(regions: SupportRegion[], num: string | null | undefined): SupportRegion | null {
  if (!num) return null;
  return regions.find((r) => r.twilio_number && sameNumber(r.twilio_number, num)) || null;
}

/** The region a message/call TO this person should come from. Prefix first;
 *  an unparseable number defaults to UK, the incumbent behaviour. */
export function regionForRecipient(regions: SupportRegion[], phone: string | null | undefined): SupportRegion | null {
  const code = regionOfNumber(phone || "") || "UK";
  return regions.find((r) => r.code === code) || regions.find((r) => r.code === "UK") || null;
}

export function regionByCode(regions: SupportRegion[], code: string | null | undefined): SupportRegion | null {
  if (!code) return null;
  return regions.find((r) => r.code === code) || null;
}

/** Region value where set, singleton value where not. `settings` is whatever
 *  columns the caller already selects from support_settings id=1. */
// deno-lint-ignore no-explicit-any
export function effective(region: SupportRegion | null, settings: any): any {
  const s = settings || {};
  if (!region) return s;
  const pick = (a: unknown, b: unknown) => (a === null || a === undefined || a === "" ? b : a);
  return {
    ...s,
    region_code: region.code,
    currency: region.currency,
    tax_label: region.tax_label,
    default_tax_rate: region.default_tax_rate,
    twilio_number: pick(region.twilio_number, s.twilio_number),
    business_phone: pick(region.business_phone, s.business_phone),
    business_timezone: pick(region.business_timezone, s.business_timezone),
    // Hours are region-owned outright: a US line evaluated on UK hours would
    // send every US-afternoon caller to voicemail.
    business_hours_enabled: region.business_hours_enabled,
    business_hours: pick(region.business_hours, s.business_hours),
    voice_id: pick(region.voice_id, s.voice_id),
    voice_greeting: pick(region.voice_greeting, s.voice_greeting),
    voicemail_prompt: pick(region.voicemail_prompt, s.voicemail_prompt),
    after_hours_voicemail_prompt: pick(region.after_hours_voicemail_prompt, s.after_hours_voicemail_prompt),
    auto_reply_sms_message: pick(region.auto_reply_sms_message, s.auto_reply_sms_message),
    after_hours_sms_message: region.after_hours_sms_message,
    business_name: pick(region.business_name, s.business_name),
    business_address: pick(region.business_address, s.business_address),
    business_email: pick(region.business_email, s.business_email),
  };
}

/** The number to place an outbound call/SMS from, for this recipient.
 *  Falls back through the UK region's line to the env secret, so a deployment
 *  with no regions configured keeps today's behaviour to the byte. */
export function fromNumberFor(regions: SupportRegion[], recipient: string | null | undefined, envFallback: string): string {
  // Twilio rejects a non-E.164 From outright, so a region number saved in a
  // national format must be normalised — and if it can't be, the always-valid
  // env number beats a number that will bounce every send.
  const dialable = (num: string | null | undefined, country: "GB" | "US") =>
    num ? toE164(num, country) : null;
  const r = regionForRecipient(regions, recipient);
  const own = dialable(r?.twilio_number, r?.code === "US" ? "US" : "GB");
  if (own) return own;
  const uk = regions.find((x) => x.code === "UK");
  return dialable(uk?.twilio_number, "GB") || envFallback;
}
