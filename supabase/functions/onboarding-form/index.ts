// onboarding-form — the customer's side of the onboarding pack. Public by
// design (the customer has no login), so the token IS the credential and this
// function is the only way in.
//
// Four actions, all keyed on that token:
//   load        what to show: the venue, UK or US questions, and the draft so
//               far. Once the pack is submitted it returns no answers at all:
//               the link outlives the job, and the pack holds a WiFi password.
//   save        one patch of changed answers, merged field by field under an
//               updated_at lock, so the page saves as the customer goes and two
//               phones cannot wipe each other's answers.
//   upload-url  a short-lived signed URL so the browser can PUT a file straight
//               into the private bucket. Files never travel through this
//               function — a menu PDF or a table plan would blow the request
//               limit, and a signed URL keeps the bucket closed to everyone else.
//   submit      the final merge, then attach every uploaded file to the LOCATION
//
// Bank numbers, date of birth, home address and photo ID are secure (the key
// lists are in _shared/onboardingSecure.ts). They never go into answers, which
// every logged in user can read, and never into the attachments bucket, where
// every logged in user can read, list and delete. Values go to
// onboarding_form_secure and files to the onboarding-secure bucket, both owner
// only (migration 114), and this function, holding the service role, is the
// only thing that writes either. answers._held says which keys are held, with
// the last 4 digits of the account number as its only hint.
//
// It never returns anything the customer should not see: no ids beyond their own
// request, no other venues, no CRM data, and never a secure value, not even to
// the customer who typed it. Request bodies are never logged, because they carry
// exactly those values.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  extForMime,
  heldFrom,
  ID_CARD_KEYS,
  idFileFits,
  isSecureFileKey,
  isSecureKey,
  isSecureValueKey,
  MAX_SECURE_BYTES,
  noteBody,
  regionFor,
  SECURE_BUCKET,
  SECURE_MIME,
  secureFileName,
  secureFileValid,
  securePath,
  secureVisible,
  serverValid,
  TERMS_VERSION,
  validPackKey,
} from "../_shared/onboardingSecure.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const BUCKET = "attachments";
const MAX_BYTES = 25 * 1024 * 1024;

// What one pack may store. Roomy for a real pack (the longest answers, a POS
// user list or a printing plan, run to a few hundred characters) and small
// enough that nobody can fill the row with a script.
const MAX_BODY_CHARS = 1024 * 1024;
const MAX_STRING = 5000;
const MAX_FILES = 20;
const MAX_ANSWERS_BYTES = 256 * 1024;
// The first try plus up to three retries when someone else wrote in between.
const LOCK_TRIES = 4;
// An ID upload that nothing points at after a day was never saved (the signal
// went, or the tab was closed), and nothing else will ever find it.
const STRAY_AFTER_MS = 24 * 60 * 60 * 1000;

const REQ_COLS = "id, location_id, company_id, onboarding_id, answers, submitted_at, sent_to, opened_at, updated_at";

// What the customer reads when something is refused. Plain words, because they
// are on a phone and this is all they will see.
const BAD_LINK = "This link is not valid. Please ask your account manager for a new one.";
const SUBMITTED = "This pack has already been submitted.";
const NOT_IN_PACK = "That question is not part of this pack.";
const CANNOT_SAVE = "That answer could not be saved.";
const TOO_LONG = "One answer is too long to save. Please keep each answer under 5,000 characters.";
const TOO_MANY_FILES = "You can add up to 20 files to one question.";
const TOO_BIG = "This pack is too big to save. Please shorten the longest answers.";
const NOT_THIS_PACK = "That file does not belong to this pack. Please upload it again.";
const NOT_SAVED = "Your answers could not be saved just now. Please try again.";
const NOT_CHECKED = "Your upload could not be checked just now. Please try again.";
const CHECK_BANK = "Some bank details need checking for this venue. Please reload this page and check them.";

// deno-lint-ignore no-explicit-any
type Sb = any;
// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
type Region = "UK" | "US";

// A refusal the customer should see, with the HTTP status that fits it. Thrown
// from deep in a merge and turned into a response in one place.
class Refusal extends Error {
  status: number;
  field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

// Two different jobs, deliberately not one function:
//  safeName — what the team SEES in the attachments list, so "Spring Menu.pdf"
//             stays readable.
//  pathSafe — what the file is STORED as. Spaces and punctuation in an object
//             key have to survive a signed URL round-trip, and the quickest way
//             to guarantee that is to not put them there.
const safeName = (n: string) =>
  (n || "file").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
const pathSafe = (n: string) =>
  safeName(n).replace(/\s+/g, "_").replace(/_+/g, "_");

const str = (v: unknown) => String(v ?? "").trim();
const isPlain = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isPlain(v) ? v : {});
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

// The lock compares updated_at, so a write must never stamp the value it read,
// even when two writes land in the same millisecond or two servers' clocks
// disagree.
function nextStamp(prev: unknown): string {
  const now = Date.now();
  const p = Date.parse(String(prev ?? ""));
  return new Date(Number.isFinite(p) && p >= now ? p + 1 : now).toISOString();
}

// The region stamped on the pack: on a submitted pack, the one it was answered
// in, which wins even if someone later changes the venue's country; on a draft,
// the one its last save was checked against.
function stampedRegion(row: Obj | null): Region | null {
  const r = obj(obj(row?.answers)._meta).region;
  return r === "UK" || r === "US" ? r : null;
}

