import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { groupTasks, dueBucket } from '../../lib/taskGrouping';
import { useStickyState } from '../../lib/stickyState';
import { parseQuickAdd, quickAddRow } from '../../lib/quickAdd';
import {
  Avatar, Check, StatusPill, PriorityPill, Tag, LinkChip, SectionLabel, MetaLabel, Mono, PageTitle,
  PrimaryBtn, GhostBtn, Segmented, LabelledPill, FilterPill, Card, DashedAdd, DarkBar, SkeletonList, EmptyState,
  StatusMenu, MobileSheet, SheetRow, STATUS_LABEL, STATUS_ORDER, useLongPress, hair, dueLabel, fmtShort, fmtHM,
} from './ui.jsx';

// Screen 02 — the grouped list.
//
// One grouping control. The group header always carries progress, so a project
// reads as a unit inside a flat list. Rows are one line by default; the second
// line appears only when there is something to say (a blocker, subtasks, a
// linked record). Status pills are buttons: click opens the four-item popover,
// 1–4 sets it on the focused row, j/k move. Selection is a hover checkbox on
// the left edge, and the dark bar is the only multi-select UI.

const GROUPS = [['project', 'Project'], ['assignee', 'Assignee'], ['due', 'Due date'], ['priority', 'Priority']];
const DEFAULT_FILTERS = { search: '', status: 'open', assignee: 'all', overdueOnly: false };
const SUBJECT_LABEL = { company: 'Company', location: 'Site', deal: 'Deal', onboarding: 'Onboarding', ticket: 'Ticket' };

