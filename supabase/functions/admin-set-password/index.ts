// admin-set-password — lets an OWNER set/reset another user's password (e.g. to
// hand someone a login when they never received the invite link). Uses the
// service-role admin API server-side; the key never reaches the browser.
//
// Body: { user_id?, email?, password }
//   - user_id present  → reset that existing user's password
//   - email only       → reset if the account exists, else create it (for an
//                        invited person who never signed up)
//
// Owner-gated: the caller's JWT is verified and their profile role must be owner.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const { data: { user: caller } } = await admin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!caller) return json({ error: 'Invalid token' }, 401);

    // Gate: caller must be an owner.
    const { data: me } = await admin.from('profiles').select('role').eq('id', caller.id).maybeSingle();
    if (me?.role !== 'owner') return json({ error: 'Only owners can set passwords.' }, 403);

    const body = await req.json().catch(() => ({}));
    const password = String(body?.password ?? '');
    let userId: string | null = body?.user_id ?? null;
    const email = (body?.email ? String(body.email).trim().toLowerCase() : null);
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
    if (!userId && !email) return json({ error: 'user_id or email required.' }, 400);

    // Resolve an existing account by email if only email was given.
    if (!userId && email) {
      const { data: prof } = await admin.from('profiles').select('id').ilike('email', email).maybeSingle();
      if (prof?.id) userId = prof.id;
    }

    if (userId) {
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, action: 'reset' });
    }

    // No account yet → create one so the invited person can log straight in.
    // (Their email is already on the invite list, so the signup trigger assigns
    // the intended role.) email_confirm skips the confirmation step.
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: email!, password, email_confirm: true,
    });
    if (cErr) return json({ error: cErr.message }, 400);
    return json({ ok: true, action: 'created', user_id: created.user?.id });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
