import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// Enable Banking redirects the user here (/bank/callback?code=<auth code>&state=<reference>)
// after bank consent. We exchange the code for a session (POST /sessions) which fetches +
// stores the linked accounts, then return to the app.
export default function BankCallback() {
  const [msg, setMsg] = useState('Linking your bank…');
  useEffect(() => {
    (async () => {
      const p = new URLSearchParams(window.location.search);
      const code = p.get('code');
      const state = p.get('state') || p.get('ref');   // state is our connection reference
      const errParam = p.get('error');
      if (errParam) { setMsg('Your bank declined the connection (' + errParam + '). Please retry from the Bank feed.'); return; }
      if (!code || !state) { setMsg('Missing authorisation — please retry from the Bank feed.'); return; }
      const { data, error } = await supabase.functions.invoke('bank-connect', { body: { action: 'finalise', reference: state, code } });
      if (error || data?.error) { setMsg('Could not finish linking: ' + (error?.message || data?.error || 'unknown error')); return; }
      setMsg(data.status === 'LN' ? 'Bank linked ✓ Taking you back…' : `Almost there (status ${data.status}). Returning — use Refresh shortly.`);
      setTimeout(() => { window.location.href = '/'; }, 1400);
    })();
  }, []);
  return <div className="h-full flex items-center justify-center text-muted text-sm">{msg}</div>;
}
