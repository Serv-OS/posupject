import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useStickyState } from '../../lib/stickyState';
import { useIsMobile } from '../../lib/useMedia';
import {
  Avatar, Tag, MetaLabel, Mono, PageTitle, PrimaryBtn, GhostBtn, Segmented, LabelledPill, FilterPill,
  Card, SkeletonList, EmptyState, hair, fmtShort, dueLabel,
} from './ui.jsx';

// Screen 14 — projects at real volume.
//
// Fourteen projects, thirteen of them the same template, all called "LS FFA
// Onboarding": a card list stops working. Grouping by template and leading
// with the CUSTOMER fixes it without renaming anything — the project name
// moves to the group header where it is said once. "Next up" is the first
// open task in the earliest incomplete phase, which is the column people
// actually scan. Cards remain for the handful of bespoke projects.

const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export default function ProjectList({ profile, onSelect, onNavigate }) {
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [members, setMembers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useStickyState('projects.view', 'table');
  // A 7-column table cannot be read on a phone: cards are the phone view (spec 14).
  const isMobile = useIsMobile();
  const effView = isMobile ? 'cards' : view;
  const [groupBy, setGroupBy] = useStickyState('projects.groupBy', 'template');
  const [search, setSearch] = useState('');
  const [behindOnly, setBehindOnly] = useStickyState('projects.behind', false);
  const [owner, setOwner] = useStickyState('projects.owner', '');
  const [status, setStatus] = useStickyState('projects.status', 'active');
  const [expanded, setExpanded] = useState({});
  const [collapsed, setCollapsed] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  // What the project is for. Internal means no customer record behind it.
  const [subj, setSubj] = useState({ type: 'internal', id: '' });
  const [groupMenu, setGroupMenu] = useState(false);
  const [ownerMenu, setOwnerMenu] = useState(false);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [p, t, tp, m, c, l, d, ob, tk] = await Promise.all([
      supabase.from('crm_projects').select('*').order('created_at', { ascending: false }),
      supabase.from('tasks').select('id, project_id, status, phase, title, due_date, sort_order').is('parent_task_id', null),
      supabase.from('project_templates').select('id, name'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
      supabase.from('onboardings').select('id, company_id, deal_id, location_id'),
      supabase.from('tickets').select('id, ticket_number, subject, company_id, location_id'),
    ]);
    setProjects(p.data || []); setTasks(t.data || []); setTemplates(tp.data || []); setMembers(m.data || []);
    setCompanies(c.data || []); setLocations(l.data || []); setDeals(d.data || []); setOnboardings(ob.data || []); setTickets(tk.data || []);
    setLoading(false);
  };

  const nameOf = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : ''; };

  // Customer is the identity of a templated project.
  const customerOf = (p) => {
    if (!p.subject_type || !p.subject_id) return { name: null, company: null, key: '__internal' };
    if (p.subject_type === 'ticket') { const tk = tickets.find(x => x.id === p.subject_id); const l = locations.find(x => x.id === tk?.location_id); const c = companies.find(x => x.id === (tk?.company_id || l?.company_id)); return { name: tk ? `Ticket #${tk.ticket_number} — ${tk.subject}` : 'Ticket', company: c?.name, key: c?.id || `ticket:${p.subject_id}` }; }
    if (p.subject_type === 'company') { const c = companies.find(x => x.id === p.subject_id); return { name: c?.name, company: null, key: p.subject_id }; }
    if (p.subject_type === 'location') { const l = locations.find(x => x.id === p.subject_id); const c = companies.find(x => x.id === l?.company_id); return { name: l?.name, company: c?.name, key: c?.id || `location:${p.subject_id}` }; }
    if (p.subject_type === 'deal') { const dl = deals.find(x => x.id === p.subject_id); const c = companies.find(x => x.id === dl?.company_id); return { name: dl?.name, company: c?.name, key: c?.id || `deal:${p.subject_id}` }; }
    if (p.subject_type === 'onboarding') {
      const o = onboardings.find(x => x.id === p.subject_id); const l = locations.find(x => x.id === o?.location_id); const dl = deals.find(x => x.id === o?.deal_id);
      const c = companies.find(x => x.id === (o?.company_id || dl?.company_id || l?.company_id));
      return { name: l?.name || dl?.name || c?.name, company: c?.name, key: c?.id || `onboarding:${p.subject_id}` };
    }
    return { name: null, company: null };
  };

  const stats = useMemo(() => {
    const today = todayKey(), m = {};
    for (const p of projects) {
      const pt = tasks.filter(t => t.project_id === p.id);
      const done = pt.filter(t => t.status === 'done').length;
      const phases = p.phases || [];
      // Next up: first open, unblocked task in the earliest incomplete phase.
      const open = pt.filter(t => t.status !== 'done');
      const rank = (t) => { const i = phases.indexOf(t.phase); return i === -1 ? 999 : i; };
      const next = [...open].sort((a, b) => rank(a) - rank(b) || (a.sort_order || 0) - (b.sort_order || 0)).find(t => t.status !== 'blocked') || open[0] || null;
      const overdueTasks = open.filter(t => t.due_date && t.due_date < today).length;
      const blocked = open.filter(t => t.status === 'blocked').length;
      const late = p.status === 'active' && p.due_date && p.due_date < today;
      m[p.id] = { total: pt.length, done, next, overdueTasks, blocked, behind: late || overdueTasks > 0 || blocked > 0 };
    }
    return m;
  }, [projects, tasks]);

  const filtered = useMemo(() => {
    let r = projects;
    if (status !== 'all') r = r.filter(p => p.status === status);
    if (owner) r = r.filter(p => p.owner_id === owner);
    if (behindOnly) r = r.filter(p => stats[p.id]?.behind);
    if (search) { const q = search.toLowerCase(); r = r.filter(p => p.name.toLowerCase().includes(q) || (customerOf(p).name || '').toLowerCase().includes(q) || (customerOf(p).company || '').toLowerCase().includes(q)); }
    return r;
  }, [projects, status, owner, behindOnly, search, stats]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const m = new Map();
    for (const p of filtered) {
      const cust = customerOf(p);
      const key = groupBy === 'template' ? (p.template_id || '__none') : groupBy === 'owner' ? (p.owner_id || '__none') : groupBy === 'customer' ? (cust.key || '__internal') : '__all';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(p);
    }
    return [...m.entries()].map(([key, list]) => {
      const tpl = groupBy === 'template' && key !== '__none' ? templates.find(t => t.id === key) : null;
      const first = customerOf(list[0]); // every project in a customer group shares the record, so the first names it
      const label = groupBy === 'template' ? (tpl?.name || (key === '__none' ? 'No template' : 'Template')) : groupBy === 'owner' ? (nameOf(key) || 'Unassigned') : groupBy === 'customer' ? (key === '__internal' ? 'Internal' : (first.company || first.name || 'Customer')) : 'All projects';
      const behind = list.filter(p => stats[p.id]?.behind).length;
      const dues = [...new Set(list.map(p => p.due_date).filter(Boolean))];
      const taskCount = tpl ? Math.round(list.reduce((s, p) => s + (stats[p.id]?.total || 0), 0) / Math.max(1, list.length)) : null;
      return { key, label, list, tpl, behind, sameDue: dues.length === 1 ? dues[0] : null, taskCount };
    }).sort((a, b) => (a.key === '__none') - (b.key === '__none') || b.list.length - a.list.length);
  }, [filtered, groupBy, templates, stats, members]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeN = projects.filter(p => p.status === 'active').length;
  const behindN = projects.filter(p => p.status === 'active' && stats[p.id]?.behind).length;
  const templatesInUse = new Set(projects.filter(p => p.status === 'active' && p.template_id).map(p => p.template_id)).size;

  const create = async (e) => {
    e.preventDefault(); if (!name.trim() || (subj.type !== 'internal' && !subj.id)) return;
    setErr('');
    const row = { name: name.trim(), owner_id: profile.id, subject_type: subj.type !== 'internal' && subj.id ? subj.type : null, subject_id: subj.type !== 'internal' && subj.id ? subj.id : null };
    const { data, error } = await supabase.from('crm_projects').insert(row).select().single();
    if (error) { setErr(error.message); return; }
    setName(''); setSubj({ type: 'internal', id: '' }); setShowCreate(false);
    if (data) onSelect(data.id); else load();
  };

  const COLS = 'grid gap-4 items-center';
  const colStyle = { gridTemplateColumns: 'minmax(0,1fr) 230px 150px 110px 36px' };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene)' }}>
      <div className="px-6 pt-5 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <PageTitle className="mb-1">Projects</PageTitle>
          <MetaLabel>{activeN} active · {behindN} behind · {templatesInUse} template{templatesInUse === 1 ? '' : 's'} in use</MetaLabel>
        </div>
        {canWrite && <PrimaryBtn onClick={() => setShowCreate(v => !v)}>New project</PrimaryBtn>}
      </div>

      <div className="px-6 pt-4 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 rounded-[10px] border w-[210px]" style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer or project…" className="flex-1 min-w-0 bg-transparent text-[13px] text-paper placeholder-dim focus:outline-none" />
        </div>
        <span className="relative">
          <LabelledPill label="Group:" value={groupBy === 'template' ? 'Template' : groupBy === 'owner' ? 'Owner' : groupBy === 'customer' ? 'Customer' : 'None'} onClick={() => setGroupMenu(v => !v)} />
          {groupMenu && (
            <div className="absolute left-0 top-full mt-1 z-40 min-w-[150px] menu-surface rounded-[10px] py-1" onMouseLeave={() => setGroupMenu(false)}>
              {[['template', 'Template'], ['customer', 'Customer'], ['owner', 'Owner'], ['none', 'None']].map(([k, l]) => <button key={k} onClick={() => { setGroupBy(k); setGroupMenu(false); }} className={`w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 ${groupBy === k ? 'font-semibold' : ''}`}>{l}</button>)}
            </div>
          )}
        </span>
        <FilterPill on={behindOnly} tone="coral" onClick={() => setBehindOnly(!behindOnly)}>Behind schedule</FilterPill>
        <span className="relative">
          <FilterPill on={!!owner} tone="ink" onClick={() => setOwnerMenu(v => !v)}>Owner: {owner ? nameOf(owner) : 'anyone'}</FilterPill>
          {ownerMenu && (
            <div className="absolute left-0 top-full mt-1 z-40 min-w-[160px] menu-surface rounded-[10px] py-1" onMouseLeave={() => setOwnerMenu(false)}>
              <button onClick={() => { setOwner(''); setOwnerMenu(false); }} className="w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10">Anyone</button>
              {members.map(m => <button key={m.id} onClick={() => { setOwner(m.id); setOwnerMenu(false); }} className={`w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 ${owner === m.id ? 'font-semibold' : ''}`}>{m.display_name || m.email}</button>)}
            </div>
          )}
        </span>
        <FilterPill on={status !== 'active'} tone="ink" onClick={() => setStatus(status === 'active' ? 'all' : status === 'all' ? 'completed' : 'active')}>{status === 'active' ? 'Active' : status === 'all' ? 'All' : status}</FilterPill>
        <span className="ml-auto hidden lg:inline-flex"><Segmented value={view} options={[['table', 'Table'], ['cards', 'Cards']]} onChange={setView} /></span>
      </div>

      {showCreate && (
        <form onSubmit={create} className="px-6 pt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Project name" className="flex-1 px-3 py-2 rounded-[10px] text-[14px] text-paper placeholder-dim focus:outline-none border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }} />
            <PrimaryBtn type="submit" disabled={!name.trim() || (subj.type !== 'internal' && !subj.id)}>Create</PrimaryBtn>
            <GhostBtn onClick={() => setShowCreate(false)}>Cancel</GhostBtn>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Segmented value={subj.type} options={[['internal', 'Internal'], ['company', 'Company'], ['location', 'Site'], ['deal', 'Deal']]} onChange={(t) => setSubj({ type: t, id: '' })} />
            {subj.type !== 'internal' && (
              <select value={subj.id} onChange={e => setSubj(x => ({ ...x, id: e.target.value }))} className="px-3 py-2 rounded-[10px] text-[13px] text-paper border min-w-[260px]" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }}>
                <option value="">Pick a {subj.type === 'location' ? 'site' : subj.type}…</option>
                {(subj.type === 'company' ? companies : subj.type === 'location' ? locations : deals).map(r => (
                  <option key={r.id} value={r.id}>{r.name}{subj.type !== 'company' && r.company_id ? ` — ${companies.find(c => c.id === r.company_id)?.name || ''}` : ''}</option>
                ))}
              </select>
            )}
            <Mono>{subj.type === 'internal' ? 'No customer behind it: ours to run' : 'The project takes its customer from this record'}</Mono>
            {err && <span className="text-[12px]" style={{ color: 'rgb(var(--c-coral-deep))' }}>{err}</span>}
          </div>
        </form>
      )}

      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-6">
        {loading && <SkeletonList rows={5} />}
        {!loading && projects.length === 0 && (
          <EmptyState title="No projects yet" body="Start one, or apply a template to an onboarding and it will appear here." primary={canWrite ? 'New project' : null} onPrimary={() => setShowCreate(true)} secondary="Templates" onSecondary={() => onNavigate?.('project_templates')} />
        )}
        {!loading && projects.length > 0 && filtered.length === 0 && (
          <EmptyState title="No projects match" body={`${filtered.length === 0 && behindOnly ? 'Nothing is behind schedule. ' : ''}${projects.length} project${projects.length === 1 ? '' : 's'} hidden by these filters.`}
            secondary="Clear filters" onSecondary={() => { setSearch(''); setBehindOnly(false); setOwner(''); setStatus('active'); }} />
        )}

        {!loading && filtered.length > 0 && effView === 'table' && (
          <Card>
            {groups.map(g => {
              const hidden = !!collapsed[g.key];
              const limit = expanded[g.key] ? g.list.length : 6;
              return (
                <div key={g.key}>
                  <div className="px-[18px] py-3 flex items-center gap-2.5 border-b" style={{ ...hair, background: 'var(--panel-bg)' }}>
                    <button onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))} className="text-[11px] text-dim">{hidden ? '▸' : '▾'}</button>
                    <span className="text-[14px] font-bold text-paper truncate">{g.label}</span>
                    {g.tpl ? <Tag>template{g.taskCount ? ` · ${g.taskCount} tasks` : ''}</Tag> : g.key === '__none' && groupBy === 'template' ? <Tag>no template</Tag> : null}
                    <Mono tone="muted">{g.list.length} live{g.list.length === 1 && g.key === '__none' ? ` · ${g.list[0].name}` : ''}</Mono>
                    {g.behind > 0 && <Mono tone="coral" bold>{g.behind} behind{g.sameDue ? ` · all due ${fmtShort(g.sameDue)}` : ''}</Mono>}
                  </div>
                  {!hidden && (
                    <>
                      <div className={`${COLS} px-[18px] py-2.5 border-b font-mono text-[9px] font-bold tracking-[.18em] uppercase text-dim`} style={{ ...hair, ...colStyle }}>
                        <div>Customer</div><div>Progress</div><div>Next up</div><div>Go live</div><div />
                      </div>
                      {g.list.slice(0, limit).map(p => {
                        const s = stats[p.id]; const cust = customerOf(p);
                        const gl = p.due_date ? dueLabel(p.due_date, p.status === 'completed' ? 'done' : 'todo') : null;
                        const late = gl?.tone === 'coral';
                        return (
                          <div key={p.id} onClick={() => onSelect(p.id)} className={`${COLS} px-[18px] py-3 border-b cursor-pointer hover:bg-card/60`}
                            style={{ ...hair, ...colStyle, borderLeft: s.behind ? '3px solid rgb(var(--c-coral))' : '3px solid transparent' }}>
                            <div className="min-w-0">
                              <div className="text-[14px] font-semibold text-paper truncate">{cust.name || p.name}</div>
                              <div className="text-[11px] text-dim truncate">{cust.company || (cust.name ? p.name : `Internal${nameOf(p.owner_id) ? ` · owner ${nameOf(p.owner_id)}` : ''}`)}</div>
                            </div>
                            <div className="flex items-center gap-[9px]">
                              <div className="flex-1 h-[7px] rounded-full overflow-hidden" style={{ background: 'var(--ink-soft)' }}>
                                <div className="h-full" style={{ width: `${s.total ? (s.done / s.total) * 100 : 0}%`, background: 'rgb(var(--c-primary))' }} />
                              </div>
                              <Mono tone="muted">{s.done}/{s.total}</Mono>
                            </div>
                            <div className="text-[12px] truncate" style={{ color: s.behind ? 'rgb(var(--c-coral))' : 'rgb(var(--c-text-soft))' }}>
                              {s.next ? s.next.title : s.total ? 'All done' : 'No tasks'}
                            </div>
                            <Mono tone={late ? 'coral' : 'muted'} bold={late}>{gl ? (late ? `-${gl.text.replace(/ days? late/, '')} days` : fmtShort(p.due_date)) : '—'}</Mono>
                            <Avatar id={p.owner_id} name={nameOf(p.owner_id)} />
                          </div>
                        );
                      })}
                      {g.list.length > 6 && !expanded[g.key] && (
                        <button onClick={() => setExpanded(e => ({ ...e, [g.key]: true }))} className="w-full text-left px-[18px] py-[11px] border-b font-mono text-[11px] text-dim hover:text-paper" style={hair}>+ {g.list.length - 6} more on this {g.tpl ? 'template' : 'group'}</button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </Card>
        )}

        {!loading && filtered.length > 0 && effView === 'cards' && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map(p => {
              const s = stats[p.id]; const cust = customerOf(p);
              const gl = p.due_date ? dueLabel(p.due_date, p.status === 'completed' ? 'done' : 'todo') : null;
              return (
                <Card key={p.id} onClick={() => onSelect(p.id)} className="p-4 hover:border-ember/30" coral={s.behind}>
                  <div className="flex items-start gap-2 mb-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-bold text-paper truncate">{p.name}</div>
                      {cust.name && <div className="text-[12px] text-muted truncate">{cust.name}{cust.company ? ` · ${cust.company}` : ''}</div>}
                    </div>
                    <Avatar id={p.owner_id} name={nameOf(p.owner_id)} />
                  </div>
                  {p.description && <div className="text-[12px] text-muted line-clamp-2 mb-2">{p.description}</div>}
                  <div className="flex items-center gap-[9px]">
                    <div className="flex-1 h-[7px] rounded-full overflow-hidden" style={{ background: 'var(--ink-soft)' }}>
                      <div className="h-full" style={{ width: `${s.total ? (s.done / s.total) * 100 : 0}%`, background: 'rgb(var(--c-primary))' }} />
                    </div>
                    <Mono tone="muted">{s.done}/{s.total}</Mono>
                    {gl && <Mono tone={gl.tone === 'coral' ? 'coral' : 'dim'} bold={gl.tone === 'coral'}>{gl.tone === 'coral' ? gl.text : fmtShort(p.due_date)}</Mono>}
                  </div>
                  {s.next && <div className="text-[12px] mt-2 truncate" style={{ color: s.behind ? 'rgb(var(--c-coral))' : 'rgb(var(--c-text-soft))' }}>Next: {s.next.title}</div>}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
