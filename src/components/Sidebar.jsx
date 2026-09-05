import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { LogoLockup } from './ServOSLogo.jsx';
import { getRunning, stopTimer, fmtClock } from '../lib/timer';
import {
  Home, Building2, MapPin, User, Target, Banknote, Box, Rocket, Folder, CheckSquare,
  Ticket, ClipboardList, FileText, LayoutGrid, Sparkles, Flag, BarChart3,
  Bug, Star, List, Layout, Layers, Package, ChevronRight, Plus, Mail, Calendar, MessageSquare, Clock, Plane, CreditCard, Receipt, TrendingUp,
  Warehouse, Boxes, PackagePlus, PackageMinus, ShoppingCart, ClipboardCheck, Truck, Factory,
  Settings as SettingsIcon, Users as UsersIcon, FileSignature, PhoneCall, Wallet, Tags, Percent, Landmark,
  Search, PanelLeftClose, PanelLeftOpen, Pin, History, CalendarCheck, GanttChart, KanbanSquare, CalendarDays,
} from 'lucide-react';

// The sidebar from the spec (screen 01): a WORK group at the top — Today with a
// live count, Tasks, Projects, Board, Timeline, Calendar, People — then CRM,
// then everything else the product has, grouped as before. Nothing is removed;
// two Delivery items became tabs of one screen and Project templates moved next
// to Settings, where they are configured rather than visited.
//
// CORE and COLLAPSIBLE stay exported because MobileNav reads the same
// catalogue. Two hand-kept lists is how a destination ends up reachable on one
// nav and missing on the other.

export const CORE = [
  ['today', 'Today', Home],
  ['tasks', 'Tasks', CheckSquare],
  ['projects', 'Projects', Folder],
  ['work_board', 'Board', KanbanSquare],
  ['work_timeline', 'Timeline', GanttChart],
  ['work_calendar', 'Calendar', CalendarDays],
  ['people', 'People', UsersIcon],
];

const CRM = [
  ['inbox', 'Inbox', Mail], ['tickets', 'Tickets', Ticket], ['deals', 'Deals', Banknote], ['companies', 'Companies', Building2],
  ['contacts', 'Contacts', User], ['locations', 'Locations', MapPin], ['leads', 'Leads', Target],
  ['chat', 'Chat', MessageSquare], ['calendar', 'Meetings', Calendar],
];

export const COLLAPSIBLE = [
  { id: 'crm', label: 'CRM', items: CRM },
  { id: 'sales', label: 'Sales', items: [
    ['processing', 'Card Processing', CreditCard], ['quotes', 'Quotes', FileSignature], ['invoices', 'Invoices', Receipt],
  ] },
  { id: 'delivery', label: 'Delivery', items: [
    ['onboarding', 'Onboarding', Rocket], ['mywork', 'My Work (old)', Home],
  ] },
  { id: 'support', label: 'Support', items: [
    ['calls', 'Call Log', PhoneCall], ['forms', 'Forms', ClipboardList], ['templates', 'Templates', FileText],
  ] },
  { id: 'finance', label: 'Finance', items: [
    ['bills', 'Bills', Wallet], ['expenses', 'Expenses', Receipt], ['what_i_owe', 'What I owe', Banknote],
    ['bank_feed', 'Bank feed', Landmark],
    ['finance_categories', 'Categories', Tags], ['finance_rates', 'Tax rates', Percent],
    ['finance_vat', 'VAT & reports', FileText], ['finance_reports', 'Reports', BarChart3],
  ] },
  { id: 'inventory', label: 'Inventory', items: [
    ['inv_dashboard', 'Dashboard', Warehouse], ['products', 'Products', Box], ['inv_stock', 'Stock', Boxes],
    ['inv_in', 'Stock In', PackagePlus], ['inv_out', 'Stock Out', PackageMinus],
    ['inv_orders', 'Orders (POs)', ShoppingCart], ['inv_shipments', 'Shipments', Truck],
    ['inv_suppliers', 'Suppliers', Factory], ['inv_stocktake', 'Stocktake', ClipboardCheck],
    ['inv_reports', 'Reports', BarChart3],
  ] },
  { id: 'product', label: 'Product', items: [
    ['modules', 'Modules', LayoutGrid], ['feature_requests', 'Feature Requests', Sparkles], ['releases', 'Releases', Flag],
  ] },
  { id: 'workforce', label: 'Workforce', items: [
    ['handover', 'Handover', ClipboardList], ['time', 'Time Tracking', Clock], ['timesheets', 'Timesheets', ClipboardCheck, 'owner'], ['schedule', 'Schedule', Calendar], ['bookings', 'Booking Page', CalendarCheck], ['timeoff', 'Time Off', Plane],
    ['staff', 'Staff', User], ['departments', 'Departments & Areas', Building2],
  ] },
  { id: 'insights', label: 'Insights', items: [
    ['reporting', 'Reporting', BarChart3], ['sales_performance', 'Sales Performance', TrendingUp],
  ] },
];

