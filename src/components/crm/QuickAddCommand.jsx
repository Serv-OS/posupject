import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../../lib/supabase';
import { parseQuickAdd, quickAddRow } from '../../lib/quickAdd';
import { Mono } from './ui.jsx';

// ⌘K — add a task, or search, from anywhere (screen 09).
//
// Three states of one field. Empty: New task (in the project you are looking
// at, if any), New project, and the last few things you opened. Typing: the
// parse shown as chips, with matching tasks and projects underneath so the
// same box jumps as well as creates. Confirmed: a toast with Open and Undo.
//
// One parser serves this and the inline row, deliberately — "@duncan" doing
// one thing in a list and another here is how people stop trusting both.

const CHIP = {
  owner: 'bg-uv/10 text-uv-deep border-uv/25', project: 'bg-ember/10 text-ember-deep border-ember/25',
  phase: 'bg-ember/5 text-ember-deep border-ember/20', priority: 'bg-amber/15 text-amber border-amber/30',
  due: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};

export default function QuickAddCommand({ profile, onNavigate, context }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [recent, setRecent] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); newProject(); return; }
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(v => !v); setDone(null); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Loaded on first open, not on mount: a command bar nobody opened must cost
  // nothing on the page it is sitting on.
  useEffect(() => {
    if (!open) return;
    Promise.all([
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('crm_projects').select('id, name, phases, updated_at').eq('status', 'active').order('updated_at', { ascending: false }),
      supabase.from('tasks').select('id, title, project_id, status, updated_at').neq('status', 'done').is('parent_task_id', null).order('updated_at', { ascending: false }).limit(200),
    ]).then(([m, p, t]) => {
      setMembers(m.data || []); setProjects(p.data || []); setTasks(t.data || []);
      setRecent([...(t.data || []).slice(0, 2).map(x => ({ kind: 'task', id: x.id, label: x.title })),
        ...(p.data || []).slice(0, 1).map(x => ({ kind: 'project', id: x.id, label: x.name }))]);
    });
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const presets = useMemo(() => (context?.projectId ? { project_id: context.projectId, phase: context.phase || null } : {}), [context]);
  const parsed = useMemo(() => parseQuickAdd(text, { members, projects, presets }), [text, members, projects, presets]);
  const currentProject = projects.find(p => p.id === (parsed.project_id || presets.project_id));

  const matches = useMemo(() => {
    const q = parsed.title.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return [
      ...tasks.filter(t => t.title.toLowerCase().includes(q)).slice(0, 4).map(t => ({ kind: 'task', id: t.id, label: t.title, sub: projects.find(p => p.id === t.project_id)?.name })),
      ...projects.filter(p => p.name.toLowerCase().includes(q)).slice(0, 3).map(p => ({ kind: 'project', id: p.id, label: p.name, sub: 'Project' })),
    ];
  }, [parsed.title, tasks, projects]);

  // Rows the arrow keys move through: create first, then jumps.
  const rows = useMemo(() => {
    if (!text.trim()) return [{ kind: 'create' }, { kind: 'newproject' }, ...recent.map(r => ({ ...r, recent: true }))];
    return [{ kind: 'create' }, ...matches];
  }, [text, recent, matches]);
  useEffect(() => { setSel(0); }, [text]);

  const create = async (openIt) => {
    if (!parsed.title.trim() || busy) return;
    setBusy(true);
    const { data, error } = await supabase.from('tasks').insert(quickAddRow(parsed, profile.id)).select('id, title').single();
    setBusy(false);
    if (error) { setDone({ error: error.message }); return; }
    setText('');
    if (openIt) { setOpen(false); onNavigate?.('task', data.id); return; }
    setDone({ id: data.id, title: data.title });
  };
  const newProject = async () => {
    const name = prompt('New internal project — name it (link a customer from the project’s Edit)');
    if (!name?.trim()) return;
    const { data, error } = await supabase.from('crm_projects').insert({ name: name.trim(), owner_id: profile.id }).select('id').single();
    if (error) { alert(error.message); return; }
    setOpen(false); onNavigate?.('project', data.id);
  };
  const undo = async () => { if (done?.id) await supabase.from('tasks').delete().eq('id', done.id); setDone(null); };
  const act = (row, shift) => {
    if (row.kind === 'create') return create(shift);
    if (row.kind === 'newproject') return newProject();
    setOpen(false); onNavigate?.(row.kind, row.id);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); act(rows[sel] || rows[0], e.shiftKey); }
  };

  if (!open) return null;
  const rowCls = (i) => `w-full text-left px-3 py-[9px] rounded-[10px] flex items-center gap-2.5 text-[14px] ${sel === i ? '' : 'hover:bg-ember/5'}`;
  const rowStyle = (i) => (sel === i ? { background: 'rgb(var(--c-primary) / .10)' } : undefined);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh] px-4 bg-black/40" onClick={() => setOpen(false)}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-[588px] rounded-[16px] overflow-hidden border" style={{ background: 'var(--raised-bg)', borderColor: 'var(--bdr)', boxShadow: 'var(--shadow-pop)' }}>
        <div className="px-[18px] py-4 border-b" style={{ borderColor: 'var(--hair)' }}>
          <input ref={inputRef} value={text} onChange={e => setText(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Add a task, or search…" className="w-full bg-transparent text-[16px] text-paper placeholder-dim focus:outline-none" />
        </div>

        {parsed.matched.length > 0 && (
          <div className="px-[18px] py-2 flex flex-wrap items-center gap-1.5 border-b" style={{ borderColor: 'var(--hair)' }}>
            {parsed.matched.map((m, i) => <span key={i} className={`px-2 py-0.5 rounded-lg text-[11px] font-medium border ${CHIP[m.type]}`}>{m.label}</span>)}
          </div>
        )}

        <div className="px-2 py-2.5">
          {rows.map((r, i) => (
            <button key={`${r.kind}-${r.id || i}`} onMouseEnter={() => setSel(i)} onClick={(e) => act(r, e.shiftKey)} className={rowCls(i)} style={rowStyle(i)}>
              {r.kind === 'create' ? (
                <>
                  <span className="font-semibold text-paper">{parsed.title.trim() ? `New task “${parsed.title.trim()}”` : 'New task'}</span>
                  {currentProject && <span className="text-muted">in {currentProject.name}</span>}
                  <Mono className="ml-auto">Enter</Mono>
                </>
              ) : r.kind === 'newproject' ? (
                <><span className="text-paper-soft">New project</span><Mono className="ml-auto">&#8984;&#8679;P</Mono></>
              ) : (
                <>
                  <span className="text-paper-soft truncate">{r.recent ? 'Recent — ' : ''}{r.label}</span>
                  {r.sub && <span className="text-[11px] text-dim truncate">{r.sub}</span>}
                  <Mono className="ml-auto">{r.kind === 'project' ? 'Project' : 'Open'}</Mono>
                </>
              )}
            </button>
          ))}
        </div>

        {done && (
          <div className="px-[18px] py-2.5 border-t flex items-center gap-3 text-[12px]" style={{ borderColor: 'var(--hair)' }}>
            {done.error ? <span className="flex-1" style={{ color: 'rgb(var(--c-coral-deep))' }}>{done.error}</span> : (
              <>
                <span className="text-paper flex-1 truncate">Added &ldquo;{done.title}&rdquo;</span>
                <button onClick={() => { setOpen(false); onNavigate?.('task', done.id); }} className="font-semibold" style={{ color: 'rgb(var(--c-primary-deep))' }}>Open</button>
                <button onClick={undo} className="text-muted hover:text-paper">Undo</button>
              </>
            )}
          </div>
        )}
        <div className="px-[18px] py-[11px] border-t" style={{ borderColor: 'var(--hair)' }}>
          <Mono>@ person &nbsp; # project &nbsp; ! priority &nbsp; dates in plain words &nbsp;·&nbsp; &#8679;Enter opens</Mono>
        </div>
      </div>
    </div>,
    document.body,
  );
}
