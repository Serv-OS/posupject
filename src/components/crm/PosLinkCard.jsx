import { useState } from 'react';
import { supabase } from '../../lib/supabase';

// How the support chat knows which venue is messaging it.
//
// When a customer opens the chat from their till, the POS sends its venue code
// (SV-1007) and, where it has one, the ops database's own uuid. The bot looks
// the venue up and stops asking "which venue are you at?" — which it otherwise
// must, because names identify nobody: the POS calls a site "Leeds" while this
// CRM holds three different customers with Leeds venues.
//
// The code is the field to fill in. It is what a person can read off a screen
// and repeat down the phone, and it is what the bot checks first. The uuid is
// there for completeness and most venues will never need it.
//
// Left blank, nothing breaks: the bot simply asks, which is right when we
// genuinely cannot tell who is calling.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PosLinkCard({ locationId, code, posId, profile, onSaved }) {
  const [draftCode, setDraftCode] = useState(code || '');
  const [draftId, setDraftId] = useState(posId || '');
  const [showId, setShowId] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  // Stored uppercase so "sv-1007" typed in a hurry still matches SV-1007.
  const normalised = draftCode.trim().toUpperCase().replace(/\s+/g, '');
  const dirty = normalised !== (code || '') || draftId.trim() !== (posId || '');

  const save = async () => {
    setErr('');
    const id = draftId.trim();
    if (id && !UUID.test(id)) {
      setErr('The POS location id should be a uuid. If all you have is a code like SV-1007, put it in the box above.');
      return;
    }
    setBusy(true);
    const { error } = await supabase.from('locations')
      .update({ venue_code: normalised || null, pos_location_id: id || null })
      .eq('id', locationId);
    setBusy(false);
    if (error) {
      // The unique indexes are the useful failures: the same code on two venues
      // would send a customer's chat to the wrong record.
      setErr(/duplicate|unique/i.test(error.message)
        ? 'Another venue already uses that code. Check you have copied the right one.'
        : error.message);
      return;
    }
    setDraftCode(normalised);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
    onSaved?.({ venue_code: normalised || null, pos_location_id: id || null });
  };

  const linked = !!(code || posId);

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-paper">POS link</h3>
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
          linked ? 'bg-emerald-100 text-emerald-700' : 'bg-amber/15 text-amber'}`}>
          {linked ? 'Linked' : 'Not linked'}
        </span>
        {code && (
          <button onClick={() => navigator.clipboard.writeText(code)}
            className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">Copy code</button>
        )}
      </div>

      <div className="p-4 space-y-2">
        <div className="text-xs text-muted">
          Paste this venue's code from the POS platform. The support chat uses it to know who is messaging,
          instead of asking them which site they're at.
        </div>

        <label className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim block">Venue code</label>
        <input
          className="w-full px-3 py-2.5 bg-card border border-bdr rounded-xl text-base font-mono tracking-wide text-paper placeholder-dim"
          placeholder="SV-1007"
          value={draftCode} onChange={e => { setDraftCode(e.target.value); setErr(''); }}
          onFocus={e => e.target.select()} disabled={!canWrite} />

        {!showId && !posId && (
          <button onClick={() => setShowId(true)} className="text-[11px] text-dim hover:text-muted">
            + also add the POS location id (uuid)
          </button>
        )}
        {(showId || posId) && (
          <>
            <label className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim block pt-1">
              POS location id <span className="normal-case tracking-normal font-sans text-dim">· optional</span>
            </label>
            <input
              className="w-full px-3 py-2 bg-card border border-bdr rounded-xl text-xs font-mono text-paper placeholder-dim"
              placeholder="3f7a1c22-9b40-4a1e-8c55-2d9e77b10a44"
              value={draftId} onChange={e => { setDraftId(e.target.value); setErr(''); }}
              onFocus={e => e.target.select()} disabled={!canWrite} />
          </>
        )}

        {err && <div className="text-[11px] text-red-600">{err}</div>}

        {canWrite && dirty && (
          <div className="flex items-center gap-2 pt-1">
            <button disabled={busy} onClick={save}
              className="btn-glass px-4 py-1.5 rounded-xl text-xs font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setDraftCode(code || ''); setDraftId(posId || ''); setErr(''); }}
              className="btn-ghost px-3 py-1.5 rounded-xl text-xs">Cancel</button>
          </div>
        )}
        {saved && <div className="text-[11px] text-emerald-600 font-semibold">✓ Saved</div>}

        {!linked && (
          <div className="text-[10px] text-dim">
            Leave it blank and nothing breaks — the bot just asks which venue they're at.
          </div>
        )}
      </div>
    </div>
  );
}
