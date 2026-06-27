import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Landmark, Plus, RefreshCw, X, AlertTriangle } from 'lucide-react';
import { gbp2 } from '../../lib/money.js';
import { suggestMatch, applyRule, txnToBill, normalizePayee } from '../../lib/bankRecon.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';
const daysUntil = (d) => d ? Math.ceil((new Date(d + 'T00:00:00') - Date.now()) / 86400000) : null;

export default function BankFeedPanel({ profile }) {
  const [connections, setConnections] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [txns, setTxns] = useState([]);
  const [bills, setBills] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [rules, setRules] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [picker, setPicker] = useState(null);   // institutions list when connecting
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    const [c, a, t, b, e, r, s, cat] = await Promise.all([
      supabase.from('bank_connections').select('*').order('created_at', { ascending: false }),
      supabase.from('bank_accounts').select('*'),
      supabase.from('bank_transactions').select('*').eq('reconciled', false).lt('amount', 0).order('booking_date', { ascending: false }).limit(200),
      supabase.from('bills').select('id, total, due_date, issue_date, supplier:inv_suppliers(name)').in('status', ['to_pay', 'partially_paid']),
      supabase.from('expenses').select('id, total, expense_date, submitter:profiles!expenses_submitter_id_fkey(display_name)').eq('status', 'approved'),
      supabase.from('bank_match_rules').select('*'),
      supabase.from('inv_suppliers').select('id, name').order('name'),
      supabase.from('expense_categories').select('id, label').eq('active', true).order('sort'),
    ]);
    setConnections(c.data || []); setAccounts(a.data || []);
    setTxns(t.data || []);
    setBills((b.data || []).map(x => ({ ...x, supplier_name: x.supplier?.name })));
    setExpenses((e.data || []).map(x => ({ ...x, supplier_name: x.submitter?.display_name })));
    setRules(r.data || []); setSuppliers(s.data || []); setCategories(cat.data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    setBusy('institutions'); setErr('');
    const { data, error } = await supabase.functions.invoke('bank-connect', { body: { action: 'institutions', country: 'gb' } });
    setBusy('');
    if (error || data?.error) { setErr('Could not load banks — is the bank-connect function deployed + secrets set? ' + (error?.message || data?.error || '')); return; }
    setPicker(data.institutions || []);
  };
  const pickBank = async (inst) => {
    setBusy('init'); setErr(''); setPicker(null);
    const { data, error } = await supabase.functions.invoke('bank-connect', { body: { action: 'init', institution_id: inst.id } });
    setBusy('');
    if (error || data?.error || !data?.link) { setErr('Could not start the connection. ' + (error?.message || data?.error || '')); return; }
    window.location.href = data.link;   // hosted GoCardless + bank consent page
  };
  const refresh = async (connId) => {
    setBusy('sync:' + connId); setErr('');
    const { data, error } = await supabase.functions.invoke('bank-sync', { body: { connection_id: connId } });
    setBusy('');
    if (error || data?.error) { setErr('Sync failed. ' + (error?.message || data?.error || '')); return; }
    load();
  };

  const accountsFor = (connId) => accounts.filter(a => a.connection_id === connId);

  // reconcile actions
  const markReconciled = (id, patch) => supabase.from('bank_transactions').update({ reconciled: true, ...patch }).eq('id', id);
  const matchTo = async (txn, type, id) => {
    const paid = { status: 'paid', amount_paid: Math.abs(txn.amount), paid_at: txn.booking_date || txn.value_date, payment_method: 'bank', payment_reference: txn.dedup_key };
    await supabase.from(type === 'bill' ? 'bills' : 'expenses').update(paid).eq('id', id);
    await markReconciled(txn.id, { matched_type: type, matched_id: id });
    load();
  };
  const createBill = async (txn) => {
    const rule = applyRule(txn, rules);
    const bill = txnToBill(txn, { supplier_id: rule?.supplier_id || null, category_id: rule?.category_id || null, cost_context: rule?.cost_context || 'ongoing' });
    const { data: b } = await supabase.from('bills').insert({ ...bill, created_by: profile.id }).select('id').single();
    if (b) await markReconciled(txn.id, { matched_type: 'bill', matched_id: b.id, category_id: bill.category_id });
    load();
  };
  const ignore = async (txn) => { await markReconciled(txn.id, { matched_type: 'ignored' }); load(); };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Landmark size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Bank feed</div>
            <div className="text-xs text-muted">Connect your bank, match transactions to bills &amp; expenses</div>
          </div>
        </div>
        {canWrite && <button onClick={connect} disabled={busy === 'institutions'} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> {busy === 'institutions' ? 'Loading…' : 'Connect bank'}</button>}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-5">
          {err && <div className="glass-card rounded-2xl p-3 text-sm text-red-600 flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{err}</div>}

          {/* Connections */}
          {connections.map(c => {
            const dleft = daysUntil(c.consent_expires_at);
            return (
              <div key={c.id} className="glass-card rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${c.status === 'LN' ? 'bg-emerald-500' : c.status === 'EX' || c.status === 'SUSPENDED' ? 'bg-red-500' : 'bg-amber-400'}`} />
                  <h3 className="text-[13px] font-bold text-paper">{c.institution_name || c.institution_id}</h3>
                  <span className="text-[10px] text-dim font-mono uppercase">{c.status}</span>
                  {dleft != null && c.status === 'LN' && <span className={`text-[10px] ${dleft <= 7 ? 'text-amber-600' : 'text-dim'}`}>· consent {dleft > 0 ? `expires in ${dleft}d` : 'EXPIRED — reconnect'}</span>}
                  {canWrite && c.status === 'LN' && <button onClick={() => refresh(c.id)} disabled={busy === 'sync:' + c.id} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium inline-flex items-center gap-1"><RefreshCw size={12} className={busy === 'sync:' + c.id ? 'animate-spin' : ''} /> Refresh</button>}
                </div>
                <div className="divide-y divide-bdr/60">
                  {accountsFor(c.id).length === 0 ? <div className="px-5 py-3 text-xs text-dim italic">{c.status === 'LN' ? 'No accounts yet — hit Refresh.' : 'Finish connecting at your bank.'}</div>
                    : accountsFor(c.id).map(a => (
                      <div key={a.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                        <div className="flex-1 min-w-0"><div className="text-paper truncate">{a.name || a.owner_name || a.iban || a.gc_account_id.slice(0, 8)}</div>
                          <div className="text-[10px] text-dim">{a.iban || ''}{a.last_synced_at ? ` · synced ${fmtD(a.last_synced_at.slice(0, 10))}` : ''}</div></div>
                        {a.balance != null && <div className="tabular-nums text-paper font-semibold">{gbp2(a.balance)}</div>}
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
          {connections.length === 0 && !err && <div className="glass-card rounded-2xl p-8 text-center text-dim text-sm italic">No bank connected yet — click "Connect bank" to link one via Open Banking.</div>}

          {/* Reconcile inbox */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
              <h3 className="text-[13px] font-bold text-paper">To reconcile</h3>
              <span className="text-xs text-dim font-mono">({txns.length})</span>
            </div>
            <div className="divide-y divide-bdr/60">
              {txns.length === 0 ? <div className="px-5 py-8 text-center text-dim text-sm italic">Nothing to reconcile — all caught up.</div>
                : txns.map(t => {
                  const sug = suggestMatch(t, bills, expenses);
                  const rule = applyRule(t, rules);
                  return (
                    <div key={t.id} className="px-5 py-3 flex items-center gap-3 text-sm flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="text-paper font-medium truncate">{t.payee || t.description || 'Payment'}</div>
                        <div className="text-[10px] text-dim">{fmtD(t.booking_date || t.value_date)}{rule ? ` · rule → ${categories.find(c => c.id === rule.category_id)?.label || 'categorised'}` : ''}</div>
                      </div>
                      <div className="tabular-nums font-semibold text-paper shrink-0">{gbp2(t.amount)}</div>
                      {canWrite && <div className="flex items-center gap-1.5 shrink-0">
                        {sug && <button onClick={() => matchTo(t, sug.type, sug.id)} className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Match {sug.type}</button>}
                        <button onClick={() => createBill(t)} className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-ember/10 text-ember-deep hover:bg-ember/20">Create bill</button>
                        <button onClick={() => ignore(t)} className="px-2.5 py-1 text-xs text-dim hover:text-paper">Ignore</button>
                      </div>}
                    </div>
                  );
                })}
            </div>
          </div>
          <div className="text-[11px] text-dim">"Create bill" makes a paid bill from the transaction (date, amount, payee pre‑filled). Bank data is read‑only via Open Banking — no payments are ever made from here.</div>
        </div>
      </div>

      {picker && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setPicker(null)}>
          <div className="glass-card rounded-2xl w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-bdr flex items-center justify-between sticky top-0 glass-card"><div className="text-base font-bold text-paper">Choose your bank</div><button onClick={() => setPicker(null)} className="text-muted hover:text-paper"><X size={18} /></button></div>
            <div className="p-3 space-y-1">
              {picker.length === 0 ? <div className="p-4 text-center text-dim text-sm">No banks returned.</div>
                : picker.map(i => (
                  <button key={i.id} onClick={() => pickBank(i)} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-card text-left">
                    {i.logo && <img src={i.logo} alt="" className="w-7 h-7 rounded object-contain shrink-0" />}
                    <span className="text-sm text-paper">{i.name}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