export default function TaskList({ profile, onSelect, onNavigate }) {
  const [allTasks, setAllTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [statusSheet, setStatusSheet] = useState(null); // phone: status is a sheet, not a clipped menu
  const [attachCounts, setAttachCounts] = useState({});
  const [tracked, setTracked] = useState({});
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useStickyState('tasks.filters', DEFAULT_FILTERS);
  const [groupBy, setGroupBy] = useStickyState('tasks.groupBy', 'project');
  const [collapsed, setCollapsed] = useState({});
  const [sel, setSel] = useState(() => new Set());
  // Hold a row to start selecting; on a phone there is no hover to reveal the box.
  const holdSelect = useLongPress((id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }));
  const [focus, setFocus] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [groupMenu, setGroupMenu] = useState(false);
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const addRef = useRef(null);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const f = { ...DEFAULT_FILTERS, ...(filters || {}) };
  const setF = (patch) => { setFilters({ ...f, ...patch }); setSel(new Set()); };

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [t, m, p, c, l, d, tk, ob] = await Promise.all([
      supabase.from('tasks').select('*').order('sort_order'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('*').order('name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
      supabase.from('tickets').select('id, ticket_number, subject'),
      supabase.from('onboardings').select('id, company_id, deal_id, location_id'),
    ]);
    setAllTasks(t.data || []); setMembers(m.data || []); setProjects(p.data || []);
    setCompanies(c.data || []); setLocations(l.data || []); setDeals(d.data || []); setTickets(tk.data || []); setOnboardings(ob.data || []);
    setLoading(false);
    // The second line's extras. Two cheap queries, not one per row.
    const ids = (t.data || []).map(x => x.id);
    if (ids.length) {
      const [a, te] = await Promise.all([
        supabase.from('attachments').select('subject_id').eq('subject_type', 'task').in('subject_id', ids),
        supabase.from('time_entries').select('subject_id, duration_seconds').eq('subject_type', 'task').in('subject_id', ids),
      ]);
      const ac = {}; for (const r of a.data || []) ac[r.subject_id] = (ac[r.subject_id] || 0) + 1;
      const tr = {}; for (const r of te.data || []) tr[r.subject_id] = (tr[r.subject_id] || 0) + (r.duration_seconds || 0);
      setAttachCounts(ac); setTracked(tr);
    }
  };

  // ── Lookups ────────────────────────────────────────────────────────────────
  const nameOf = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : ''; };
  const childMap = useMemo(() => { const m = {}; for (const t of allTasks) if (t.parent_task_id) (m[t.parent_task_id] ||= []).push(t); return m; }, [allTasks]);
  // A closed project's leftovers are not open work; counting them made every
  // handed-over onboarding read as overdue forever.
  const activeProjectIds = useMemo(() => new Set(projects.filter(p => p.status === 'active').map(p => p.id)), [projects]);
  const topLevel = useMemo(() => allTasks.filter(t => !t.parent_task_id && (!t.project_id || activeProjectIds.has(t.project_id))), [allTasks, activeProjectIds]);
  const allTopLevel = useMemo(() => allTasks.filter(t => !t.parent_task_id), [allTasks]);
  const linkOf = (t) => {
    const resolve = (type, id) => {
      if (!type || !id) return null;
      if (type === 'company') { const c = companies.find(x => x.id === id); return c ? { label: 'Company', name: c.name, tone: 'ink' } : null; }
      if (type === 'location') { const l = locations.find(x => x.id === id); return l ? { label: 'Site', name: l.name, tone: 'ink', companyId: l.company_id } : null; }
      if (type === 'deal') { const dl = deals.find(x => x.id === id); return dl ? { label: 'Deal', name: dl.name, tone: 'primary', companyId: dl.company_id } : null; }
      if (type === 'ticket') { const tk = tickets.find(x => x.id === id); return tk ? { label: 'Ticket', name: `#${tk.ticket_number}`, tone: 'primary' } : null; }
      if (type === 'onboarding') {
        const o = onboardings.find(x => x.id === id);
        const l = locations.find(x => x.id === o?.location_id);
        const c = companies.find(x => x.id === (o?.company_id || l?.company_id));
        return { label: 'Onboarding', name: l?.name || c?.name || '', tone: 'ink', companyId: c?.id };
      }
      return { label: SUBJECT_LABEL[type] || type, name: '', tone: 'ink' };
    };
    return resolve(t.subject_type, t.subject_id);
  };
  // Who the work is for, and where. Every project here hangs off an onboarding,
  // so without that hop fourteen jobs all read as one template name.
  const projectCustomer = (p) => {
    const of = (companyId, siteId, dealId) => {
      const site = locations.find(x => x.id === siteId);
      const deal = deals.find(x => x.id === dealId);
      const company = companies.find(x => x.id === (companyId || site?.company_id || deal?.company_id));
      const name = site?.name || deal?.name || company?.name || null;
      return name ? { site: name, company: company && company.name !== name ? company.name : null } : null;
    };
    if (!p?.subject_type || !p?.subject_id) return null;
    if (p.subject_type === 'company') return of(p.subject_id);
    if (p.subject_type === 'location') return of(null, p.subject_id);
    if (p.subject_type === 'deal') return of(null, null, p.subject_id);
    if (p.subject_type === 'onboarding') {
      const o = onboardings.find(x => x.id === p.subject_id);
      return o ? of(o.company_id, o.location_id, o.deal_id) : null;
    }
    return null;
  };

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let r = topLevel;
    if (f.status === 'open') r = r.filter(t => t.status !== 'done');
    else if (f.status !== 'all') r = r.filter(t => t.status === f.status);
    if (f.assignee === 'me') r = r.filter(t => t.owner_id === profile.id);
    if (f.assignee === 'unassigned') r = r.filter(t => !t.owner_id);
    if (f.overdueOnly) r = r.filter(t => dueBucket(t) === 'overdue' && t.status !== 'done');
    if (f.search) { const q = f.search.toLowerCase(); r = r.filter(t => t.title.toLowerCase().includes(q)); }
    return r;
  }, [topLevel, f.status, f.assignee, f.overdueOnly, f.search, profile.id]);
  const groups = useMemo(() => groupTasks(filtered, groupBy, { projects, members }), [filtered, groupBy, projects, members]);
  const visibleRows = useMemo(() => groups.flatMap(g => collapsed[g.key] ? [] : (g.sub ? g.sub.flatMap(s => s.tasks) : g.tasks)), [groups, collapsed]);

  const counts = useMemo(() => ({
    open: topLevel.filter(t => t.status !== 'done').length,
    overdue: topLevel.filter(t => t.status !== 'done' && dueBucket(t) === 'overdue').length,
    blocked: topLevel.filter(t => t.status === 'blocked').length,
    done: topLevel.filter(t => t.status === 'done').length,
  }), [topLevel]);
  const filtersActive = f.status !== 'open' || f.assignee !== 'all' || f.overdueOnly || !!f.search;
  const filterWords = [f.status !== 'open' && (f.status === 'all' ? 'all statuses' : f.status.replace('_', ' ')),
    f.assignee === 'me' && 'assigned to me', f.assignee === 'unassigned' && 'unassigned', f.overdueOnly && 'overdue only', f.search && `matching “${f.search}”`].filter(Boolean).join(', ');

  // ── Writes: optimistic, put back on failure ────────────────────────────────
  const patch = async (id, p) => {
    const before = allTasks;
    setAllTasks(ts => ts.map(t => (t.id === id ? { ...t, ...p } : t)));
    const { error } = await supabase.from('tasks').update(p).eq('id', id);
    if (error) { setAllTasks(before); setErr(error.message); }
  };
  const toggleDone = (t) => patch(t.id, t.status === 'done' ? { status: 'todo', completed_at: null } : { status: 'done', completed_at: new Date().toISOString() });
  const setStatus = async (t, status) => {
    const p = { status, completed_at: status === 'done' ? new Date().toISOString() : null };
    if (status === 'blocked') { const why = prompt('What is it waiting on?', t.blocked_reason || ''); if (why === null) return; p.blocked_reason = why.trim() || null; }
    else if (t.status === 'blocked') p.blocked_reason = null;
    setMenuFor(null);
    await patch(t.id, p);
  };
  const addTask = async () => {
    const text = addText.trim(); if (!text) return;
    const parsed = parseQuickAdd(text, { members, projects });
    const { error } = await supabase.from('tasks').insert(quickAddRow(parsed, profile.id));
    if (error) { setErr(error.message); return; }
    setAddText(''); load();
  };

  // Bulk actions — the dark bar.
  const selected = allTasks.filter(t => sel.has(t.id));
  const bulk = async (p) => {
    const ids = [...sel]; if (!ids.length) return;
    const { error } = await supabase.from('tasks').update(p).in('id', ids);
    if (error) { setErr(error.message); return; }
    setSel(new Set()); load();
  };
  const bulkAssign = () => { const name = prompt('Assign to (name):'); if (name === null) return; const m = members.find(x => (x.display_name || x.email).toLowerCase().startsWith(name.toLowerCase())); if (!m && name.trim()) { alert('No one by that name.'); return; } bulk({ owner_id: m?.id || null }); };
  const bulkDue = () => { const d = prompt('Due date (YYYY-MM-DD), blank to clear:'); if (d === null) return; bulk({ due_date: d.trim() || null }); };
  const bulkPhase = () => { const ph = prompt('Move to phase (name), blank to clear:'); if (ph === null) return; bulk({ phase: ph.trim() || null }); };
  const bulkStatus = () => { const s = prompt('Status: todo, in_progress, blocked, done'); if (!s) return; if (!['todo', 'in_progress', 'blocked', 'done'].includes(s.trim())) return; bulk({ status: s.trim(), completed_at: s.trim() === 'done' ? new Date().toISOString() : null }); };
  const bulkDelete = async () => { if (!confirm(`Delete ${sel.size} task${sel.size === 1 ? '' : 's'}? This cannot be undone.`)) return; const { error } = await supabase.from('tasks').delete().in('id', [...sel]); if (error) { setErr(error.message); return; } setSel(new Set()); load(); };

  // Keyboard: j/k move, 1–4 set status, Enter opens, x toggles selection.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey) return;
      if (!visibleRows.length) return;
      const i = focus ? visibleRows.findIndex(t => t.id === focus) : -1;
      if (e.key === 'j') { e.preventDefault(); setFocus(visibleRows[Math.min(i + 1, visibleRows.length - 1)].id); }
      else if (e.key === 'k') { e.preventDefault(); setFocus(visibleRows[Math.max(i - 1, 0)].id); }
      else if (e.key === 'Enter' && focus) { e.preventDefault(); onSelect?.(focus); }
      else if (e.key === 'x' && focus) { e.preventDefault(); setSel(s => { const n = new Set(s); n.has(focus) ? n.delete(focus) : n.add(focus); return n; }); }
      else if (['1', '2', '3', '4'].includes(e.key) && focus && canWrite) { const t = visibleRows.find(x => x.id === focus); if (t) setStatus(t, ['todo', 'in_progress', 'blocked', 'done'][Number(e.key) - 1]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleRows, focus, canWrite]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstProject = groupBy === 'project' ? projects.find(p => p.id === groups[0]?.key) : null;

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene)' }}>
      {/* Header */}
      <div className="px-[18px] lg:px-6 pt-3 lg:pt-5 flex items-start gap-3 lg:gap-4 flex-wrap lg:flex-nowrap">
        <div className="flex-1 min-w-0 basis-full sm:basis-auto">
          <PageTitle className="mb-1">Tasks</PageTitle>
          <MetaLabel className="block truncate">{counts.open} open · {counts.overdue} overdue · {counts.blocked} blocked · {counts.done} done</MetaLabel>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          <GhostBtn onClick={() => onNavigate?.('project_templates')}>Import from template</GhostBtn>
          {canWrite && <PrimaryBtn onClick={() => { setAdding(true); setTimeout(() => addRef.current?.focus(), 30); }}>New task</PrimaryBtn>}
        </div>
      </div>

      {/* Toolbar */}
      <div className="px-6 pt-4 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border w-[230px]" style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }}>
          <input value={f.search} onChange={e => setF({ search: e.target.value })} placeholder="Search tasks…"
            className="flex-1 min-w-0 bg-transparent text-[13px] text-paper placeholder-dim focus:outline-none" />
        </div>
        <Segmented value="list" options={[['list', 'List'], ['board', 'Board'], ['calendar', 'Calendar']]}
          onChange={(v) => { if (v === 'board') onNavigate?.('work_board'); if (v === 'calendar') onNavigate?.('work_calendar'); }} />
        <span className="relative">
          <LabelledPill label="Group:" value={GROUPS.find(g => g[0] === groupBy)?.[1] || 'Project'} onClick={() => setGroupMenu(v => !v)} />
          {groupMenu && (
            <div className="absolute left-0 top-full mt-1 z-40 min-w-[160px] menu-surface rounded-[10px] py-1">
              {GROUPS.map(([k, l]) => <button key={k} onClick={() => { setGroupBy(k); setGroupMenu(false); }} className={`w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 ${groupBy === k ? 'font-semibold' : ''}`}>{l}</button>)}
            </div>
          )}
        </span>
        <FilterPill on={f.status !== 'open'} tone="ink" onClick={() => setF({ status: f.status === 'open' ? 'all' : 'open' })}>{f.status === 'open' ? 'Open' : f.status === 'all' ? 'All' : f.status.replace('_', ' ')}</FilterPill>
        <FilterPill on={f.assignee !== 'all'} tone="ink" onClick={() => setF({ assignee: f.assignee === 'all' ? 'me' : f.assignee === 'me' ? 'unassigned' : 'all' })}>{f.assignee === 'all' ? 'Everyone' : f.assignee === 'me' ? 'Mine' : 'Unassigned'}</FilterPill>
        <FilterPill on={f.overdueOnly} onClick={() => setF({ overdueOnly: !f.overdueOnly })}>Overdue only</FilterPill>
        {filtersActive && <button onClick={() => setF(DEFAULT_FILTERS)} className="text-[12px] text-dim hover:text-paper">Clear</button>}
        <Mono className="ml-auto">Saved view: {GROUPS.find(g => g[0] === groupBy)?.[1]}{filtersActive ? ' · filtered' : ''}</Mono>
      </div>

      {/* Dashed add row */}
      {canWrite && (
        <div className="px-6 pt-[14px]">
          {adding ? (
            <div className="flex items-center gap-2.5 px-[14px] py-[9px] rounded-[12px] border" style={{ background: 'var(--surface-solid)', borderColor: 'rgb(var(--c-primary) / .5)' }}>
              <span className="text-[18px] leading-none text-dim">+</span>
              <input ref={addRef} autoFocus value={addText} onChange={e => setAddText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } if (e.key === 'Escape') { setAdding(false); setAddText(''); } }}
                placeholder="Add a task — @person #project !priority fri"
                className="flex-1 min-w-0 bg-transparent text-[14px] text-paper placeholder-dim focus:outline-none" />
              <button onClick={addTask} disabled={!addText.trim()} className="text-[13px] font-semibold disabled:opacity-40" style={{ color: 'rgb(var(--c-primary-deep))' }}>Add</button>
              <button onClick={() => { setAdding(false); setAddText(''); }} className="text-[13px] text-dim">Cancel</button>
            </div>
          ) : (
            <DashedAdd onClick={() => { setAdding(true); setTimeout(() => addRef.current?.focus(), 30); }}>
              Add a task{firstProject ? ` to ${firstProject.name}` : ''} — <span className="font-mono text-[13px]">@peter mon !high</span>
            </DashedAdd>
          )}
        </div>
      )}
      {err && <div className="px-6 pt-2 text-[12px]" style={{ color: 'rgb(var(--c-coral-deep))' }}>Could not save: {err} <button className="underline ml-1" onClick={() => setErr('')}>dismiss</button></div>}

      {/* Groups */}
      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-6 flex flex-col gap-[14px]">
        {loading && <SkeletonList rows={4} />}
        {!loading && topLevel.length === 0 && (
          <EmptyState title="Nothing to do yet"
            body="Add the first task, or start from a template if this is a job you run often — onboarding, install, monthly close."
            primary={canWrite ? 'Add a task' : null} secondary="Use a template"
            onPrimary={() => { setAdding(true); setTimeout(() => addRef.current?.focus(), 30); }} onSecondary={() => onNavigate?.('project_templates')} />
        )}
        {!loading && topLevel.length > 0 && filtered.length === 0 && (
          <EmptyState title="No tasks match" body={`${filterWords.charAt(0).toUpperCase() + filterWords.slice(1)}. ${counts.open} open task${counts.open === 1 ? ' is' : 's are'} hidden by these filters.`}
            secondary="Clear filters" onSecondary={() => setF(DEFAULT_FILTERS)} />
        )}
        {!loading && groups.map(g => {
          const proj = groupBy === 'project' && g.key !== '__none' ? projects.find(p => p.id === g.key) : null;
          const customer = proj ? projectCustomer(proj) : null;
          const hidden = !!collapsed[g.key];
          const due = proj?.due_date ? dueLabel(proj.due_date, proj.status === 'completed' ? 'done' : 'todo') : null;
          const rowsOf = (list) => list.map(t => renderRow(t));
          const renderRow = (t) => {
            const kids = childMap[t.id] || [];
            const link = linkOf(t);
            const due = dueLabel(t.due_date, t.status);
            const isDone = t.status === 'done', isBlocked = t.status === 'blocked', isActive = t.status === 'in_progress';
            const extras = [];
            if (kids.length) extras.push(`${kids.filter(k => k.status === 'done').length}/${kids.length} subtasks`);
            if (attachCounts[t.id]) extras.push(`${attachCounts[t.id]} attachment${attachCounts[t.id] === 1 ? '' : 's'}`);
            if (tracked[t.id]) extras.push(`${fmtHM(tracked[t.id])} tracked`);
            const second = isBlocked ? (t.blocked_reason ? `Blocked by ${t.blocked_reason}` : 'Blocked') : null;
            const focused = focus === t.id;
            return (
              <div key={t.id}>
                <div onMouseEnter={() => setFocus(t.id)} {...holdSelect(t.id)}
                  className="group relative flex items-start sm:items-center gap-3 pl-4 pr-4 py-[11px] border-b"
                  style={{ borderColor: 'var(--ink-soft)', borderLeft: isBlocked ? '3px solid rgb(var(--c-coral))' : '3px solid transparent',
                    background: isActive || focused ? 'rgb(var(--c-primary) / .05)' : 'transparent' }}>
                  {/* Hover checkbox on the left edge — the only selection control. */}
                  <input type="checkbox" checked={sel.has(t.id)} onChange={() => setSel(s => { const n = new Set(s); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })}
                    className={`absolute -left-[2px] top-1/2 -translate-y-1/2 accent-ember w-[14px] h-[14px] transition-opacity ${sel.has(t.id) || sel.size > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    style={{ marginLeft: -12 }} />
                  <Check done={isDone} active={isActive} onClick={() => canWrite && toggleDone(t)} disabled={!canWrite} />
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onSelect?.(t.id)}>
                    <div className={`text-[15px] ${isDone ? 'text-dim line-through' : 'text-paper font-medium'} truncate sm:truncate`}>{t.title}</div>
                    {(second || link || extras.length > 0) && (
                      <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                        {second && <span className="text-[11px] truncate" style={{ color: 'rgb(var(--c-coral))' }}>{second}</span>}
                        {link && <Tag tone={link.tone}>{link.label}{link.name ? ` ${link.name}` : ''}</Tag>}
                        {extras.length > 0 && <span className="text-[11px] text-dim truncate">{extras.join(' · ')}</span>}
                      </div>
                    )}
                    {/* Phone: the chips go UNDER the title. Kept on one line they
                        left the title exactly zero pixels wide. */}
                    <div className="sm:hidden flex items-center gap-2 mt-1.5 flex-wrap">
                      {due.text && <Mono tone={due.tone === 'coral' ? 'coral' : due.tone === 'primary' ? 'primary' : 'dim'} bold={due.tone === 'coral'}>{due.text}</Mono>}
                      <PriorityPill priority={t.priority} />
                      <span onClick={e => { e.stopPropagation(); if (canWrite) setStatusSheet(t); }}><StatusPill status={t.status} caret={false} /></span>
                    </div>
                  </div>
                  <span className="hidden sm:inline-flex"><Mono tone={due.tone === 'coral' ? 'coral' : due.tone === 'primary' ? 'primary' : 'dim'} bold={due.tone === 'coral' || due.tone === 'primary'}>{due.text}</Mono></span>
                  <span className="hidden sm:inline-flex"><PriorityPill priority={t.priority} /></span>
                  <span className="relative hidden sm:inline-flex">
                    <StatusPill status={t.status} onClick={canWrite ? () => setMenuFor(menuFor === t.id ? null : t.id) : undefined} />
                    {menuFor === t.id && <StatusMenu current={t.status} onPick={(s) => setStatus(t, s)} onClose={() => setMenuFor(null)} />}
                  </span>
                  <Avatar id={t.owner_id} name={nameOf(t.owner_id)} />
                </div>
                {kids.map(k => (
                  <div key={k.id} className="flex items-center gap-3 pl-[46px] pr-4 py-2 border-b" style={{ borderColor: 'var(--ink-soft)' }}>
                    <Check size={16} done={k.status === 'done'} onClick={() => canWrite && toggleDone(k)} disabled={!canWrite} />
                    <span className={`flex-1 text-[13px] cursor-pointer ${k.status === 'done' ? 'text-dim line-through' : 'text-paper-soft'}`} onClick={() => onSelect?.(k.id)}>{k.title}</span>
                    <Mono size={10}>Subtask</Mono>
                  </div>
                ))}
              </div>
            );
          };
          // Progress is the project's real state; the list above it is filtered.
          const projTasks = groupBy === 'project' && g.key !== '__none' ? allTopLevel.filter(t => t.project_id === g.key) : g.tasks;
          const total = projTasks.length, doneN = projTasks.filter(t => t.status === 'done').length;
          const pct = total ? Math.round((doneN / total) * 100) : 0;
          const goLive = (() => {
            if (!due || proj?.status !== 'active') return null;
            const days = Math.round((new Date(proj.due_date + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
            // A date already gone is late, not a go-live to look forward to.
            if (days < 0) return <Mono tone="coral" bold>{`Due ${fmtShort(proj.due_date)} \u00b7 ${-days}d late`}</Mono>;
            return <Mono tone={days <= 14 ? 'coral' : 'dim'} bold={days <= 14}>{days <= 14 ? `Go live ${fmtShort(proj.due_date)}` : `Due ${fmtShort(proj.due_date)}`}</Mono>;
          })();
          const stats = (<>
            <Mono tone="muted">{doneN}/{total} done</Mono>
            {g.progress.blocked > 0 && <Mono tone="coral" bold>{g.progress.blocked} blocked</Mono>}
            {goLive}
          </>);
          return (
            <Card key={g.key}>
              {/* Two rows on a phone: who it is for, then the numbers. One row on
                  a desktop. Kept on one line the customer name lost to the chips. */}
              <div className="px-4 py-3 border-b" style={hair}>
                <div className="flex items-center gap-2.5">
                  <button onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))} aria-label={hidden ? 'Expand' : 'Collapse'}
                    className="w-8 h-8 -my-1 -ml-1.5 shrink-0 flex items-center justify-center text-[13px] text-dim hover:text-paper">{hidden ? '\u25b8' : '\u25be'}</button>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-bold text-paper truncate">{customer?.site || g.label}</span>
                    <span className="block sm:hidden text-[11px] text-dim truncate">{[customer?.company, customer?.site ? g.label : null].filter(Boolean).join(' \u00b7 ')}</span>
                  </span>
                  <span className="hidden sm:contents">
                    {customer?.company && <Tag>{customer.company}</Tag>}
                    {customer?.site && <Mono tone="muted" className="truncate max-w-[200px]">{g.label}</Mono>}
                  </span>
                  {proj?.owner_id && <Avatar id={proj.owner_id} name={nameOf(proj.owner_id)} size={20} />}
                  <div className="hidden sm:block w-[110px] h-[6px] rounded-full overflow-hidden shrink-0" style={{ background: 'var(--ink-line)' }}>
                    <div className="h-full" style={{ width: `${pct}%`, background: 'rgb(var(--c-primary))' }} />
                  </div>
                  <span className="hidden sm:contents">{stats}</span>
                </div>
                <div className="sm:hidden flex items-center gap-2.5 flex-wrap mt-1.5 pl-[38px]">{stats}</div>
              </div>
              {!hidden && (g.sub
                ? g.sub.map(s => (
                    <div key={s.key}>
                      <div className="px-4 pt-[9px] pb-1"><SectionLabel>{s.key === '__nophase' ? 'Unphased' : `Phase — ${s.label}`}</SectionLabel></div>
                      {rowsOf(s.tasks)}
                    </div>
                  ))
                : rowsOf(g.tasks))}
            </Card>
          );
        })}
      </div>

      {statusSheet && (
        <MobileSheet title={statusSheet.title} sub="Set status" onClose={() => setStatusSheet(null)}>
          {STATUS_ORDER.map(st => (
            <SheetRow key={st} active={statusSheet.status === st} onClick={() => { setStatus(statusSheet, st); setStatusSheet(null); }}>{STATUS_LABEL[st]}</SheetRow>
          ))}
        </MobileSheet>
      )}
      {sel.size > 0 && canWrite && (
        <div className="px-[14px] lg:px-6 pb-4 sticky z-30" style={{ bottom: 'calc(var(--tabbar-h) + env(safe-area-inset-bottom))' }}>
          <DarkBar count={sel.size} onClear={() => setSel(new Set())}
            actions={[['Assign', bulkAssign], ['Due date', bulkDue], ['Move to phase', bulkPhase], ['Status', bulkStatus], ['Delete', bulkDelete, true]]} />
        </div>
      )}
      {selected.length === 0 && null}
    </div>
  );
}
