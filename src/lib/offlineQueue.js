// Writes made without signal wait here and send when it returns (screen 18).
//
// A queued item is one Supabase write: insert / update / delete on a table.
// The queue lives in localStorage so it survives the app being killed on a
// roof, and every change fires `offline-queue-changed` so the banner and the
// Inbox card can redraw without polling.

const KEY = 'offline.queue.v1';

const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const write = (q) => {
  try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* private mode: keep going */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('offline-queue-changed'));
};
const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
export const pending = () => read();
export const remove = (id) => write(read().filter(x => x.id !== id));
export const clearFailed = () => write(read().map(({ error, ...x }) => x));

const looksLikeNoSignal = (e) => !!e && /fetch|network|failed to|load failed|timeout/i.test(e.message || String(e));

async function exec(supabase, op) {
  let q = supabase.from(op.table);
  if (op.kind === 'insert') return q.insert(op.values);
  if (op.kind === 'update' || op.kind === 'delete') {
    q = op.kind === 'update' ? q.update(op.values) : q.delete();
    for (const [k, v] of Object.entries(op.match || {})) q = q.eq(k, v);
    return q;
  }
  return { error: new Error(`unknown op ${op.kind}`) };
}

function enqueue(label, op) {
  const item = { id: newId(), label, op, at: new Date().toISOString() };
  write([...read(), item]);
  return item;
}

/**
 * Run one write now, or queue it when there is no signal.
 * @param label what the person sees in "Queued while offline", e.g. "Note on #1042"
 * @param op    { table, kind: 'insert'|'update'|'delete', values?, match? }
 * @returns {Promise<{queued:boolean, error?:any}>}
 */
export async function runOrQueue(supabase, label, op) {
  if (!isOnline()) { enqueue(label, op); return { queued: true }; }
  try {
    const { error } = await exec(supabase, op);
    if (error && looksLikeNoSignal(error)) { enqueue(label, op); return { queued: true }; }
    return { queued: false, error: error || null };
  } catch (e) {
    if (looksLikeNoSignal(e)) { enqueue(label, op); return { queued: true }; }
    return { queued: false, error: e };
  }
}

/** Send everything queued, in order. Items that fail for a real reason stay, marked with the error. */
export async function flush(supabase) {
  if (!isOnline()) return 0;
  const q = read();
  if (!q.length) return 0;
  const left = []; let sent = 0;
  for (const item of q) {
    try {
      const { error } = await exec(supabase, item.op);
      if (!error) { sent++; continue; }
      if (looksLikeNoSignal(error)) { left.push(item); continue; }
      left.push({ ...item, error: error.message || String(error) });
    } catch (e) {
      left.push(looksLikeNoSignal(e) ? item : { ...item, error: e.message || String(e) });
    }
  }
  write(left);
  return sent;
}

/** Flush whenever the browser says signal is back. Returns the unsubscribe. */
export function watch(supabase) {
  if (typeof window === 'undefined') return () => {};
  const on = () => { flush(supabase); };
  window.addEventListener('online', on);
  if (isOnline()) flush(supabase);
  return () => window.removeEventListener('online', on);
}
