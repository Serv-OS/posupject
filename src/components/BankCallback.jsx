import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

// Monzo sends the user back here (/bank/callback?code=...&state=<reference>)
// after they sign in. Two more steps happen on this page:
//   1. finalise: the code is swapped for tokens
//   2. activate: Monzo only shares data once the access is approved in the
//      Monzo app, so we ask, and check every few seconds. The moment it is
//      approved the whole history is imported: Monzo allows that for 5 minutes
//      after approval only, then just the last 90 days.
// A function's own error message: supabase-js only says "non-2xx status code"
// and keeps the body on error.context.
async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return { data, error: null };
  let detail = null;
  try { detail = (await error.context?.json())?.error; } catch { /* not json */ }
  return { data: detail ? { error: detail } : data, error: detail ? null : error };
}

export default function BankCallback() {
  const [step, setStep] = useState('linking'); // linking | approve | importing | done | error
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState(null);
  const conn = useRef(null);
  const timer = useRef(null);

  const activate = async () => {
    const { data, error } = await invoke('bank-connect', { action: 'activate', connection_id: conn.current });
    if (error || data?.error) { setStep('error'); setMsg(error?.message || data?.error || 'unknown error'); return true; }
    if (data.waiting) return false;
    setResult(data.accounts || []);
    setStep('done');
    return true;
  };

  const poll = async () => {
    setStep((s) => (s === 'approve' ? 'approve' : s));
    const finished = await activate();
    if (!finished) timer.current = setTimeout(poll, 4000);
  };

  useEffect(() => {
    (async () => {
      const p = new URLSearchParams(window.location.search);
      const code = p.get('code');
      const state = p.get('state') || p.get('ref');
      const errParam = p.get('error');
      if (errParam) { setStep('error'); setMsg('The bank said no (' + errParam + '). Try again from Bank feed.'); return; }
      if (!code || !state) { setStep('error'); setMsg('Missing sign in details. Try again from Bank feed.'); return; }
      const { data, error } = await invoke('bank-connect', { action: 'finalise', reference: state, code });
      if (error || data?.error) { setStep('error'); setMsg(error?.message || data?.error || 'unknown error'); return; }
      if (data.status === 'LN') { setStep('done'); setResult([]); return; }
      conn.current = data.connection_id;
      setStep('approve');
      timer.current = setTimeout(poll, 3000);
    })();
    return () => clearTimeout(timer.current);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-card rounded-2xl p-6 max-w-md w-full text-center space-y-3">
        {step === 'linking' && <div className="text-muted text-sm">Linking Monzo…</div>}
        {step === 'approve' && (
          <>
            <div className="text-lg font-bold text-paper">Approve it in the Monzo app</div>
            <div className="text-sm text-muted">Open Monzo on your phone and tap <b>Allow</b> on the request to share your data. This page carries on by itself once you have.</div>
            <div className="text-[11px] text-dim">Checking every few seconds…</div>
          </>
        )}
        {step === 'done' && (
          <>
            <div className="text-lg font-bold text-paper">Monzo is connected</div>
            {(result || []).map((r) => (
              <div key={r.account} className="text-sm text-muted">{r.account}: {r.imported} transactions imported{r.webhook === 'registered' ? ', live updates on' : ''}</div>
            ))}
            <button onClick={() => { window.location.href = '/'; }} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Back to the CRM</button>
          </>
        )}
        {step === 'error' && (
          <>
            <div className="text-lg font-bold text-paper">Could not finish connecting</div>
            <div className="text-sm text-red-600">{msg}</div>
            <button onClick={() => { window.location.href = '/'; }} className="btn-glass px-5 py-2 rounded-xl text-sm">Back to the CRM</button>
          </>
        )}
      </div>
    </div>
  );
}
