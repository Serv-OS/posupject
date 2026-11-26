// Bank feed connect. Called from the app (verify_jwt on) by an editor or owner.
//
// Monzo (live, 25 Nov 2026): the Monzo Developer API, connecting POSUP's own
// Monzo Business account. Actions:
//   institutions   the sources that are set up (Monzo, and the older Google
//                  Sheets export when its secrets are present)
//   init           Monzo: a connection row and the Monzo sign in link
//   finalise       Monzo: swaps the code from /bank/callback for tokens
//   activate       Monzo: once the access is approved in the Monzo app, saves
//                  the accounts, imports the WHOLE history (Monzo allows that
//                  for 5 minutes after approval only), and registers the
//                  webhook that makes the feed live
//   match_invoice  books money in against an invoice, through the same
//                  record_invoice_payment the card payments use
// Brex (ServOS US, dollars): brex_connect takes a Brex user token pasted into
// the CRM, checks it, keeps it in bank_tokens and imports two years.
// The Google Sheets path is kept as it was for any connection made that way.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readSheet, headerIndex, corsJson } from "../_shared/gsheets.ts";
import { authUrl, exchangeCode, listAccounts, monzoGet, monzoPost, needsApproval } from "../_shared/monzo.ts";
import { accessToken, saveTokens, syncMonzoAccount, syncMonzoBalance } from "../_shared/monzoSync.ts";
import { companyCardExpense } from "../_shared/bankBook.ts";
import { aiMatch } from "../_shared/bankMatchAi.ts";
import { listCashAccounts, listCardAccounts, syncBrexAccount, syncBrexBalances } from "../_shared/brex.ts";

