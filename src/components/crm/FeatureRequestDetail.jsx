import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import AssociationManager from './AssociationManager.jsx';

import { PRIORITY_LABEL, priorityLabel } from '../../lib/priority';
const STATUSES = ['new','under_review','planned','in_progress','shipped','declined'];
const STATUS_LABELS = { new:'New', under_review:'Under Review', planned:'Planned', in_progress:'In Progress', shipped:'Shipped', declined:'Declined' };
const STATUS_STYLES = {
  new:'bg-blue-100 text-blue-700 border border-blue-200', under_review:'bg-purple-100 text-purple-700 border border-purple-200',
  planned:'bg-orange-100 text-orange-700 border border-orange-200', in_progress:'bg-amber-100 text-amber-700 border border-amber-200',
  shipped:'bg-emerald-100 text-emerald-700 border border-emerald-200', declined:'bg-red-100 text-red-700 border border-red-200',
};

export default function FeatureRequestDetail({ requestId, profile, onClose, onNavigate }) {
  const [request, setRequest] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [members, setMembers] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [tab, setTab] = useState('overview');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, [requestId]);

  const load = async () => {
    const [r, c, m] = await Promise.all([
      supabase.from('feature_requests').select('*').eq('id', requestId).single(),
      supabase.from('contacts').select('id, first_name, last_name, email'),
      supabase.from('profiles').select('id, email, display_name'),
    ]);
    setRequest(r.data);
    setContacts(c.data || []);
    setMembers(m.data || []);
  };

  const startEdit = () => { setDraft({ ...request }); setEditing(true); };
  const save = async () => {
    const { id, created_at, updated_at, ...patch } = draft;
    const { error } = await supabase.from('feature_requests').update(patch).eq('id', requestId);
    if (error) { alert('Could not save: ' + error.message); return; }
    setEditing(false); load();
  };
  const set = (k, v) => setDraft({ ...draft, [k]: v });

  const changeStatus = async (s) => {
    await supabase.from('feature_requests').update({ status: s }).eq('id', requestId);
    load();
  };

  if (!request) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading...</div>;

  const contactName = (id) => {
    const c = contacts.find(x => x.id === id);
    return c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email : 'Unknown';
  };
  const ownerName = (id) => { const m = members.find(u => u.id === id); return m ? (m.display_name || m.email.split('@')[0]) : 'Unassigned'; };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
  const tabBtn = (t, lbl) => (
    <button onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded transition ${tab === t ? 'bg-card text-paper' : 'text-muted hover:text-paper'}`}>{lbl}</button>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3">
        <button onClick={onClose} className="text-muted hover:text-paper text-sm">&larr;</button>
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold text-paper truncate">{request.title}</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {priorityLabel(request.priority)} / {STATUS_LABELS[request.status]}
          </div>
        </div>
        <span className={`px-2 py-1 text-[10px] font-bold uppercase rounded ${STATUS_STYLES[request.status]}`}>{STATUS_LABELS[request.status]}</span>
        {canWrite && !editing && (
          <button onClick={startEdit} className="px-3 py-1.5 bg-card border border-bdr rounded text-xs text-muted hover:text-paper">Edit</button>
        )}
      </div>

      {canWrite && (
        <div className="px-6 py-2 border-b border-bdr flex gap-0.5 overflow-x-auto">
          {STATUSES.map((s, i) => {
            const isActive = request.status === s;
            const isPast = STATUSES.indexOf(request.status) > i;
            return (
              <button key={s} onClick={() => changeStatus(s)}
                className={`px-2 py-1 text-[9px] font-bold uppercase rounded transition whitespace-nowrap ${
                  isActive ? 'bg-ember text-ink' : isPast ? 'bg-ember/20 text-ember' : 'bg-card text-dim hover:text-paper'
                }`}>{STATUS_LABELS[s]}</button>
            );
          })}
        </div>
      )}

      <div className="px-6 py-2 border-b border-bdr flex gap-1">
        {tabBtn('overview', 'Overview')}
        {tabBtn('companies', 'Companies')}
        {tabBtn('deals', 'Deals')}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl">
          {tab === 'overview' && !editing && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Priority" value={priorityLabel(request.priority)} />
                <Field label="Status" value={STATUS_LABELS[request.status]} />
                <Field label="Requested by" value={contactName(request.requested_by)} />
                <Field label="Owner" value={ownerName(request.owner_id)} />
              </div>
              {request.description && (
                <div><div className={label}>Description</div><div className="text-sm text-paper whitespace-pre-wrap">{request.description}</div></div>
              )}
            </div>
          )}

          {tab === 'overview' && editing && (
            <div className="space-y-3">
              <div><label className={label}>Title</label><input className={input} value={draft.title || ''} onChange={e => set('title', e.target.value)} /></div>
              <div><label className={label}>Description</label><textarea className={input + ' resize-none'} rows={4} value={draft.description || ''} onChange={e => set('description', e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Status</label><select className={input} value={draft.status} onChange={e => set('status', e.target.value)}>
                  {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</select></div>
                <div><label className={label}>Priority</label><select className={input} value={draft.priority} onChange={e => set('priority', e.target.value)}>
                  <option value="P0">{PRIORITY_LABEL.P0}</option><option value="P1">{PRIORITY_LABEL.P1}</option><option value="P2">{PRIORITY_LABEL.P2}</option><option value="P3">{PRIORITY_LABEL.P3}</option></select></div>
                <div><label className={label}>Requested by</label><select className={input} value={draft.requested_by || ''} onChange={e => set('requested_by', e.target.value || null)}>
                  <option value="">None</option>
                  {contacts.map(c => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}</option>)}
                </select></div>
                <div><label className={label}>Owner</label><select className={input} value={draft.owner_id || ''} onChange={e => set('owner_id', e.target.value || null)}>
                  <option value="">Unassigned</option>
                  {members.map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}
                </select></div>
              </div>
              <div className="flex gap-2"><button onClick={save} className="px-4 py-2 bg-ember text-ink text-sm font-semibold rounded">Save</button>
                <button onClick={() => setEditing(false)} className="px-4 py-2 text-sm text-muted border border-bdr rounded">Cancel</button></div>
            </div>
          )}

          {tab === 'companies' && <AssociationManager subjectType="feature_request" subjectId={requestId} targetType="company" profile={profile} onNavigate={onNavigate} />}
          {tab === 'deals' && <AssociationManager subjectType="feature_request" subjectId={requestId} targetType="deal" profile={profile} onNavigate={onNavigate} />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (<div><div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-0.5">{label}</div>
    <div className="text-sm text-paper">{value || <span className="text-dim italic">--</span>}</div></div>);
}
