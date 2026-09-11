// The secure half of the onboarding pack, shared by the edge functions.
//
// NO imports, on purpose: src/lib/onboardingForm.test.js imports this file
// directly to prove it agrees with the form definition (src/lib/onboardingForm.js),
// and a Deno URL import would stop vitest loading it.
//
// What is secure: bank numbers, the legal representative's date of birth and
// home address, and their photo ID. None of it ever sits in
// onboarding_form_requests.answers, which every logged in user can read, or in
// the attachments bucket, where any logged in user can read, list and delete
// every object. Values live in onboarding_form_secure and files in the private
// onboarding-secure bucket, both readable by the owner only (migration 114).
// answers._held says which keys are held; the only hint it carries is the last
// 4 digits of the account number.

type Region = "UK" | "US";
type Obj = Record<string, unknown>;

export interface SecureFile {
  path: string;
  name: string;
  size: number;
  mime: string;
}

/** 'section.field' keys whose values live in onboarding_form_secure.secure_values.
 *  Same order as the definition; the test checks they are equal. */
export const SECURE_VALUE_KEYS: readonly string[] = [
  "bank.sort_code",
  "bank.routing_number",
  "bank.account_number",
  "representative.dob",
  "representative.home_address",
];

/** 'section.field' keys whose files live in the onboarding-secure bucket. */
export const SECURE_FILE_KEYS: readonly string[] = [
  "representative.id_passport",
  "representative.id_front",
  "representative.id_back",
];

export const SECURE_BUCKET = "onboarding-secure";
// JPEG rather than HEIC because an iPhone hands over a JPEG when the input
// accepts only these, and every payment provider reads all three.
export const SECURE_MIME: readonly string[] = ["image/jpeg", "image/png", "application/pdf"];
export const MAX_SECURE_BYTES = 10 * 1024 * 1024;

export const isSecureValueKey = (key: string): boolean => SECURE_VALUE_KEYS.includes(key);
export const isSecureFileKey = (key: string): boolean => SECURE_FILE_KEYS.includes(key);
export const isSecureKey = (key: string): boolean => isSecureValueKey(key) || isSecureFileKey(key);

/** The two faces of a card ID (a licence or an ID card). Both types use the
 *  same keys, so each file records which type it was uploaded as. */
export const ID_CARD_KEYS: readonly string[] = ["representative.id_front", "representative.id_back"];

const str = (v: unknown): string => String(v ?? "").trim();
const obj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});

/** A section or field key a customer's page may write: letters, digits and
 *  underscores, as the definition writes them. Never one starting with _
 *  (_held and _meta are ours), and never a name every object already has, such
 *  as constructor or toString. `out[key]` on one of those reaches the object's
 *  own machinery: a save keyed "constructor" once wrote over Object.entries for
 *  every request on that worker. */
export function validPackKey(key: unknown): boolean {
  return typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/.test(key) && !(key in Object.prototype);
}

/** UK or US questions, decided by us and never asked. The venue's country
 *  first, then the company's, and nothing at all is the UK. Mirrors regionFor
 *  in src/lib/onboardingForm.js. */
export function regionFor(locationCountry?: string | null, companyCountry?: string | null): Region {
  const isUs = (c: unknown) => ["US", "USA"].includes(str(c).toUpperCase());
  if (str(locationCountry)) return isUs(locationCountry) ? "US" : "UK";
  return isUs(companyCountry) ? "US" : "UK";
}

/** The hint stored in answers._held, which staff and the customer's link can
 *  see: the last 4 digits of the account number, and nothing for anything
 *  else. Short account numbers get no hint, so "ending 1234" can never be the
 *  whole of a 4 digit US account number. */
export function hintFor(key: string, value: unknown): string | null {
  if (key !== "bank.account_number") return null;
  const d = String(value ?? "").replace(/\D/g, "");
  return d.length >= 6 ? d.slice(-4) : null;
}

/** The answers._held entry for a key: {hint} for the account number, true otherwise. */
export function heldEntry(key: string, value: unknown): { hint: string } | true {
  const hint = hintFor(key, value);
  return hint ? { hint } : true;
}