const APP_URL = () => (Deno.env.get("APP_URL") || "https://posupject.vercel.app").replace(/\/$/, "");
const REDIRECT = () => `${APP_URL()}/bank/callback`;
const SYNC_URL = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/bank-sync`;

serve(async (req) => {
  if (req.method === "OPTIONS") return corsJson({});
  if (req.method !== "POST") return corsJson({ error: "method" }, 405);

  const auth = req.headers.get("Authorization") || "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return corsJson({ error: "unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // The owner, and editors the owner has given bank feed access (migration 116).
  const { data: prof } = await admin.from("profiles").select("*").eq("id", user.id).single();
  const allowed = prof && (prof.role === "owner" || (prof.role === "editor" && prof.bank_feed_access === true));
  if (!allowed) return corsJson({ error: "You do not have access to the bank feed. Ask the owner to switch it on for you in Users." }, 403);

  const body = await req.json().catch(() => ({}));
  const { action } = body;
  const monzoId = Deno.env.get("MONZO_CLIENT_ID");
  const monzoSecret = Deno.env.get("MONZO_CLIENT_SECRET");
  const sheetId = Deno.env.get("GSHEETS_BANK_SHEET_ID");

  try {
    if (action === "institutions") {
      const list = [];
      if (monzoId && monzoSecret) list.push({ id: "monzo", name: "Monzo Business (UK, pounds)", logo: null });
      list.push({ id: "brex", name: "Brex (US, dollars)", logo: null, token: true });
      if (sheetId) list.push({ id: "monzo-gsheets", name: "Monzo Business (Google Sheets)", logo: null });
      if (!list.length) return corsJson({ error: "No bank is set up yet: add MONZO_CLIENT_ID and MONZO_CLIENT_SECRET." }, 400);
      return corsJson({ institutions: list });
    }

    // ── Monzo ──────────────────────────────────────────────────────────────
    if (action === "init" && body.institution_id === "monzo") {
      if (!monzoId || !monzoSecret) return corsJson({ error: "MONZO_CLIENT_ID and MONZO_CLIENT_SECRET are not set." }, 400);
      const reference = crypto.randomUUID();
      // One Monzo connection: reconnecting reuses it, so accounts and
      // reconciled lines stay where they are.
      const { data: existing } = await admin.from("bank_connections").select("id").eq("institution_id", "monzo").maybeSingle();
      if (existing) {
        await admin.from("bank_connections").update({ reference, status: "CR", updated_at: new Date().toISOString() }).eq("id", existing.id);
      } else {
        const { error } = await admin.from("bank_connections").insert({
          reference, institution_id: "monzo", institution_name: "Monzo Business", aspsp_country: "GB", status: "CR", created_by: user.id,
        });
        if (error) throw new Error(error.message);
      }
      return corsJson({ link: authUrl(monzoId, REDIRECT(), reference) });
    }

    // ── Brex ───────────────────────────────────────────────────────────────
    if (action === "brex_connect") {
      const token = String(body.token || "").trim();
      if (token.length < 20) return corsJson({ error: "Paste the whole Brex token (it starts bxt_)." }, 400);
      let cash: any[] = [], card: any[] = [], cashErr = "", cardErr = "";
      try { cash = await listCashAccounts(token); } catch (e) { cashErr = (e as Error).message; if ((e as any).status === 401) return corsJson({ error: cashErr }, 400); }
      try { card = await listCardAccounts(token); } catch (e) { cardErr = (e as Error).message; }
      if (!cash.length && !card.length) return corsJson({ error: `Brex shows no accounts this token can read. ${cashErr || cardErr}` }, 400);
      const now = new Date().toISOString();
      const { data: existing } = await admin.from("bank_connections").select("id").eq("institution_id", "brex").maybeSingle();
      let connId = existing?.id;
      if (connId) {
        await admin.from("bank_connections").update({ status: "LN", updated_at: now }).eq("id", connId);
      } else {
        const { data: c, error } = await admin.from("bank_connections").insert({
          reference: crypto.randomUUID(), institution_id: "brex", institution_name: "Brex", aspsp_country: "US", status: "LN", created_by: user.id,
        }).select("id").single();
        if (error) throw new Error(error.message);
        connId = c.id;
      }
      // Brex tokens do not expire while used; expires_at is when it would
      // lapse if the sync stopped (90 days of no calls).
      const { error: te } = await admin.from("bank_tokens").upsert({
        connection_id: connId, access_token: token, refresh_token: null,
        expires_at: new Date(Date.now() + 90 * 86400000).toISOString(), updated_at: now,
      }, { onConflict: "connection_id" });
      if (te) throw new Error(`save token: ${te.message}`);
      const want = [
        ...cash.map((a: any) => ({ pid: `cash:${a.id}`, name: `Brex · ${a.name || "Business account"}`, currency: a.current_balance?.currency || "USD", num: a.account_number ? `Acct ${String(a.account_number).slice(-4)}` : null })),
        ...(card.length ? [{ pid: "card:primary", name: "Brex card", currency: card[0]?.current_balance?.currency || "USD", num: null }] : []),
      ];
      const saved: any[] = [];
      for (const w of want) {
        const { data: row, error } = await admin.from("bank_accounts").upsert({
          connection_id: connId, gc_account_id: `brex:${w.pid}`, provider_account_id: w.pid, account_uid: w.pid,
          name: w.name, currency: w.currency, iban: w.num, active: true, updated_at: now,
        }, { onConflict: "gc_account_id" }).select("*").single();
        if (error) throw new Error(error.message);
        saved.push(row);
      }
      const result: any[] = [];
      for (const acc of saved) {
        try { result.push({ account: acc.name, imported: await syncBrexAccount(admin, token, acc, true) }); }
        catch (e) { result.push({ account: acc.name, error: (e as Error).message }); }
      }
      await syncBrexBalances(admin, token, saved);
      await admin.from("bank_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", connId);
      return corsJson({ status: "LN", accounts: result });
    }

    if (action === "finalise") {
      const { data: conn } = await admin.from("bank_connections").select("*").eq("reference", String(body.reference || "")).maybeSingle();
      if (!conn) return corsJson({ error: "This sign in link is out of date. Start again from Bank feed." }, 404);
      if (conn.institution_id !== "monzo") return corsJson({ status: conn.status });
      if (!body.code) return corsJson({ error: "Monzo did not send a code back." }, 400);
      const t = await exchangeCode(monzoId!, monzoSecret!, REDIRECT(), String(body.code));
      await saveTokens(admin, conn.id, t);
      // The state is single use.
      await admin.from("bank_connections").update({ status: "SA", reference: crypto.randomUUID(), updated_at: new Date().toISOString() }).eq("id", conn.id);
      return corsJson({ status: "SA", connection_id: conn.id });
    }

    if (action === "activate") {
      const { data: conn } = await admin.from("bank_connections").select("*").eq("id", String(body.connection_id || "")).maybeSingle();
      if (!conn || conn.institution_id !== "monzo") return corsJson({ error: "No Monzo connection." }, 404);
      const token = await accessToken(admin, conn.id);
      let accounts;
      try {
        accounts = await listAccounts(token);
        // /accounts answers before approval; the balance does not.
        if (accounts[0]) await monzoGet(token, "/balance", [["account_id", accounts[0].id]]);
      } catch (e) {
        if (needsApproval(e)) return corsJson({ status: "SA", waiting: true });
        throw e;
      }
      if (!accounts.length) return corsJson({ error: "Monzo shows no open accounts on this login." }, 422);
      // The business account feeds the CRM. A personal account on the same
      // login is saved but switched off. One Monzo login can hold several
      // companies (POSUP and SERVOS APP LIMITED): MONZO_ACCOUNTS names the
      // ones this CRM keeps (a word from the account name, comma separated).
      // An account already saved keeps the on/off it was given.
      const hasBusiness = accounts.some((a: any) => a.type === "uk_business");
      const wanted = (Deno.env.get("MONZO_ACCOUNTS") || "").split(",").map((w) => w.trim().toUpperCase()).filter(Boolean);
      const { data: before } = await admin.from("bank_accounts").select("gc_account_id, active").in("gc_account_id", accounts.map((a: any) => a.id));
      const keep = new Map((before || []).map((b: any) => [b.gc_account_id, b.active]));
      const defaultOn = (a: any) => {
        if (hasBusiness && a.type !== "uk_business") return false;
        if (!wanted.length) return true;
        const label = String(a.description || "").toUpperCase();
        return wanted.some((w) => label.includes(w));
      };
      const saved = [];
      for (const a of accounts) {
        const name = a.type === "uk_business" ? `Monzo Business${a.description ? ` · ${a.description}` : ""}` : "Monzo personal";
        const { data: row, error } = await admin.from("bank_accounts").upsert({
          connection_id: conn.id, gc_account_id: a.id, provider_account_id: a.id, account_uid: a.id,
          name, owner_name: (a.owners || [])[0]?.preferred_name || null, currency: a.currency || "GBP",
          iban: a.account_number && a.sort_code ? `${a.sort_code.replace(/(\d\d)(\d\d)(\d\d)/, "$1-$2-$3")} ${a.account_number}` : null,
          active: keep.has(a.id) ? keep.get(a.id) : defaultOn(a), updated_at: new Date().toISOString(),
        }, { onConflict: "gc_account_id" }).select("*").single();
        if (error) throw new Error(error.message);
        saved.push(row);
      }
      await admin.from("bank_connections").update({ status: "LN", updated_at: new Date().toISOString() }).eq("id", conn.id);
      const result: any[] = [];
      for (const acc of saved.filter((a) => a.active)) {
        const opened = accounts.find((x: any) => x.id === acc.provider_account_id)?.created || null;
        const imported = await syncMonzoAccount(admin, token, acc, true, opened);
        await syncMonzoBalance(admin, token, acc);
        // Live: Monzo calls bank-sync on every new transaction.
        let webhook = "registered";
        try {
          const hooks = await monzoGet(token, "/webhooks", [["account_id", acc.provider_account_id]]);
          const url = `${SYNC_URL()}?account=${encodeURIComponent(acc.provider_account_id)}`;
          if (!(hooks.webhooks || []).some((h: any) => h.url === url)) await monzoPost(token, "/webhooks", { account_id: acc.provider_account_id, url });
        } catch (e) { webhook = `not registered: ${(e as Error).message}`; }
        result.push({ account: acc.name, imported, webhook });
      }
      await admin.from("bank_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", conn.id);
      return corsJson({ status: "LN", accounts: result });
    }

    if (action === "ai_match") {
      // Ask again: these lines, or every unmatched line.
      if (!body.txn_ids?.length) await admin.from("bank_transactions").update({ ai_checked_at: null }).eq("reconciled", false);
      const r = await aiMatch(admin, { txnIds: body.txn_ids, limit: 60 });
      if (r.error) return corsJson({ error: r.error }, 502);
      return corsJson(r);
    }

    if (action === "company_card") {
      const { data: txn } = await admin.from("bank_transactions").select("*").eq("id", String(body.txn_id || "")).maybeSingle();
      if (!txn) return corsJson({ error: "Transaction not found." }, 404);
      const { data: person } = await admin.from("profiles").select("id").eq("id", String(body.person_id || "")).maybeSingle();
      if (!person) return corsJson({ error: "Choose who spent it." }, 400);
      const expenseId = await companyCardExpense(admin, txn, person.id, body.category_id || null, user.id);
      if (body.remember && txn.payee) {
        // "Always do this for this payee": a rule that runs after each sync.
        await admin.from("bank_match_rules").insert({
          payee_pattern: String(body.remember_pattern || txn.payee), create_as: "expense", assign_to: person.id,
          category_id: body.category_id || null, auto: true, created_by: user.id,
        });
      }
      return corsJson({ ok: true, expense_id: expenseId });
    }

    if (action === "match_invoice") {
      const { data: txn } = await admin.from("bank_transactions").select("*").eq("id", String(body.txn_id || "")).maybeSingle();
      if (!txn) return corsJson({ error: "Transaction not found." }, 404);
      if (txn.reconciled) return corsJson({ error: "That payment is already matched." }, 409);
      if (Number(txn.amount) <= 0) return corsJson({ error: "Only money coming in can pay an invoice." }, 400);
      const { data: inv } = await admin.from("invoices").select("*").eq("id", String(body.invoice_id || "")).maybeSingle();
      if (!inv) return corsJson({ error: "Invoice not found." }, 404);
      if ((inv.currency || "GBP") !== (txn.currency || "GBP")) return corsJson({ error: "The payment and the invoice are in different currencies." }, 400);
      // The bank line's own key is the payment reference, so the same line can
      // never be booked twice.
      const { data: res, error } = await admin.rpc("record_invoice_payment", {
        p_invoice_id: inv.id, p_amount: Number(txn.amount), p_session_id: `bank:${txn.dedup_key}`,
      });
      if (error) throw new Error(error.message);
      if (!res?.recorded && res?.reason !== "repeat") return corsJson({ error: res?.reason === "already_paid" ? "That invoice is already paid." : "Could not record the payment.", result: res }, 409);
      await admin.from("bank_transactions").update({ reconciled: true, matched_type: "invoice", matched_id: inv.id }).eq("id", txn.id);
      return corsJson({ ok: true, result: res });
    }

    // ── Google Sheets (older route) ────────────────────────────────────────
    if (action === "init") {
      if (!sheetId) return corsJson({ error: "GSHEETS_BANK_SHEET_ID not set." }, 400);
      const res = await readSheet(sheetId);
      if (!res.ok) return corsJson({ error: "Could not read the Google Sheet (check the share + GSHEETS_SA_KEY).", detail: res.error }, 502);
      const headers = res.rows[0] || [];
      const idx = headerIndex(headers);
      if (idx.date == null && idx.amount == null) return corsJson({ error: "Sheet has no recognisable header row (need Date + Amount).", headers }, 422);
      const { data: existing } = await admin.from("bank_connections").select("id").eq("institution_id", "monzo-gsheets").maybeSingle();
      let connId = existing?.id;
      if (!connId) {
        const { data: conn } = await admin.from("bank_connections").insert({
          reference: crypto.randomUUID(), institution_id: "monzo-gsheets", institution_name: "Monzo Business (Google Sheets)",
          aspsp_country: "GB", session_id: sheetId, status: "LN", created_by: user.id,
        }).select("id").single();
        connId = conn?.id;
      } else {
        await admin.from("bank_connections").update({ status: "LN", session_id: sheetId, updated_at: new Date().toISOString() }).eq("id", connId);
      }
      await admin.from("bank_accounts").upsert({
        connection_id: connId, gc_account_id: sheetId, account_uid: sheetId, identification_hash: sheetId,
        name: "Monzo Business", currency: Deno.env.get("GSHEETS_BANK_CURRENCY") || "GBP", active: true, updated_at: new Date().toISOString(),
      }, { onConflict: "gc_account_id" });
      return corsJson({ connected: true, columns: headers });
    }

    return corsJson({ error: "unknown action" }, 400);
  } catch (e) {
    return corsJson({ error: (e as Error).message }, 500);
  }
});
