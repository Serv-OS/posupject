import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { pipelineTotals, DEFAULT_STAGE_WEIGHTS } from '../../lib/trading';
import { gbp0 } from '../../lib/money';
import { oneOffValue, recurringValue, totalValue } from '../../lib/dealValue';

// CEO-defined targets (see project_sales_targets memory)
const MONTHLY_ARR_QUOTA = 48000;   // $48K new ARR per AE per month
const COMMISSION_RATE = 0.10;      // 10% of ARR
const GOAL_ACTIVITIES_DAY = 40;
const GOAL_ACTIVITIES_WEEK = 200;
const GOAL_DEMOS_SCHEDULED_WEEK = 8;
const GOAL_DEMOS_RUN_WEEK = 8;
const GOAL_ONSITE_WEEK = 50;

function startOfMonth() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfToday() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function startOfWeek() { const d = startOfToday(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d; } // Monday

// Lead funnel stages for this CRM's pipeline (see LeadBoard).
const LEAD_OPEN_STAGES = ['new_lead','attempting','mql','sql'];
const LEAD_ENGAGED_STAGES = ['attempting','mql'];
const LEAD_QUALIFIED_STAGES = ['sql','deal'];
const LEAD_STALE_DAYS = 5;

export default function ReportingDashboard({ profile }) {
  const [deals, setDeals] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [locationModules, setLocationModules] = useState([]);
  const [modules, setModules] = useState([]);
  const [featureRequests, setFeatureRequests] = useState([]);
  const [stageHistory, setStageHistory] = useState([]);
  const [members, setMembers] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [trading, setTrading] = useState([]);
  const [weights, setWeights] = useState(DEFAULT_STAGE_WEIGHTS);
  const [tab, setTab] = useState('leads');
  const [leads, setLeads] = useState([]);
  const [leadDays, setLeadDays] = useState(30);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const results = await Promise.all([
      supabase.from('deals').select('*'),
      supabase.from('onboardings').select('*'),
      supabase.from('tickets').select('*'),
      supabase.from('tasks').select('*'),
      supabase.from('companies').select('*'),
      supabase.from('locations').select('*'),
      supabase.from('contacts').select('*'),
      supabase.from('location_modules').select('*'),
      supabase.from('modules').select('*').order('sort_order'),
      supabase.from('feature_requests').select('*'),
      supabase.from('stage_history').select('*').order('changed_at', { ascending: false }).limit(2000),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_activities').select('actor_id, type, occurred_at').gte('occurred_at', startOfMonth().toISOString()),
      supabase.from('leads').select('*'),
      supabase.from('deal_trading').select('*'),
      supabase.from('deal_stage_weights').select('stage, probability'),
    ]);
    setDeals(results[0].data || []);
    setTrading(results[14]?.data || []);
    if (results[15]?.data?.length) {
      setWeights(Object.fromEntries(results[15].data.map(w => [w.stage, Number(w.probability)])));
    }
    setOnboardings(results[1].data || []);
    setTickets(results[2].data || []);
    setTasks(results[3].data || []);
    setCompanies(results[4].data || []);
    setLocations(results[5].data || []);
    setContacts(results[6].data || []);
    setLocationModules(results[7].data || []);
    setModules(results[8].data || []);
    setFeatureRequests(results[9].data || []);
    setStageHistory(results[10].data || []);
    setMembers(results[11].data || []);
    setActivities(results[12].data || []);
    setLeads(results[13].data || []);
    setLoading(false);
  };

  const ownerName = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : ''; };

  const exportCSV = (headers, rows, filename) => {
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  };

  // Lead metrics — period-scoped funnel, sources, owners, stale detection
  const leadMetrics = useMemo(() => {
    const now = Date.now();
    const cut = now - leadDays * 86400000;
    const inP = (ts) => ts && new Date(ts).getTime() >= cut;
    const isQualified = (l, qIds) => LEAD_QUALIFIED_STAGES.includes(l.stage) || qIds.has(l.id);

    const newLeads = leads.filter(l => inP(l.created_at));
    const leadHist = stageHistory.filter(h => h.object_type === 'lead' && inP(h.changed_at));
    const movedTo = (stages) => { const ids = new Set(); leadHist.forEach(h => { if (stages.includes(h.to_stage)) ids.add(h.object_id); }); return ids; };
    const engagedIds = movedTo(LEAD_ENGAGED_STAGES);
    const qualifiedIds = movedTo(LEAD_QUALIFIED_STAGES);
    const disqualifiedIds = movedTo(['disqualified']);

    // How long from lead creation to qualification (for quals that happened in period)
    const qDays = [];
    leadHist.forEach(h => {
      if (!LEAD_QUALIFIED_STAGES.includes(h.to_stage)) return;
      const l = leads.find(x => x.id === h.object_id);
      if (l?.created_at) qDays.push((new Date(h.changed_at) - new Date(l.created_at)) / 86400000);
    });
    const avgToQualify = qDays.length ? qDays.reduce((a, b) => a + b, 0) / qDays.length : null;

    // Stale = still open but untouched for LEAD_STALE_DAYS+
    const staleLeads = leads
      .filter(l => LEAD_OPEN_STAGES.includes(l.stage) && (now - new Date(l.updated_at || l.created_at).getTime()) > LEAD_STALE_DAYS * 86400000)
      .map(l => ({ ...l, staleDays: Math.floor((now - new Date(l.updated_at || l.created_at).getTime()) / 86400000) }))
      .sort((a, b) => b.staleDays - a.staleDays);

    const bySource = {};
    newLeads.forEach(l => {
      const s = (l.source || 'unknown').toLowerCase();
      bySource[s] = bySource[s] || { count: 0, qualified: 0 };
      bySource[s].count++;
      if (isQualified(l, qualifiedIds)) bySource[s].qualified++;
    });

    const byOwner = {};
    const own = (id) => ownerName(id) || 'Unassigned';
    newLeads.forEach(l => {
      byOwner[own(l.owner_id)] = byOwner[own(l.owner_id)] || { count: 0, qualified: 0, stale: 0 };
      byOwner[own(l.owner_id)].count++;
      if (isQualified(l, qualifiedIds)) byOwner[own(l.owner_id)].qualified++;
    });
    staleLeads.forEach(l => {
      byOwner[own(l.owner_id)] = byOwner[own(l.owner_id)] || { count: 0, qualified: 0, stale: 0 };
      byOwner[own(l.owner_id)].stale++;
    });

    // New leads per week, last 8 weeks
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const start = startOfWeek().getTime() - i * 7 * 86400000;
      const end = start + 7 * 86400000;
      weeks.push({
        label: new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        n: leads.filter(l => { const t = new Date(l.created_at).getTime(); return t >= start && t < end; }).length,
      });
    }

    const qualifiedNew = newLeads.filter(l => isQualified(l, qualifiedIds)).length;
    return {
      newCount: newLeads.length, engaged: engagedIds.size, qualified: qualifiedIds.size,
      disqualified: disqualifiedIds.size,
      conv: newLeads.length ? Math.round((qualifiedNew / newLeads.length) * 100) : 0,
      avgToQualify, staleLeads, openCount: leads.filter(l => LEAD_OPEN_STAGES.includes(l.stage)).length,
      bySource, byOwner, weeks,
    };
  }, [leads, stageHistory, leadDays, members]);

  // Sales metrics
  const [dealDays, setDealDays] = useState(90);

  const salesMetrics = useMemo(() => {
    // ── Deal analytics ──────────────────────────────────────────────────────
    // Close rate is measured on DEALS, never leads. A big share of what gets
    // signed here never had a lead at all — deals are passed in to close — so
    // any funnel that starts at leads simply doesn't see them.
    //
    // Value model: one-off = hardware + services (falling back to the deal's
    // headline value when those aren't broken out, which is how the passed-in
    // one-time deals are recorded); recurring = SaaS ARR + payments ARR.
    // Value rules live in lib/dealValue.js and are pinned by tests — reporting
    // must never re-invent what a deal is worth.
    const oneOff = oneOffValue;
    const recurring = recurringValue;
    const totalOf = totalValue;
    const closedAt = (d) => new Date(d.closed_at || d.updated_at || d.created_at);

    const cutoff = dealDays === 0 ? null : new Date(Date.now() - dealDays * 86400000);
    const inRange = (d) => !cutoff || closedAt(d) >= cutoff;

    const pipeline = deals.filter(d => !['closed_won','closed_lost'].includes(d.stage));
    const wonAll = deals.filter(d => d.stage === 'closed_won');
    const won = wonAll.filter(inRange);
    const lost = deals.filter(d => d.stage === 'closed_lost').filter(inRange);
    const closed = [...won, ...lost];

    const pipelineValue = pipeline.reduce((s, d) => s + totalOf(d), 0);
    const wonValue = won.reduce((s, d) => s + totalOf(d), 0);
    const wonOneOff = won.reduce((s, d) => s + oneOff(d), 0);
    const wonRecurring = won.reduce((s, d) => s + recurring(d), 0);
    const winRate = closed.length ? Math.round((won.length / closed.length) * 100) : 0;
    const avgDeal = won.length ? wonValue / won.length : 0;
    const daysToClose = won
      .filter(d => d.closed_at && d.created_at)
      .map(d => (new Date(d.closed_at) - new Date(d.created_at)) / 86400000);
    const avgDays = daysToClose.length ? Math.round(daysToClose.reduce((a, b) => a + b, 0) / daysToClose.length) : null;

    // How the deal arrived: a deal a lead points at came through the funnel;
    // everything else was passed in directly. Detected from the data, so nobody
    // has to remember to tag anything.
    const leadDealIds = new Set(leads.map(l => l.deal_id).filter(Boolean));
    const channelOf = (d) => leadDealIds.has(d.id) ? 'From leads' : 'Passed in / direct';
    const byChannel = {};
    closed.forEach(d => {
      const c = byChannel[channelOf(d)] || (byChannel[channelOf(d)] = { won: 0, lost: 0, value: 0 });
      if (d.stage === 'closed_won') { c.won += 1; c.value += totalOf(d); } else c.lost += 1;
    });
    pipeline.forEach(d => {
      const c = byChannel[channelOf(d)] || (byChannel[channelOf(d)] = { won: 0, lost: 0, value: 0 });
      c.open = (c.open || 0) + 1;
    });

    // Monthly won trend, last 12 months — count and value.
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString('en-GB', { month: 'short' }), count: 0, value: 0 });
    }
    const byKey = Object.fromEntries(months.map(m => [m.key, m]));
    wonAll.forEach(d => {
      const c = closedAt(d);
      const k = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}`;
      if (byKey[k]) { byKey[k].count += 1; byKey[k].value += totalOf(d); }
    });

    // Lost reasons — why deals die, ranked.
    const lostReasons = {};
    lost.forEach(d => { const r = (d.lost_reason || 'No reason recorded').trim(); lostReasons[r] = (lostReasons[r] || 0) + 1; });

    // By owner: closed performance, not just deal counts.
    const byOwner = {};
    closed.forEach(d => {
      const n = ownerName(d.owner_id) || 'Unassigned';
      const o = byOwner[n] || (byOwner[n] = { won: 0, lost: 0, value: 0 });
      if (d.stage === 'closed_won') { o.won += 1; o.value += totalOf(d); } else o.lost += 1;
    });

    // By source label, for the deals that carry one.
    const bySource = {};
    closed.forEach(d => {
      const src = (d.source || 'not set').trim();
      const o = bySource[src] || (bySource[src] = { won: 0, lost: 0, value: 0 });
      if (d.stage === 'closed_won') { o.won += 1; o.value += totalOf(d); } else o.lost += 1;
    });

    // Pipeline by stage with value, so open coverage is visible next to closed.
    const byStage = {};
    pipeline.forEach(d => {
      const o = byStage[d.stage] || (byStage[d.stage] = { count: 0, value: 0 });
      o.count += 1; o.value += totalOf(d);
    });

    return {
      total: deals.length, pipeline: pipeline.length, pipelineValue,
      won: won.length, wonValue, wonOneOff, wonRecurring, lost: lost.length,
      winRate, avgDeal, avgDays, byChannel, months, lostReasons, byOwner, bySource, byStage,
      totalOf, channelOf,
    };
  }, [deals, leads, members, dealDays]);

  // Quota, commission & activity goals per AE (this month / this week)
  const quotaMetrics = useMemo(() => {
    const monthStart = startOfMonth().getTime();
    const weekStart = startOfWeek().getTime();
    const todayStart = startOfToday().getTime();
    const dealArr = (d) => (d.saas_arr || 0) + (d.payments_arr || 0);

    // AEs = members who own at least one deal
    const aeIds = [...new Set(deals.map(d => d.owner_id).filter(Boolean))];
    const aes = members.filter(m => aeIds.includes(m.id));
    const list = (aes.length ? aes : members);

    const rows = list.map(m => {
      const wonThisMonth = deals.filter(d =>
        d.owner_id === m.id && d.stage === 'closed_won' && d.closed_at && new Date(d.closed_at).getTime() >= monthStart);
      const arrClosed = wonThisMonth.reduce((s, d) => s + dealArr(d), 0);
      const attainment = MONTHLY_ARR_QUOTA ? arrClosed / MONTHLY_ARR_QUOTA : 0;
      const commission = arrClosed * COMMISSION_RATE;

      const myActs = activities.filter(a => a.actor_id === m.id);
      const actsToday = myActs.filter(a => new Date(a.occurred_at).getTime() >= todayStart).length;
      const actsWeek = myActs.filter(a => new Date(a.occurred_at).getTime() >= weekStart).length;
      const onsiteWeek = myActs.filter(a => a.type === 'meeting' && new Date(a.occurred_at).getTime() >= weekStart).length;

      const myHist = stageHistory.filter(h => h.object_type === 'deal' && h.changed_by === m.id && h.changed_at && new Date(h.changed_at).getTime() >= weekStart);
      const demosScheduled = myHist.filter(h => h.to_stage === 'demo_booked').length;
      const demosRun = myHist.filter(h => h.to_stage === 'demo_done').length;

      return { id: m.id, name: ownerName(m.id), arrClosed, attainment, commission, wonCount: wonThisMonth.length, actsToday, actsWeek, onsiteWeek, demosScheduled, demosRun };
    }).sort((a, b) => b.arrClosed - a.arrClosed);

    const teamArr = rows.reduce((s, r) => s + r.arrClosed, 0);
    const teamCommission = rows.reduce((s, r) => s + r.commission, 0);
    const teamQuota = MONTHLY_ARR_QUOTA * rows.length;
    return { rows, teamArr, teamCommission, teamQuota };
  }, [deals, members, activities, stageHistory]);

  // Onboarding metrics
  const obMetrics = useMemo(() => {
    // Board order (OnboardingBoard.STAGES), so the report reads like the board
    // instead of whatever order the rows happened to arrive in.
    const ORDER = ['kickoff','hardware_ordered','hardware_shipped','on_hold','account_menu_config','staff_training','go_live_scheduled','live','handover_to_support'];
    const LABELS = { kickoff:'Kickoff', hardware_ordered:'HW ordered', hardware_shipped:'HW shipped', on_hold:'On hold', account_menu_config:'Config', staff_training:'Training', go_live_scheduled:'Go-live scheduled', live:'Live', handover_to_support:'Handover to support' };
    const byStage = {};
    onboardings.forEach(o => { byStage[o.stage] = (byStage[o.stage] || 0) + 1; });
    const ordered = [...ORDER.filter(k => byStage[k]), ...Object.keys(byStage).filter(k => !ORDER.includes(k))]
      .map(k => [LABELS[k] || k.replace(/_/g, ' '), byStage[k]]);
    // A venue at Handover has GONE live — onboarding is finished and support
    // owns it. Counting only stage==='live' pushed every handed-over venue
    // back into "In progress", so finished jobs read as unfinished.
    const live = onboardings.filter(o => ['live', 'handover_to_support'].includes(o.stage)).length;
    const onHold = onboardings.filter(o => o.stage === 'on_hold').length;
    return { total: onboardings.length, live, onHold, inProgress: onboardings.length - live - onHold, byStage: ordered };
  }, [onboardings]);

  // Support metrics
  const ticketMetrics = useMemo(() => {
    const open = tickets.filter(t => !['resolved','closed'].includes(t.stage));
    const escalated = tickets.filter(t => t.stage === 'escalated');
    const byType = {};
    tickets.forEach(t => { byType[t.ticket_type || 'other'] = (byType[t.ticket_type || 'other'] || 0) + 1; });
    return { total: tickets.length, open: open.length, escalated: escalated.length, resolved: tickets.filter(t => t.stage === 'resolved').length, byType };
  }, [tickets]);

  // Task metrics
  const taskMetrics = useMemo(() => {
    const overdue = tasks.filter(t => t.due_date && t.status !== 'done' && new Date(t.due_date) < new Date());
    const blocked = tasks.filter(t => t.status === 'blocked');
    return { total: tasks.length, done: tasks.filter(t => t.status === 'done').length, overdue: overdue.length, blocked: blocked.length };
  }, [tasks]);

  // Module metrics
  const moduleMetrics = useMemo(() => {
    return modules.map(m => ({
      name: m.name,
      total: locationModules.filter(lm => lm.module_id === m.id).length,
      live: locationModules.filter(lm => lm.module_id === m.id && lm.status === 'live').length,
    }));
  }, [modules, locationModules]);

  const formatCurrency = (v) => `£${v.toLocaleString('en-GB', { minimumFractionDigits: 0 })}`;

  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim";
  const tabBtn = (t, lbl) => (
    <button onClick={() => setTab(t)}
      className={`px-3 py-1.5 text-xs font-medium rounded transition ${tab === t ? 'bg-card text-paper' : 'text-muted hover:text-paper'}`}>{lbl}</button>
  );

  if (loading) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading reports...</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr">
        <div className="text-lg font-bold text-paper">Reporting</div>
        <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">Cross-system dashboards</div>
      </div>

      <div className="px-6 py-2 border-b border-bdr flex gap-1 overflow-x-auto">
        {tabBtn('leads', 'Leads')}
        {tabBtn('sales', 'Sales')}
        {tabBtn('quota', 'Quota & Commission')}
        {tabBtn('onboarding', 'Onboarding')}
        {tabBtn('support', 'Support')}
        {tabBtn('tasks', 'Tasks')}
        {tabBtn('modules', 'Modules')}
        {tabBtn('customers', 'Customers')}
        {tabBtn('volume', 'Volume')}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl space-y-6">

          {tab === 'leads' && (
            <>
              <div className="flex items-center gap-1">
                {[7, 30, 90].map(d => (
                  <button key={d} onClick={() => setLeadDays(d)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-xl transition ${leadDays === d ? 'bg-ember text-white' : 'bg-card text-muted hover:text-paper'}`}>
                    {d} days
                  </button>
                ))}
                <span className="ml-auto text-[10px] text-dim">Stale = open lead untouched {LEAD_STALE_DAYS}+ days</span>
              </div>

              <div className="grid grid-cols-4 gap-3">
                <MetricCard label="New leads" value={leadMetrics.newCount} />
                <MetricCard label="Working (Att/MQL)" value={leadMetrics.engaged} color="text-orange-600" />
                <MetricCard label="Qualified (SQL+)" value={leadMetrics.qualified} color="text-emerald-600" />
                <MetricCard label="Disqualified" value={leadMetrics.disqualified} color="text-red-600" />
              </div>
              <div className="grid grid-cols-4 gap-3">
                <MetricCard label="Conversion" value={`${leadMetrics.conv}%`} sub="new → qualified" />
                <MetricCard label="Avg days to qualify" value={leadMetrics.avgToQualify != null ? leadMetrics.avgToQualify.toFixed(1) : '--'} />
                <MetricCard label="Open leads" value={leadMetrics.openCount} />
                <MetricCard label="Stale now" value={leadMetrics.staleLeads.length} color={leadMetrics.staleLeads.length ? 'text-red-600' : 'text-emerald-600'} />
              </div>

              <div className="glass-card rounded-2xl p-4">
                <div className={label + ' mb-3'}>New leads per week</div>
                <div className="flex items-end gap-2 h-28">
                  {leadMetrics.weeks.map((w, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-[10px] font-mono text-muted">{w.n || ''}</span>
                      <div className="w-full bg-ember/80 rounded-t" style={{ height: `${Math.round((w.n / Math.max(1, ...leadMetrics.weeks.map(w => w.n))) * 88)}px` }} />
                      <span className="text-[9px] text-dim whitespace-nowrap">{w.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="glass-card rounded-2xl p-4">
                  <div className={label + ' mb-3'}>Leads by source ({leadDays}d)</div>
                  {Object.entries(leadMetrics.bySource).sort((a, b) => b[1].count - a[1].count).map(([s, d]) => (
                    <div key={s} className="flex items-center gap-3 py-1.5">
                      <span className="text-xs text-paper w-28 truncate">{s}</span>
                      <div className="flex-1 h-2 bg-ink rounded-full overflow-hidden">
                        <div className="h-full bg-ember rounded-full" style={{ width: `${Math.round((d.count / Math.max(1, leadMetrics.newCount)) * 100)}%` }} />
                      </div>
                      <span className="text-xs font-mono text-ember w-8 text-right">{d.count}</span>
                      <span className="text-[10px] font-mono text-emerald-600 w-14 text-right">{d.count ? Math.round((d.qualified / d.count) * 100) : 0}% qual</span>
                    </div>
                  ))}
                  {Object.keys(leadMetrics.bySource).length === 0 && <div className="text-xs text-dim italic py-2">No new leads in this period.</div>}
                </div>
                <div className="glass-card rounded-2xl p-4">
                  <div className={label + ' mb-3'}>Leads by owner ({leadDays}d)</div>
                  <div className="flex text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim pb-1">
                    <span className="flex-1">Owner</span><span className="w-10 text-right">New</span><span className="w-10 text-right">Qual</span><span className="w-10 text-right">Stale</span>
                  </div>
                  {Object.entries(leadMetrics.byOwner).sort((a, b) => b[1].count - a[1].count).map(([n, d]) => (
                    <div key={n} className="flex py-1 text-xs border-t border-bdr">
                      <span className="flex-1 text-paper truncate">{n}</span>
                      <span className="w-10 text-right font-mono text-paper">{d.count}</span>
                      <span className="w-10 text-right font-mono text-emerald-600">{d.qualified}</span>
                      <span className={`w-10 text-right font-mono ${d.stale ? 'text-red-600' : 'text-dim'}`}>{d.stale}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
                  <div className={label}>Stale leads — need a touch</div>
                  <span className="ml-auto text-[10px] text-dim">{leadMetrics.staleLeads.length} open leads untouched {LEAD_STALE_DAYS}+ days</span>
                </div>
                <div className="p-2">
                  {leadMetrics.staleLeads.slice(0, 12).map(l => (
                    <div key={l.id} className="flex items-center gap-3 px-2 py-1.5 border-b border-bdr last:border-b-0 text-xs">
                      <span className="flex-1 text-paper truncate">{l.name}</span>
                      <span className="text-muted w-24 truncate">{ownerName(l.owner_id) || 'Unassigned'}</span>
                      <span className="text-muted w-20 capitalize">{(l.stage || '').replace(/_/g, ' ')}</span>
                      <span className="text-red-600 font-mono w-12 text-right">{l.staleDays}d</span>
                    </div>
                  ))}
                  {leadMetrics.staleLeads.length === 0 && <div className="text-xs text-dim italic py-3 text-center">Nothing stale — pipeline is being worked. 🎉</div>}
                </div>
              </div>

              <button onClick={() => exportCSV(
                ['Name', 'Stage', 'Source', 'Owner', 'Created', 'Last touched', 'Days since touch'],
                leads.map(l => [l.name, l.stage, l.source, ownerName(l.owner_id), l.created_at, l.updated_at, Math.floor((Date.now() - new Date(l.updated_at || l.created_at).getTime()) / 86400000)]),
                'leads-export.csv'
              )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export leads CSV</button>
            </>
          )}

          {tab === 'sales' && (
            <>
              {/* Range: close rate means nothing without a window */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {[[30,'30 days'],[90,'90 days'],[365,'12 months'],[0,'All time']].map(([d, l]) => (
                  <button key={d} onClick={() => setDealDays(d)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${dealDays === d ? 'bg-ember text-white' : 'bg-card text-muted hover:text-paper'}`}>{l}</button>
                ))}
                <span className="text-[10px] text-dim ml-auto">Closed deals in this window · pipeline is always current</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <MetricCard label="Won" value={salesMetrics.won} sub={formatCurrency(salesMetrics.wonValue)} color="text-emerald-600" />
                <MetricCard label="Close rate" value={`${salesMetrics.winRate}%`} sub={`${salesMetrics.won} won · ${salesMetrics.lost} lost`} />
                <MetricCard label="One-off revenue" value={formatCurrency(salesMetrics.wonOneOff)} sub={'\u00A0'}
                  color={salesMetrics.wonOneOff > 0 ? 'text-emerald-600' : 'text-dim'} />
                <MetricCard label="Recurring (ARR)" value={formatCurrency(salesMetrics.wonRecurring)} sub={'\u00A0'}
                  color={salesMetrics.wonRecurring > 0 ? 'text-ember' : 'text-dim'} />
                <MetricCard label="Avg deal" value={formatCurrency(salesMetrics.avgDeal)} sub={'\u00A0'} />
                {/* "0" here looked like a bug. Under a day is a real answer for
                    passed-in deals logged the day they sign — say it in words. */}
                <MetricCard
                  label="Avg time to close"
                  value={salesMetrics.avgDays == null ? '—' : salesMetrics.avgDays < 1 ? 'Same day' : `${salesMetrics.avgDays}d`}
                  sub={salesMetrics.avgDays == null ? 'needs closed dates' : '\u00A0'} />
              </div>

              {/* Monthly won trend — the shape of the year at a glance */}
              <div className="glass-card rounded-2xl p-4">
                <div className={label + ' mb-3'}>Won by month (12 months)</div>
                <div className="flex items-end gap-1.5">
                  {(() => {
                    const max = Math.max(1, ...salesMetrics.months.map(m => m.value));
                    return salesMetrics.months.map(m => (
                      <div key={m.key} className="flex-1 min-w-0 flex flex-col items-center justify-end" title={`${m.label}: ${m.count} won, ${formatCurrency(m.value)}`}>
                        {m.value > 0 && <div className="text-[9px] font-mono text-emerald-600 whitespace-nowrap">{formatCurrency(m.value)}</div>}
                        {m.count > 0 && <div className="text-[9px] font-mono text-dim">{m.count} won</div>}
                        <div className="w-full flex items-end justify-center border-b border-bdr" style={{ height: 96 }}>
                          <div className={`w-3/4 rounded-t ${m.value > 0 ? 'bg-emerald-500/70' : 'bg-card'}`}
                            style={{ height: `${m.value > 0 ? Math.max(6, Math.round((m.value / max) * 92)) : 2}px` }} />
                        </div>
                        <div className="text-[9px] font-mono text-dim mt-1">{m.label}</div>
                      </div>
                    ));
                  })()}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* THE question: how do deals arrive, and how well does each close */}
                <div className="glass-card rounded-2xl p-4">
                  <div className={label + ' mb-1'}>How deals arrive</div>
                  <div className="text-[10px] text-dim mb-3">Detected from the data — a deal a lead points at came through the funnel; the rest were passed in to close.</div>
                  {Object.entries(salesMetrics.byChannel).map(([k, v]) => {
                    const closed = v.won + v.lost;
                    const rate = closed ? Math.round((v.won / closed) * 100) : null;
                    return (
                      <div key={k} className="py-2 border-b border-bdr last:border-0">
                        <div className="flex justify-between text-xs">
                          <span className="text-paper font-medium">{k}</span>
                          <span className="text-emerald-600 font-mono">{formatCurrency(v.value)}</span>
                        </div>
                        <div className="flex justify-between text-[11px] text-muted mt-0.5">
                          <span>{v.won} won · {v.lost} lost{v.open ? ` · ${v.open} open` : ''}</span>
                          <span className="font-mono">{rate == null ? '—' : `${rate}% close`}</span>
                        </div>
                      </div>
                    );
                  })}
                  {Object.keys(salesMetrics.byChannel).length === 0 && <div className="text-xs text-dim italic py-2">No closed deals in this window.</div>}
                </div>

                <div className="glass-card rounded-2xl p-4">
                  <div className={label + ' mb-3'}>By owner (closed in window)</div>
                  {Object.entries(salesMetrics.byOwner).sort((a, b) => b[1].value - a[1].value).map(([k, v]) => {
                    const closed = v.won + v.lost;
                    return (
                      <div key={k} className="flex justify-between py-1.5 text-xs border-b border-bdr last:border-0">
                        <span className="text-paper">{k}</span>
                        <span className="text-muted">{v.won}/{closed} won · <span className="text-emerald-600 font-mono">{formatCurrency(v.value)}</span></span>
                      </div>
                    );
                  })}
                  {Object.keys(salesMetrics.byOwner).length === 0 && <div className="text-xs text-dim italic py-2">No closed deals in this window.</div>}
                </div>

                <div className="glass-card rounded-2xl p-4">
                  <div className={label + ' mb-3'}>By source</div>
                  {Object.entries(salesMetrics.bySource).sort((a, b) => (b[1].won + b[1].lost) - (a[1].won + a[1].lost)).map(([k, v]) => {
                    const closed = v.won + v.lost;
                    const rate = closed ? Math.round((v.won / closed) * 100) : 0;
                    return (
                      <div key={k} className="flex justify-between py-1.5 text-xs border-b border-bdr last:border-0">
                        <span className="text-paper">{k}</span>
                        <span className="text-muted font-mono">{rate}% · {formatCurrency(v.value)}</span>
                      </div>
                    );
                  })}
                </div>

                <div className="glass-card rounded-2xl p-4">
                  <div className={label + ' mb-3'}>Why deals were lost</div>
                  {Object.entries(salesMetrics.lostReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                    <div key={k} className="flex justify-between py-1.5 text-xs border-b border-bdr last:border-0">
                      <span className="text-paper">{k}</span><span className="text-red-600 font-mono">{v}</span>
                    </div>
                  ))}
                  {Object.keys(salesMetrics.lostReasons).length === 0 && <div className="text-xs text-dim italic py-2">Nothing lost in this window.</div>}
                </div>
              </div>

              {/* Open pipeline, valued — what's coming, next to what closed */}
              <div className="glass-card rounded-2xl p-4">
                <div className={label + ' mb-3'}>Open pipeline — {salesMetrics.pipeline} deals · {formatCurrency(salesMetrics.pipelineValue)}</div>
                {Object.entries(salesMetrics.byStage).map(([k, v]) => (
                  <div key={k} className="flex justify-between py-1 text-xs">
                    <span className="text-paper">{k.replace(/_/g, ' ')}</span>
                    <span className="text-muted font-mono">{v.count} · {formatCurrency(v.value)}</span>
                  </div>
                ))}
              </div>

              <button onClick={() => exportCSV(
                ['Name','Company','Stage','Channel','Source','One-off','Recurring ARR','Total','Owner','Created','Closed'],
                deals.map(d => [d.name, companies.find(c => c.id === d.company_id)?.name, d.stage,
                  salesMetrics.channelOf(d), d.source,
                  oneOffValue(d), recurringValue(d),
                  totalValue(d), ownerName(d.owner_id), d.created_at, d.closed_at]),
                'deals-export.csv'
              )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export deals CSV</button>
            </>
          )}

          {tab === 'quota' && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <MetricCard label="Team ARR (this month)" value={formatCurrency(quotaMetrics.teamArr)} color="text-emerald-600" />
                <MetricCard label="Team Quota" value={formatCurrency(quotaMetrics.teamQuota)} />
                <MetricCard label="Attainment" value={`${quotaMetrics.teamQuota ? Math.round((quotaMetrics.teamArr / quotaMetrics.teamQuota) * 100) : 0}%`} />
                <MetricCard label="Commission (10%)" value={formatCurrency(quotaMetrics.teamCommission)} color="text-ember" />
              </div>

              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
                  <div className={label}>Per rep — Quota &amp; Commission (this month)</div>
                  <div className="ml-auto text-[10px] text-dim">Target {formatCurrency(MONTHLY_ARR_QUOTA)} ARR / mo · 10% commission</div>
                </div>
                <div className="p-2">
                  <table className="w-full">
                    <thead>
                      <tr className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">
                        <th className="px-3 py-2 text-left">Rep</th>
                        <th className="px-3 py-2 text-right">Won</th>
                        <th className="px-3 py-2 text-right">ARR closed</th>
                        <th className="px-3 py-2 text-left">Attainment</th>
                        <th className="px-3 py-2 text-right">Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotaMetrics.rows.map(r => (
                        <tr key={r.id} className="border-t border-bdr">
                          <td className="px-3 py-2 text-sm text-paper">{r.name}</td>
                          <td className="px-3 py-2 text-xs text-muted text-right">{r.wonCount}</td>
                          <td className="px-3 py-2 text-sm text-emerald-600 font-mono text-right">{formatCurrency(r.arrClosed)}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-ink rounded-full overflow-hidden min-w-[60px]">
                                <div className={`h-full rounded-full ${r.attainment >= 1 ? 'bg-emerald-500' : 'bg-ember'}`} style={{ width: `${Math.min(100, Math.round(r.attainment * 100))}%` }} />
                              </div>
                              <span className={`text-xs font-mono w-10 text-right ${r.attainment >= 1 ? 'text-emerald-600 font-bold' : 'text-muted'}`}>{Math.round(r.attainment * 100)}%</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-sm text-ember font-mono text-right">{formatCurrency(r.commission)}{r.attainment >= 1 && ' ✓'}</td>
                        </tr>
                      ))}
                      {quotaMetrics.rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-dim text-sm">No sales reps with deals yet.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="glass-card rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
                  <div className={label}>Activity goals</div>
                  <div className="ml-auto text-[10px] text-dim">{GOAL_ACTIVITIES_DAY}/day · {GOAL_ACTIVITIES_WEEK}/wk · {GOAL_DEMOS_SCHEDULED_WEEK} demos booked · {GOAL_DEMOS_RUN_WEEK} run · {GOAL_ONSITE_WEEK} onsite</div>
                </div>
                <div className="p-2">
                  <table className="w-full">
                    <thead>
                      <tr className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">
                        <th className="px-3 py-2 text-left">Rep</th>
                        <th className="px-3 py-2 text-center">Today</th>
                        <th className="px-3 py-2 text-center">This week</th>
                        <th className="px-3 py-2 text-center">Demos booked</th>
                        <th className="px-3 py-2 text-center">Demos run</th>
                        <th className="px-3 py-2 text-center">Onsite</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotaMetrics.rows.map(r => (
                        <tr key={r.id} className="border-t border-bdr">
                          <td className="px-3 py-2 text-sm text-paper">{r.name}</td>
                          <GoalCell value={r.actsToday} goal={GOAL_ACTIVITIES_DAY} />
                          <GoalCell value={r.actsWeek} goal={GOAL_ACTIVITIES_WEEK} />
                          <GoalCell value={r.demosScheduled} goal={GOAL_DEMOS_SCHEDULED_WEEK} />
                          <GoalCell value={r.demosRun} goal={GOAL_DEMOS_RUN_WEEK} />
                          <GoalCell value={r.onsiteWeek} goal={GOAL_ONSITE_WEEK} />
                        </tr>
                      ))}
                      {quotaMetrics.rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-dim text-sm">No activity yet.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <button onClick={() => exportCSV(
                ['Rep','Won','ARR closed','Quota','Attainment %','Commission','Activities (wk)','Demos booked (wk)','Demos run (wk)','Onsite (wk)'],
                quotaMetrics.rows.map(r => [r.name, r.wonCount, r.arrClosed, MONTHLY_ARR_QUOTA, Math.round(r.attainment*100), Math.round(r.commission), r.actsWeek, r.demosScheduled, r.demosRun, r.onsiteWeek]),
                'quota-commission.csv'
              )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export quota CSV</button>
            </>
          )}

          {tab === 'onboarding' && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <MetricCard label="Total" value={obMetrics.total} />
                <MetricCard label="Live (incl. handed over)" value={obMetrics.live} color="text-emerald-600" />
                <MetricCard label="In Progress" value={obMetrics.inProgress} color="text-orange-600" />
                <MetricCard label="On Hold" value={obMetrics.onHold} color="text-amber-600" />
              </div>
              <div className="glass-card rounded-2xl p-4">
                <div className={label + ' mb-3'}>By Stage (board order)</div>
                {obMetrics.byStage.map(([k, v]) => (
                  <div key={k} className="flex justify-between py-1 text-xs"><span className="text-paper">{k}</span><span className="text-ember font-mono">{v}</span></div>
                ))}
              </div>
              <button onClick={() => exportCSV(
                ['Company','Stage','Owner','Created'],
                onboardings.map(o => [companies.find(c=>c.id===o.company_id)?.name, o.stage, ownerName(o.owner_id), o.created_at]),
                'onboardings-export.csv'
              )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export onboardings CSV</button>
            </>
          )}

          {tab === 'support' && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <MetricCard label="Open" value={ticketMetrics.open} />
                <MetricCard label="Escalated" value={ticketMetrics.escalated} color="text-red-600" />
                <MetricCard label="Resolved" value={ticketMetrics.resolved} color="text-emerald-600" />
                <MetricCard label="Total" value={ticketMetrics.total} />
              </div>
              <div className="glass-card rounded-2xl p-4">
                <div className={label + ' mb-3'}>By Type</div>
                {Object.entries(ticketMetrics.byType).map(([k, v]) => (
                  <div key={k} className="flex justify-between py-1 text-xs"><span className="text-paper">{k}</span><span className="text-ember font-mono">{v}</span></div>
                ))}
              </div>
              <button onClick={() => exportCSV(
                ['Subject','Company','Priority','Type','Stage','Owner','Created'],
                tickets.map(t => [t.subject, companies.find(c=>c.id===t.company_id)?.name, t.priority, t.ticket_type, t.stage, ownerName(t.owner_id), t.created_at]),
                'tickets-export.csv'
              )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export tickets CSV</button>
            </>
          )}

          {tab === 'tasks' && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <MetricCard label="Total" value={taskMetrics.total} />
                <MetricCard label="Done" value={taskMetrics.done} color="text-emerald-600" />
                <MetricCard label="Overdue" value={taskMetrics.overdue} color="text-red-600" />
                <MetricCard label="Blocked" value={taskMetrics.blocked} color="text-orange-600" />
              </div>
              <button onClick={() => exportCSV(
                ['Title','Status','Priority','Assignee','Due Date','Project','Created'],
                tasks.map(t => [t.title, t.status, t.priority, ownerName(t.owner_id), t.due_date, t.project_id, t.created_at]),
                'tasks-export.csv'
              )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export tasks CSV</button>
            </>
          )}

          {tab === 'modules' && (
            <>
              <div className="glass-card rounded-2xl p-4">
                <div className={label + ' mb-3'}>Module Attach Rate</div>
                {moduleMetrics.map(m => (
                  <div key={m.name} className="flex items-center gap-3 py-1.5">
                    <span className="text-xs text-paper w-48 truncate">{m.name}</span>
                    <div className="flex-1 h-2 bg-ink rounded-full overflow-hidden">
                      <div className="h-full bg-ember rounded-full" style={{ width: `${locations.length ? (m.live / locations.length) * 100 : 0}%` }} />
                    </div>
                    <span className="text-xs text-ember font-mono w-16 text-right">{m.live}/{locations.length}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => exportCSV(
                ['Module','Total Enabled','Live','Attach Rate'],
                moduleMetrics.map(m => [m.name, m.total, m.live, locations.length ? `${Math.round((m.live/locations.length)*100)}%` : '0%']),
                'modules-export.csv'
              )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export modules CSV</button>
            </>
          )}

          {tab === 'volume' && (() => {
            // Volume running through the system: what the venues themselves take,
            // not what we bill them. Best case and likely case sit side by side
            // on purpose — a raw pipeline total flatters early-stage deals, and a
            // weighted one alone hides how much is genuinely in play.
            const t = pipelineTotals(trading, weights);
            const byStage = Object.entries(
              trading.filter(d => d.stage !== 'closed_won' && d.stage !== 'closed_lost')
                .reduce((acc, d) => {
                  const k = d.stage || 'unknown';
                  acc[k] = acc[k] || { n: 0, rev: 0, weighted: 0 };
                  acc[k].n += 1;
                  acc[k].rev += Number(d.est_monthly_revenue) || 0;
                  acc[k].weighted += (Number(d.est_monthly_revenue) || 0) * (weights[k] ?? 0);
                  return acc;
                }, {}),
            ).sort((a, b) => b[1].rev - a[1].rev);
            const missing = trading.filter(d => !d.est_monthly_revenue && d.stage !== 'closed_lost');
            const won = trading.filter(d => d.stage === 'closed_won' && d.est_monthly_revenue)
              .sort((a, b) => Number(b.est_monthly_revenue) - Number(a.est_monthly_revenue));

            return (
              <div className="space-y-4">
                <div className="grid grid-cols-4 gap-4">
                  <Stat label="Won — monthly volume" value={gbp0(t.wonRevenue)}
                    sub={`${t.wonCount} deals · ${gbp0(t.wonRevenue * 12)}/yr`} tone="emerald" />
                  <Stat label="Pipeline — best case" value={gbp0(t.openRevenue)} sub={`${t.openCount} open deals`} />
                  <Stat label="Pipeline — likely" value={gbp0(t.weightedRevenue)} sub="weighted by stage" tone="amber" />
                  <Stat label="Transactions won / month" value={(t.wonTransactions || 0).toLocaleString('en-GB')}
                    sub={`${(t.openTransactions || 0).toLocaleString('en-GB')} more in pipeline`} />
                </div>

                <div className="glass-card rounded-2xl overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
                    <h3 className="text-[13px] font-bold text-paper">Open pipeline by stage</h3>
                  </div>
                  <div className="divide-y divide-bdr">
                    {byStage.length === 0 && <div className="p-6 text-center text-dim text-sm italic">No open deals with figures.</div>}
                    {byStage.map(([stage, v]) => (
                      <div key={stage} className="px-5 py-3 flex items-center gap-4">
                        <div className="w-44 shrink-0 text-sm text-paper capitalize">{stage.replace(/_/g, ' ')}</div>
                        <div className="text-xs text-dim w-16 shrink-0">{v.n} deal{v.n === 1 ? '' : 's'}</div>
                        <div className="text-[10px] text-dim w-12 shrink-0 tabular-nums">{Math.round((weights[stage] ?? 0) * 100)}%</div>
                        <div className="flex-1 h-2 rounded-full bg-card overflow-hidden">
                          <div className="h-full bg-ember/60" style={{ width: `${t.openRevenue ? (v.rev / t.openRevenue) * 100 : 0}%` }} />
                        </div>
                        <div className="w-28 text-right text-sm text-paper tabular-nums shrink-0">{gbp0(v.rev)}</div>
                        <div className="w-28 text-right text-sm text-muted tabular-nums shrink-0">{gbp0(v.weighted)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="px-5 py-2 border-t border-bdr flex justify-end gap-4 text-[10px] font-mono uppercase tracking-wider text-dim">
                    <span className="w-28 text-right">best case</span><span className="w-28 text-right">likely</span>
                  </div>
                </div>

                {missing.length > 0 && (
                  <div className="glass-card rounded-2xl overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
                      <h3 className="text-[13px] font-bold text-paper">No figures yet</h3>
                      <span className="text-xs text-dim font-mono">({missing.length})</span>
                      <span className="ml-auto text-[11px] text-dim">every one of these is missing from the totals above</span>
                    </div>
                    <div className="divide-y divide-bdr max-h-64 overflow-y-auto">
                      {missing.map(d => (
                        <div key={d.deal_id} className="px-5 py-2.5 flex items-center gap-3 text-xs">
                          <span className="flex-1 min-w-0 truncate text-paper">{d.name}</span>
                          <span className="text-dim capitalize shrink-0">{(d.stage || '').replace(/_/g, ' ')}</span>
                          <span className="text-dim shrink-0 w-20 text-right">{d.site_count} site{d.site_count === 1 ? '' : 's'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {won.length > 0 && (
                  <div className="glass-card rounded-2xl overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-bdr flex items-center gap-2">
                      <h3 className="text-[13px] font-bold text-paper">Volume won</h3>
                      <span className="text-xs text-dim font-mono">({won.length})</span>
                    </div>
                    <div className="divide-y divide-bdr max-h-80 overflow-y-auto">
                      {won.map(d => (
                        <div key={d.deal_id} className="px-5 py-2.5 flex items-center gap-3 text-xs">
                          <span className="flex-1 min-w-0 truncate text-paper">{d.name}</span>
                          <span className="text-dim shrink-0">{d.site_count} site{d.site_count === 1 ? '' : 's'}</span>
                          <span className="text-muted tabular-nums shrink-0 w-24 text-right">
                            {d.est_avg_transaction ? '£' + Number(d.est_avg_transaction).toFixed(2) + ' avg' : ''}
                          </span>
                          <span className="text-paper font-semibold tabular-nums shrink-0 w-28 text-right">{gbp0(d.est_monthly_revenue)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {tab === 'customers' && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <MetricCard label="Companies" value={companies.length} />
                <MetricCard label="Locations" value={locations.length} />
                <MetricCard label="Live" value={locations.filter(l => l.status === 'live').length} color="text-emerald-600" />
                <MetricCard label="Contacts" value={contacts.length} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="glass-card rounded-2xl p-4">
                  <div className={label + ' mb-3'}>Locations by Status</div>
                  {['prospect','onboarding','live','churned'].map(s => (
                    <div key={s} className="flex justify-between py-1 text-xs">
                      <span className="text-paper">{s}</span>
                      <span className="text-ember font-mono">{locations.filter(l => l.status === s).length}</span>
                    </div>
                  ))}
                </div>
                <div className="glass-card rounded-2xl p-4">
                  <div className={label + ' mb-3'}>Feature Requests</div>
                  {['new','under_review','planned','in_progress','shipped','declined'].map(s => {
                    const count = featureRequests.filter(f => f.status === s).length;
                    return count > 0 ? (
                      <div key={s} className="flex justify-between py-1 text-xs">
                        <span className="text-paper">{s.replace(/_/g,' ')}</span>
                        <span className="text-ember font-mono">{count}</span>
                      </div>
                    ) : null;
                  })}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => exportCSV(
                  ['Name','Domain','City','Industry','Locations','Owner','Created'],
                  companies.map(c => [c.name, c.domain, c.city, c.industry, locations.filter(l=>l.company_id===c.id).length, ownerName(c.owner_id), c.created_at]),
                  'companies-export.csv'
                )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export companies CSV</button>
                <button onClick={() => exportCSV(
                  ['Name','Email','Phone','Job Title','Source','Created'],
                  contacts.map(c => [[c.first_name,c.last_name].filter(Boolean).join(' '), c.email, c.phone, c.job_title, c.source, c.created_at]),
                  'contacts-export.csv'
                )} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded hover:text-paper">Export contacts CSV</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GoalCell({ value, goal }) {
  const met = value >= goal;
  return (
    <td className="px-3 py-2 text-center">
      <span className={`text-xs font-mono ${met ? 'text-emerald-600 font-bold' : value > 0 ? 'text-paper' : 'text-dim'}`}>
        {value}<span className="text-dim">/{goal}</span>
      </span>
    </td>
  );
}

function MetricCard({ label, value, sub, color = 'text-paper' }) {
  return (
    <div className="glass-card rounded-2xl p-5 text-center">
      <div className={`text-3xl font-bold font-mono ${color}`}>{value}</div>
      <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-dim mt-1.5">{label}</div>
      {sub && <div className="text-xs text-ember mt-1">{sub}</div>}
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  const color = tone === 'emerald' ? 'text-emerald-600'
    : tone === 'amber' ? 'text-amber-600'
    : tone === 'red' ? 'text-red-600' : 'text-paper';
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}
