import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { sumByCurrency, fmtByCurrency } from '../../lib/money';
import { TrendingUp, Phone, Mail, Users as UsersIcon, MessageSquare, FileText, Target } from 'lucide-react';
import { LEAD_STAGES } from '../../lib/leadStages';

// In-depth sales activity reporting: what each rep is actually doing —
// calls, emails, meetings, leads worked, deals created/moved/won — measured
// against the configurable activity goals and ARR quota.

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const gbp0 = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });

function rangeFor(preset) {
  const now = new Date(); const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  if (preset === 'week') { const dow = (start.getDay() + 6) % 7; start.setDate(start.getDate() - dow); }
  else if (preset === 'last_week') { const dow = (start.getDay() + 6) % 7; start.setDate(start.getDate() - dow - 7); end.setTime(start.getTime() + 6 * 86400000); end.setHours(23, 59, 59); }
  else if (preset === 'month') start.setDate(1);
  else if (preset === 'quarter') { start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1); }
  return { from: start, to: end };
}

const ACT_TYPES = [
  ['call', 'Calls', Phone], ['email', 'Emails', Mail], ['meeting', 'Meetings', UsersIcon],
  ['sms', 'SMS', MessageSquare], ['note', 'Notes', FileText],
];
const DEFAULT_TARGETS = { activities_per_day: 40, activities_per_week: 200, meetings_per_week: 8, quota_arr_month: 48000, commission_pct: 10 };