export type HeldEntry = { hint: string } | { doc: string } | true;

/** The whole answers._held for a secure row: every key with a value or a file.
 *  Built from the row rather than patched key by key, so it can only ever say
 *  what is really held. Keys follow the list order, so two builds of the same
 *  row compare equal as JSON. A card face carries {doc}, the ID type it was
 *  uploaded as, so a licence photo is never counted as the ID card's. */
export function heldFrom(values: unknown, files: unknown): Record<string, HeldEntry> {
  const vals = obj(values);
  const fs = obj(files);
  const out: Record<string, HeldEntry> = {};
  for (const k of SECURE_VALUE_KEYS) {
    if (typeof vals[k] === "string" && str(vals[k])) out[k] = heldEntry(k, vals[k]);
  }
  for (const k of SECURE_FILE_KEYS) {
    const f = obj(fs[k]);
    if (typeof f.path !== "string" || !f.path) continue;
    out[k] = ID_CARD_KEYS.includes(k) && typeof f.doc === "string" && str(f.doc) ? { doc: str(f.doc) } : true;
  }
  return out;
}

/** Whether a held card face belongs to the ID type chosen now. A file saved
 *  before the type was recorded has no doc and still counts. */
export function idFileFits(key: string, file: unknown, answers: Obj | null | undefined): boolean {
  if (!ID_CARD_KEYS.includes(key)) return true;
  const doc = obj(file).doc;
  if (typeof doc !== "string" || !str(doc)) return true;
  return str(doc) === str(obj(obj(answers).representative).id_type);
}

/** The sign off wording the server stamps on a pack as _meta.terms_version.
 *  Mirrors TERMS_VERSION in src/lib/onboardingForm.js: bump both together. */
export const TERMS_VERSION = 2;

/** Which secure keys the customer is being asked for, given their answers.
 *  Mirrors the showIf rules of those eight fields in the definition, and the
 *  test checks it against them. Anything held for a key not in this set is
 *  deleted at submit, so switching from a licence to a passport never leaves
 *  the licence images behind. */
export function secureVisible(answers: Obj | null | undefined, region: string): Set<string> {
  const us = String(region ?? "").toUpperCase() === "US";
  const rep = obj(obj(answers).representative);
  const out = new Set<string>([
    us ? "bank.routing_number" : "bank.sort_code",
    "bank.account_number",
    "representative.dob",
  ]);
  if (rep.home_same === "No") out.add("representative.home_address");
  if (rep.id_type === "Passport") out.add("representative.id_passport");
  else if (str(rep.id_type)) {
    out.add("representative.id_front");
    out.add("representative.id_back");
  }
  return out;
}

/** US routing number checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ends in 0. */
export function validAba(v: unknown): boolean {
  const s = String(v ?? "");
  if (!/^\d{9}$/.test(s) || /^0+$/.test(s)) return false;
  const d = s.split("").map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// A real YYYY-MM-DD date, 1900 or later, and 18 or over. The page checks age
// against the customer's own calendar and this runs on UTC, so the server
// allows one day's grace: someone saving on their 18th birthday in a time zone
// ahead of UTC is never refused after the page said yes.
function dobOk(ymd: string, now: Date): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (d < 1 || d > (mo === 2 && leap ? 29 : DAYS_IN_MONTH[mo - 1])) return false;
  const t = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const [ty, tm, td] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  const age = ty - y - (tm < mo || (tm === mo && td < d) ? 1 : 0);
  return age >= 18;
}

/** Basic server checks before a secure value is stored. The page has already
 *  normalised the value (bare digits, YYYY-MM-DD), so anything else is refused
 *  rather than guessed at. A key for the other region is refused too, so a US
 *  pack can never end up holding a sort code. */