// Configured, not visited: templates sit next to Settings.
const FOOTER_NAV = [['project_templates', 'Project templates', Layers], ['account', 'My Account', User], ['settings', 'Settings', SettingsIcon]];

const PROJECT_ICON = { 'bugs': Bug, 'features': Star, 'todo': List, 'ui changes': Layout, 'modules to build': Layers };

// Map detail views back to the nav item that should stay highlighted
const ACTIVE_MAP = {
  company_detail: 'companies', contact_detail: 'contacts', location_detail: 'locations',
  lead_detail: 'leads', deal_detail: 'deals', quote_detail: 'quotes',
  onboarding_detail: 'onboarding', project_detail: 'projects', task_detail: 'tasks',
  ticket_detail: 'tickets', inbox_mail: 'inbox', form_detail: 'forms', feature_request_detail: 'feature_requests',
  release_detail: 'releases', invoice_detail: 'invoices',
  bill_detail: 'bills', expense_detail: 'expenses', work: 'work_board',
};

const DEFAULT_GROUPS = { appbuild: false, crm: true, sales: false, delivery: false, support: false, finance: false, inventory: false, product: false, workforce: false, insights: false };

const INDEX = [
  ...CORE.map(([key, label, Icon]) => ({ key, label, Icon, section: 'Work' })),
  ...COLLAPSIBLE.flatMap(g => g.items.map(([key, label, Icon, need]) => ({ key, label, Icon, section: g.label, need }))),
  ...FOOTER_NAV.map(([key, label, Icon]) => ({ key, label, Icon, section: 'Account' })),
];
const BY_KEY = Object.fromEntries(INDEX.map(r => [r.key, r]));
const CORE_KEYS = new Set(CORE.map(c => c[0]));

function usePersist(key, initial) {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial; } catch { return initial; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }, [key, v]);
  return [v, setV];
}

// The counts next to Today / Tasks / Projects. Today is the one that matters:
// overdue plus due today for THIS person, in coral when anything is late.
function useNavCounts(profile, view) {
  const [c, setC] = useState({ today: 0, late: 0, tasks: 0, projects: 0 });
  useEffect(() => {
    if (!profile?.id) return;
    let dead = false;
    const load = async () => {
      const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
      const [w, t, p] = await Promise.all([
        supabase.from('work_items').select('due_at, status').eq('owner_id', profile.id).neq('status', 'done').not('due_at', 'is', null),
        supabase.from('tasks').select('id', { count: 'exact', head: true }).neq('status', 'done').is('parent_task_id', null),
        supabase.from('crm_projects').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      ]);
      if (dead) return;
      const rows = w.data || [];
      const late = rows.filter(r => String(r.due_at).slice(0, 10) < todayKey).length;
      const due = rows.filter(r => String(r.due_at).slice(0, 10) === todayKey).length;
      setC({ today: late + due, late, tasks: t.count || 0, projects: p.count || 0 });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(id); };
  }, [profile?.id, view]);
  return c;
}

