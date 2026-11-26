// Monzo bank feed: tokens and syncing, shared by bank-connect and bank-sync.
import { listTransactions, mapMonzoTransaction, refreshTokens } from "./monzo.ts";

type Obj = Record<string, any>;
const DAY = 86400000;

const clientId = () => Deno.env.get("MONZO_CLIENT_ID") || "";
const clientSecret = () => Deno.env.get("MONZO_CLIENT_SECRET") || "";

export async function saveTokens(admin: any, connectionId: string, t: { access_token: string; refresh_token: string | null; expires_in: number; user_id?: string }) {
  const { error } = await admin.from("bank_tokens").upsert({
    connection_id: connectionId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    provider_user_id: t.user_id || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "connection_id" });
  if (error) throw new Error(`save tokens: ${error.message}`);
}

/** A working access token, refreshed when it has under 10 minutes left.
 *  A Monzo refresh kills the old refresh token, so when two syncs race the
 *  loser's refresh fails: it then rereads the row and uses the winner's. */
export async function accessToken(admin: any, connectionId: string): Promise<string> {
  const read = async () => (await admin.from("bank_tokens").select("*").eq("connection_id", connectionId).maybeSingle()).data as Obj | null;
  const row = await read();
  if (!row) throw new Error("Not connected to Monzo yet.");
  if (new Date(row.expires_at).getTime() - Date.now() > 10 * 60000) return row.access_token;
  if (!row.refresh_token) throw new Error("Monzo access has expired. Reconnect the bank.");
  try {
    const t = await refreshTokens(clientId(), clientSecret(), row.refresh_token);
    await saveTokens(admin, connectionId, { ...t, user_id: row.provider_user_id });
    return t.access_token;
  } catch (e) {
    const again = await read();
    if (again && again.refresh_token !== row.refresh_token && new Date(again.expires_at).getTime() > Date.now()) return again.access_token;
    await admin.from("bank_connections").update({ status: "EX", updated_at: new Date().toISOString() }).eq("id", connectionId);
    throw new Error(`Monzo access could not be renewed, reconnect the bank. ${(e as Error).message}`);
  }
}

/** Pull one account's transactions into bank_transactions.
 *  Monzo pages forwards from `since` (oldest first). Without a `since` it
 *  returns only the newest 100, which is how the first import got just 99
 *  lines. So there is always a start:
 *   - full: from `fullFrom` (the account's opening date). Monzo allows this
 *     only in the 5 minutes after the user approves.
 *   - otherwise: the last 89 days, every time. A few pages for a small
 *     business, and it heals any gap and updates pending lines that settled. */
export async function syncMonzoAccount(admin: any, token: string, account: Obj, full = false, fullFrom: string | null = null): Promise<number> {
  const since = full && fullFrom ? new Date(fullFrom).toISOString() : new Date(Date.now() - 89 * DAY).toISOString();
  const txs = await listTransactions(token, account.provider_account_id, since, full ? 400 : 60);
  const now = new Date().toISOString();
  const rows = txs.map(mapMonzoTransaction).filter(Boolean)
    .map((m) => ({ account_id: account.id, gc_account_id: account.gc_account_id, ...m, synced_at: now }));
  // Never overwrite what someone has already reconciled: those fields are not
  // in the row, so an upsert leaves them as they are.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("bank_transactions").upsert(rows.slice(i, i + 500), { onConflict: "gc_account_id,dedup_key" });
    if (error) throw new Error(`save transactions: ${error.message}`);
  }
  return rows.length;
}

/** Balance straight from Monzo. */
export async function syncMonzoBalance(admin: any, token: string, account: Obj) {
  const r = await fetch(`https://api.monzo.com/balance?account_id=${encodeURIComponent(account.provider_account_id)}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  const now = new Date().toISOString();
  await admin.from("bank_accounts").update({
    ...(r.ok && typeof j.balance === "number" ? { balance: j.balance / 100, balance_at: now.slice(0, 10) } : {}),
    last_synced_at: now, updated_at: now,
  }).eq("id", account.id);
}