export function serverValid(key: string, value: unknown, region: string, now: Date = new Date()): boolean {
  if (typeof value !== "string") return false;
  const us = String(region ?? "").toUpperCase() === "US";
  switch (key) {
    case "bank.sort_code":
      return !us && /^\d{6}$/.test(value);
    case "bank.routing_number":
      return us && validAba(value);
    case "bank.account_number":
      return us ? /^\d{4,17}$/.test(value) : /^\d{8}$/.test(value);
    case "representative.dob":
      return dobOk(value, now);
    case "representative.home_address": {
      const n = value.trim().length;
      return n >= 5 && n <= 500;
    }
    default:
      return false;
  }
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };
const DISPLAY: Record<string, string> = {
  "representative.id_passport": "Passport photo page",
  "representative.id_front": "Photo ID front",
  "representative.id_back": "Photo ID back",
};

/** The file extension for an allowed mime type, or null when it is not allowed. */
export const extForMime = (mime: string): string | null => EXT[mime] ?? null;

/** Where a secure file is stored: <request_id>/<field_key>-<id>.<ext>. The
 *  field key is in the path so a passport page can never be relabelled as a
 *  licence front. */
export function securePath(requestId: string, key: string, mime: string, id: string): string | null {
  const ext = extForMime(mime);
  if (!isSecureFileKey(key) || !ext) return null;
  return `${requestId}/${key.split(".")[1]}-${id}.${ext}`;
}

/** A neutral display name such as "Passport photo page.jpg". Never the
 *  customer's own file name, which often has their name in it. */
export function secureFileName(key: string, mime: string): string {
  return `${DISPLAY[key] || "Photo ID"}.${extForMime(mime) || "file"}`;
}

/** A file value the customer's page may store under a secure key: one
 *  {path, name, size, mime}, inside this request's own folder and under this
 *  field's own prefix, an allowed type, 10MB or less. */
export function secureFileValid(key: string, file: unknown, requestId: string): file is SecureFile {
  if (!isSecureFileKey(key) || !requestId || !file || typeof file !== "object" || Array.isArray(file)) return false;
  const f = file as Obj;
  const prefix = `${requestId}/${key.split(".")[1]}-`;
  return typeof f.path === "string" && f.path.startsWith(prefix)
    && /^[A-Za-z0-9-]{8,64}\.(jpg|png|pdf)$/.test(f.path.slice(prefix.length))
    && typeof f.name === "string"
    && typeof f.size === "number" && f.size > 0 && f.size <= MAX_SECURE_BYTES
    && typeof f.mime === "string" && SECURE_MIME.includes(f.mime);
}

/** What the activity note says instead of the summary when the summary holds
 *  a secure value. */
export const NOTE_WITHHELD = "Summary withheld. See the onboarding pack.";

// Lowercase with every run of spaces and line breaks as one space, so an
// address typed over three lines still matches one written with commas.
const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Belt and braces for the activity note, which every logged in user reads.
 *  The summary prints "provided, held securely" for every secure field, so it
 *  never legitimately holds a secure value. If one turns up anyway, in any of
 *  the forms people write it (a sort code as 12-34-56 or 12 34 56, a date of
 *  birth as a UK or US date), this says so and the note is withheld whole.
 *  Blanking the value where it sits would not do: "[held securely] Elm St"
 *  hands anyone reading the card, which shows the address, the account number
 *  that was blanked. Values under 4 characters are too short to mean anything. */
export function mentionsSecret(text: string, secrets: readonly unknown[]): boolean {
  const hay = squash(String(text ?? ""));
  if (!hay) return false;
  for (const raw of secrets) {
    const s = str(raw);
    if (s.length < 4) continue;
    const variants = [s];
    if (/^\d{6}$/.test(s)) {
      variants.push(`${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4)}`, `${s.slice(0, 2)} ${s.slice(2, 4)} ${s.slice(4)}`);
    }
    const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (dob) {
      for (const sep of ["/", "-", "."]) {
        variants.push(`${dob[3]}${sep}${dob[2]}${sep}${dob[1]}`, `${dob[2]}${sep}${dob[3]}${sep}${dob[1]}`);
      }
    }
    if (variants.some((v) => hay.includes(squash(v)))) return true;
  }
  return false;
}

/** The note body: the summary, or NOTE_WITHHELD when it mentions a secret. */
export function noteBody(summary: string, secrets: readonly unknown[]): string {
  return mentionsSecret(summary, secrets) ? NOTE_WITHHELD : String(summary ?? "");
}