// ── Answers ─────────────────────────────────────────────────────────────────

// A file stored for an ordinary question. It must be one this pack uploaded,
// which upload-url always puts under onboarding/<request id>/, so a patch can
// never point our team at another customer's file. Only the four props the page
// writes are kept, in the order it writes them.
function plainFile(v: unknown, rid: string): Obj | null {
  if (!isPlain(v) || typeof v.path !== "string") return null;
  const path = v.path;
  if (!path.startsWith(`onboarding/${rid}/`) || path.length > 1024 || path.includes("..") || /[\\\x00-\x1f]/.test(path)) {
    return null;
  }
  const size = Number(v.size);
  return {
    name: String(v.name ?? "").slice(0, 255),
    path,
    size: v.size != null && Number.isFinite(size) && size >= 0 ? size : null,
    mime: typeof v.mime === "string" ? v.mime.slice(0, 255) : null,
  };
}

// A change to a question that takes several files (the menu, the table plan),
// sent as the files to have and the paths to take away rather than the whole
// list. Two phones each adding a menu page would otherwise each save a list
// without the other's, and one page would silently vanish from the pack.
class FileSetChange {
  add: Obj[];
  remove: string[];
  constructor(add: Obj[], remove: string[]) {
    this.add = add;
    this.remove = remove;
  }
}

// One ordinary answer, checked. null removes the field.
function plainValue(key: string, v: unknown, rid: string): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (Number.isFinite(v)) return v;
    throw new Refusal(400, CANNOT_SAVE, key);
  }
  if (typeof v === "string") {
    if (v.length > MAX_STRING) throw new Refusal(413, TOO_LONG, key);
    return v;
  }
  const checkFiles = (items: unknown[]): Obj[] => {
    if (items.length > MAX_FILES) throw new Refusal(413, TOO_MANY_FILES, key);
    return items.map((item) => {
      const file = plainFile(item, rid);
      if (!file) throw new Refusal(400, isPlain(item) && typeof item.path === "string" ? NOT_THIS_PACK : CANNOT_SAVE, key);
      return file;
    });
  };
  if (Array.isArray(v)) return checkFiles(v);
  if (isPlain(v) && !has(v, "path") && (Array.isArray(v.add) || Array.isArray(v.remove))) {
    const remove = Array.isArray(v.remove) ? v.remove : [];
    // Paths to take away are only compared, never used to reach storage, but
    // they are capped all the same.
    if (remove.length > 200 || remove.some((p: unknown) => typeof p !== "string" || p.length > 1024)) {
      throw new Refusal(400, CANNOT_SAVE, key);
    }
    return new FileSetChange(checkFiles(Array.isArray(v.add) ? v.add : []), remove);
  }
  const file = plainFile(v, rid);
  if (!file) throw new Refusal(400, isPlain(v) && typeof v.path === "string" ? NOT_THIS_PACK : CANNOT_SAVE, key);
  return file;
}

interface Patch {
  plain: Record<string, Record<string, unknown>>;
  values: Map<string, unknown>; // secure values as sent, not yet checked
  files: Map<string, unknown>; // secure files as sent, not yet checked
  typed: string[]; // every string sent under a secure key, kept out of the note
}

// Splits a patch into ordinary answers (checked here) and secure ones (checked
// against the region and the bucket by the caller).
//   'save'   a key starting with _ is refused; secure keys are collected.
//   'final'  an old page's whole answers at submit: _ keys and secure keys are
//            dropped, as the old page never had a secure place to send them.
// A key such as "constructor" is refused in both: see validPackKey.
function splitPatch(patch: unknown, rid: string, mode: "save" | "final"): Patch {
  if (!isPlain(patch)) throw new Refusal(400, CANNOT_SAVE);
  const out: Patch = { plain: {}, values: new Map(), files: new Map(), typed: [] };
  for (const [sk, section] of Object.entries(patch)) {
    if (sk.startsWith("_") && mode === "final") continue;
    if (!validPackKey(sk) || !isPlain(section)) throw new Refusal(400, NOT_IN_PACK, sk);
    for (const [fk, value] of Object.entries(section)) {
      const key = `${sk}.${fk}`;
      if (fk.startsWith("_") && mode === "final") continue;
      if (!validPackKey(fk)) throw new Refusal(400, NOT_IN_PACK, key);
      if (isSecureKey(key)) {
        if (typeof value === "string") out.typed.push(value);
        if (mode === "final") continue;
        if (isSecureValueKey(key)) out.values.set(key, value);
        else out.files.set(key, value);
        continue;
      }
      // An own property check, not a truthy one: out.plain.constructor is
      // always there on a plain object.
      if (!has(out.plain, sk)) out.plain[sk] = {};
      out.plain[sk][fk] = plainValue(key, value, rid);
    }
  }
  return out;
}

