import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useStickyState } from '../../lib/stickyState';
import { weekColumns, monthColumns, rangeLabel, spanPercent, phaseSpans, addDays, dayKey } from '../../lib/planning';
import { PageTitle, Segmented, LabelledPill, Mono, SectionLabel, Card, SkeletonList, EmptyState, hair } from './ui.jsx';

// Screen 05 — phases across weeks. Read-mostly.
//
// A bar is derived, not stored: it spans the earliest start to the latest due
// date of the tasks in that phase, coral if any of them is overdue or blocked.
// A project with no phases draws one bar, so this screen works before anyone
// adopts phases. Nothing here creates tasks; clicking a bar opens the project.
// Dragging a bar's right edge moves the phase's latest due date, week by week.

const TONE = {
  primary: { bg: 'rgb(var(--c-primary))', fg: 'rgb(var(--c-ink))' },
  done:    { bg: 'rgb(var(--c-primary) / .35)', fg: 'rgb(var(--c-text))' },
  amber:   { bg: 'rgb(var(--c-amber))', fg: 'rgb(var(--c-ink))' },
  coral:   { bg: 'rgb(var(--c-coral))', fg: 'var(--on-accent)' },
  uv:      { bg: 'rgb(var(--c-uv))', fg: 'var(--on-accent)' },
  none:    { bg: 'var(--ink-strong)', fg: 'rgb(var(--c-muted))' },
};