// The running-timer card pinned to the bottom of the sidebar (screen 01).
function TimerCard({ profile, onOpen }) {
  const [running, setRunning] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const refresh = () => getRunning(profile.id).then(setRunning);
    refresh();
    window.addEventListener('timer-changed', refresh);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('timer-changed', refresh); clearInterval(tick); };
  }, [profile.id]);
  if (!running) return null;
  const secs = (now - new Date(running.started_at).getTime()) / 1000;
  return (
    <div className="rounded-[12px] border px-3 py-[11px]" style={{ background: 'var(--card-bg)', borderColor: 'var(--bdr)' }}>
      <div className="font-mono text-[9px] font-bold tracking-[.18em] uppercase text-dim mb-[5px]">Timer running</div>
      <button onClick={() => onOpen(running)} className="text-[13px] font-semibold text-paper text-left leading-snug mb-[3px] truncate w-full block hover:text-ember-deep">
        {running.label || running.subject_type}
      </button>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[15px] font-bold" style={{ color: 'rgb(var(--c-primary-deep))' }}>{fmtClock(secs)}</span>
        <button onClick={() => stopTimer(profile.id)} className="text-[12px] text-muted hover:text-paper">Stop</button>
      </div>
    </div>
  );
}

export default function Sidebar({ profile, projects, activeProject, setActiveProject, view, setView, onSignOut, onRefresh, theme, onNavigate }) {
  const [logos, setLogos] = useState({ light: null, dark: null });
  useEffect(() => { supabase.from('support_settings').select('logo_url, logo_url_dark').eq('id', 1).maybeSingle().then(r => setLogos({ light: r.data?.logo_url || null, dark: r.data?.logo_url_dark || null })); }, []);
  const logoUrl = theme === 'dark' ? (logos.dark || logos.light) : (logos.light);

  const [open, setOpen] = useState(() => {
    try { return { ...DEFAULT_GROUPS, ...(JSON.parse(localStorage.getItem('servos_nav_groups_v2')) || {}) }; }
    catch { return DEFAULT_GROUPS; }
  });
  useEffect(() => { try { localStorage.setItem('servos_nav_groups_v2', JSON.stringify(open)); } catch { /* ignore */ } }, [open]);
  const toggle = (id) => setOpen(o => ({ ...o, [id]: !o[id] }));

  const [pinned, setPinned] = usePersist('servos_nav_pins', []);
  const [recents, setRecents] = usePersist('servos_nav_recents', []);
  const [rail, setRail] = usePersist('servos_nav_rail', false);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);
  const railOn = rail && !mobile;

  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [hover, setHover] = useState(null);
  const searchRef = useRef(null);

  const [adding, setAdding] = useState(false);
  const [projName, setProjName] = useState('');
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const activeKey = ACTIVE_MAP[view] || view;
  const counts = useNavCounts(profile, view);

  useEffect(() => { if (BY_KEY[activeKey]) setRecents(r => [activeKey, ...r.filter(k => k !== activeKey)].slice(0, 8)); }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return [];
    return INDEX
      .filter(r => !r.need || profile.role === r.need)
      .map(r => { const idx = r.label.toLowerCase().indexOf(query); const inSec = r.section.toLowerCase().includes(query); return (idx < 0 && !inSec) ? null : { r, idx: idx < 0 ? 99 : idx }; })
      .filter(Boolean)
      .sort((a, b) => (a.idx - b.idx) || a.r.label.localeCompare(b.r.label))
      .slice(0, 14)
      .map(x => x.r);
  }, [query, profile.role]);
  useEffect(() => { setSel(0); }, [query]);

  const go = (key) => { setView(key); setQ(''); setSel(0); };
  const focusSearch = () => { if (rail) setRail(false); setTimeout(() => searchRef.current?.focus(), 60); };
  // ⌘K belongs to quick add now (screen 09). The nav search keeps Escape only.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && document.activeElement === searchRef.current) { setQ(''); setSel(0); searchRef.current?.blur(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onQKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, Math.max(results.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); go(results[sel].key); }
  };

  const togglePin = (key) => setPinned(p => p.includes(key) ? p.filter(k => k !== key) : [...p, key]);
  const pinnedRows = pinned.map(k => BY_KEY[k]).filter(Boolean);
  const recentRows = recents.filter(k => !pinned.includes(k) && k !== activeKey && !CORE_KEYS.has(k)).slice(0, 4).map(k => BY_KEY[k]).filter(Boolean);

  const createProject = async (e) => {
    e.preventDefault();
    if (!projName.trim()) return;
    const slug = projName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Math.random().toString(36).slice(2, 6);
    const { data: p } = await supabase.from('backlog_projects').insert({
      name: projName.trim(), slug, icon: '📦', default_item_type: 'task', created_by: profile.id,
    }).select().single();
    if (p) {
      const defaults = [
        { name: 'Backlog', position: 0, color: '#948A7A', is_done: false },
        { name: 'In Progress', position: 1, color: '#E8743C', is_done: false },
        { name: 'Testing', position: 2, color: '#C75A29', is_done: false },
        { name: 'Shipped', position: 3, color: '#6B6359', is_done: true },
      ];
      await supabase.from('buckets').insert(defaults.map(b => ({ ...b, backlog_project_id: p.id })));
      setActiveProject(p);
    }
    setProjName(''); setAdding(false); onRefresh?.();
  };

  const countFor = (key) => {
    if (key === 'today') return counts.today ? { n: counts.today, coral: counts.late > 0 } : null;
    if (key === 'tasks') return counts.tasks ? { n: counts.tasks } : null;
    if (key === 'projects') return counts.projects ? { n: counts.projects } : null;
    return null;
  };

  const openTimerSubject = (running) => {
    if (!running?.subject_type || !onNavigate) return;
    onNavigate(running.subject_type, running.subject_id);
  };

  return (
    <aside className={`shrink-0 flex flex-col h-full transition-[width] duration-200 border-r ${railOn ? 'w-[68px]' : 'w-[224px] lg:w-[224px]'}`}
      style={{ borderColor: 'var(--hair)', background: 'var(--scene-bg)' }}>
      {/* Header: logo + rail toggle */}
      <div className="px-3 pt-[18px] pb-3 shrink-0 flex items-center gap-2">
        {railOn
          ? <div className="mx-auto"><LogoLockup size={26} markOnly /></div>
          : (logoUrl ? <img src={logoUrl} alt="Logo" className="h-9 object-contain flex-1 min-w-0" /> : <div className="flex-1 pl-2"><LogoLockup size={30} /></div>)}
        {!mobile && (
          <button onClick={() => setRail(r => !r)} title={railOn ? 'Expand sidebar' : 'Collapse to rail'}
            className="text-dim hover:text-paper rounded-lg p-1.5 shrink-0 transition">
            {railOn ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        )}
      </div>

      {/* Search */}
      {!railOn ? (
        <div className="px-3 pb-2 shrink-0">
          <div className="relative flex items-center">
            <Search size={13} className="absolute left-3 text-dim pointer-events-none" />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onQKey}
              placeholder="Find anything…"
              className="w-full pl-8 pr-2 py-[7px] rounded-[10px] text-[13px] text-paper placeholder-dim focus:outline-none border"
              style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }} />
          </div>
        </div>
      ) : (
        <div className="py-2 flex justify-center shrink-0">
          <button onClick={focusSearch} title="Search" className="w-10 h-9 border rounded-[10px] flex items-center justify-center text-dim hover:text-paper transition" style={{ borderColor: 'var(--bdr)' }}><Search size={15} /></button>
        </div>
      )}

      {/* Nav */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-2 flex flex-col gap-[22px]">
        {query ? (
          <div>
            <GroupLabel>{results.length ? 'Results' : ''}</GroupLabel>
            {results.map((r, i) => (
              <SearchRow key={r.key} row={r} query={query} selected={i === sel} onClick={() => go(r.key)} onHover={() => setSel(i)} />
            ))}
            {results.length === 0 && (
              <div className="px-3 py-8 text-center">
                <div className="text-sm font-medium text-muted">No matches for “{q}”</div>
                <div className="text-xs text-dim mt-1">Search covers every menu item.</div>
              </div>
            )}
          </div>
        ) : railOn ? (
          <div className="flex flex-col items-center gap-0.5">
            {CORE.map(([key, label, Icon]) => <RailBtn key={key} row={{ key, label, Icon }} active={activeKey === key} onClick={() => go(key)} />)}
            <div className="h-px w-8 my-1.5" style={{ background: 'var(--ink-line)' }} />
            {pinnedRows.map(r => <RailBtn key={'p' + r.key} row={r} active={activeKey === r.key} onClick={() => go(r.key)} />)}
            {COLLAPSIBLE.map(g => (
              <div key={g.id} className="flex flex-col items-center gap-0.5 w-full">
                <div className="h-px w-8 my-1.5" style={{ background: 'var(--ink-line)' }} />
                {g.items.filter(([, , , need]) => !need || profile.role === need).map(([key, label, Icon]) => <RailBtn key={key} row={{ key, label, Icon, section: g.label }} active={activeKey === key} onClick={() => go(key)} />)}
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* WORK — the spec's top group, with live counts */}
            <div className="flex flex-col gap-[2px]">
              <GroupLabel>Work</GroupLabel>
              {CORE.map(([key, label, Icon]) => (
                <NavItem key={key} icon={Icon} label={label} active={activeKey === key} onClick={() => go(key)} navKey={key}
                  count={countFor(key)} pinned={pinned.includes(key)} onPin={() => togglePin(key)} hover={hover} setHover={setHover} rowKey={key} />
              ))}
            </div>

            {/* Pinned + Recent, only when they have something */}
            {pinnedRows.length > 0 && (
              <div className="flex flex-col gap-[2px]">
                <GroupLabel icon={<Pin size={10} />}>Pinned</GroupLabel>
                {pinnedRows.map(r => (
                  <NavItem key={r.key} icon={r.Icon} label={r.label} active={activeKey === r.key} onClick={() => go(r.key)} navKey={r.key}
                    pinned onPin={() => togglePin(r.key)} hover={hover} setHover={setHover} rowKey={'pin:' + r.key} />
                ))}
              </div>
            )}
            {recentRows.length > 0 && (
              <div className="flex flex-col gap-[2px]">
                <GroupLabel icon={<History size={10} />}>Recent</GroupLabel>
                {recentRows.map(r => (
                  <NavItem key={r.key} icon={r.Icon} label={r.label} active={activeKey === r.key} onClick={() => go(r.key)} navKey={r.key} />
                ))}
              </div>
            )}

            {/* Everything else, grouped. CRM open by default; the rest fold. */}
            {COLLAPSIBLE.map(g => (
              <div key={g.id} className="flex flex-col gap-[2px]">
                <GroupHeader label={g.label} count={g.items.length} open={open[g.id]} onToggle={() => toggle(g.id)} />
                {open[g.id] && g.items.filter(([, , , need]) => !need || profile.role === need).map(([key, label, Icon]) => (
                  <NavItem key={key} icon={Icon} label={label} active={activeKey === key} onClick={() => go(key)} navKey={key}
                    pinned={pinned.includes(key)} onPin={() => togglePin(key)} hover={hover} setHover={setHover} rowKey={key} />
                ))}
              </div>
            ))}

            {/* App Build (dynamic backlog projects) */}
            <div className="flex flex-col gap-[2px]">
              <GroupHeader label="App Build" count={projects.length} open={open.appbuild}
                onToggle={() => toggle('appbuild')}
                onAdd={canWrite ? () => { setOpen(o => ({ ...o, appbuild: true })); setAdding(true); } : null} />
              {open.appbuild && (
                <>
                  {adding && (
                    <form onSubmit={createProject} className="px-1 py-1 flex gap-1.5">
                      <input value={projName} onChange={e => setProjName(e.target.value)} autoFocus placeholder="Project name"
                        className="flex-1 min-w-0 px-2 py-1 rounded-lg text-sm text-paper placeholder-dim border" style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }} />
                      <button type="submit" className="px-2 py-1 bg-ember text-white rounded-lg text-xs font-semibold">Add</button>
                    </form>
                  )}
                  {projects.map(p => {
                    const Icon = PROJECT_ICON[(p.name || '').toLowerCase()] || Package;
                    const isActive = activeProject?.id === p.id;
                    const onProjectView = isActive && (view === 'board' || view === 'features');
                    return (
                      <div key={p.id}>
                        <NavItem icon={Icon} label={p.name} active={view === 'board' && isActive} onClick={() => { setActiveProject(p); setView('board'); }} />
                        {onProjectView && (
                          <div className="ml-4 pl-2 border-l flex flex-col gap-[2px]" style={{ borderColor: 'var(--hair)' }}>
                            <NavItem icon={LayoutGrid} label="Board" active={view === 'board'} onClick={() => { setActiveProject(p); setView('board'); }} />
                            <NavItem icon={Star} label="Features" active={view === 'features'} onClick={() => { setActiveProject(p); setView('features'); }} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Timer + footer */}
      <div className="px-3 pb-3 shrink-0 flex flex-col gap-2">
        {!railOn && <TimerCard profile={profile} onOpen={openTimerSubject} />}
        {!railOn ? (
          <div className="pt-2 border-t" style={{ borderColor: 'var(--hair)' }}>
            <div className="flex items-center gap-2 mb-1.5 px-1">
              <div className="w-7 h-7 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0"
                style={{ background: 'rgb(var(--c-primary))', color: 'rgb(var(--c-ink))' }}>
                {(profile.display_name || profile.email || 'P')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-paper truncate leading-tight">{profile.display_name || 'Peter'}</div>
                <div className="font-mono text-[9px] text-dim uppercase tracking-[.18em]">{profile.role}</div>
              </div>
            </div>
            {FOOTER_NAV.map(([key, label, Icon]) => (
              <NavItem key={key} icon={Icon} label={label} active={activeKey === key} onClick={() => setView(key)} navKey={key} small />
            ))}
            {profile.role === 'owner' && <NavItem icon={UsersIcon} label="Users" active={activeKey === 'users'} onClick={() => setView('users')} navKey="users" small />}
            <button onClick={onSignOut} className="w-full mt-1 px-3 py-1.5 text-[12px] text-muted hover:text-paper rounded-[10px] text-left">Sign out</button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 pt-2 border-t" style={{ borderColor: 'var(--hair)' }}>
            <RailBtn row={{ key: 'account', label: 'My Account', Icon: User }} active={activeKey === 'account'} onClick={() => setView('account')} />
            <RailBtn row={{ key: 'settings', label: 'Settings', Icon: SettingsIcon }} active={activeKey === 'settings'} onClick={() => setView('settings')} />
            <div className="w-7 h-7 rounded-full text-[11px] font-bold flex items-center justify-center mt-1" title={profile.display_name || profile.email}
              style={{ background: 'rgb(var(--c-primary))', color: 'rgb(var(--c-ink))' }}>
              {(profile.display_name || profile.email || 'P')[0].toUpperCase()}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/** 9px mono, .18em, uppercase, dim, padding 0 10px 6px — from the artboard. */
function GroupLabel({ children, icon }) {
  if (!children) return null;
  return (
    <div className="flex items-center gap-1.5 px-[10px] pb-[6px] font-mono text-[9px] font-bold uppercase tracking-[.18em] text-dim">
      {icon}<span>{children}</span>
    </div>
  );
}

function GroupHeader({ label, count, open, onToggle, onAdd }) {
  return (
    <div className="flex items-center px-[10px] pb-[4px] gap-1">
      <button onClick={onToggle} className="flex items-center gap-1.5 flex-1 min-w-0 font-mono text-[9px] font-bold uppercase tracking-[.18em] text-dim hover:text-muted transition">
        <ChevronRight size={11} strokeWidth={2.5} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="truncate">{label}</span>
        <span className="ml-auto text-dim/70 normal-case tracking-normal">{count}</span>
      </button>
      {onAdd && <button onClick={onAdd} title="New" className="text-dim hover:text-paper shrink-0"><Plus size={13} strokeWidth={2.5} /></button>}
    </div>
  );
}

// Left-click navigates in-app; modified clicks fall through so open-in-new-tab works.
function handleNav(e, onClick) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
  e.preventDefault();
  onClick?.();
}

/** 9px 10px, radius 10, 14px. Active = card-bg + bdr + 600. Count in mono 11. */
function NavItem({ icon: Icon, label, active, onClick, navKey, pinned, onPin, hover, setHover, rowKey, count, small }) {
  const showPin = onPin && (pinned || hover === rowKey);
  const onEnter = setHover ? () => setHover(rowKey) : undefined;
  const onLeave = setHover ? () => setHover(h => h === rowKey ? null : h) : undefined;
  const cls = `group w-full flex items-center gap-[10px] px-[10px] ${small ? 'py-[7px] text-[13px]' : 'py-[9px] text-[14px]'} rounded-[10px] border transition text-left`;
  const style = active
    ? { background: 'var(--card-bg)', borderColor: 'var(--bdr)', color: 'rgb(var(--c-text))', fontWeight: 600 }
    : { borderColor: 'transparent', color: 'rgb(var(--c-text-soft))' };
  const inner = (
    <>
      <Icon size={small ? 15 : 17} strokeWidth={1.75} className="shrink-0 opacity-80" />
      <span className="truncate whitespace-nowrap flex-1">{label}</span>
      {count && (
        <span className="font-mono text-[11px] shrink-0" style={{ color: count.coral ? 'rgb(var(--c-coral))' : 'rgb(var(--c-dim))', fontWeight: count.coral ? 700 : 400 }}>{count.n}</span>
      )}
      {showPin && (
        <span role="button" title={pinned ? 'Unpin' : 'Pin to top'}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPin(); }}
          className={`shrink-0 ${pinned ? 'text-ember' : 'text-dim hover:text-paper'}`}>
          <Pin size={12} fill={pinned ? 'currentColor' : 'none'} />
        </span>
      )}
    </>
  );
  return navKey ? (
    <a href={`#${navKey}`} onClick={(e) => handleNav(e, onClick)} onMouseEnter={onEnter} onMouseLeave={onLeave} className={cls + ' no-underline hover:bg-card/60'} style={style}>{inner}</a>
  ) : (
    <button onClick={onClick} onMouseEnter={onEnter} onMouseLeave={onLeave} className={cls + ' hover:bg-card/60'} style={style}>{inner}</button>
  );
}

function RailBtn({ row, active, onClick }) {
  const Icon = row.Icon;
  const cls = 'w-11 h-9 rounded-[10px] flex items-center justify-center transition border';
  const style = active ? { background: 'var(--card-bg)', borderColor: 'var(--bdr)', color: 'rgb(var(--c-text))' } : { borderColor: 'transparent', color: 'rgb(var(--c-muted))' };
  const title = row.label + (row.section ? ' — ' + row.section : '');
  return row.key ? (
    <a href={`#${row.key}`} onClick={(e) => handleNav(e, onClick)} title={title} className={cls + ' no-underline hover:bg-card/60'} style={style}><Icon size={17} strokeWidth={1.75} /></a>
  ) : (
    <button onClick={onClick} title={title} className={cls + ' hover:bg-card/60'} style={style}><Icon size={17} strokeWidth={1.75} /></button>
  );
}

function SearchRow({ row, query, selected, onClick, onHover }) {
  const Icon = row.Icon;
  const li = row.label.toLowerCase().indexOf(query);
  const pre = li >= 0 ? row.label.slice(0, li) : row.label;
  const match = li >= 0 ? row.label.slice(li, li + query.length) : '';
  const post = li >= 0 ? row.label.slice(li + query.length) : '';
  return (
    <button onClick={onClick} onMouseEnter={onHover}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-sm transition text-left"
      style={selected ? { background: 'var(--card-bg)' } : undefined}>
      <Icon size={16} strokeWidth={1.75} className="shrink-0 text-muted" />
      <span className="flex-1 min-w-0">
        <span className="block truncate text-paper">{pre}<span className="font-bold text-ember-deep">{match}</span>{post}</span>
        <span className="block text-[11px] text-dim truncate">{row.section}</span>
      </span>
      {selected && <span className="shrink-0 font-mono text-[10px] text-dim border rounded px-1.5 py-0.5" style={{ borderColor: 'var(--bdr)' }}>↵</span>}
    </button>
  );
}
