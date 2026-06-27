import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { LogoLockup } from './ServOSLogo.jsx';
import {
  Home, Building2, MapPin, User, Target, Banknote, Box, Rocket, Folder, CheckSquare,
  Ticket, ClipboardList, FileText, LayoutGrid, Sparkles, Flag, BarChart3,
  Bug, Star, List, Layout, Layers, Package, ChevronRight, Plus, Mail, Calendar, MessageSquare, Clock, Plane, CreditCard, Receipt, TrendingUp,
  Warehouse, Boxes, PackagePlus, PackageMinus, ShoppingCart, ClipboardCheck, Truck, Factory,
  Settings as SettingsIcon, Users as UsersIcon, FileSignature, PhoneCall, Wallet, Tags, Percent, Landmark
} from 'lucide-react';

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
    ['finance_vat', 'VAT & reports', FileText],
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

  const [adding, setAdding] = useState(false);
  const [projName, setProjName] = useState('');
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const activeKey = ACTIVE_MAP[view] || view;

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
    <aside className="w-64 shrink-0 glass border-r border-bdr flex flex-col h-full">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-bdr shrink-0">
        {logoUrl ? <img src={logoUrl} alt="Logo" className="h-12 object-contain" /> : <LogoLockup size={40} />}
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto px-2 py-3">

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
                      <NavItem icon={LayoutGrid} label="Board" active={view === 'board'}
                        onClick={() => { setActiveProject(p); setView('board'); }} />
                      <NavItem icon={Star} label="Features" active={view === 'features'}
                        onClick={() => { setActiveProject(p); setView('features'); }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* My Work (pinned) */}
        <div className="mt-2 space-y-0.5">
          <NavItem icon={Home} label="My Work" active={activeKey === 'mywork'} onClick={() => setView('mywork')} />
          <NavItem icon={Mail} label="Inbox" active={activeKey === 'inbox'} onClick={() => setView('inbox')} />
          <NavItem icon={Calendar} label="Calendar" active={activeKey === 'calendar'} onClick={() => setView('calendar')} />
          <NavItem icon={MessageSquare} label="Chat" active={activeKey === 'chat'} onClick={() => setView('chat')} />
        </div>

        {/* Collapsible groups */}
        {COLLAPSIBLE.map(g => (
          <div key={g.id}>
            <GroupHeader label={g.label} count={g.items.length} open={open[g.id]} onToggle={() => toggle(g.id)} />
            {open[g.id] && (
              <div className="space-y-0.5">
                {g.items.map(([key, label, Icon]) => (
                  <NavItem key={key} icon={Icon} label={label} active={activeKey === key} onClick={() => setView(key)} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-bdr shrink-0">
        <div className="flex items-center gap-2 mb-2 px-1">
          <div className="w-8 h-8 rounded-full bg-ember text-ink text-sm font-bold flex items-center justify-center shrink-0">
            {(profile.display_name || profile.email || 'P')[0].toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-paper truncate">{profile.display_name || 'Peter'}</div>
            <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">{profile.role}</div>
          </div>
        </div>
        <NavItem icon={User} label="My Account" active={activeKey === 'account'} onClick={() => setView('account')} />
        <NavItem icon={SettingsIcon} label="Settings" active={activeKey === 'settings'} onClick={() => setView('settings')} />
        {profile.role === 'owner' && (
          <NavItem icon={UsersIcon} label="Users" active={activeKey === 'users'} onClick={() => setView('users')} />
        )}
        <button onClick={onSignOut} className="w-full mt-1 px-3 py-1.5 text-xs btn-ghost rounded-xl">Sign out</button>
      </div>
    </aside>
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
      {onAdd && (
        <button onClick={onAdd} title="New" className="text-dim hover:text-paper shrink-0"><Plus size={14} strokeWidth={2.5} /></button>
      )}
    </div>
  );
}

function NavItem({ icon: Icon, label, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2.5 pl-2.5 pr-3 py-2 rounded-r-xl rounded-l-md text-sm border-l-[3px] transition ${
        active
          ? 'bg-ember/10 text-ember-deep font-semibold border-ember'
          : 'border-transparent text-muted hover:bg-card hover:text-paper'
      }`}>
      <Icon size={18} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate whitespace-nowrap">{label}</span>
    </button>
  );
}
