import { useState } from 'react';
import { supabase } from '../../lib/supabase';

// The venue's id in the POS platform.
//
// When a customer opens the support chat from their till, the POS sends this id
// along with the conversation. The bot looks the venue up by it and stops asking
// "which venue are you at?" — which it otherwise must, because names do not
// identify anyone: the POS calls a site "Leeds" while this CRM holds three
// different customers with Leeds venues.
//
// Paste it in when the location is created on the POS side. Left blank, nothing
// breaks: the bot simply asks, which is the right behaviour when we genuinely
// cannot tell who is calling.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PosLinkCard({ locationId, value, profile, onSaved }) {
  const [draft, setDraft] = useState(value || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const dirty = (draft || '') !== (value || '');

  const save = async () => {
    const v = draft.trim();
    setErr('');
    // The POS id is a uuid. Catching a mistyped or half-pasted one here beats a
    // silent no-match later, where the only symptom is the bot asking a question
    // it should already know the answer to.
    if (v && !UUID.test(v)) {
      setErr('That does not look like a POS location id. It should be a uuid, e.g. 3f7a1c22-9b40-4a1e-8c55-2d9e77b10a44');
      return;
    }
    setBusy(true);
    const { error } = await supabase.from('locations')
      .update({ pos_location_id: v || null }).eq('id', locationId);
    setBusy(false);
    if (error) {
      // The unique index is the useful failure: it means this id is already on
      // another venue, which would silently send a customer's chat to the wrong
      // record.
      setErr(/duplicate|unique/i.test(error.message)
        ? 'Another venue already uses that POS id. Check you have copied the right one.'
        : error.message);
      return;
    }
    setSaved(true); setTimeout(() => setSaved(false), 2000);
    onSaved?.(v || null);
  };

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-paper">POS link</h3>
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
          value ? 'bg-emerald-100 text-emerald-700' : 'bg-amber/15 text-amber'}`}>
          {value ? 'Linked' : 'Not linked'}
        </span>
      </div>
      <div className="p-4 space-y-2">
        <div className="text-xs text-muted">
          Paste this venue's id from the POS platform. The support chat uses it to know which venue a customer
          is messaging from, instead of asking them.
        </div>

        <div className="flex gap-2">
          <input
            className="flex-1 px-3 py-2 bg-card border border-bdr rounded-xl text-xs font-mono text-paper placeholder-dim"
            placeholder="3f7a1c22-9b40-4a1e-8c55-2d9e77b10a44"
            value={draft} onChange={e => { setDraft(e.target.value); setErr(''); }}
            onFocus={e => e.target.select()} disabled={!canWrite} />
          {value && (
            <button onClick={() => { navigator.clipboard.writeText(value); }}
              title="Copy" className="btn-ghost px-3 py-2 rounded-xl text-xs shrink-0">Copy</button>
          )}
        </div>

        {err && <div className="text-[11px] text-red-600">{err}</div>}

        {canWrite && dirty && (
          <div className="flex items-center gap-2">
            <button disabled={busy} onClick={save}
              className="btn-glass px-4 py-1.5 rounded-xl text-xs font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : 'Save POS id'}
            </button>
            <button onClick={() => { setDraft(value || ''); setErr(''); }}
              className="btn-ghost px-3 py-1.5 rounded-xl text-xs">Cancel</button>
          </div>
        )}
        {saved && <div className="text-[11px] text-emerald-600 font-semibold">✓ Saved</div>}

        {!value && (
          <div className="text-[10px] text-dim">
            Leave it blank and nothing breaks — the bot just asks which venue they're at.
          </div>
        )}
      </div>
    </div>
  );
}
