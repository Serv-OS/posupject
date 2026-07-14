import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { LogoLockup } from './ServOSLogo.jsx';
import {
  Home, Building2, MapPin, User, Target, Banknote, Box, Rocket, Folder, CheckSquare,
  Ticket, ClipboardList, FileText, LayoutGrid, Sparkles, Flag, BarChart3,
  Bug, Star, List, Layout, Layers, Package, ChevronRight, Plus, Mail, Calendar, MessageSquare, Clock, Plane, CreditCard, Receipt, TrendingUp,
  Warehouse, Boxes, PackagePlus, PackageMinus, ShoppingCart, ClipboardCheck, Truck, Factory,
  Settings as SettingsIcon, Users as UsersIcon, FileSignature, PhoneCall, Wallet, Tags, Percent, Landmark,
  Search, PanelLeftClose, PanelLeftOpen, Pin, History
} from 'lucide-react';

// Core pinned block (un-grouped, top).
const CORE = [
  ['mywork', 'My Work', Home], ['inbox', 'Inbox', Mail], ['calendar', 'Calendar', Calendar], ['chat', 'Chat', MessageSquare],
];

// Collapsible groups (App Build is dynamic; My Work + My Account are pinned)
const COLLAPSIBLE = [
  { id: 'sales', label: 'Sales', items: [
    ['companies', 'Companies', Building2], ['locations', 'Locations', MapPin], ['contacts', 'Contacts', User],
    ['leads', 'Leads', Target], ['deals', 'Deals', Banknote],
    ['processing', 'Card Processing', CreditCard], ['quotes', 'Quotes', FileSignature],
    ['invoices', 'Invoices', Receipt],
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
  { id: 'delivery', label: 'Delivery', items: [
    ['onboarding', 'Onboarding', Rocket], ['projects', 'Projects', Folder], ['tasks', 'Tasks', CheckSquare],
  ] },
  { id: 'support', label: 'Support', items: [
    ['tickets', 'Support', Ticket], ['calls', 'Call Log', PhoneCall], ['forms', 'Forms', ClipboardList], ['templates', 'Templates', FileText],
  ] },
  { id: 'product', label: 'Product', items: [
    ['modules', 'Modules', LayoutGrid], ['feature_requests', 'Feature Requests', Sparkles], ['releases', 'Releases', Flag],
  ] },
  { id: 'workforce', label: 'Workforce', items: [
    ['time', 'Time Tracking', Clock], ['schedule', 'Schedule', Calendar], ['timeoff', 'Time Off', Plane],
    ['staff', 'Staff', User], ['departments', 'Departments & Areas', Building2],
  ] },
  { id: 'insights', label: 'Insights', items: [
    ['reporting', 'Reporting', BarChart3], ['sales_performance', 'Sales Performance', TrendingUp],
  ] },
];

const FOOTER_NAV = [['account', 'My Account', User], ['settings', 'Settings', SettingsIcon]];

const PROJECT_ICON = { 'bugs': Bug, 'features': Star, 'todo': List, 'ui changes': Layout, 'modules to build': Layers };

// Map detail views back to the nav item that should stay highlighted
const ACTIVE_MAP = {
  company_detail: 'companies', contact_detail: 'contacts', location_detail: 'locations',
  lead_detail: 'leads', deal_detail: 'deals', quote_detail: 'deals',
  onboarding_detail: 'onboarding', project_detail: 'projects', task_detail: 'tasks',
  ticket_detail: 'tickets', form_detail: 'forms', feature_request_detail: 'feature_requests',
  release_detail: 'releases', invoice_detail: 'invoices', quote_detail: 'quotes',
  bill_detail: 'bills', expense_detail: 'expenses',
};

const DEFAULT_GROUPS = { appbuild: true, sales: true, finance: false, inventory: true, delivery: false, support: false, product: false, workforce: false, insights: false };

// A flat searchable index of every static nav item (core + groups + footer).
const INDEX = [
  ...CORE.map(([key, label, Icon]) => ({ key, label, Icon, section: 'General' })),
  ...COLLAPSIBLE.flatMap(g => g.items.map(([key, label, Icon]) => ({ key, label, Icon, section: g.label }))),
  ...FOOTER_NAV.map(([key, label, Icon]) => ({ key, label, Icon, section: 'Account' })),
];
const BY_KEY = Object.fromEntries(INDEX.map(r => [r.key, r]));
const CORE_KEYS = new Set(CORE.map(c => c[0]));

function usePersist(key, initial) {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial; } catch { return initial; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }, [key, v]);
  return [v, setV];
}

