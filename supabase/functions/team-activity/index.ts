// team-activity — who is doing what in the CRM.
//
// Answers the questions an owner actually asks: when did each person last log
// in, when were they last on the app, what was the last thing they did, and on
// how many of the last 30 days did they do anything at all. That last number is
// the honest one — a single login proves nothing, a run of empty days is the
// thing you can put to someone.
//
// last_sign_in_at lives in auth.users, which the browser cannot read, so this
// runs service-role and is OWNER-GATED like admin-set-password.
//
// GET/POST body: { days?: number } (feed window, default 14)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));
const dayKey = (ts: string) => String(ts).slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const { data: { user: caller } } = await admin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!caller) return json({ error: 'Invalid token' }, 401);

    // Gate: this is people-monitoring data, so owners only.
    const { data: me } = await admin.from('profiles').select('role').eq('id', caller.id).maybeSingle();
    if (me?.role !== 'owner') return json({ error: 'Only owners can see team activity.' }, 403);

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const feedDays = Math.min(Math.max(Number(body?.days) || 14, 1), 90);
    const since30 = daysAgo(30);
    const since7 = daysAgo(7);
    const sinceFeed = daysAgo(feedDays);

    // ── The people ──────────────────────────────────────────────────────────
    const { data: profiles } = await admin.from('profiles')
      .select('id, email, display_name, role, teams, created_at').order('display_name');

    // auth.users holds the only real login record.
    const logins = new Map<string, { last_sign_in_at: string | null; created_at: string | null }>();
    try {
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      for (const u of list?.users || []) {
        logins.set(u.id, { last_sign_in_at: u.last_sign_in_at ?? null, created_at: u.created_at ?? null });
      }
    } catch (e) {
      console.error('listUsers failed:', (e as Error).message);
    }

    // agent_status is written by the phone bar's heartbeat — "app was open".
    // It has no migration in this repo, so never let its absence break the page.
    const seen = new Map<string, string>();
    try {
      const { data: st } = await admin.from('agent_status').select('profile_id, last_seen_at, status');
      for (const r of st || []) if (r.profile_id) seen.set(r.profile_id, r.last_seen_at);
    } catch { /* table may not exist on this instance */ }

    // ── What they did ───────────────────────────────────────────────────────
    // Two sources cover almost everything a person does here: activities they
    // logged (notes, emails, calls, SMS) and stages they moved.
    const [{ data: acts }, { data: stages }, { data: tasks }, { data: times }, { data: hands }] = await Promise.all([
      admin.from('crm_activities')
        .select('id, actor_id, type, subject, body, subject_type, subject_id, occurred_at, direction')
        .gte('occurred_at', since30).not('actor_id', 'is', null)
        .order('occurred_at', { ascending: false }).limit(4000),
      admin.from('stage_history')
        .select('id, changed_by, object_type, object_id, to_stage, changed_at')
        .gte('changed_at', since30).not('changed_by', 'is', null)
        .order('changed_at', { ascending: false }).limit(4000),
      admin.from('tasks')
        .select('id, owner_id, title, completed_at')
        .gte('completed_at', since30).not('completed_at', 'is', null)
        .order('completed_at', { ascending: false }).limit(1000),
      // Logging time IS work, and it was the biggest blind spot: on 1 Sep one
      // colleague had 15 actions and this function could see 5 of them, because
      // the other 10 were time entries. Someone doing a full day of site visits
      // and logging every one looked idle.
      admin.from('time_entries')
        .select('id, profile_id, label, created_at, duration_seconds')
        .gte('created_at', since30).not('profile_id', 'is', null)
        .order('created_at', { ascending: false }).limit(2000),
      admin.from('handovers')
        .select('id, author_id, title, created_at')
        .gte('created_at', since30).order('created_at', { ascending: false }).limit(200),
    ]);

    type Event = { at: string; who: string; what: string; kind: string };
    const events: Event[] = [];
    for (const a of acts || []) {
      const dir = a.direction === 'inbound' ? 'received' : 'sent';
      const label = a.type === 'note' ? 'Added a note'
        : a.type === 'call' ? 'Logged a call'
        : a.type === 'email' ? `Email ${dir}`
        : a.type === 'sms' ? `SMS ${dir}`
        : a.type === 'chat' ? 'Replied in chat'
        : `Logged ${a.type}`;
      const detail = (a.subject || String(a.body || '').slice(0, 60) || '').trim();
      events.push({
        at: a.occurred_at, who: a.actor_id!, kind: a.type,
        what: detail ? `${label} — ${detail}` : label,
      });
    }
    for (const s of stages || []) {
      events.push({
        at: s.changed_at, who: s.changed_by!, kind: 'stage',
        what: `Moved a ${s.object_type} to ${String(s.to_stage).replace(/_/g, ' ')}`,
      });
    }
    for (const t of tasks || []) {
      if (!t.owner_id) continue;
      events.push({ at: t.completed_at!, who: t.owner_id, kind: 'task', what: `Completed task — ${t.title}` });
    }
    for (const t of times || []) {
      const mins = Math.round((t.duration_seconds || 0) / 60);
      events.push({
        at: t.created_at, who: t.profile_id!, kind: 'time',
        what: `Logged ${mins ? `${mins}m` : 'time'}${t.label ? ` — ${t.label}` : ''}`,
      });
    }
    for (const h of hands || []) {
      if (!h.author_id) continue;
      events.push({ at: h.created_at, who: h.author_id, kind: 'handover', what: `Wrote a handover${h.title ? ` — ${h.title}` : ''}` });
    }
    events.sort((a, b) => (a.at < b.at ? 1 : -1));

    // Records raised, per person — the "produced something" signal that a
    // note-count alone misses.
    // Raising a record is an action. Only quotes and invoices record who
    // CREATED them; elsewhere owner_id is an ASSIGNMENT that can be changed
    // months later, so a record created today and assigned to someone is not
    // evidence that they did anything. Those are counted as events (with the
    // creation date) only where the column genuinely means authorship.
    const created: Record<string, number> = {};
    const countCreated = async (table: string, label: string, col = 'created_by') => {
      try {
        const { data } = await admin.from(table).select(`id, ${col}, created_at`)
          .gte('created_at', since30).not(col, 'is', null).limit(2000);
        for (const r of (data || []) as Record<string, string>[]) {
          const id = r[col];
          if (!id) continue;
          created[id] = (created[id] || 0) + 1;
          events.push({ at: r.created_at, who: id, kind: 'created', what: `Raised a ${label}` });
        }
      } catch { /* table absent on this instance */ }
    };
    await Promise.all([
      countCreated('quotes', 'quote'), countCreated('invoices', 'invoice'),
      // created_by was added on 1 Sep 2026 after a location ("VSC - Bali Cafe")
      // was created and the database recorded nobody. Rows older than that
      // migration have NULL and simply do not appear — better than guessing.
      countCreated('locations', 'site'), countCreated('companies', 'customer'),
      countCreated('contacts', 'contact'), countCreated('deals', 'deal'),
    ]);
    events.sort((a, b) => (a.at < b.at ? 1 : -1));

    const people = (profiles || []).map((p) => {
      const mine = events.filter((e) => e.who === p.id);
      const in7 = mine.filter((e) => e.at >= since7);
      const activeDays = new Set(mine.map((e) => dayKey(e.at)));
      const activeDays7 = new Set(in7.map((e) => dayKey(e.at)));
      const last = mine[0] || null;
      const auth = logins.get(p.id);
      return {
        id: p.id,
        name: p.display_name || (p.email || '').split('@')[0],
        email: p.email,
        role: p.role,
        teams: p.teams || [],
        last_login: auth?.last_sign_in_at || null,
        last_seen: seen.get(p.id) || null,
        last_action_at: last?.at || null,
        last_action: last?.what || null,
        actions_7d: in7.length,
        actions_30d: mine.length,
        // The number that actually answers "are they turning up": how many
        // separate days in the window they did anything at all.
        active_days_7d: activeDays7.size,
        active_days_30d: activeDays.size,
        created_30d: created[p.id] || 0,
      };
    });

    const feed = events
      .filter((e) => e.at >= sinceFeed)
      .slice(0, 300)
      .map((e) => ({
        at: e.at, who: e.who, kind: e.kind, what: e.what,
        who_name: people.find((p) => p.id === e.who)?.name || 'Unknown',
      }));

    return json({ people, feed, feed_days: feedDays, generated_at: iso(new Date()) });
  } catch (e) {
    console.error('team-activity failed:', e);
    return json({ error: (e as Error).message }, 500);
  }
});
