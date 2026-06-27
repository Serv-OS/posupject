import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// GoCardless redirects the user here (/bank/callback?ref=<reference>) after bank consent.
// We finalise the requisition (fetch + store the linked accounts) then return to the app.
export default function BankCallback() {
  const [msg, setMsg] = useState('Linking your bank…');
  useEffect(() => {
    (async () => {
      const ref = new URLSearchParams(window.location.search).get('ref');
      if (!ref) { setMsg('Missing reference — please retry from the Bank feed.'); return; }
      const { data, error } = await supabase.functions.invoke('bank-connect', { body: { action: 'finalise', reference: ref } });
      if (error || data?.error) { setMsg('Could not finish linking: ' + (error?.message || data?.error || 'unknown error')); return; }
      setMsg(data.status === 'LN' ? 'Bank linked ✓ Taking you back…' : `Almost there (status ${data.status}). Returning — use Refresh shortly.`);
      setTimeout(() => { window.location.href = '/'; }, 1400);
    })();
  }, []);
  return <div className="h-full flex items-center justify-center text-muted text-sm">{msg}</div>;
}