// Stored files, less the ones taken away, plus the ones added, each path once,
// in the order they arrived.
function mergeFileSet(current: unknown, change: FileSetChange, key: string): Obj[] | null {
  const gone = new Set(change.remove);
  const seen = new Set<string>();
  const out: Obj[] = [];
  const have = Array.isArray(current) ? current : isPlain(current) ? [current] : [];
  for (const f of [...have, ...change.add]) {
    const p = isPlain(f) && typeof f.path === "string" ? f.path : "";
    if (!p || gone.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(f);
  }
  if (out.length > MAX_FILES) throw new Refusal(413, TOO_MANY_FILES, key);
  return out.length ? out : null;
}

// Stored answers with a patch merged in, field by field. Copies, never mutates
// what was read, so a retry after losing the lock starts clean. Any secure key
// found in answers is removed on the way through: it should never be there.
function mergeAnswers(stored: unknown, patch: Record<string, Record<string, unknown>>): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(obj(stored))) out[k] = isPlain(v) ? { ...v } : v;
  for (const [sk, fields] of Object.entries(patch)) {
    const section: Obj = has(out, sk) && isPlain(out[sk]) ? out[sk] : {};
    for (const [fk, v] of Object.entries(fields)) {
      const next = v instanceof FileSetChange ? mergeFileSet(has(section, fk) ? section[fk] : null, v, `${sk}.${fk}`) : v;
      if (next === null) delete section[fk];
      else section[fk] = next;
    }
    if (Object.keys(section).length) out[sk] = section;
    else delete out[sk];
  }
  for (const [sk, section] of Object.entries(out)) {
    if (sk.startsWith("_") || !isPlain(section)) continue;
    for (const fk of Object.keys(section)) if (isSecureKey(`${sk}.${fk}`)) delete section[fk];
  }
  return out;
}

// What load hands the page: the draft, without our own keys except the two the
// page needs (_held and _meta), and never a secure key.
function draftAnswers(stored: unknown): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(mergeAnswers(stored, {}))) {
    if (k.startsWith("_") && k !== "_held" && k !== "_meta") continue;
    out[k] = v;
  }
  return out;
}

// Every ordinary file in the answers, by path.
function storedFiles(answers: Obj, rid: string): Map<string, Obj> {
  const out = new Map<string, Obj>();
  for (const [sk, section] of Object.entries(answers)) {
    if (sk.startsWith("_") || !isPlain(section)) continue;
    for (const [fk, v] of Object.entries(section)) {
      if (isSecureKey(`${sk}.${fk}`)) continue;
      for (const item of Array.isArray(v) ? v : [v]) {
        const file = plainFile(item, rid);
        if (file && !out.has(file.path)) out.set(file.path, file);
      }
    }
  }
  return out;
}

async function readRequest(sb: Sb, rid: string): Promise<Obj | null> {
  const { data, error } = await sb.from("onboarding_form_requests").select(REQ_COLS).eq("id", rid).maybeSingle();
  if (error) throw new Error("Could not read the pack.");
  return data || null;
}

// ── Secure store ────────────────────────────────────────────────────────────

interface SecureState {
  values: Obj;
  files: Obj;
  before: { values: Obj; files: Obj }; // the row as read, before this change
  changed: boolean;
  removed: string[]; // bucket paths no longer referenced after the write
}

const filePaths = (files: Obj): string[] =>
  Object.values(files).map((f) => obj(f).path).filter((p): p is string => typeof p === "string" && !!p);

async function readSecure(sb: Sb, rid: string): Promise<{ row: Obj | null; values: Obj; files: Obj }> {
  const { data, error } = await sb.from("onboarding_form_secure")
    .select("secure_values, files, updated_at").eq("request_id", rid).maybeSingle();
  if (error) throw new Error("Could not read the secure details.");
  return { row: data || null, values: { ...obj(data?.secure_values) }, files: { ...obj(data?.files) } };
}

// Read, change and write the pack's secure row under the same kind of
// updated_at lock as the answers, so two saves cannot drop each other's
// details. mutate edits the copies and says whether anything changed. Returns
// null when the lock kept losing.
async function writeSecure(
  sb: Sb,
  rid: string,
  mutate: (values: Obj, files: Obj) => boolean,
): Promise<SecureState | null> {
  for (let i = 0; i < LOCK_TRIES; i++) {
    const { row, values, files } = await readSecure(sb, rid);
    const before = { values: { ...values }, files: { ...files } };
    if (!mutate(values, files)) return { values, files, before, changed: false, removed: [] };
    const after = new Set(filePaths(files));
    const removed = filePaths(before.files).filter((p) => !after.has(p));
    const stamp = nextStamp(row?.updated_at);
    if (row) {
      const { data, error } = await sb.from("onboarding_form_secure")
        .update({ secure_values: values, files, updated_at: stamp })
        .eq("request_id", rid).eq("updated_at", row.updated_at)
        .select("request_id");
      if (error) throw new Error("Could not save the secure details.");
      if (data?.length) return { values, files, before, changed: true, removed };
    } else {
      // No row yet. There is no insert policy for anyone else: the service role
      // is the only way a row is ever created.
      const { error } = await sb.from("onboarding_form_secure")
        .insert({ request_id: rid, secure_values: values, files, updated_at: stamp });
      if (!error) return { values, files, before, changed: true, removed };
      // 23505: another save created the row first. Read it and go again.
      if (error.code !== "23505") throw new Error("Could not save the secure details.");
    }
  }
  return null;
}

// Drops every held value that does not fit a region's questions: a sort code
// on a pack now asking US questions, or a 12 digit account number on a UK one.
// For writeSecure; says whether anything went.
const dropUnfit = (region: Region) => (values: Obj): boolean => {
  let changed = false;
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== "string" || !serverValid(k, v, region)) {
      delete values[k];
      changed = true;
    }
  }
  return changed;
};