export default function Timeline({ profile, onNavigate }) {
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [unit, setUnit] = useStickyState('timeline.unit', 'weeks');
  const [rows, setRows] = useStickyState('timeline.rows', 'project');
  const [offset, setOffset] = useState(0);
  const [rowsMenu, setRowsMenu] = useState(false);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);
  const load = async () => {
    const [p, t, m, c, l, d] = await Promise.all([
      supabase.from('crm_projects').select('*').eq('status', 'active').order('due_date', { ascending: true, nullsFirst: false }),
      supabase.from('tasks').select('id, title, project_id, phase, status, owner_id, due_date, start_date, created_at').is('parent_task_id', null),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
    ]);
    setProjects(p.data || []); setTasks(t.data || []); setMembers(m.data || []);
    setCompanies(c.data || []); setLocations(l.data || []); setDeals(d.data || []);
    setLoading(false);
  };

  const nameOf = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : ''; };
  const customerOf = (p) => {
    if (!p.subject_type || !p.subject_id) return null;
    if (p.subject_type === 'company') return companies.find(x => x.id === p.subject_id)?.name;
    if (p.subject_type === 'location') { const l = locations.find(x => x.id === p.subject_id); return companies.find(x => x.id === l?.company_id)?.name || l?.name; }
    if (p.subject_type === 'deal') { const dl = deals.find(x => x.id === p.subject_id); return companies.find(x => x.id === dl?.company_id)?.name || dl?.name; }
    return null;
  };

  const base = useMemo(() => { const d = new Date(); return unit === 'weeks' ? addDays(d, offset * 7 * 6) : new Date(d.getFullYear(), d.getMonth() + offset * 6, 1); }, [unit, offset]);
  const cols = useMemo(() => (unit === 'weeks' ? weekColumns(base, 6) : monthColumns(base, 6)), [unit, base]);
  const r0 = cols[0].start.getTime(), r1 = cols[cols.length - 1].end.getTime();

  // Rows: one per project (bars per phase), or one per person (bars per project).
  const lines = useMemo(() => {
    if (rows === 'assignee') {
      const people = [...members.map(m => ({ id: m.id, name: nameOf(m.id), sub: 'Assignee' })), { id: null, name: 'Unassigned', sub: 'Needs an owner' }];
      return people.map(person => {
        const mine = tasks.filter(t => t.owner_id === person.id && t.status !== 'done');
        const byProject = new Map();
        for (const t of mine) { const k = t.project_id || '__none'; if (!byProject.has(k)) byProject.set(k, []); byProject.get(k).push(t); }
        const spans = [...byProject.entries()].flatMap(([pid, ts]) => {
          const p = projects.find(x => x.id === pid) || { name: 'No project', phases: [] };
          return phaseSpans({ ...p, phases: [] }, ts).map(s => ({ ...s, name: p.name, label: s.blocked ? `${p.name} · ${s.blocked} blocked` : p.name, projectId: pid === '__none' ? null : pid }));
        });
        return { key: person.id || 'none', name: person.name, sub: person.sub, spans, projectId: null };
      }).filter(l => l.spans.length || l.key !== 'none');
    }
    return projects.map(p => ({
      key: p.id, name: p.name, sub: customerOf(p) || (p.owner_id ? `Owner ${nameOf(p.owner_id)}` : ''), projectId: p.id,
      spans: phaseSpans(p, tasks.filter(t => t.project_id === p.id)).map(s => ({ ...s, projectId: p.id })),
    }));
  }, [rows, projects, tasks, members, companies, locations, deals]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag the right edge to move the phase's latest due date, a whole week at a time.
  const trackRef = useRef(null);
  const drag = useRef(null);
  const onEdgeDown = (e, line, span) => {
    if (!canWrite || !span.projectId) return;
    e.preventDefault(); e.stopPropagation();
    drag.current = { line, span, x0: e.clientX, width: trackRef.current?.getBoundingClientRect().width || 800 };
    const move = () => {};
    const up = async (ev) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const d = drag.current; drag.current = null; if (!d) return;
      const dayPx = d.width / ((r1 - r0) / 86400000);
      const days = Math.round((ev.clientX - d.x0) / dayPx / 7) * 7;
      if (!days) return;
      const phaseName = d.span.name;
      const inPhase = tasks.filter(t => t.project_id === d.span.projectId && (projects.find(p => p.id === d.span.projectId)?.phases?.length ? (t.phase === phaseName || (phaseName === 'Unphased' && !t.phase)) : true) && t.due_date);
      if (!inPhase.length) return;
      const latest = inPhase.reduce((a, b) => (a.due_date > b.due_date ? a : b));
      const next = dayKey(addDays(new Date(latest.due_date + 'T00:00:00'), days));
      const { error } = await supabase.from('tasks').update({ due_date: next }).eq('id', latest.id);
      if (error) alert('Could not move the date: ' + error.message); else load();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene)' }}>
      <div className="px-6 pt-5 pb-[14px] flex items-center gap-[14px] flex-wrap">
        <PageTitle>Timeline</PageTitle>
        <Segmented value={unit} options={[['weeks', 'Weeks'], ['months', 'Months']]} onChange={(v) => { setUnit(v); setOffset(0); }} />
        <span className="relative">
          <LabelledPill label="Rows:" value={rows === 'assignee' ? 'Assignee' : 'Project'} onClick={() => setRowsMenu(v => !v)} />
          {rowsMenu && (
            <div className="absolute left-0 top-full mt-1 z-40 min-w-[140px] menu-surface rounded-[10px] py-1" onMouseLeave={() => setRowsMenu(false)}>
              {[['project', 'Project'], ['assignee', 'Assignee']].map(([k, l]) => <button key={k} onClick={() => { setRows(k); setRowsMenu(false); }} className={`w-full px-3 py-2 text-left text-[13px] text-paper hover:bg-ember/10 ${rows === k ? 'font-semibold' : ''}`}>{l}</button>)}
            </div>
          )}
        </span>
        <div className="flex gap-1.5 items-center">
          <button onClick={() => setOffset(o => o - 1)} className="px-[11px] py-1.5 rounded-[9px] border text-[13px]" style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }}>←</button>
          <button onClick={() => setOffset(o => o + 1)} className="px-[11px] py-1.5 rounded-[9px] border text-[13px]" style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }}>→</button>
          {offset !== 0 && <button onClick={() => setOffset(0)} className="px-[13px] py-1.5 rounded-[9px] border text-[13px]" style={{ background: 'var(--panel-bg)', borderColor: 'var(--bdr)' }}>Now</button>}
        </div>
        <Mono>{rangeLabel(cols)}</Mono>
      </div>

      <div className="flex-1 overflow-hidden px-6 pb-6">
        {loading ? <SkeletonList rows={4} /> : lines.length === 0 ? (
          <EmptyState title="Nothing scheduled" body="Active projects with dated tasks draw here. Add a due date to a task and its phase appears as a bar." />
        ) : (
          <Card className="h-full flex flex-col">
            <div className="grid border-b overflow-hidden" style={{ gridTemplateColumns: `250px repeat(${cols.length}, minmax(0,1fr))`, borderColor: 'var(--ink-line)' }}>
              <div className="px-4 py-2.5"><SectionLabel>{rows === 'assignee' ? 'Person' : 'Project'}</SectionLabel></div>
              {cols.map((c, i) => (
                <div key={i} className="px-2 py-2.5 border-l font-mono text-[10px]" style={{ ...hair, color: c.now ? 'rgb(var(--c-primary-deep))' : 'rgb(var(--c-dim))', fontWeight: c.now ? 700 : 400 }}>
                  {c.label}{c.now ? ' · now' : ''}
                </div>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto">
              {lines.map((line, li) => (
                <div key={line.key} className={`grid ${li < lines.length - 1 ? 'border-b' : ''}`} style={{ gridTemplateColumns: '250px minmax(0,1fr)', ...hair }}>
                  <div className="px-4 py-[14px] min-w-0 cursor-pointer" onClick={() => line.projectId && onNavigate?.('project', line.projectId)}>
                    <div className="text-[14px] font-semibold text-paper truncate">{line.name}</div>
                    <div className="text-[11px] text-dim truncate">{line.sub}</div>
                  </div>
                  <div ref={li === 0 ? trackRef : undefined} className="relative border-l" style={{ ...hair, minHeight: 24 + 32, padding: '16px 0' }}>
                    {/* Column guides */}
                    {cols.slice(1).map((c, i) => <span key={i} className="absolute top-0 bottom-0 border-l" style={{ left: `${((i + 1) / cols.length) * 100}%`, borderColor: 'var(--ink-soft)' }} />)}
                    {(() => {
                      const placed = line.spans.map(s => ({ s, pos: spanPercent(s.start.getTime(), s.end.getTime(), r0, r1) })).filter(x => x.pos);
                      // Stack bars that overlap so nothing hides behind another.
                      const lanes = [];
                      for (const x of placed) { let lane = 0; while (lanes[lane]?.some(o => !(x.pos.left >= o.pos.left + o.pos.width || o.pos.left >= x.pos.left + x.pos.width))) lane++; (lanes[lane] ||= []).push(x); x.lane = lane; }
                      return placed.map(({ s, pos, lane }, i) => {
                        const t = TONE[s.tone] || TONE.none;
                        return (
                          <div key={i} title={`${s.label}${s.count ? ` · ${s.done}/${s.count} done` : ''}`}
                            onClick={() => s.projectId && onNavigate?.('project', s.projectId)}
                            className="absolute h-6 rounded-[7px] text-[11px] font-semibold flex items-center px-[9px] truncate cursor-pointer select-none"
                            style={{ left: `${pos.left}%`, width: `calc(${pos.width}% - 4px)`, top: 16 + lane * 30, background: t.bg, color: t.fg, boxSizing: 'border-box', marginLeft: 2 }}>
                            <span className="truncate flex-1">{s.label}</span>
                            {canWrite && s.projectId && <span onPointerDown={(e) => onEdgeDown(e, line, s)} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize" title="Drag to move the phase end" />}
                          </div>
                        );
                      });
                    })()}
                    {line.spans.length > 1 && <div style={{ height: (Math.max(0, line.spans.length - 1)) * 0 }} />}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