export default function SalesPerformance({ profile, onNavigate }) {
  const [preset, setPreset] = useState('week');
  const [custom, setCustom] = useState(null); // {from, to} iso strings
  const [reps, setReps] = useState([]);
  const [activities, setActivities] = useState([]);
  const [leads, setLeads] = useState([]);
  const [deals, setDeals] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [history, setHistory] = useState([]);
  const [targets, setTargets] = useState(DEFAULT_TARGETS);
  const [selectedRep, setSelectedRep] = useState(null);
  const [loading, setLoading] = useState(true);
  const isOwner = profile.role === 'owner';

  const { from, to } = useMemo(() => {
    if (custom) return { from: new Date(custom.from + 'T00:00:00'), to: new Date(custom.to + 'T23:59:59') };
    return rangeFor(preset);
  }, [preset, custom]);
  const fromIso = from.toISOString(), toIso = to.toISOString();
  const rangeDays = Math.max(1, Math.round((to - from) / 86400000) + (custom || preset !== 'week' ? 1 : 1));
  const weeks = Math.max(1 / 7, rangeDays / 7);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, a, l, d, q, h, st] = await Promise.all([
      supabase.from('profiles').select('id, display_name, email, teams, role'),
      supabase.from('crm_activities').select('id, type, actor_id, occurred_at, subject_type, subject_id, direction, channel_metadata').gte('occurred_at', fromIso).lte('occurred_at', toIso),
      supabase.from('leads').select('id, owner_id, stage, created_at, name'),
      supabase.from('deals').select('id, owner_id, stage, created_at, closed_at, name, value, saas_arr, payments_arr, currency'),
      supabase.from('quotes').select('id, created_by, created_at, status'),
      supabase.from('stage_history').select('id, object_type, object_id, from_stage, to_stage, changed_by, changed_at').gte('changed_at', fromIso).lte('changed_at', toIso),
      supabase.from('support_settings').select('sales_targets').eq('id', 1).maybeSingle(),
    ]);
    setReps((p.data || []).filter(x => x.display_name || x.email));
    setActivities(a.data || []); setLeads(l.data || []); setDeals(d.data || []);
    setQuotes(q.data || []); setHistory(h.data || []);
    setTargets({ ...DEFAULT_TARGETS, ...(st.data?.sales_targets || {}) });
    setLoading(false);
  }, [fromIso, toIso]);
  useEffect(() => { load(); }, [load]);

  const inRange = (ts) => ts && ts >= fromIso && ts <= toIso;

  // Per-rep stats
  const stats = useMemo(() => reps.map(r => {
    const acts = activities.filter(a => a.actor_id === r.id);
    const byType = {}; ACT_TYPES.forEach(([t]) => { byType[t] = acts.filter(a => a.type === t).length; });
    const noShows = acts.filter(a => a.type === 'meeting' && a.channel_metadata?.outcome === 'no_show').length;
    const meetingsHeld = acts.filter(a => a.type === 'meeting' && a.channel_metadata?.outcome === 'completed').length;
    const myMoves = history.filter(h => h.changed_by === r.id);
    const leadsWorked = new Set([
      ...acts.filter(a => a.subject_type === 'lead').map(a => a.subject_id),
      ...myMoves.filter(h => h.object_type === 'lead').map(h => h.object_id),
    ]).size;
    const leadsCreated = leads.filter(l => l.owner_id === r.id && inRange(l.created_at)).length;
    const dealsCreated = deals.filter(d => d.owner_id === r.id && inRange(d.created_at)).length;
    const dealsWon = deals.filter(d => d.owner_id === r.id && d.stage === 'closed_won' && inRange(d.closed_at));
    // ARR per currency (GBP default) — quota is a £ target, so pace and the
    // quota badge count £ ARR only; USD shows beside it, no invented FX.
    const arrWon = sumByCurrency(dealsWon, d => Number(d.saas_arr || 0) + Number(d.payments_arr || 0));
    const quotesSent = quotes.filter(qt => qt.created_by === r.id && inRange(qt.created_at)).length;
    const total = acts.length;
    const activityGoal = Math.round(targets.activities_per_week * weeks);
    const meetingGoal = Math.round(targets.meetings_per_week * weeks);
    const quotaScaled = targets.quota_arr_month * (rangeDays / 30.44);
    return {
      rep: r, total, byType, noShows, meetingsHeld, leadsWorked, leadsCreated, dealsCreated,
      stageMoves: myMoves.length, dealsWon: dealsWon.length, arrWon, quotesSent,
      activityGoal, meetingGoal, quotaScaled,
      hitQuota: (arrWon.GBP || 0) >= quotaScaled,
    };
  }).filter(s => s.total > 0 || s.leadsCreated > 0 || s.dealsCreated > 0 || s.stageMoves > 0 || s.quotesSent > 0 || s.dealsWon > 0)
    .sort((a, b) => b.total - a.total), [reps, activities, leads, deals, quotes, history, targets, weeks, rangeDays]);

  const teamTotals = useMemo(() => ({
    activities: stats.reduce((s, x) => s + x.total, 0),
    meetings: stats.reduce((s, x) => s + (x.byType.meeting || 0), 0),
    calls: stats.reduce((s, x) => s + (x.byType.call || 0), 0),
    won: stats.reduce((s, x) => s + x.dealsWon, 0),
    arr: stats.reduce((s, x) => ({ GBP: (s.GBP || 0) + (x.arrWon.GBP || 0), USD: (s.USD || 0) + (x.arrWon.USD || 0) }), {}),
  }), [stats]);

  const saveTargets = async (next) => {
    setTargets(next);
    await supabase.from('support_settings').upsert({ id: 1, sales_targets: next }, { onConflict: 'id' });
  };

  const input = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  const sel = stats.find(s => s.rep.id === selectedRep);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center gap-3 flex-wrap">
        <TrendingUp size={20} className="text-ember" />
        <div className="mr-2">
          <div className="text-xl font-bold text-paper">Sales Performance</div>
          <div className="text-xs text-muted">Activity, pipeline and quota by rep</div>
        </div>
        {[['week', 'This week'], ['last_week', 'Last week'], ['month', 'This month'], ['quarter', 'This quarter']].map(([k, lbl]) => (
          <button key={k} onClick={() => { setPreset(k); setCustom(null); }}
            className={`px-3 py-1.5 rounded-xl text-sm transition ${!custom && preset === k ? 'bg-ember text-white font-semibold' : 'btn-ghost'}`}>{lbl}</button>
        ))}
        <div className="flex items-center gap-1.5">
          <input type="date" className={input} value={custom?.from || iso(from)} onChange={e => setCustom({ from: e.target.value, to: custom?.to || iso(to) })} />
          <span className="text-dim text-xs">to</span>
          <input type="date" className={input} value={custom?.to || iso(to)} onChange={e => setCustom({ from: custom?.from || iso(from), to: e.target.value })} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1300px] mx-auto space-y-5">

          {/* Team summary */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Stat label="Team activities" value={teamTotals.activities} />
            <Stat label="Calls" value={teamTotals.calls} />
            <Stat label="Meetings" value={teamTotals.meetings} />
            <Stat label="Deals won" value={teamTotals.won} tone="emerald" />
            <Stat label="ARR won" value={fmtByCurrency(teamTotals.arr, 0)} tone="emerald" />
          </div>

          {/* Targets */}
          <div className="glass-card rounded-2xl p-4 flex items-center gap-5 flex-wrap">
            <div className="flex items-center gap-2 text-sm font-bold text-paper"><Target size={15} className="text-ember" /> Goals</div>
            <TargetField label="Activities / week" value={targets.activities_per_week} disabled={!isOwner}
              onSave={v => saveTargets({ ...targets, activities_per_week: v })} />
            <TargetField label="Meetings / week" value={targets.meetings_per_week} disabled={!isOwner}
              onSave={v => saveTargets({ ...targets, meetings_per_week: v })} />
            <TargetField label="Quota ARR / month" value={targets.quota_arr_month} disabled={!isOwner} money
              onSave={v => saveTargets({ ...targets, quota_arr_month: v })} />
            <TargetField label="Commission %" value={targets.commission_pct} disabled={!isOwner}
              onSave={v => saveTargets({ ...targets, commission_pct: v })} />
            <div className="text-[11px] text-dim ml-auto">Goals scale to the selected period{!isOwner ? ' · owner edits' : ''}</div>
          </div>

          {/* Leaderboard */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-bdr"><h3 className="text-[13px] font-bold text-paper">Rep leaderboard</h3></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1050px]">
                <thead>
                  <tr className="text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-dim border-b border-bdr">
                    <th className="text-left px-5 py-2.5 font-bold">Rep</th>
                    <th className="text-right px-2 py-2.5 font-bold">Activities</th>
                    {ACT_TYPES.map(([k, lbl]) => <th key={k} className="text-right px-2 py-2.5 font-bold">{lbl}</th>)}
                    <th className="text-right px-2 py-2.5 font-bold">Leads new</th>
                    <th className="text-right px-2 py-2.5 font-bold">Leads worked</th>
                    <th className="text-right px-2 py-2.5 font-bold">Deals new</th>
                    <th className="text-right px-2 py-2.5 font-bold">Stage moves</th>
                    <th className="text-right px-2 py-2.5 font-bold">Quotes</th>
                    <th className="text-right px-2 py-2.5 font-bold">Won</th>
                    <th className="text-right px-5 py-2.5 font-bold">ARR won</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? <tr><td colSpan={13} className="px-5 py-8 text-center text-dim">Loading…</td></tr>
                    : stats.length === 0 ? <tr><td colSpan={13} className="px-5 py-8 text-center text-dim italic">No sales activity in this period.</td></tr>
                    : stats.map(s => (
                      <tr key={s.rep.id} onClick={() => setSelectedRep(selectedRep === s.rep.id ? null : s.rep.id)}
                        className={`border-b border-bdr/60 cursor-pointer ${selectedRep === s.rep.id ? 'bg-ember/5' : 'hover:bg-card/50'}`}>
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="w-7 h-7 rounded-full bg-ember/15 text-ember-deep text-[11px] font-bold flex items-center justify-center shrink-0">
                              {(s.rep.display_name || s.rep.email)[0].toUpperCase()}</span>
                            <span className="text-paper font-medium">{s.rep.display_name || s.rep.email.split('@')[0]}</span>
                            {s.hitQuota && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Quota ✓</span>}
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <span className="font-semibold text-paper tabular-nums">{s.total}</span>
                          <Pace value={s.total} goal={s.activityGoal} />
                        </td>
                        {ACT_TYPES.map(([k]) => (
                          <td key={k} className="px-2 py-2.5 text-right tabular-nums text-muted">
                            {s.byType[k] || 0}
                            {k === 'meeting' && s.noShows > 0 && <span className="text-[9px] font-bold text-red-500 ml-1">({s.noShows} NS)</span>}
                            {k === 'meeting' && <Pace value={s.byType.meeting || 0} goal={s.meetingGoal} />}
                          </td>
                        ))}
                        <td className="px-2 py-2.5 text-right tabular-nums text-paper">{s.leadsCreated}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-paper">{s.leadsWorked}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-paper">{s.dealsCreated}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-muted">{s.stageMoves}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-muted">{s.quotesSent}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums font-semibold text-emerald-600">{s.dealsWon}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums font-semibold text-paper">{fmtByCurrency(s.arrWon, 0)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Rep drill-down */}
          {sel && <RepDetail s={sel} activities={activities} leads={leads} deals={deals} from={from} to={to} onNavigate={onNavigate} targets={targets} />}

        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${tone === 'emerald' ? 'text-emerald-600' : 'text-paper'}`}>{value}</div>
    </div>
  );
}

function Pace({ value, goal }) {
  if (!goal) return null;
  const pct = Math.min(100, (value / goal) * 100);
  return (
    <div className="w-14 ml-auto mt-0.5">
      <div className="h-1 rounded-full bg-card overflow-hidden">
        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[9px] text-dim text-right">{value}/{goal}</div>
    </div>
  );
}

function TargetField({ label, value, onSave, disabled, money }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      {label}
      <input className="w-20 px-2 py-1 bg-card border border-bdr rounded-lg text-sm text-paper text-right focus:outline-none focus:border-ember disabled:opacity-60"
        value={v} disabled={disabled}
        onChange={e => setV(e.target.value)}
        onBlur={() => { const n = Number(v); if (!Number.isNaN(n) && n !== value) onSave(n); }} />
      {money && <span className="text-dim">£</span>}
    </label>
  );
}

function RepDetail({ s, activities, leads, deals, from, to, onNavigate, targets }) {
  const name = s.rep.display_name || s.rep.email.split('@')[0];
  const mine = activities.filter(a => a.actor_id === s.rep.id).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

  // daily activity counts
  const days = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) days.push(iso(new Date(d)));
  const perDay = days.map(day => mine.filter(a => a.occurred_at.slice(0, 10) === day).length);
  const maxDay = Math.max(1, ...perDay);

  const myLeads = leads.filter(l => l.owner_id === s.rep.id && !['disqualified'].includes(l.stage));
  const funnel = LEAD_STAGES.filter(st => st.key !== 'disqualified').map(st => ({ ...st, n: myLeads.filter(l => l.stage === st.key).length }));
  const openDeals = deals.filter(d => d.owner_id === s.rep.id && !['closed_won', 'closed_lost'].includes(d.stage));
  const pipeline = sumByCurrency(openDeals, d => Number(d.saas_arr || 0) + Number(d.payments_arr || 0));
  const commissionPct = Number(targets.commission_pct || 0) / 100;
  const commission = s.hitQuota ? { GBP: (s.arrWon.GBP || 0) * commissionPct, USD: (s.arrWon.USD || 0) * commissionPct } : { GBP: 0 };
  const TYPE_ICON = { call: '📞', email: '📧', sms: '💬', note: '📝', meeting: '🤝', whatsapp: '📲' };

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-3 flex-wrap">
        <h3 className="text-[13px] font-bold text-paper">{name} — detail</h3>
        <span className="text-xs text-muted">{s.total} activities · {s.dealsWon} won · {fmtByCurrency(s.arrWon, 0)} ARR</span>
        {s.hitQuota
          ? <span className="text-xs font-semibold text-emerald-600 ml-auto">Quota hit — est. commission {fmtByCurrency(commission, 0)}</span>
          : <span className="text-xs text-dim ml-auto">{fmtByCurrency(s.arrWon, 0)} / {gbp0(s.quotaScaled)} quota ({Math.round(((s.arrWon.GBP || 0) / Math.max(1, s.quotaScaled)) * 100)}%)</span>}
      </div>
      <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Daily activity */}
        <div>
          <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-2">Activity by day</div>
          <div className="flex items-end gap-1 h-28">
            {perDay.map((n, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1" title={`${days[i]}: ${n}`}>
                <div className="w-full rounded-t bg-ember/70" style={{ height: `${(n / maxDay) * 100}%`, minHeight: n ? 3 : 0 }} />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[9px] text-dim mt-1">
            <span>{days[0]?.slice(5)}</span><span>{days[days.length - 1]?.slice(5)}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {ACT_TYPES.map(([k, lbl]) => (
              <span key={k} className="text-[11px] px-2 py-0.5 rounded-lg bg-card text-muted">{lbl}: <b className="text-paper">{s.byType[k] || 0}</b></span>
            ))}
            <span className="text-[11px] px-2 py-0.5 rounded-lg bg-emerald-50 text-emerald-700">Held: <b>{s.meetingsHeld}</b></span>
            <span className={`text-[11px] px-2 py-0.5 rounded-lg ${s.noShows ? 'bg-red-50 text-red-600' : 'bg-card text-muted'}`}>No-shows: <b>{s.noShows}</b></span>
          </div>
        </div>

        {/* Lead funnel + pipeline */}
        <div>
          <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-2">Their lead funnel (current)</div>
          <div className="space-y-1.5">
            {funnel.map(st => {
              const max = Math.max(1, ...funnel.map(f => f.n));
              return (
                <div key={st.key} className="flex items-center gap-2 text-xs">
                  <span className="w-24 text-muted truncate">{st.label}</span>
                  <div className="flex-1 h-3.5 rounded bg-card overflow-hidden">
                    <div className="h-full rounded bg-ember/60" style={{ width: `${(st.n / max) * 100}%` }} />
                  </div>
                  <span className="w-6 text-right tabular-nums text-paper">{st.n}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 text-xs text-muted">Open deals: <b className="text-paper">{openDeals.length}</b> · Pipeline ARR: <b className="text-paper">{fmtByCurrency(pipeline, 0)}</b></div>
        </div>

        {/* Recent activity */}
        <div>
          <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-2">Latest activity</div>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {mine.slice(0, 20).map(a => (
              <div key={a.id} className="flex items-center gap-2 text-xs py-1 border-b border-bdr/40 last:border-0">
                <span>{TYPE_ICON[a.type] || '📝'}</span>
                <span className="text-paper capitalize">{a.type}</span>
                {a.direction && <span className="text-dim">{a.direction === 'inbound' ? '← in' : '→ out'}</span>}
                {a.subject_type && (
                  <button onClick={() => onNavigate?.(a.subject_type, a.subject_id)} className="text-dim hover:text-ember capitalize">on {a.subject_type}</button>
                )}
                <span className="text-dim ml-auto shrink-0">{new Date(a.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
            {mine.length === 0 && <div className="text-xs text-dim italic">No activity in this period.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