// The secure details a pack keeps for its answers and region: only questions
// being asked, bank numbers that fit that region's questions, and card faces
// uploaded as the ID type chosen now.
function keepSecure(values: Obj, files: Obj, answers: Obj, region: Region): { values: Obj; files: Obj } {
  const visible = secureVisible(answers, region);
  const kept: { values: Obj; files: Obj } = { values: {}, files: {} };
  for (const [k, v] of Object.entries(values)) {
    if (visible.has(k) && typeof v === "string" && serverValid(k, v, region)) kept.values[k] = v;
  }
  for (const [k, f] of Object.entries(files)) {
    if (visible.has(k) && idFileFits(k, f, answers)) kept.files[k] = f;
  }
  return kept;
}

// Deletes bucket objects, but only inside this pack's own folder.
async function removeObjects(sb: Sb, rid: string, paths: string[]): Promise<void> {
  const mine = [...new Set(paths)].filter((p) => typeof p === "string" && p.startsWith(`${rid}/`) && !p.includes(".."));
  if (!mine.length) return;
  const { error } = await sb.storage.from(SECURE_BUCKET).remove(mine);
  if (error) console.error("onboarding-form: secure file delete failed", error.message);
}

// What storage holds at a path: its size and type, null when nothing is there,
// or "error" when storage could not be asked. A save may only claim a file that
// really arrived, or the pack would count as having ID it does not have.
async function storedObject(sb: Sb, path: string): Promise<{ size: number | null; mime: string | null } | null | "error"> {
  const cut = path.lastIndexOf("/");
  const name = path.slice(cut + 1);
  const { data, error } = await sb.storage.from(SECURE_BUCKET).list(path.slice(0, cut), { limit: 100, search: name });
  if (error) return "error";
  const hit = (data || []).find((o: Obj) => o?.name === name);
  if (!hit) return null;
  const size = Number(hit.metadata?.size);
  return {
    size: hit.metadata?.size != null && Number.isFinite(size) ? size : null,
    mime: typeof hit.metadata?.mimetype === "string" ? hit.metadata.mimetype : null,
  };
}

// Makes answers._held on the request say exactly what the secure row holds,
// and, when a region is given (drafts only), stamps _meta.region with the
// region the held values were just checked against.
async function syncHeld(sb: Sb, rid: string, held: Obj, region?: Region): Promise<void> {
  const want = JSON.stringify(held);
  for (let i = 0; i < LOCK_TRIES; i++) {
    const row = await readRequest(sb, rid);
    if (!row) return;
    const answers = obj(row.answers);
    const meta = obj(answers._meta);
    if (JSON.stringify(obj(answers._held)) === want && (!region || meta.region === region)) return;
    const next: Obj = { ...answers, _held: held };
    if (region) next._meta = { ...meta, region };
    const { data, error } = await sb.from("onboarding_form_requests")
      .update({ answers: next, updated_at: nextStamp(row.updated_at) })
      .eq("id", rid).eq("updated_at", row.updated_at)
      .select("id");
    if (error) break;
    if (data?.length) return;
  }
  console.error("onboarding-form: could not update the held list");
}

// Sending the pack again can move it to a venue in the other country, and the
// page then asks that country's questions. A bank number held from the old
// questions would still count as answered and go in with the pack, so anything
// that no longer fits is dropped and asked for again. Best effort: save and
// submit check again.
async function recheckRegion(sb: Sb, rid: string, region: Region): Promise<void> {
  try {
    const res = await writeSecure(sb, rid, dropUnfit(region));
    if (!res) {
      console.error("onboarding-form: could not recheck the held details");
      return;
    }
    await syncHeld(sb, rid, heldFrom(res.values, res.files), region);
  } catch (e) {
    console.error("onboarding-form: held details recheck failed", (e as Error).message);
  }
}

// An ID upload whose save never landed (the signal dropped, the tab closed) is
// in the bucket with nothing pointing at it, and on a pack that is never sent
// nothing else would ever remove it. Anything a day old and unreferenced goes.
async function sweepStrays(sb: Sb, rid: string): Promise<void> {
  try {
    const { data: listed, error } = await sb.storage.from(SECURE_BUCKET).list(rid, { limit: 1000 });
    if (error) return;
    const cutoff = Date.now() - STRAY_AFTER_MS;
    // Folders come back with no id, and an object with no created_at is left alone.
    const old = (listed || []).filter((o: Obj) => o?.id && o.name && Date.parse(String(o.created_at ?? "")) < cutoff);
    if (!old.length) return;
    const { files } = await readSecure(sb, rid);
    const keep = new Set(filePaths(files));
    await removeObjects(sb, rid, old.map((o: Obj) => `${rid}/${o.name}`).filter((p: string) => !keep.has(p)));
  } catch (e) {
    console.error("onboarding-form: stray sweep failed", (e as Error).message);
  }
}

