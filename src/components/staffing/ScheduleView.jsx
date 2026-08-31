import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { ChevronLeft, ChevronRight, Users, LayoutGrid, Send, Plus, Trash2, X } from 'lucide-react';
import { isoDate, mondayOf, weekDays, DOW_SHORT, fmtRange, shiftHours, timeOffOnDate, isAssignable } from '../../lib/staffing';
import ClockCard from './ClockCard.jsx';

export default function ScheduleView({ profile }) {
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [mode, setMode] = useState('staff'); // 'staff' | 'area'
  const [deptFilter, setDeptFilter] = useState('all');
  const [areaFilter, setAreaFilter] = useState('all');
  const [staff, setStaff] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [areas, setAreas] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [timeOff, setTimeOff] = useState([]);
  const [editShift, setEditShift] = useState(null); // {id?, user_id, date, start_time, finish_time, area_id}
  const [showPublish, setShowPublish] = useState(false);
  const [loading, setLoading] = useState(true);

  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const days = weekDays(monday);
  const weekStart = isoDate(days[0]);
  const weekEnd = isoDate(days[6]);
  const todayIso = isoDate(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    const [p, d, a, s, t] = await Promise.all([
      supabase.from('profiles').select('id, display_name, email, mobile, department_id, coverable_area_ids, default_weekly_hours').order('display_name'),
      supabase.from('departments').select('*').order('name'),
      supabase.from('areas').select('*').order('name'),
      supabase.from('shifts').select('*').gte('date', weekStart).lte('date', weekEnd),
      supabase.from('time_off').select('*').eq('status', 'approved').lte('start_date', weekEnd).gte('end_date', weekStart),
    ]);
    setStaff(p.data || []); setDepartments(d.data || []); setAreas(a.data || []);
    setShifts(s.data || []); setTimeOff(t.data || []);
    setLoading(false);
  }, [weekStart, weekEnd]);

  useEffect(() => { load(); }, [load]);

  const areaById = (id) => areas.find(a => a.id === id);
  const shiftsFor = (userId, iso) => shifts.filter(s =>
    s.user_id === userId && s.date === iso && (areaFilter === 'all' || s.area_id === areaFilter));
  const hasDraft = shifts.some(s => s.status === 'draft');

  const saveShift = async (data) => {
    const row = { user_id: data.user_id, date: data.date, start_time: data.start_time, finish_time: data.finish_time, area_id: data.area_id || null, status: 'draft', updated_at: new Date().toISOString() };
    if (data.id) await supabase.from('shifts').update(row).eq('id', data.id);
    else await supabase.from('shifts').insert(row);
    setEditShift(null); load();
  };
  const deleteShift = async (id) => { await supabase.from('shifts').delete().eq('id', id); setEditShift(null); load(); };

  const moveShift = async (id, userId, iso) => {
    await supabase.from('shifts').update({ user_id: userId, date: iso, status: 'draft', updated_at: new Date().toISOString() }).eq('id', id);
    load();
  };

  const filteredDepts = deptFilter === 'all' ? departments : departments.filter(d => d.id === deptFilter);
  const staffByDept = (deptId) => staff.filter(s => s.department_id === deptId);
  const unassigned = staff.filter(s => !s.department_id);
  const filteredAreas = areaFilter === 'all' ? areas : areas.filter(a => a.id === areaFilter);

  const input = "px-2.5 py-1.5 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 lg:px-6 pt-4">
        <ClockCard profile={profile} />
      </div>

      {/* Toolbar */}
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          <button onClick={() => setMonday(m => { const x = new Date(m); x.setDate(x.getDate() - 7); return x; })} className="btn-ghost p-2 rounded-xl"><ChevronLeft size={16} /></button>
          <button onClick={() => setMonday(mondayOf(new Date()))} className="px-3 py-1.5 rounded-xl text-sm btn-ghost">This week</button>
          <button onClick={() => setMonday(m => { const x = new Date(m); x.setDate(x.getDate() + 7); return x; })} className="btn-ghost p-2 rounded-xl"><ChevronRight size={16} /></button>
        </div>
        <div className="text-sm font-bold text-paper">{fmtRange(monday)}</div>
        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg ${hasDraft ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
          {hasDraft ? 'Draft' : 'Published'}
        </span>

        <select className={input} value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
          <option value="all">All departments</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className={input} value={areaFilter} onChange={e => setAreaFilter(e.target.value)}>
          <option value="all">All areas</option>
          {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>

        <div className="flex items-center gap-0.5 bg-card rounded-xl p-0.5 ml-auto">
          <button onClick={() => setMode('staff')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold ${mode === 'staff' ? 'bg-ember text-white' : 'text-muted'}`}><Users size={14} /> By staff</button>
          <button onClick={() => setMode('area')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold ${mode === 'area' ? 'bg-ember text-white' : 'text-muted'}`}><LayoutGrid size={14} /> By area</button>
        </div>
        {canWrite && (
          <button onClick={() => setShowPublish(true)} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Send size={14} /> Publish rota</button>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? <div className="text-center text-dim text-sm py-10">Loading…</div> : (
          <div className="min-w-[900px]">
            {/* Header row */}
            <div className="grid items-stretch" style={{ gridTemplateColumns: '200px repeat(7, 1fr)' }}>
              <div className="px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">{mode === 'staff' ? 'Staff' : 'Area'}</div>
              {days.map((d, i) => (
                <div key={i} className={`px-2 py-2 text-center border-l border-bdr ${isoDate(d) === todayIso ? 'bg-ember/10 rounded-t-xl' : ''}`}>
                  <div className="text-[10px] font-mono font-bold uppercase text-dim">{DOW_SHORT[i]}</div>
                  <div className={`text-sm font-bold ${isoDate(d) === todayIso ? 'text-ember-deep' : 'text-paper'}`}>{d.getDate()}</div>
                </div>
              ))}
            </div>

            {mode === 'staff'
              ? <StaffMode {...{ filteredDepts, staffByDept, unassigned, days, todayIso, shiftsFor, areaById, timeOff, canWrite, setEditShift, moveShift, monday }} />
              : <AreaMode {...{ filteredAreas, days, todayIso, shifts, areaFilter, staff, canWrite, setEditShift }} />}
          </div>
        )}
      </div>

      {editShift && (
        <ShiftModal shift={editShift} areas={areas} staff={staff} onSave={saveShift} onDelete={deleteShift} onClose={() => setEditShift(null)} />
      )}
      {showPublish && (
        <PublishModal profile={profile} monday={monday} days={days} shifts={shifts} staff={staff} areas={areas}
          onClose={() => setShowPublish(false)} onDone={() => { setShowPublish(false); load(); }} />
      )}
    </div>
  );
}

// ── View A: by staff ────────────────────────────────────────────────────────
function StaffMode({ filteredDepts, staffByDept, unassigned, days, todayIso, shiftsFor, areaById, timeOff, canWrite, setEditShift, moveShift }) {
  const groups = [...filteredDepts.map(d => ({ dept: d, people: staffByDept(d.id) }))];
  if (unassigned.length && filteredDepts.length === 0) { /* nothing */ }
  const showUnassigned = unassigned.length > 0;

  const headcount = days.map(d => {
    const iso = isoDate(d);
    const ids = new Set();
    [...filteredDepts.flatMap(dep => staffByDept(dep.id)), ...(showUnassigned ? unassigned : [])].forEach(p => {
      if (shiftsFor(p.id, iso).length) ids.add(p.id);
    });
    return ids.size;
  });

  return (
    <div>
      {groups.map(({ dept, people }) => (
        <div key={dept.id}>
          <DeptHeader dept={dept} count={people.length} />
          {people.length === 0 ? <div className="px-3 py-2 text-xs text-dim italic">No staff in this department</div>
            : people.map(p => <StaffRow key={p.id} {...{ p, days, todayIso, shiftsFor, areaById, timeOff, canWrite, setEditShift, moveShift }} />)}
        </div>
      ))}
      {showUnassigned && (
        <div>
          <div className="px-3 py-2 mt-2 text-[11px] font-bold text-muted">Unassigned</div>
          {unassigned.map(p => <StaffRow key={p.id} {...{ p, days, todayIso, shiftsFor, areaById, timeOff, canWrite, setEditShift, moveShift }} />)}
        </div>
      )}
      {/* Headcount footer */}
      <div className="grid mt-1 border-t border-bdr" style={{ gridTemplateColumns: '200px repeat(7, 1fr)' }}>
        <div className="px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">On shift</div>
        {headcount.map((n, i) => <div key={i} className="px-2 py-2 text-center border-l border-bdr text-sm font-bold text-paper">{n}</div>)}
      </div>
    </div>
  );
}

function DeptHeader({ dept, count }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 mt-2">
      <span className="w-2.5 h-2.5 rounded-full" style={{ background: dept.colour }} />
      <span className="text-[11px] font-bold text-paper uppercase tracking-wide">{dept.name}</span>
      <span className="text-[10px] text-dim font-mono">({count})</span>
    </div>
  );
}

