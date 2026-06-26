import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { round2, gbp2 } from '../../lib/money.js';
import { computeMileage, taxYearBounds } from '../../lib/rates.js';
import { ytdMilesBefore, canDo, EXPENSE_ACTIONS, STATUS_LABEL, STATUS_BADGE, isApprover } from '../../lib/expenseOps.js';
import AttachmentsCard from '../crm/AttachmentsCard.jsx';

const nowIso = () => new Date().toISOString();
const fmtDT = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

export default function ExpenseBuilder({ expenseId, profile, onClose, onNavigate }) {
  const [exp, setExp] = useState(null);
  const [cats, setCats] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [people, setPeople] = useState([]);
  const [amapRows, setAmapRows] = useState([]);
  const [priorMileage, setPriorMileage] = useState([]);
  const [events, setEvents] = useState([]);
  const [receiptCount, setReceiptCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    const { data: e } = await supabase.from('expenses').select('*').eq('id', expenseId).single();
    setExp(e);
    const [c, co, l, d, p, a, ev, att] = await Promise.all([
      supabase.from('expense_categories').select('id, label, default_tax_rate, reclaimable').eq('active', true).order('sort'),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
      supabase.from('deals').select('id, title, company_id').order('created_at', { ascending: false }).limit(500),
      supabase.from('profiles').select('id, display_name, role').order('display_name'),
      supabase.from('amap_rates').select('*'),
      supabase.from('expense_events').select('*, actor:profiles(display_name)').eq('expense_id', expenseId).order('created_at'),
      supabase.from('attachments').select('id', { count: 'exact', head: true }).eq('subject_type', 'expense').eq('subject_id', expenseId),
    ]);
    setCats(c.data || []); setCompanies(co.data || []); setLocations(l.data || []); setDeals(d.data || []);
    setPeople(p.data || []); setAmapRows(a.data || []); setEvents(ev.data || []); setReceiptCount(att.count || 0);
    if (e?.submitter_id) {
      const { data: pm } = await supabase.from('expenses').select('id, type, journey_date, miles').eq('submitter_id', e.submitter_id).eq('type', 'mileage');
      setPriorMileage(pm || []);
    }
  }, [expenseId]);
  useEffect(() => { load(); }, [load]);

  const jd = exp?.journey_date || exp?.expense_date;  // journey date defaults to the expense date
  const ytd = useMemo(() => exp?.type === 'mileage' && jd ? ytdMilesBefore(priorMileage, jd, expenseId) : 0, [exp, jd, priorMileage, expenseId]);
  const mileage = useMemo(() => exp?.type === 'mileage'
    ? computeMileage({ amapRows, vehicleType: exp.vehicle_type || 'car_van', journeyDate: jd, miles: exp.miles, ytdMilesBefore: ytd, passengers: exp.passengers })
    : null, [exp, jd, amapRows, ytd]);

  if (!exp) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading…</div>;

  const totals = exp.type === 'mileage'
    ? { net: mileage?.amount || 0, vat: 0, gross: mileage?.amount || 0 }
    : { gross: Number(exp.total || 0), vat: Number(exp.tax_amount || 0), net: round2(Number(exp.total || 0) - Number(exp.tax_amount || 0)) };

  const set = (k, v) => setExp(p => ({ ...p, [k]: v }));
  const locked = ['approved', 'paid'].includes(exp.status) && !isApprover(profile);
  const editable = !['paid'].includes(exp.status) && (exp.submitter_id === profile.id || isApprover(profile));
  const notify = (m) => { setFlash(m); setTimeout(() => setFlash(''), 2500); };

  const buildPatch = () => {
    const common = {
      type: exp.type, category_id: exp.category_id || null, company_id: exp.company_id || null,
      location_id: exp.location_id || null, deal_id: exp.deal_id || null, cost_context: exp.cost_context || 'ongoing',
      expense_date: exp.expense_date, description: (exp.description || '').trim() || null,
      reimburse_to_user_id: exp.reimburse_to_user_id || exp.submitter_id,
      vat_reclaimable: !!exp.vat_reclaimable, has_vat_invoice: !!exp.has_vat_invoice,
      notes: (exp.notes || '').trim() || null, updated_at: nowIso(),
    };
    if (exp.type === 'mileage') {
      return { ...common, vehicle_type: exp.vehicle_type || 'car_van', journey_date: exp.journey_date || exp.expense_date,
        from_location: (exp.from_location || '').trim() || null, to_location: (exp.to_location || '').trim() || null,
        purpose: (exp.purpose || '').trim() || null, miles: Number(exp.miles) || 0, passengers: Number(exp.passengers) || 0,
        ytd_miles_before: ytd, rate_pence: mileage?.firstRate ?? null,
        subtotal: totals.gross, tax_amount: 0, total: totals.gross };
    }
    return { ...common, subtotal: totals.net, tax_amount: totals.vat, total: totals.gross };
  };

  const save = async () => {
    setBusy(true);
    const { error } = await supabase.from('expenses').update(buildPatch()).eq('id', expenseId);
    setBusy(false);
    if (error) { alert(error.message); return false; }
    notify('Saved'); load(); return true;
  };

  const notifyUsers = async (ids, title, body) => {
    const recips = [...new Set(ids.filter(Boolean).filter(id => id !== profile.id))];
    if (!recips.length) return;
    await supabase.from('notifications').insert(recips.map(rid => ({
      recipient_id: rid, actor_id: profile.id, type: 'system', title, body, entity_type: 'expense', link_id: expenseId,
    })));
  };

  const act = async (action, extra = {}, note) => {
    if (!canDo(action, exp, profile)) return;
    if (action === 'submit' && exp.type !== 'mileage' && receiptCount === 0) { alert('A receipt is required before submitting a non-mileage claim.'); return; }
    setBusy(true);
    await supabase.from('expenses').update(buildPatch()).eq('id', expenseId); // persist edits first
    const to = EXPENSE_ACTIONS[action].to;
    const { error } = await supabase.from('expenses').update({ status: to, ...extra, updated_at: nowIso() }).eq('id', expenseId);
    if (!error) {
      await supabase.from('expense_events').insert({ expense_id: expenseId, actor_id: profile.id, from_status: exp.status, to_status: to, note: note || null });
      const amt = gbp2(totals.gross);
      if (action === 'submit') await notifyUsers(people.filter(p => p.role === 'owner' || p.role === 'editor').map(p => p.id), 'Expense submitted', `${profile.display_name || 'Someone'} submitted EXP-${exp.expense_number} (${amt})`);
      if (action === 'approve') await notifyUsers([exp.submitter_id, exp.reimburse_to_user_id], 'Expense approved', `Your claim EXP-${exp.expense_number} (${amt}) was approved`);
      if (action === 'reject') await notifyUsers([exp.submitter_id], 'Expense rejected', `EXP-${exp.expense_number} was rejected: ${note || 'no reason given'}`);
      if (action === 'pay') await notifyUsers([exp.submitter_id, exp.reimburse_to_user_id], 'Expense paid', `EXP-${exp.expense_number} (${amt}) has been paid`);
    }
    setBusy(false);
    if (error) { alert(error.message); return; }
    load();
  };

  const approve = () => act('approve', { approver_id: profile.id, approved_at: nowIso(), rejection_reason: null });
  const reject = () => { const r = prompt('Reason for rejection?'); if (r == null) return; act('reject', { approver_id: profile.id, rejection_reason: r }, r); };
  const pay = () => { const ref = prompt('Payment reference (optional):') || null; act('pay', { paid_at: nowIso(), payment_reference: ref }, ref ? `ref ${ref}` : null); };
  const submit = () => act('submit', { submitted_at: nowIso() });

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember disabled:opacity-60";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
  const ty = taxYearBounds(exp.journey_date || exp.expense_date);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <button onClick={onClose} className="text-muted hover:text-paper text-lg">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold text-paper">Claim #{exp.expense_number}</div>
            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg ${STATUS_BADGE[exp.status]}`}>{STATUS_LABEL[exp.status]}</span>
          </div>
          {exp.rejection_reason && exp.status === 'rejected' && <div className="text-xs text-red-600 mt-0.5">Rejected: {exp.rejection_reason}</div>}
        </div>
        <div className="flex items-center gap-2">
          {flash && <span className="text-sm text-emerald-600 font-medium">✓ {flash}</span>}
          {editable && <button onClick={save} disabled={busy} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">Save</button>}
          {canDo('submit', exp, profile) && <button onClick={submit} disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-xl bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-200">Submit</button>}
          {canDo('approve', exp, profile) && <button onClick={approve} disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-xl bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200">Approve</button>}
          {canDo('reject', exp, profile) && <button onClick={reject} disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-xl bg-red-100 text-red-700 border border-red-200 hover:bg-red-200">Reject</button>}
          {canDo('pay', exp, profile) && <button onClick={pay} disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-xl bg-ember text-white hover:bg-ember-deep">Mark paid</button>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-12 gap-4 max-w-[1100px]">
          <div className="col-span-7 space-y-4">
            {/* Type toggle */}
            <div className="glass-card rounded-2xl p-4 space-y-3">
              <div className="flex gap-1 bg-card rounded-xl p-0.5 w-fit">
                {[['staff_claim', 'Expense'], ['mileage', 'Mileage']].map(([t, lbl]) => (
                  <button key={t} disabled={!editable} onClick={() => set('type', t)} className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${exp.type === t ? 'bg-ember text-white' : 'text-muted'}`}>{lbl}</button>
                ))}
              </div>

              {exp.type === 'mileage' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className={label}>Vehicle</label>
                      <select className={input} disabled={!editable} value={exp.vehicle_type || 'car_van'} onChange={e => set('vehicle_type', e.target.value)}>
                        <option value="car_van">Car / van</option><option value="motorcycle">Motorcycle</option><option value="bicycle">Bicycle</option></select></div>
                    <div><label className={label}>Journey date</label><input type="date" className={input} disabled={!editable} value={exp.journey_date || exp.expense_date || ''} onChange={e => set('journey_date', e.target.value)} /></div>
                    <div><label className={label}>From</label><input className={input} disabled={!editable} value={exp.from_location || ''} onChange={e => set('from_location', e.target.value)} /></div>
                    <div><label className={label}>To</label><input className={input} disabled={!editable} value={exp.to_location || ''} onChange={e => set('to_location', e.target.value)} /></div>
                    <div><label className={label}>Miles</label><input type="number" className={input} disabled={!editable} value={exp.miles ?? ''} onChange={e => set('miles', e.target.value)} /></div>
                    <div><label className={label}>Passengers</label><input type="number" className={input} disabled={!editable} value={exp.passengers ?? 0} onChange={e => set('passengers', e.target.value)} /></div>
                  </div>
                  <div><label className={label}>Purpose</label><input className={input} disabled={!editable} value={exp.purpose || ''} onChange={e => set('purpose', e.target.value)} /></div>
                  {mileage && Number(exp.miles) > 0 && (
                    <div className="glass-inner rounded-xl p-3 text-sm">
                      <div className="flex justify-between"><span className="text-muted">Tax year {ty?.label} so far</span><span className="tabular-nums">{ytd.toLocaleString('en-GB')} mi</span></div>
                      {exp.vehicle_type !== 'motorcycle' && exp.vehicle_type !== 'bicycle' && (
                        <div className="flex justify-between text-xs text-dim"><span>{mileage.firstMiles} mi @ {mileage.firstRate}p{mileage.aboveMiles ? ` + ${mileage.aboveMiles} mi @ ${mileage.aboveRate}p` : ''}</span><span className="tabular-nums">{gbp2(mileage.mileageAmount)}</span></div>
                      )}
                      {mileage.passengerAmount > 0 && <div className="flex justify-between text-xs text-dim"><span>{exp.passengers} passenger(s) supplement</span><span className="tabular-nums">{gbp2(mileage.passengerAmount)}</span></div>}
                      <div className="flex justify-between font-semibold text-paper mt-1"><span>Reimbursement</span><span className="tabular-nums">{gbp2(mileage.amount)}</span></div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div><label className={label}>Description</label><input className={input} disabled={!editable} value={exp.description || ''} onChange={e => set('description', e.target.value)} placeholder="What was it for?" /></div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className={label}>Date</label><input type="date" className={input} disabled={!editable} value={exp.expense_date || ''} onChange={e => set('expense_date', e.target.value)} /></div>
                    <div><label className={label}>Amount (gross) £</label><input type="number" className={input} disabled={!editable} value={exp.total ?? ''} onChange={e => set('total', e.target.value)} /></div>
                    <div><label className={label}>of which VAT £</label><input type="number" className={input} disabled={!editable} value={exp.tax_amount ?? ''} onChange={e => set('tax_amount', e.target.value)} /></div>
                  </div>
                </>
              )}
            </div>

            <AttachmentsCard subjectType="expense" subjectId={expenseId} profile={profile} />
            {exp.type !== 'mileage' && receiptCount === 0 && <div className="text-[11px] text-amber-600">⚠ A receipt is required before you can submit this claim.</div>}

            {/* Audit timeline */}
            <div className="glass-card rounded-2xl p-4">
              <div className="text-sm font-bold text-paper mb-2">History</div>
              {events.length === 0 ? <div className="text-xs text-dim italic">No activity yet.</div>
                : <div className="space-y-1.5">
                  {events.map(ev => (
                    <div key={ev.id} className="text-xs text-muted flex gap-2">
                      <span className="text-dim w-28 shrink-0">{fmtDT(ev.created_at)}</span>
                      <span className="text-paper">{STATUS_LABEL[ev.to_status] || ev.to_status}</span>
                      <span>· {ev.actor?.display_name || 'system'}{ev.note ? ` — ${ev.note}` : ''}</span>
                    </div>
                  ))}
                </div>}
            </div>
          </div>

          {/* Right */}
          <div className="col-span-5 space-y-4">
            <div className="glass-card rounded-2xl p-4">
              <div className="text-sm font-bold text-paper mb-1">Total</div>
              <Row k="Net" v={gbp2(totals.net)} />
              <Row k="VAT" v={gbp2(totals.vat)} />
              <Row k="Claim total" v={gbp2(totals.gross)} bold />
            </div>
            <div className="glass-card rounded-2xl p-4 space-y-3">
              <div className="text-sm font-bold text-paper">Details</div>
              <div><label className={label}>Category</label>
                <select className={input} disabled={!editable} value={exp.category_id || ''} onChange={e => set('category_id', e.target.value || null)}>
                  <option value="">—</option>{cats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
              <div><label className={label}>Reimburse to</label>
                <select className={input} disabled={!isApprover(profile) && !editable} value={exp.reimburse_to_user_id || exp.submitter_id || ''} onChange={e => set('reimburse_to_user_id', e.target.value)}>
                  {people.map(p => <option key={p.id} value={p.id}>{p.display_name || p.id.slice(0, 6)}</option>)}</select></div>
              <div><label className={label}>Cost context</label>
                <div className="flex gap-1 bg-card rounded-xl p-0.5">
                  {['ongoing', 'deal'].map(c => <button key={c} disabled={!editable} onClick={() => set('cost_context', c)} className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold ${exp.cost_context === c ? 'bg-ember text-white' : 'text-muted'}`}>{c === 'deal' ? 'Deal cost' : 'Ongoing'}</button>)}</div></div>
              <div><label className={label}>Customer</label>
                <select className={input} disabled={!editable} value={exp.company_id || ''} onChange={e => { set('company_id', e.target.value || null); set('location_id', null); }}>
                  <option value="">—</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div><label className={label}>Deal</label>
                <select className={input} disabled={!editable} value={exp.deal_id || ''} onChange={e => set('deal_id', e.target.value || null)}>
                  <option value="">—</option>{deals.filter(d => !exp.company_id || d.company_id === exp.company_id).map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></div>
            </div>
            {exp.status === 'paid' && <div className="glass-card rounded-2xl p-4 text-sm"><div className="text-emerald-600 font-semibold">Paid {fmtDT(exp.paid_at)}</div>{exp.payment_reference && <div className="text-xs text-muted">Ref: {exp.payment_reference}</div>}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, bold }) {
  return <div className="flex justify-between py-1 text-sm"><span className="text-muted">{k}</span><span className={`font-mono ${bold ? 'text-paper font-bold' : 'text-paper'}`}>{v}</span></div>;
}