export default function Sidebar({ profile, projects, activeProject, setActiveProject, view, setView, onSignOut, onRefresh, theme }) {
  const [logos, setLogos] = useState({ light: null, dark: null });
  useEffect(() => { supabase.from('support_settings').select('logo_url, logo_url_dark').eq('id', 1).maybeSingle().then(r => setLogos({ light: r.data?.logo_url || null, dark: r.data?.logo_url_dark || null })); }, []);
  const logoUrl = theme === 'dark' ? (logos.dark || logos.light) : (logos.light);

  const [open, setOpen] = useState(() => {
    try { return { ...DEFAULT_GROUPS, ...(JSON.parse(localStorage.getItem('servos_nav_groups')) || {}) }; }
    catch { return DEFAULT_GROUPS; }
  });
  useEffect(() => { try { localStorage.setItem('servos_nav_groups', JSON.stringify(open)); } catch { /* ignore */ } }, [open]);
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

  // Track recents whenever the active nav item changes.
  useEffect(() => { if (BY_KEY[activeKey]) setRecents(r => [activeKey, ...r.filter(k => k !== activeKey)].slice(0, 8)); }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Search
  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return [];
    return INDEX
      .map(r => { const idx = r.label.toLowerCase().indexOf(query); const inSec = r.section.toLowerCase().includes(query); return (idx < 0 && !inSec) ? null : { r, idx: idx < 0 ? 99 : idx }; })
      .filter(Boolean)
      .sort((a, b) => (a.idx - b.idx) || a.r.label.localeCompare(b.r.label))
      .slice(0, 14)
      .map(x => x.r);
  }, [query]);
  useEffect(() => { setSel(0); }, [query]);

  const go = (key) => { setView(key); setQ(''); setSel(0); };

  const focusSearch = () => { if (rail) setRail(false); setTimeout(() => searchRef.current?.focus(), 60); };
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); }
      else if (e.key === 'Escape' && document.activeElement === searchRef.current) { setQ(''); setSel(0); searchRef.current?.blur(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rail]); // eslint-disable-line react-hooks/exhaustive-deps
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

  return (
    <aside className={`shrink-0 glass border-r border-bdr flex flex-col h-full transition-[width] duration-200 ${railOn ? 'w-[68px]' : 'w-64'}`}>
      {/* Header: logo + rail toggle */}
      <div className="px-3 py-4 border-b border-bdr shrink-0 flex items-center gap-2">
        {railOn
          ? <div className="mx-auto"><LogoLockup size={30} markOnly /></div>
          : (logoUrl ? <img src={logoUrl} alt="Logo" className="h-11 object-contain flex-1 min-w-0" /> : <div className="flex-1"><LogoLockup size={38} /></div>)}
        {!mobile && (
          <button onClick={() => setRail(r => !r)} title={railOn ? 'Expand sidebar' : 'Collapse to rail'}
            className="text-dim hover:text-paper hover:bg-card rounded-lg p-1.5 shrink-0 transition">
            {railOn ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        )}
      </div>

      {/* Search */}
      {!railOn ? (
        <div className="px-2.5 pt-2.5 pb-1.5 shrink-0">
          <div className="relative flex items-center">
            <Search size={14} className="absolute left-3 text-dim pointer-events-none" />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onQKey}
              placeholder="Find anything…"
              className="w-full pl-9 pr-11 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember/60" />
            <span className="absolute right-2.5 text-[10px] font-mono font-semibold text-dim border border-bdr rounded px-1.5 py-0.5 pointer-events-none">⌘K</span>
          </div>
        </div>
      ) : (
        <div className="py-2 flex justify-center shrink-0">
          <button onClick={focusSearch} title="Search (⌘K)" className="w-10 h-9 border border-bdr rounded-xl flex items-center justify-center text-dim hover:text-paper hover:bg-card transition"><Search size={15} /></button>
        </div>
      )}

      {/* Nav */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">

        {query ? (
          /* ── Search results ── */
          <div>
            <SectionLabel>{results.length ? 'Results' : ''}</SectionLabel>
            {results.map((r, i) => (
              <SearchRow key={r.key} row={r} query={query} selected={i === sel}
                onClick={() => go(r.key)} onHover={() => setSel(i)} />
            ))}
            {results.length === 0 && (
              <div className="px-3 py-8 text-center">
                <div className="text-sm font-medium text-muted">No matches for “{q}”</div>
                <div className="text-xs text-dim mt-1">Search covers every menu item.</div>
              </div>
            )}
          </div>
        ) : railOn ? (
          /* ── Icon rail ── */
          <div className="flex flex-col items-center gap-0.5">
            {pinnedRows.map(r => <RailBtn key={'p' + r.key} row={r} active={activeKey === r.key} onClick={() => go(r.key)} navKey={r.key} />)}
            {pinnedRows.length > 0 && <div className="h-px w-8 bg-bdr my-1.5" />}
            {CORE.map(([key, label, Icon]) => <RailBtn key={key} row={{ key, label, Icon }} active={activeKey === key} onClick={() => go(key)} navKey={key} />)}
            {COLLAPSIBLE.map(g => (
              <div key={g.id} className="flex flex-col items-center gap-0.5 w-full">
                <div className="h-px w-8 bg-bdr my-1.5" />
                {g.items.map(([key, label, Icon]) => <RailBtn key={key} row={{ key, label, Icon, section: g.label }} active={activeKey === key} onClick={() => go(key)} navKey={key} />)}
              </div>
            ))}
          </div>
        ) : (
          /* ── Full browse ── */
          <>
            {/* Core — primary items, pinned to the top with a divider so it never blends into Recent */}
            <div className="space-y-0.5">
              {CORE.map(([key, label, Icon]) => (
                <NavItem key={key} icon={Icon} label={label} active={activeKey === key} onClick={() => go(key)} navKey={key}
                  pinned={pinned.includes(key)} onPin={() => togglePin(key)} hover={hover} setHover={setHover} rowKey={key} />
              ))}
            </div>
            <div className="h-px bg-bdr/70 mx-2 my-2.5" />

            {/* App Build (dynamic projects) */}
            <GroupHeader label="App Build" count={projects.length} open={open.appbuild}
              onToggle={() => toggle('appbuild')}
              onAdd={canWrite ? () => { setOpen(o => ({ ...o, appbuild: true })); setAdding(true); } : null} />
            {open.appbuild && (
              <div className="space-y-0.5">
                {adding && (
                  <form onSubmit={createProject} className="px-2 py-1 flex gap-1.5">
                    <input value={projName} onChange={e => setProjName(e.target.value)} autoFocus placeholder="Project name"
                      className="flex-1 px-2 py-1 bg-card border border-bdr rounded-lg text-sm text-paper placeholder-dim" />
                    <button type="submit" className="px-2 py-1 bg-ember text-white rounded-lg text-xs font-semibold">Add</button>
                  </form>
                )}
                {projects.map(p => {
                  const Icon = PROJECT_ICON[(p.name || '').toLowerCase()] || Package;
                  const isActive = activeProject?.id === p.id;
                  const onProjectView = isActive && (view === 'board' || view === 'features');
                  return (
                    <div key={p.id}>
                      <NavItem icon={Icon} label={p.name} active={view === 'board' && isActive}
                        onClick={() => { setActiveProject(p); setView('board'); }} />
                      {onProjectView && (
                        <div className="ml-4 pl-2 border-l border-bdr space-y-0.5">
                          <NavItem icon={LayoutGrid} label="Board" active={view === 'board'} onClick={() => { setActiveProject(p); setView('board'); }} />
                          <NavItem icon={Star} label="Features" active={view === 'features'} onClick={() => { setActiveProject(p); setView('features'); }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pinned */}
            {pinnedRows.length > 0 && (
              <div className="mt-2">
                <SectionLabel icon={<Pin size={11} />}>Pinned</SectionLabel>
                <div className="space-y-0.5">
                  {pinnedRows.map(r => (
                    <NavItem key={r.key} icon={r.Icon} label={r.label} active={activeKey === r.key} onClick={() => go(r.key)} navKey={r.key}
                      pinned onPin={() => togglePin(r.key)} hover={hover} setHover={setHover} rowKey={'pin:' + r.key} />
                  ))}
                </div>
              </div>
            )}

            {/* Recent */}
            {recentRows.length > 0 && (
              <div className="mt-2">
                <SectionLabel icon={<History size={11} />}>Recent</SectionLabel>
                <div className="space-y-0.5">
                  {recentRows.map(r => (
                    <NavItem key={r.key} icon={r.Icon} label={r.label} active={activeKey === r.key} onClick={() => go(r.key)} navKey={r.key} />
                  ))}
                </div>
              </div>
            )}

            {/* Collapsible groups */}
            {COLLAPSIBLE.map(g => (
              <div key={g.id}>
                <GroupHeader label={g.label} count={g.items.length} open={open[g.id]} onToggle={() => toggle(g.id)} />
                {open[g.id] && (
                  <div className="space-y-0.5">
                    {g.items.map(([key, label, Icon]) => (
                      <NavItem key={key} icon={Icon} label={label} active={activeKey === key} onClick={() => go(key)} navKey={key}
                        pinned={pinned.includes(key)} onPin={() => togglePin(key)} hover={hover} setHover={setHover} rowKey={key} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-bdr shrink-0">
        {!railOn ? (
          <>
            <div className="flex items-center gap-2 mb-2 px-1">
              <div className="w-8 h-8 rounded-full bg-ember text-ink text-sm font-bold flex items-center justify-center shrink-0">
                {(profile.display_name || profile.email || 'P')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-paper truncate">{profile.display_name || 'Peter'}</div>
                <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">{profile.role}</div>
              </div>
            </div>
            {FOOTER_NAV.map(([key, label, Icon]) => (
              <NavItem key={key} icon={Icon} label={label} active={activeKey === key} onClick={() => setView(key)} navKey={key} />
            ))}
            {profile.role === 'owner' && <NavItem icon={UsersIcon} label="Users" active={activeKey === 'users'} onClick={() => setView('users')} navKey="users" />}
            <button onClick={onSignOut} className="w-full mt-1 px-3 py-1.5 text-xs btn-ghost rounded-xl">Sign out</button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <RailBtn row={{ key: 'account', label: 'My Account', Icon: User }} active={activeKey === 'account'} onClick={() => setView('account')} />
            <RailBtn row={{ key: 'settings', label: 'Settings', Icon: SettingsIcon }} active={activeKey === 'settings'} onClick={() => setView('settings')} />
            <div className="w-8 h-8 rounded-full bg-ember text-ink text-sm font-bold flex items-center justify-center mt-1" title={profile.display_name || profile.email}>
              {(profile.display_name || profile.email || 'P')[0].toUpperCase()}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function SectionLabel({ children, icon }) {
  if (!children) return null;
  return (
    <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">
      {icon}<span>{children}</span>
    </div>
  );
}

function GroupHeader({ label, count, open, onToggle, onAdd }) {
  return (
    <div className="flex items-center px-2 mt-3 mb-1 gap-1">
      <button onClick={onToggle} className="flex items-center gap-1.5 flex-1 min-w-0 text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim hover:text-muted transition">
        <ChevronRight size={12} strokeWidth={2.5} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="truncate">{label}</span>
        <span className="ml-auto text-dim/70 normal-case">{count}</span>
      </button>
      {onAdd && <button onClick={onAdd} title="New" className="text-dim hover:text-paper shrink-0"><Plus size={14} strokeWidth={2.5} /></button>}
    </div>
  );
}

// Left-click navigates in-app; modified clicks (⌘/ctrl/shift/alt or middle) fall
// through to the browser so "open in new tab/window" works on the anchor's href.
function handleNav(e, onClick) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
  e.preventDefault();
  onClick?.();
}

function NavItem({ icon: Icon, label, active, onClick, navKey, pinned, onPin, hover, setHover, rowKey }) {
  const showPin = onPin && (pinned || hover === rowKey);
  const onEnter = setHover ? () => setHover(rowKey) : undefined;
  const onLeave = setHover ? () => setHover(h => h === rowKey ? null : h) : undefined;
  const cls = `group w-full flex items-center gap-2.5 pl-2.5 pr-2 py-2 rounded-r-xl rounded-l-md text-sm border-l-[3px] transition ${
    active ? 'bg-ember/10 text-ember-deep font-semibold border-ember' : 'border-transparent text-muted hover:bg-card hover:text-paper'
  }`;
  const inner = (
    <>
      <Icon size={18} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate whitespace-nowrap flex-1 text-left">{label}</span>
      {showPin && (
        <span role="button" title={pinned ? 'Unpin' : 'Pin to top'}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPin(); }}
          className={`shrink-0 ${pinned ? 'text-ember' : 'text-dim hover:text-paper'}`}>
          <Pin size={13} fill={pinned ? 'currentColor' : 'none'} />
        </span>
      )}
    </>
  );
  // Real link (right-click / ⌘-click / middle-click → new tab) when we know the
  // destination view; plain button otherwise (e.g. project board items).
  return navKey ? (
    <a href={`#${navKey}`} onClick={(e) => handleNav(e, onClick)} onMouseEnter={onEnter} onMouseLeave={onLeave} className={cls + ' no-underline'}>
      {inner}
    </a>
  ) : (
    <button onClick={onClick} onMouseEnter={onEnter} onMouseLeave={onLeave} className={cls}>
      {inner}
    </button>
  );
}

function RailBtn({ row, active, onClick }) {
  const Icon = row.Icon;
  const cls = `w-11 h-9 rounded-xl flex items-center justify-center transition ${active ? 'bg-ember/10 text-ember-deep' : 'text-muted hover:bg-card hover:text-paper'}`;
  const title = row.label + (row.section ? ' — ' + row.section : '');
  return row.key ? (
    <a href={`#${row.key}`} onClick={(e) => handleNav(e, onClick)} title={title} className={cls + ' no-underline'}>
      <Icon size={18} strokeWidth={1.75} />
    </a>
  ) : (
    <button onClick={onClick} title={title} className={cls}>
      <Icon size={18} strokeWidth={1.75} />
    </button>
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
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition ${selected ? 'bg-card' : 'hover:bg-card'}`}>
      <Icon size={18} strokeWidth={1.75} className="shrink-0 text-muted" />
      <span className="flex-1 min-w-0 text-left">
        <span className="block truncate text-paper">{pre}<span className="font-bold text-ember-deep">{match}</span>{post}</span>
        <span className="block text-[11px] text-dim truncate">{row.section}</span>
      </span>
      {selected && <span className="shrink-0 text-[10px] text-dim border border-bdr rounded px-1.5 py-0.5">↵</span>}
    </button>
  );
}