// Once a pack is in: delete every secure detail the final answers no longer ask
// for (a licence left behind after switching to a passport, a sort code on a
// venue that turned out to be in the US), sweep uploads that were never saved,
// and make _held agree with what is left. Best effort, as the pack is already
// in and the owner can still delete everything from our card.
async function finishSecure(sb: Sb, rid: string, answers: Obj, region: Region): Promise<void> {
  try {
    const res = await writeSecure(sb, rid, (values, files) => {
      const kept = keepSecure(values, files, answers, region);
      let changed = false;
      for (const k of Object.keys(values)) if (!has(kept.values, k)) { delete values[k]; changed = true; }
      for (const k of Object.keys(files)) if (!has(kept.files, k)) { delete files[k]; changed = true; }
      return changed;
    });
    if (!res) {
      console.error("onboarding-form: could not tidy the secure details");
      return;
    }
    const keep = new Set(filePaths(res.files));
    const orphans: string[] = [];
    const { data: listed, error } = await sb.storage.from(SECURE_BUCKET).list(rid, { limit: 1000 });
    if (error) console.error("onboarding-form: could not list secure files", error.message);
    for (const o of listed || []) {
      // Folders come back with no id. Only real objects are swept.
      if (o?.id && o.name && !keep.has(`${rid}/${o.name}`)) orphans.push(`${rid}/${o.name}`);
    }
    await removeObjects(sb, rid, [...res.removed, ...orphans]);
    await syncHeld(sb, rid, heldFrom(res.values, res.files));
  } catch (e) {
    console.error("onboarding-form: secure tidy failed", (e as Error).message);
  }
}

// A save whose secure write landed after a submit on another phone: puts back
// what it replaced, key by key, and only where nothing has written over that
// key since, so the pack keeps the details it was sent with.
async function undoSecure(
  sb: Sb,
  rid: string,
  written: SecureState,
  valueChanges: Map<string, string | null>,
  fileChanges: Map<string, Obj | null>,
): Promise<void> {
  const res = await writeSecure(sb, rid, (values, files) => {
    let changed = false;
    for (const [k, v] of valueChanges) {
      const now = has(values, k) ? values[k] : null;
      const was = has(written.before.values, k) ? written.before.values[k] : null;
      if (now !== v || now === was) continue;
      if (was === null) delete values[k];
      else values[k] = was;
      changed = true;
    }
    for (const [k, f] of fileChanges) {
      const nowPath = has(files, k) ? obj(files[k]).path ?? null : null;
      const was = has(written.before.files, k) ? written.before.files[k] : null;
      if (nowPath !== (f ? f.path : null) || nowPath === (was ? obj(was).path ?? null : null)) continue;
      if (was === null) delete files[k];
      else files[k] = was;
      changed = true;
    }
    return changed;
  });
  if (!res) console.error("onboarding-form: could not undo a save that crossed a submit");
}

