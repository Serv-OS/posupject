import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';

const STATUS_BADGE = {
  active: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  completed: 'bg-blue-100 text-blue-700 border border-blue-200',
  cancelled: 'bg-red-100 text-red-700 border border-red-200',
};

const SUBJECT_LABELS = {
  company: 'Company', location: 'Location', deal: 'Deal',
  onboarding: 'Onboarding', ticket: 'Ticket',
};

export default function ProjectList({ profile, onSelect }) {
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deals, setDeals] = useState([]);
  const [onboardings, setOnboardings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const [p, t, m, c, l, d, ob] = await Promise.all([
      supabase.from('crm_projects').select('*').order('created_at', { ascending: false }),
      supabase.from('tasks').select('id, project_id, status'),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('companies').select('id, name'),
      supabase.from('locations').select('id, name, company_id'),
      supabase.from('deals').select('id, name, company_id'),
      supabase.from('onboardings').select('id, company_id, deal_id, location_id'),
    ]);
    setProjects(p.data || []);
    setTasks(t.data || []);
    setMembers(m.data || []);
    setCompanies(c.data || []);
    setLocations(l.data || []);
    setDeals(d.data || []);
    setOnboardings(ob.data || []);
    setLoading(false);
  };

  const filtered = useMemo(() => {
    if (filter === 'all') return projects;
    return projects.filter(p => p.status === filter);
  }, [projects, filter]);

  const taskStats = (projectId) => {
    const pt = tasks.filter(t => t.project_id === projectId);
    const done = pt.filter(t => t.status === 'done').length;
    const blocked = pt.filter(t => t.status === 'blocked').length;
    const inProgress = pt.filter(t => t.status === 'in_progress').length;
    return { total: pt.length, done, blocked, inProgress, open: pt.length - done };
  };

  const ownerName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : '';
  };

  // Resolve linked record name
  const getLinkedInfo = (project) => {
    if (!project.subject_type || !project.subject_id) return null;
    let recordName = '';
    let companyName = '';

    if (project.subject_type === 'company') {
      const c = companies.find(x => x.id === project.subject_id);
      recordName = c?.name || '';
      companyName = recordName;
    } else if (project.subject_type === 'location') {
      const l = locations.find(x => x.id === project.subject_id);
      recordName = l?.name || '';
      const c = companies.find(x => x.id === l?.company_id);
      companyName = c?.name || '';
    } else if (project.subject_type === 'deal') {
      const d = deals.find(x => x.id === project.subject_id);
      recordName = d?.name || '';
      const c = companies.find(x => x.id === d?.company_id);
      companyName = c?.name || '';
    } else if (project.subject_type === 'onboarding') {
      // Show the venue the job is for: install location, else deal, else company.
      const o = onboardings.find(x => x.id === project.subject_id);
      const loc = locations.find(x => x.id === o?.location_id);
      const dl = deals.find(x => x.id === o?.deal_id);
      recordName = loc?.name || dl?.name || companies.find(x => x.id === o?.company_id)?.name || '';
      const c = companies.find(x => x.id === (o?.company_id || dl?.company_id || loc?.company_id));
      companyName = c?.name || '';
    } else {
      recordName = project.subject_id?.slice(0, 8) || '';
    }

    if (!recordName && !companyName) return null;
    return {
      type: SUBJECT_LABELS[project.subject_type] || project.subject_type,
      name: recordName,
      company: companyName,
    };
  };

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    const { data } = await supabase.from('crm_projects').insert({
      name: name.trim(),
      description: description.trim() || null,
      owner_id: profile.id,
    }).select().single();
    setName(''); setDescription(''); setShowCreate(false);
    if (data) onSelect(data.id);
    else load();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-bdr flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-paper">Projects</div>
          <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
            {projects.filter(p => p.status === 'active').length} active / {projects.length} total
          </div>
        </div>
        {canWrite && (
          <button onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 bg-ember text-white text-sm font-semibold rounded hover:bg-ember-deep transition">
            + New project
          </button>
        )}
      </div>

      <div className="px-6 py-3 border-b border-bdr flex gap-2">
        {['active', 'completed', 'cancelled', 'all'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 py-1.5 text-xs rounded-xl transition ${filter === s ? 'bg-card text-paper font-medium' : 'text-muted hover:text-paper'}`}>
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {showCreate && (
        <div className="px-6 py-3 border-b border-bdr max-h-[70vh] overflow-y-auto">
          <form onSubmit={create} className="space-y-2">
            <input className={input} value={name} onChange={e => setName(e.target.value)}
              placeholder="Project name" autoFocus />
            <textarea className={input + ' resize-none'} rows={2} value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What is this project about? Describe the scope and objectives..." />
            <div className="flex gap-2">
              <button type="submit" className="px-4 py-2 bg-ember text-white text-sm font-semibold rounded shrink-0">Create</button>
              <button type="button" onClick={() => setShowCreate(false)}
                className="px-3 py-2 text-sm text-muted border border-bdr rounded shrink-0">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl space-y-3">
          {loading && <div className="py-8 text-center text-dim text-sm">Loading...</div>}
          {!loading && filtered.map(p => {
            const stats = taskStats(p.id);
            const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
            const linked = getLinkedInfo(p);

            return (
              <div key={p.id}
                onClick={() => onSelect(p.id)}
                className="glass-card rounded-2xl p-5 cursor-pointer hover:border-ember/30 transition">

                {/* Top row: name + status + owner */}
                <div className="flex items-start gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-semibold text-paper">{p.name}</div>
                    {p.description && <div className="text-xs text-muted mt-0.5 line-clamp-2">{p.description}</div>}
                  </div>
                  <span className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded shrink-0 ${STATUS_BADGE[p.status]}`}>{p.status}</span>
                </div>

                {/* Linked record + company */}
                {linked && (
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-ember/10 text-ember-deep border border-ember/20">
                      <span className="font-medium">{linked.type}:</span> {linked.name}
                    </span>
                    {linked.company && linked.type !== 'Company' && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-slate-100 text-slate-600 border border-slate-200">
                        {'\u{1F3E2}'} {linked.company}
                      </span>
                    )}
                  </div>
                )}

                {/* Owner + dates */}
                <div className="flex items-center gap-4 mb-3 text-xs text-muted">
                  {p.owner_id && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded-full bg-ember text-white text-[9px] font-bold flex items-center justify-center">
                        {ownerName(p.owner_id)[0]?.toUpperCase() || '?'}
                      </span>
                      {ownerName(p.owner_id)}
                    </span>
                  )}
                  {p.due_date && (
                    <span className={new Date(p.due_date) < new Date() && p.status === 'active' ? 'text-red-600 font-medium' : ''}>
                      Due {new Date(p.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </span>
                  )}
                  <span>Created {new Date(p.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
                </div>

                {/* Task stats bar */}
                {stats.total > 0 ? (
                  <div>
                    <div className="flex items-center gap-3 mb-1.5">
                      <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-ember rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-muted font-mono w-20 text-right">{stats.done}/{stats.total} done</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px]">
                      {stats.open > 0 && <span className="text-blue-600">{stats.open} open</span>}
                      {stats.inProgress > 0 && <span className="text-orange-600">{stats.inProgress} in progress</span>}
                      {stats.blocked > 0 && <span className="text-red-600 font-bold">{stats.blocked} blocked</span>}
                      <span className="text-emerald-600">{stats.done} completed</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-dim italic">No tasks yet</div>
                )}
              </div>
            );
          })}
          {!loading && filtered.length === 0 && (
            <div className="py-8 text-center text-dim text-sm">No projects found.</div>
          )}
        </div>
      </div>
    </div>
  );
}