function StaffRow({ p, days, todayIso, shiftsFor, areaById, timeOff, canWrite, setEditShift, moveShift }) {
  const weekHours = days.reduce((sum, d) => sum + shiftsFor(p.id, isoDate(d)).reduce((s, sh) => s + shiftHours(sh.start_time, sh.finish_time), 0), 0);
  const target = Number(p.default_weekly_hours || 0);
  return (
    <div className="grid items-stretch border-t border-bdr/60" style={{ gridTemplateColumns: '200px repeat(7, 1fr)' }}>
      <div className="px-3 py-2 flex items-center gap-2 min-w-0">
        <div className="w-7 h-7 rounded-full bg-ember/15 text-ember-deep text-[11px] font-bold flex items-center justify-center shrink-0">
          {(p.display_name || p.email || '?')[0].toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-paper truncate">{p.display_name || p.email?.split('@')[0]}</div>
          {/* Readable while you build: green on target, amber under, red over. */}
          <div className="text-[11px] font-semibold tabular-nums"
            style={{ color: !target ? 'var(--c-dim)' : weekHours > target ? '#dc2626' : weekHours < target ? '#b45309' : '#059669' }}>
            {Math.round(weekHours * 10) / 10}h{target ? ` / ${target}h` : ''}
          </div>
        </div>
      </div>
      {days.map((d, i) => {
        const iso = isoDate(d);
        const off = timeOffOnDate(timeOff, p.id, iso);
        const cellShifts = shiftsFor(p.id, iso);
        return (
          <div key={i}
            onDragOver={canWrite ? (e) => e.preventDefault() : undefined}
            onDrop={canWrite ? (e) => { const id = e.dataTransfer.getData('shiftId'); if (id) moveShift(id, p.id, iso); } : undefined}
            className={`px-1.5 py-1.5 border-l border-bdr min-h-[52px] group relative ${iso === todayIso ? 'bg-ember/5' : ''}`}>
            {off ? (
              <div className="h-full rounded-lg text-[10px] font-semibold flex items-center justify-center text-center px-1"
                style={{ background: `repeating-linear-gradient(45deg, ${off.type === 'sick' ? '#fca5a5' : '#fcd34d'}33, ${off.type === 'sick' ? '#fca5a5' : '#fcd34d'}33 5px, transparent 5px, transparent 10px)`, color: off.type === 'sick' ? '#b91c1c' : '#92400e' }}>
                {off.type === 'sick' ? 'Sick' : 'Holiday'}
              </div>
            ) : (
              <>
                {cellShifts.map(sh => {
                  const area = areaById(sh.area_id);
                  return (
                    <div key={sh.id} draggable={canWrite}
                      onDragStart={(e) => e.dataTransfer.setData('shiftId', sh.id)}
                      onClick={() => canWrite && setEditShift({ ...sh })}
                      className="mb-1 px-2 py-1 rounded-lg text-[11px] cursor-pointer border-l-[3px]"
                      style={{ background: (area?.colour || '#94a3b8') + '1f', borderColor: area?.colour || '#94a3b8' }}>
                      <div className="font-semibold text-paper">{sh.start_time}–{sh.finish_time}</div>
                      {area && <div className="text-[10px]" style={{ color: area.colour }}>{area.name}</div>}
                      {sh.status === 'draft' && <div className="text-[9px] text-amber-600">draft</div>}
                    </div>
                  );
                })}
                {canWrite && cellShifts.length === 0 && (
                  <button onClick={() => setEditShift({ user_id: p.id, date: iso, start_time: '09:00', finish_time: '17:00', area_id: '' })}
                    className="opacity-0 group-hover:opacity-100 transition w-full h-full min-h-[40px] rounded-lg border-2 border-dashed border-bdr text-dim hover:border-ember hover:text-ember flex items-center justify-center">
                    <Plus size={16} />
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── View B: by area (coverage) ──────────────────────────────────────────────
function AreaMode({ filteredAreas, days, todayIso, shifts, staff, canWrite, setEditShift }) {
  const nameOf = (id) => { const p = staff.find(s => s.id === id); return p?.display_name || p?.email?.split('@')[0] || '?'; };
  return (
    <div>
      {filteredAreas.map(area => (
        <div key={area.id} className="grid items-stretch border-t border-bdr/60" style={{ gridTemplateColumns: '200px repeat(7, 1fr)' }}>
          <div className="px-3 py-2 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: area.colour }} />
            <div>
              <div className="text-sm text-paper">{area.name}</div>
              <div className="text-[10px] text-dim">need {area.required_per_day}/day</div>
            </div>
          </div>
          {days.map((d, i) => {
            const iso = isoDate(d);
            const covering = shifts.filter(s => s.area_id === area.id && s.date === iso);
            const covered = covering.length;
            const gap = area.required_per_day - covered;
            return (
              <div key={i} className={`px-1.5 py-1.5 border-l border-bdr min-h-[52px] ${iso === todayIso ? 'bg-ember/5' : ''}`}>
                <div className={`text-xs font-bold mb-1 ${covered >= area.required_per_day ? 'text-emerald-600' : 'text-paper'}`}>{covered}/{area.required_per_day}</div>
                {covering.map(s => (
                  <div key={s.id} onClick={() => canWrite && setEditShift({ ...s })}
                    className="text-[10px] text-muted truncate cursor-pointer hover:text-paper">{nameOf(s.user_id)} · {s.start_time}–{s.finish_time}</div>
                ))}
                {gap > 0 && (
                  <button onClick={() => canWrite && setEditShift({ user_id: '', date: iso, start_time: '09:00', finish_time: '17:00', area_id: area.id })}
                    className="mt-1 w-full text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-red-100 text-red-700 hover:bg-red-200">
                    Gap · need {gap}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Shift add/edit modal ────────────────────────────────────────────────────
function ShiftModal({ shift, areas, staff, onSave, onDelete, onClose }) {
  const [s, setS] = useState({ area_id: '', ...shift });
  const area = areas.find(a => a.id === s.area_id);
  const assignable = staff.filter(p => isAssignable(p, area));
  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }));
  const valid = s.user_id && s.start_time && s.finish_time;
  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
  return (
    <Modal onClose={onClose} title={s.id ? 'Edit shift' : 'Add shift'}>
      <div className="space-y-3">
        <div><label className={label}>Staff member</label>
          <select className={input} value={s.user_id || ''} onChange={e => set('user_id', e.target.value)}>
            <option value="">Select…</option>
            {assignable.map(p => <option key={p.id} value={p.id}>{p.display_name || p.email}</option>)}
          </select></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Start</label><input type="time" className={input} value={s.start_time || ''} onChange={e => set('start_time', e.target.value)} /></div>
          <div><label className={label}>Finish</label><input type="time" className={input} value={s.finish_time || ''} onChange={e => set('finish_time', e.target.value)} /></div>
        </div>
        <div><label className={label}>Area (optional)</label>
          <select className={input} value={s.area_id || ''} onChange={e => set('area_id', e.target.value)}>
            <option value="">No area</option>
            {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></div>
        <div className="flex items-center gap-2 pt-1">
          <button disabled={!valid} onClick={() => onSave(s)} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">Save</button>
          <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
          {s.id && <button onClick={() => onDelete(s.id)} className="ml-auto text-red-600 hover:bg-red-50 p-2 rounded-xl"><Trash2 size={16} /></button>}
        </div>
      </div>
    </Modal>
  );
}

// ── Publish + SMS modal ─────────────────────────────────────────────────────
function PublishModal({ profile, monday, days, shifts, staff, areas, onClose, onDone }) {
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const areaName = (id) => areas.find(a => a.id === id)?.name;
  const nameOf = (id) => { const p = staff.find(s => s.id === id); return p?.display_name || p?.email?.split('@')[0] || '?'; };
  const dayLabel = (iso) => { const d = new Date(iso + 'T00:00:00'); return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); };

  // recipients = staff with ≥1 shift this week (optionally only those with a draft)
  const userIds = [...new Set(shifts.map(s => s.user_id))];
  const recipients = userIds.map(uid => {
    const mine = shifts.filter(s => s.user_id === uid).sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
    const hasDraft = mine.some(s => s.status === 'draft');
    const p = staff.find(s => s.id === uid);
    const token = (uid.slice(0, 8));
    const lines = mine.map(s => `${dayLabel(s.date)} ${s.start_time}-${s.finish_time}${s.area_id ? ' ' + areaName(s.area_id) : ''}`);
    const body = `Hi ${nameOf(uid)}, your shifts for the week of ${monday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}:\n${lines.join('\n')}\nConfirm: crm.co/r/${token}`;
    return { uid, name: nameOf(uid), mobile: p?.mobile || null, count: mine.length, hasDraft, body };
  });
  const toSend = recipients.filter(r => (!onlyChanged || r.hasDraft));
  const withMobile = toSend.filter(r => r.mobile);
  const noMobile = toSend.filter(r => !r.mobile);
  const areasCovered = [...new Set(shifts.map(s => s.area_id).filter(Boolean))].map(areaName);

  const publish = async () => {
    setSending(true);
    try {
      // 1. mark shifts published (the ones being announced)
      const ids = shifts.filter(s => (!onlyChanged || s.status === 'draft')).map(s => s.id);
      if (ids.length) await supabase.from('shifts').update({ status: 'published', updated_at: new Date().toISOString() }).in('id', ids);
      // 2. send SMS via the roster-sms provider stub
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/roster-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ messages: withMobile.map(r => ({ to: r.mobile, body: r.body, name: r.name })) }),
      });
      const d = await res.json().catch(() => ({}));
      setResult({ sent: d.sent ?? withMobile.length, skipped: noMobile.length, error: res.ok ? null : (d.error || 'SMS gateway error') });
    } catch (e) {
      setResult({ sent: 0, skipped: noMobile.length, error: e.message });
    }
    setSending(false);
  };

  return (
    <Modal onClose={onClose} title="Publish rota" wide>
      {result ? (
        <div className="space-y-3 text-sm">
          <div className="text-paper">{result.error ? '⚠️ Published with issues' : '✅ Rota published'}</div>
          <div className="text-muted">{result.sent} SMS sent{result.skipped ? `, ${result.skipped} skipped (no mobile)` : ''}.</div>
          {result.error && <div className="text-red-600 text-xs">{result.error}</div>}
          <button onClick={onDone} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Done</button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat n={shifts.length} label="shifts" />
            <Stat n={recipients.length} label="staff" />
            <Stat n={areasCovered.length} label="areas covered" />
          </div>

          <label className="flex items-center gap-2 cursor-pointer text-sm text-paper">
            <input type="checkbox" checked={onlyChanged} onChange={e => setOnlyChanged(e.target.checked)} className="accent-ember" />
            Only text staff whose shifts changed since last publish
          </label>

          <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim">Recipients (SMS)</div>
          <div className="max-h-72 overflow-y-auto space-y-2">
            {toSend.map(r => (
              <div key={r.uid} className="glass-inner rounded-xl p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-paper">{r.name}</span>
                  {r.mobile ? <span className="text-xs text-muted font-mono">{r.mobile}</span>
                    : <span className="text-[10px] font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded">No mobile — skipped</span>}
                  <span className="text-[10px] text-dim ml-auto">{r.count} shift{r.count !== 1 ? 's' : ''}</span>
                </div>
                <div className="text-[11px] text-muted whitespace-pre-wrap leading-relaxed">{r.body}</div>
              </div>
            ))}
            {toSend.length === 0 && <div className="text-sm text-dim italic">No recipients{onlyChanged ? ' with changes' : ''}.</div>}
          </div>

          <div className="flex items-center gap-2">
            <button disabled={sending} onClick={publish} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5">
              <Send size={14} /> {sending ? 'Publishing…' : `Publish & text ${withMobile.length}`}
            </button>
            <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Stat({ n, label }) {
  return <div className="glass-inner rounded-xl p-3 text-center"><div className="text-2xl font-bold text-paper">{n}</div><div className="text-[11px] text-muted">{label}</div></div>;
}

function Modal({ title, children, onClose, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`glass-card rounded-2xl w-full ${wide ? 'max-w-lg' : 'max-w-sm'}`} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between">
          <div className="text-base font-bold text-paper">{title}</div>
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
