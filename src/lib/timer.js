import { supabase } from './supabase';

// Time tracking helpers. A "running" timer is a time_entries row with
// ended_at IS NULL. At most one per user (enforced by a partial unique index).
// Components stay in sync via a window 'timer-changed' event.

const notify = () => window.dispatchEvent(new Event('timer-changed'));

// Resolve which customer (company/location) a subject belongs to, so the
// entry can be reported against a customer. Best-effort; returns {} on miss.
async function resolvePolymorphic(type, id) {
  try {
    if (type === 'company') return { company_id: id };
    if (type === 'location') {
      const { data } = await supabase.from('locations').select('company_id').eq('id', id).maybeSingle();
      return { company_id: data?.company_id || null, location_id: id };
    }
    if (type === 'deal') {
      const { data } = await supabase.from('deals').select('company_id').eq('id', id).maybeSingle();
      return { company_id: data?.company_id || null };
    }
    if (type === 'lead') {
      const { data } = await supabase.from('leads').select('company_id').eq('id', id).maybeSingle();
      return { company_id: data?.company_id || null };
    }
    if (type === 'contact') {
      const { data } = await supabase.from('contacts').select('company_id').eq('id', id).maybeSingle();
      return { company_id: data?.company_id || null };
    }
    if (type === 'onboarding') {
      const { data } = await supabase.from('onboardings').select('company_id, location_id').eq('id', id).maybeSingle();
      return { company_id: data?.company_id || null, location_id: data?.location_id || null };
    }
    if (type === 'ticket') {
      const { data } = await supabase.from('tickets').select('company_id').eq('id', id).maybeSingle();
      return { company_id: data?.company_id || null };
    }
  } catch { /* ignore */ }
  return {};
}

export async function resolveCustomer(subjectType, subjectId) {
  if (!subjectType || !subjectId) return {};
  try {
    if (subjectType === 'task') {
      const { data: t } = await supabase.from('tasks').select('subject_type, subject_id, project_id').eq('id', subjectId).maybeSingle();
      if (t?.subject_type && t?.subject_id) return resolvePolymorphic(t.subject_type, t.subject_id);
      if (t?.project_id) {
        const { data: p } = await supabase.from('crm_projects').select('subject_type, subject_id').eq('id', t.project_id).maybeSingle();
        if (p?.subject_type && p?.subject_id) return resolvePolymorphic(p.subject_type, p.subject_id);
      }
      return {};
    }
    if (subjectType === 'project') {
      const { data: p } = await supabase.from('crm_projects').select('subject_type, subject_id').eq('id', subjectId).maybeSingle();
      if (p?.subject_type && p?.subject_id) return resolvePolymorphic(p.subject_type, p.subject_id);
      return {};
    }
    return resolvePolymorphic(subjectType, subjectId);
  } catch {
    return {};
  }
}

// The user's currently-running entry, or null.
export async function getRunning(profileId) {
  const { data } = await supabase.from('time_entries')
    .select('*').eq('profile_id', profileId).is('ended_at', null)
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

// Start a timer on a subject. Stops any currently-running one first.
export async function startTimer({ subjectType, subjectId, label, profileId }) {
  await stopTimer(profileId); // one timer at a time
  const { company_id, location_id } = await resolveCustomer(subjectType, subjectId);
  const { data, error } = await supabase.from('time_entries').insert({
    profile_id: profileId,
    subject_type: subjectType || null,
    subject_id: subjectId || null,
    label: label || null,
    company_id: company_id || null,
    location_id: location_id || null,
    started_at: new Date().toISOString(),
  }).select().single();
  notify();
  if (error) throw error;
  return data;
}

// Stop the user's running timer (if any), writing duration_seconds.
export async function stopTimer(profileId) {
  const running = await getRunning(profileId);
  if (!running) return null;
  const ended = new Date();
  const seconds = Math.max(1, Math.round((ended.getTime() - new Date(running.started_at).getTime()) / 1000));
  const { data } = await supabase.from('time_entries')
    .update({ ended_at: ended.toISOString(), duration_seconds: seconds })
    .eq('id', running.id).select().single();
  notify();
  return data;
}

// "1h 23m" / "8m 04s"
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// "0:08:04" live clock for the running widget
export function fmtClock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
