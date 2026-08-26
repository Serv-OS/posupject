// One phone normaliser for both countries we trade in. Replaces four
// near-identical UK-only copies (twilio-inbound-sms, twilio-voicemail,
// twilio-voice-incoming, plus notify-dispatch's e164) that all shared the same
// blind spot: a +1 caller generated zero variants, so US customers could never
// match a stored contact and every US call/text minted a fresh ticket.
//
// Matching here is exact-string OR (PostgREST .or) against unnormalised stored
// numbers, so the job is to emit every format a person plausibly typed in:
//   UK  +447576562085 ↔ 07576562085 ↔ 447576562085 ↔ 7576562085
//   US  +16505550123 ↔ 6505550123 ↔ 16505550123 ↔ (650) 555-0123 ↔ 650-555-0123

export const digitsOf = (s: string): string => (s || "").replace(/\D/g, "");

/** Every stored format that could mean the same number as `raw`. */
export function phoneVariants(raw: string): string[] {
  const n = (raw || "").replace(/\s/g, "");
  if (!n) return [];
  const out = new Set<string>([n]);
  const d = digitsOf(n);

  // UK: mobile/geographic national numbers are 0 + 10 digits.
  if (n.startsWith("+44")) {
    out.add("0" + n.slice(3));
    out.add(n.slice(1));       // 447...
    // Bare 10-digit only for MOBILES (75xx..79xx — a real stored shape in this
    // DB). Emitting it for geographic numbers collided with US area codes:
    // +44 20 7946 0123 (London) and +1 207 946 0123 (Maine) share the string
    // '2079460123', which threaded the wrong customer's ticket.
    if (n[3] === "7") out.add(n.slice(3));
  } else if (n.startsWith("0") && d.length === 11) {
    out.add("+44" + n.slice(1));
    out.add("44" + n.slice(1));
  } else if (n.startsWith("44") && d.length === 12) {
    out.add("+" + n);
    out.add("0" + n.slice(2));
  }

  // US/Canada: NANP is 1 + 10 digits, area code never starts 0 or 1.
  const usTen = (t: string) => {
    out.add("+1" + t);
    out.add("1" + t);
    out.add(t);
    out.add(`(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}`);
    out.add(`${t.slice(0, 3)}-${t.slice(3, 6)}-${t.slice(6)}`);
  };
  if (n.startsWith("+1") && d.length === 11) usTen(d.slice(1));
  else if (d.length === 11 && d.startsWith("1") && /[2-9]/.test(d[1])) usTen(d.slice(1));
  else if (d.length === 10 && /[2-9]/.test(d[0])) usTen(d);

  return [...out];
}

/** Normalise free-typed input to E.164. The rules, in order of certainty:
 *  - US punctuation ((713) 555-0123, 713-555-0123) marks a number as US before
 *    anything else — NANP area codes CAN start with 7 (702, 713, 718, 770...),
 *    so the digits alone cannot decide those.
 *  - '+44 (0)7576…' loses its written trunk zero.
 *  - A bare 10-digit starting 7 is genuinely ambiguous (UK mobile minus its 0
 *    vs a 7xx US area code): defaultCountry decides — callers that know the
 *    recipient's region must pass it.
 *  Returns null when the input cannot be a dialable number. */
export function toE164(raw: string, defaultCountry: "GB" | "US" = "GB"): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  // Written trunk zero: '+44 (0)7576 562085' means +447576562085.
  const noTrunk = trimmed.replace(/^\+(\d+)\s*\(0\)/, "+$1");
  // US national punctuation is a country claim in itself.
  if (/^\(?[2-9]\d{2}\)?[\s.\-]\d{3}[\s.\-]?\d{4}$/.test(trimmed) ||
      /^[2-9]\d{2}[.\-]\d{3}[.\-]\d{4}$/.test(trimmed)) {
    return "+1" + digitsOf(trimmed);
  }
  const n = noTrunk.replace(/[\s()\-\.]/g, "");
  if (!n) return null;
  if (n.startsWith("+")) {
    // A retained trunk zero after the country code is never dialable.
    const fixed = /^\+440\d{10}$/.test(n) ? "+44" + n.slice(4) : n;
    return /^\+\d{7,15}$/.test(fixed) ? fixed : null;
  }
  const d = digitsOf(n);
  if (n.startsWith("00")) return d.length >= 9 ? "+" + d.slice(2) : null;
  if (d.startsWith("44") && d.length === 12) return "+" + d;
  if (d.startsWith("0") && d.length === 11) return "+44" + d.slice(1);
  if (d.length === 11 && d.startsWith("1") && /[2-9]/.test(d[1])) return "+" + d;
  if (d.length === 10) {
    if (d.startsWith("7")) return defaultCountry === "US" ? "+1" + d : "+44" + d;
    if (/[2-9]/.test(d[0])) return "+1" + d;            // US local format
  }
  if (defaultCountry === "US" && d.length >= 7) return "+1" + d;
  return null;
}

/** 'US' for +1, 'UK' for +44, null when neither. */
export function regionOfNumber(raw: string): "UK" | "US" | null {
  const e = toE164(raw) || (raw || "").replace(/\s/g, "");
  if (e.startsWith("+1")) return "US";
  if (e.startsWith("+44")) return "UK";
  return null;
}

/** Same line? Normalise both sides first, so a region number saved in a
 *  national format ('07576 562085') still matches Twilio's '+447576562085';
 *  digit equality is the fallback for anything toE164 can't read. */
export const sameNumber = (a: string, b: string): boolean => {
  const ea = toE164(a), eb = toE164(b);
  if (ea && eb) return ea === eb;
  const da = digitsOf(a), db = digitsOf(b);
  return !!da && !!db && da === db;
};
