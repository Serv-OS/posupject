import { useEffect, useState } from 'react';
import { invalidAddresses, parseAddressList } from '../../lib/replyRecipients';

/**
 * Email addresses as removable chips, for the To and Cc lines of a reply.
 *
 * Type or paste one address or several. Enter, comma, semicolon, Tab or
 * leaving the box turns them into chips; Backspace in an empty box removes the
 * last chip. If ANY part of the text is not an address, all of it stays in the
 * box, marked red, and is reported through onPendingChange so the composer can
 * refuse to send rather than quietly drop someone. Chips always show the
 * address itself, so a friendly name cannot disguise where a reply is going.
 *
 * `value` is [{ name, email }] as returned by parseAddressList.
 */
export default function AddressInput({ label, value = [], onChange, placeholder = 'Add an email address', onPendingChange, disabled = false }) {
  const [draft, setDraft] = useState('');
  const setPending = (t) => { setDraft(t); onPendingChange?.(t.trim()); };
  const bad = invalidAddresses(draft);
  const invalid = bad.length > 0;
  // When the box leaves the screen (another channel, a reset) its unsent text
  // goes with it, so a box nobody can see can never block a send.
  useEffect(() => () => onPendingChange?.(''), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Turn typed text into chips. All or nothing: one bad part keeps the whole text
  // in the box and returns false, so nobody is left off without the sender seeing it.
  const commit = (text = draft) => {
    const t = String(text).trim();
    if (!t) { setPending(''); return true; }
    if (invalidAddresses(t).length) { setPending(t); return false; }
    const found = parseAddressList(t);
    if (!found.length) return false;
    const seen = new Set(value.map((a) => a.email));
    onChange(value.concat(found.filter((a) => !seen.has(a.email) && seen.add(a.email))));
    setPending('');
    return true;
  };
  const remove = (email) => onChange(value.filter((a) => a.email !== email));

  return (
    <div className={`flex flex-wrap items-center gap-1 px-2 py-1.5 bg-card border rounded-xl min-h-[38px] ${invalid ? 'border-red-400' : 'border-bdr'} ${disabled ? 'opacity-60' : ''}`}>
      {label && <span className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim w-6 shrink-0">{label}</span>}
      {value.map((a) => (
        <span key={a.email} title={a.name ? `${a.name} <${a.email}>` : a.email} className="inline-flex items-center gap-1 max-w-full pl-2 pr-1 py-0.5 rounded-lg bg-card border border-bdr text-xs text-paper">
          <span className="truncate">{a.email}</span>
          {!disabled && (
            <button type="button" onClick={() => remove(a.email)} aria-label={`Remove ${a.email}`} className="w-4 h-4 leading-none rounded text-muted hover:text-paper">×</button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            // A separator typed or pasted commits everything before it.
            if (/[,;]\s*$/.test(v) || (/[,;]/.test(v) && v.length - draft.length > 1)) { if (!commit(v.replace(/[,;]\s*$/, ''))) setPending(v); }
            else setPending(v);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === 'Tab') && draft.trim()) { if (commit()) e.preventDefault(); else if (e.key === 'Enter') e.preventDefault(); }
            else if (e.key === 'Enter') e.preventDefault();          // never submit a form from the address box
            else if (e.key === 'Backspace' && !draft && value.length) remove(value[value.length - 1].email);
          }}
          onBlur={() => commit()}
          placeholder={value.length ? '' : placeholder}
          className={`flex-1 min-w-[140px] bg-transparent text-sm focus:outline-none ${invalid ? 'text-red-600' : 'text-paper'} placeholder-dim`}
          type="email" inputMode="email" autoComplete="off" spellCheck={false}
        />
      )}
      {invalid && <span className="w-full text-[10px] text-red-600 px-1">Not an email address: {bad.join(', ')}</span>}
    </div>
  );
}
