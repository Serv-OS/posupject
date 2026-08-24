import { useEffect, useState } from 'react';

// The offer of a call, inside the onboarding pack.
//
// It shows REAL next-available times rather than a bare "book a call" button.
// A live time you can picture yourself on ("Thu 15:30, your time") asks far
// less of someone than a link that might lead to a wall of admin, and it proves
// there is genuinely someone at the other end this week.

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/booking-public`;
const SLUG = 'onboarding-call';

export default function BookingInvite({ venue, prefill = {}, compact }) {
  const [slots, setSlots] = useState(null);   // null = loading, [] = none
  const [cfg, setCfg] = useState(null);
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();

  useEffect(() => {
    (async () => {
      try {
        const post = (b) => fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
        const [c, s] = await Promise.all([
          post({ slug: SLUG, action: 'config' }),
          post({ slug: SLUG, action: 'slots', from: new Date().toISOString(), to: new Date(Date.now() + 14 * 86400000).toISOString() }),
        ]);
        setCfg(c?.error ? null : c);
        setSlots(Array.isArray(s?.slots) ? s.slots : []);
      } catch { setSlots([]); }
    })();
  }, []);

  const q = new URLSearchParams();
  if (prefill.name) q.set('name', prefill.name);
  if (prefill.email) q.set('email', prefill.email);
  if (venue) q.set('company', venue);
  const href = `/book/${SLUG}${q.toString() ? `?${q}` : ''}`;

  const when = (iso) => new Date(iso).toLocaleString('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  const mins = cfg?.durationMins || 30;

  return (
    <section className={`rounded-2xl border border-slate-900 bg-slate-900 text-white ${compact ? 'p-5' : 'p-6'}`}>
      <h2 className="text-[17px] font-bold">Rather talk it through?</h2>
      <p className="text-[14px] text-slate-300 mt-1.5 leading-relaxed">
        Menus, printing and table plans are quicker to explain than to type. Book {mins} minutes with one of our
        setup team and we'll go through {venue ? <strong className="text-white">{venue}</strong> : 'your venue'} together,
        answer anything you're unsure about, and make sure install day holds no surprises.
      </p>

      {slots === null ? (
        <div className="mt-4 text-sm text-slate-400">Checking the diary…</div>
      ) : slots.length === 0 ? (
        <a href={href} target="_blank" rel="noreferrer"
          className="inline-block mt-4 px-5 py-2.5 rounded-xl bg-white text-slate-900 font-bold text-sm hover:bg-slate-100">
          See available times
        </a>
      ) : (
        <>
          <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
            Next available · your time
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {slots.slice(0, 4).map((s) => (
              <a key={s} href={`${href}${q.toString() ? '&' : '?'}slot=${encodeURIComponent(s)}`} target="_blank" rel="noreferrer"
                className="px-3 py-2 rounded-xl bg-white/10 border border-white/20 text-sm font-semibold hover:bg-white hover:text-slate-900 transition">
                {when(s)}
              </a>
            ))}
          </div>
          <a href={href} target="_blank" rel="noreferrer"
            className="inline-block mt-4 px-5 py-2.5 rounded-xl bg-white text-slate-900 font-bold text-sm hover:bg-slate-100">
            See all times
          </a>
          <div className="text-[11px] text-slate-400 mt-2">
            Shown in {tz.replace(/_/g, ' ')} · no charge, and you can move it later
          </div>
        </>
      )}
    </section>
  );
}