// ── Handler ─────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Read as text and parse whatever the content type says: the page's last save
  // as a tab closes goes as text/plain, the one kind of request a browser sends
  // with no preflight, so it is not cut off while the page hides.
  let parsed: unknown = null;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json({ error: TOO_BIG }, 413);
    parsed = JSON.parse(text);
  } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!isPlain(parsed)) return json({ error: "Invalid JSON" }, 400);
  const body: Obj = parsed;

  const token = String(body?.token || "").trim();
  const action = String(body?.action || "load");
  if (!token) return json({ error: "Missing token" }, 400);
  if (token.length > 200) return json({ error: BAD_LINK }, 404);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: found } = await supabase
    .from("onboarding_form_requests")
    .select(REQ_COLS)
    .eq("token", token).maybeSingle();

  // Same answer for a bad token and a deleted one: nothing to probe for.
  if (!found) return json({ error: BAD_LINK }, 404);
  const reqRow: Obj = found;
  const rid = String(reqRow.id);

  try {
    // A pack created before its onboarding knew its venue would otherwise attach
    // the customer's menu and logo to the COMPANY — and on a partner company with
    // two dozen venues that is the difference between a useful record and a pile.
    // The onboarding is the authority on which venue this job is for, so fill a
    // blank from it. An explicitly chosen venue on the request is never overridden.
    if (!reqRow.location_id && reqRow.onboarding_id) {
      const { data: onb } = await supabase.from("onboardings")
        .select("location_id").eq("id", reqRow.onboarding_id).maybeSingle();
      if (onb?.location_id) {
        const stamp = nextStamp(reqRow.updated_at);
        const { data: upd } = await supabase.from("onboarding_form_requests")
          .update({ location_id: onb.location_id, updated_at: stamp })
          .eq("id", rid).select("updated_at");
        reqRow.location_id = onb.location_id;
        // Keep the lock value current, so the first save does not lose to us.
        if (upd?.length) reqRow.updated_at = upd[0].updated_at;
      }
    }

    // Whose pack this is, for the page header, and which country's questions it
    // asks: the venue's country, then the company's, and nothing at all is UK.
    let venue = "";
    let venueAddress = "";
    let region: Region = "UK";
    if (action === "load" || action === "save" || action === "submit") {
      let loc: Obj | null = null;
      if (reqRow.location_id) {
        const { data } = await supabase.from("locations")
          .select("name, address, city, postcode, country, company_id").eq("id", reqRow.location_id).maybeSingle();
        loc = data || null;
      }
      let co: Obj | null = null;
      const companyId = reqRow.company_id || loc?.company_id;
      if (companyId && (!str(loc?.name) || !str(loc?.country))) {
        const { data } = await supabase.from("companies").select("name, country").eq("id", companyId).maybeSingle();
        co = data || null;
      }
      venue = str(loc?.name) || str(co?.name);
      venueAddress = [loc?.address, loc?.city, loc?.postcode].map(str).filter(Boolean).join(", ");
      region = (reqRow.submitted_at && stampedRegion(reqRow)) || regionFor(loc?.country, co?.country);
    }

    if (action === "load") {
      if (!reqRow.opened_at) {
        await supabase.from("onboarding_form_requests")
          .update({ opened_at: new Date().toISOString() }).eq("id", rid);
      }
      let row: Obj = reqRow;
      if (!row.submitted_at) {
        // The venue moved to the other country since the last save: what is
        // held is checked against the questions this page is about to ask.
        const stamped = stampedRegion(row);
        if (stamped && stamped !== region) {
          await recheckRegion(supabase, rid, region);
          row = (await readRequest(supabase, rid)) || row;
        }
        await sweepStrays(supabase, rid);
      }
      const answers = obj(row.answers);
      if (row.submitted_at) {
        // Nothing else once it is in: the link is still a working credential,
        // and the answers include a WiFi password and our customer's contacts.
        // A name only, for the booking invite on the thank you screen.
        return json({
          v: 2,
          venue,
          submitted: true,
          prefill_name: str(obj(answers.company).contact_name) || str(obj(answers.signoff).full_name),
        });
      }
      return json({
        v: 2,
        venue,
        venue_address: venueAddress,
        region,
        sent_to: str(row.sent_to),
        answers: draftAnswers(answers),
        held: obj(answers._held),
        submitted: false,
        updated_at: row.updated_at,
      });
    }

    if (action === "save") {
      if (reqRow.submitted_at) return json({ error: SUBMITTED }, 409);
      const patch = splitPatch(body.patch, rid, "save");

      // Checked up front, before anything is written, so an oversized pack is
      // refused whole rather than half saved.
      const merged = mergeAnswers(reqRow.answers, patch.plain);
      if (jsonBytes(merged) > MAX_ANSWERS_BYTES) {
        return json({ error: TOO_BIG }, 413);
      }

      // Secure answers that fail the server's checks are not stored and are
      // listed back as rejected. The rest of the patch still saves: one bad
      // value must not leave the whole pack unsaved on a phone that keeps
      // retrying.
      const rejected: string[] = [];
      const valueChanges = new Map<string, string | null>();
      for (const [key, v] of patch.values) {
        if (v === null) valueChanges.set(key, null);
        else if (typeof v === "string" && v.length <= MAX_STRING && serverValid(key, v.trim(), region)) {
          valueChanges.set(key, v.trim());
        } else rejected.push(key);
      }
      // A card face is held with the ID type it was uploaded as: the type in
      // the answers once this save's own changes are in.
      const idType = str(obj(merged.representative).id_type);
      const fileChanges = new Map<string, Obj | null>();
      for (const [key, v] of patch.files) {
        if (v === null) { fileChanges.set(key, null); continue; }
        if (!secureFileValid(key, v, rid)) { rejected.push(key); continue; }
        const real = await storedObject(supabase, v.path);
        if (real === "error") return json({ error: NOT_CHECKED }, 503);
        if (!real || (real.size !== null && real.size > MAX_SECURE_BYTES) || (real.mime && !SECURE_MIME.includes(real.mime))) {
          rejected.push(key);
          continue;
        }
        // The type comes from the extension upload-url chose, and the name is
        // ours, never the customer's file name, which often has their own name
        // in it. The size is what storage says arrived.
        const ext = v.path.slice(v.path.lastIndexOf(".") + 1);
        const mime = SECURE_MIME.find((m) => extForMime(m) === ext) || v.mime;
        const file: Obj = { path: v.path, name: secureFileName(key, mime), size: real.size ?? v.size, mime };
        if (ID_CARD_KEYS.includes(key) && idType) file.doc = idType;
        fileChanges.set(key, file);
      }

      const secureAsked = valueChanges.size > 0 || fileChanges.size > 0;
      // The venue moved to the other country since the last save, so what is
      // held is checked against the new questions even if nothing secure was sent.
      const stamped = stampedRegion(reqRow);
      const regionMoved = !!stamped && stamped !== region;
      if (!Object.keys(patch.plain).length && !secureAsked && !regionMoved) {
        return json({
          saved_at: new Date().toISOString(),
          updated_at: reqRow.updated_at,
          held: obj(obj(reqRow.answers)._held),
          rejected,
        });
      }

      let written: SecureState | null = null;
      if (secureAsked || regionMoved) {
        // Looked at again just before the secure write: a submit from another
        // phone may have landed while this save was asking storage about files,
        // and bank or ID details must never change under a pack that is in.
        const fresh = await readRequest(supabase, rid);
        if (!fresh) return json({ error: BAD_LINK }, 404);
        if (fresh.submitted_at) return json({ error: SUBMITTED }, 409);
        written = await writeSecure(supabase, rid, (values, files) => {
          let changed = false;
          for (const [k, v] of valueChanges) {
            if (v === null) {
              if (has(values, k)) { delete values[k]; changed = true; }
            } else if (values[k] !== v) { values[k] = v; changed = true; }
          }
          for (const [k, f] of fileChanges) {
            if (f === null) {
              if (has(files, k)) { delete files[k]; changed = true; }
            } else if (obj(files[k]).path !== f.path) { files[k] = f; changed = true; }
          }
          if (dropUnfit(region)(values)) changed = true;
          return changed;
        });
        if (!written) return json({ error: NOT_SAVED }, 503);
      }

      let row: Obj | null = reqRow;
      for (let i = 0; i < LOCK_TRIES; i++) {
        if (i > 0) row = await readRequest(supabase, rid);
        if (!row) return json({ error: BAD_LINK }, 404);
        if (row.submitted_at) {
          // Lost a race with a submit on another phone. This save's secure
          // changes are undone (the old ID image is still in the bucket, as
          // nothing is deleted until the answers are in), then the store is
          // tidied against the final answers, which sweeps the new upload.
          if (written?.changed) {
            await undoSecure(supabase, rid, written, valueChanges, fileChanges);
            await finishSecure(supabase, rid, obj(row.answers), stampedRegion(row) || region);
          }
          return json({ error: SUBMITTED }, 409);
        }
        const answers = mergeAnswers(row.answers, patch.plain);
        // _held is rebuilt from the secure row itself, read after this save's
        // write, so it can only say what is really held. A save with no secure
        // keys carries the stored _held forward untouched.
        if (written) {
          const now = await readSecure(supabase, rid);
          answers._held = heldFrom(now.values, now.files);
        }
        const stamp = nextStamp(row.updated_at);
        // saved_at is when the customer last saved. updated_at cannot say that:
        // sending the pack again moves it too, and our card shows "Last saved".
        answers._meta = { ...obj(obj(row.answers)._meta), v: 2, region, saved_at: stamp };
        if (jsonBytes(answers) > MAX_ANSWERS_BYTES) return json({ error: TOO_BIG }, 413);
        const { data: upd, error } = await supabase.from("onboarding_form_requests")
          .update({ answers, updated_at: stamp })
          .eq("id", rid).eq("updated_at", row.updated_at).is("submitted_at", null)
          .select("updated_at");
        if (error) throw new Error("Could not save your answers.");
        if (upd?.length) {
          // A replaced or removed ID image goes only now the answers are in.
          if (written) await removeObjects(supabase, rid, written.removed);
          return json({ saved_at: stamp, updated_at: upd[0].updated_at, held: obj(answers._held), rejected });
        }
      }
      // The secure write stands though the answers did not save, so what it
      // replaced is pointed at by nothing.
      if (written) await removeObjects(supabase, rid, written.removed);
      // Never 409 here: the page reads 409 as "already submitted".
      return json({ error: NOT_SAVED }, 503);
    }

    if (action === "upload-url") {
      if (reqRow.submitted_at) return json({ error: SUBMITTED }, 409);
      const key = `${String(body?.sectionKey || "")}.${String(body?.fieldKey || "")}`;

      if (isSecureFileKey(key)) {
        // Refused before anything is signed, so a wrong file never reaches the
        // bucket. The bucket enforces the same type and size rules as well.
        const mime = String(body?.mime || "").toLowerCase();
        const size = Number(body?.size || 0);
        if (!SECURE_MIME.includes(mime)) return json({ error: "Please choose a JPG, PNG or PDF file." }, 415);
        if (!Number.isFinite(size) || size < 0 || size > MAX_SECURE_BYTES) {
          return json({ error: "That file is larger than 10MB. Please choose a smaller one." }, 413);
        }
        const path = securePath(rid, key, mime, crypto.randomUUID());
        if (!path) return json({ error: "Please choose a JPG, PNG or PDF file." }, 415);
        const { data, error } = await supabase.storage.from(SECURE_BUCKET).createSignedUploadUrl(path);
        if (error) {
          console.error("onboarding-form: secure upload url failed", error.message);
          return json({ error: "Your upload could not be started. Please try again." }, 500);
        }
        return json({ path, token: data.token, signedUrl: data.signedUrl, name: secureFileName(key, mime), mime, secure: true });
      }
      // A secure value is typed, never uploaded, and nothing for a secure
      // question may land in the attachments bucket.
      if (isSecureValueKey(key)) return json({ error: "That question does not take a file." }, 400);

      const name = safeName(String(body?.fileName || ""));
      const size = Number(body?.size || 0);
      if (size > MAX_BYTES) return json({ error: `${name} is larger than 25MB. Please send it to us by email instead.` }, 413);
      // Path is namespaced by the request id, so one customer can never write
      // over another's file, and a stray token cannot reach anything existing.
      const path = `onboarding/${rid}/${crypto.randomUUID()}-${pathSafe(name)}`;
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) return json({ error: error.message }, 500);
      return json({ path, token: data.token, signedUrl: data.signedUrl, name });
    }

    if (action === "submit") {
      if (reqRow.submitted_at) return json({ error: SUBMITTED }, 409);
      // A page from before save as you go still sends its whole answers here.
      // They go in as one final patch, and the terms it showed were the first
      // wording. The current page saves as it goes and sends no answers.
      const fromOldPage = isPlain(body.answers);
      const final = fromOldPage ? splitPatch(body.answers, rid, "final") : null;
      const summary = String(body?.summary || "");
      // That old page only ever had the UK form, whatever the venue, so its
      // answers are UK answers. Stamping the venue's region would make our card
      // read them as US and hide the VAT answers it really gave.
      const packRegion: Region = fromOldPage ? "UK" : region;

      let row: Obj | null = reqRow;
      let answers: Obj = {};
      let before: { values: Obj; files: Obj } = { values: {}, files: {} };
      let committed = false;
      for (let i = 0; i < LOCK_TRIES && !committed; i++) {
        if (i > 0) row = await readRequest(supabase, rid);
        if (!row) return json({ error: BAD_LINK }, 404);
        if (row.submitted_at) return json({ error: SUBMITTED }, 409);
        answers = mergeAnswers(row.answers, final ? final.plain : {});
        const sec = await readSecure(supabase, rid);
        before = sec;
        // A bank number held from before the venue moved to the other country
        // would otherwise go in unchecked, or be dropped and leave the pack
        // short of bank details. It is dropped and the customer asked to look.
        const visible = secureVisible(answers, packRegion);
        const unfit = Object.entries(sec.values)
          .some(([k, v]) => visible.has(k) && !(typeof v === "string" && serverValid(k, v, packRegion)));
        if (unfit) {
          await recheckRegion(supabase, rid, packRegion);
          return json({ error: CHECK_BANK }, 422);
        }
        const kept = keepSecure(sec.values, sec.files, answers, packRegion);
        answers._held = heldFrom(kept.values, kept.files);
        answers._meta = {
          ...obj(obj(row.answers)._meta),
          v: 2,
          region: packRegion,
          terms_version: fromOldPage ? 1 : TERMS_VERSION,
        };
        if (jsonBytes(answers) > MAX_ANSWERS_BYTES) return json({ error: TOO_BIG }, 413);
        const stamp = nextStamp(row.updated_at);
        const { data: upd, error } = await supabase.from("onboarding_form_requests")
          .update({ answers, submitted_at: stamp, updated_at: stamp })
          .eq("id", rid).eq("updated_at", row.updated_at).is("submitted_at", null)
          .select("id");
        if (error) throw new Error("Could not send your pack.");
        committed = !!upd?.length;
      }
      if (!committed) return json({ error: "Your pack could not be sent just now. Please try again." }, 503);

      // The pack is in. Delete what the final answers do not ask for.
      await finishSecure(supabase, rid, answers, packRegion);

      // The files are the point: they land on the LOCATION, named as the
      // customer named them, so the venue record shows exactly what we were
      // given. Only ordinary files the stored answers really hold (so never an
      // ID, which is not in answers), each once: the page's list first, in its
      // order, then anything else stored, such as a table plan added from
      // another phone that the phone pressing Send never saw. Best-effort — a
      // failed row here must not lose the answers.
      const stored = storedFiles(answers, rid);
      const listed: string[] = Array.isArray(body.files)
        ? body.files.slice(0, 500).map((f: unknown) => String(obj(f).path ?? ""))
        : [];
      const wanted: Obj[] = [];
      for (const p of [...listed, ...stored.keys()]) {
        const f = stored.get(p);
        if (f && !wanted.includes(f)) wanted.push(f);
      }
      let already = new Set<string>();
      if (wanted.length) {
        const { data: rows, error } = await supabase.from("attachments")
          .select("file_path").in("file_path", wanted.map((f) => f.path));
        if (error) console.error("attachment check failed", error.message);
        already = new Set((rows || []).map((r: Obj) => String(r.file_path)));
      }
      for (const f of wanted) {
        if (already.has(f.path)) continue;
        try {
          const { error } = await supabase.from("attachments").insert({
            subject_type: reqRow.location_id ? "location" : "company",
            subject_id: reqRow.location_id || reqRow.company_id,
            file_name: safeName(String(f.name || "file")),
            file_path: String(f.path),
            mime_type: f.mime || null,
            size_bytes: Number(f.size) || null,
            source: "onboarding_form",
          });
          if (error) console.error("attachment row failed", error.message);
        } catch (e) { console.error("attachment row failed", (e as Error).message); }
      }

      // Leave a trace on the onboarding so the team sees it without hunting.
      // Every logged in user reads activity notes. The summary never holds a
      // secure value, but if one this pack held (or a secure file path) turns
      // up in it anyway, the whole summary is withheld rather than patched.
      if (reqRow.onboarding_id && summary) {
        try {
          const secrets = [
            ...Object.values(before.values),
            ...filePaths(before.files),
            ...(final ? final.typed : []),
          ];
          const noteText = noteBody(summary, secrets);
          // That it happened, never what matched.
          if (noteText !== summary) console.error("onboarding-form: summary withheld from the activity note");
          await supabase.from("crm_activities").insert({
            type: "note", subject_type: "onboarding", subject_id: reqRow.onboarding_id,
            is_internal: true,
            subject: "Onboarding pack completed by the customer",
            body: noteText.slice(0, 20000),
            channel_metadata: { kind: "onboarding_form", files: wanted.length },
          });
        } catch (e) { console.error("activity failed", (e as Error).message); }
      }

      return json({ ok: true, files: wanted.length });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    if (e instanceof Refusal) {
      return json(e.field ? { error: e.message, field: e.field } : { error: e.message }, e.status);
    }
    // The message only: an error object can carry the row that failed.
    console.error("onboarding-form failed", (e as Error).message);
    return json({ error: (e as Error).message || "Something went wrong" }, 500);
  }
});
