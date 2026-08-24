import { useEffect, useMemo, useState } from 'react';

// The public booking page. Two steps, deliberately: pick a time, then say who
// you are. Asking for a name before showing whether there is a slot at all is
// how booking pages lose people.
//
// Every time on this page is rendered in the VISITOR's timezone, detected from
// their browser and shown plainly, because the host is in California and most
// people booking are in the UK. A time with no zone against it is how meetings
// get missed by eight hours.

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/booking-public`;
const call = async (payload) => {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
};

const myZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };
const dayKey = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });   // YYYY-MM-DD
const timeIn = (iso, tz) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const longDay = (iso, tz) => new Date(iso).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });

export default function BookingPage({ slug }) {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState('');
  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [calendarOk, setCalendarOk] = useState(true);
  const [day, setDay] = useState(null);
  const [slot, setSlot] = useState(null);
  // Arriving from the onboarding pack, we already know who they are and which
  // venue this is about, and they may have clicked a specific time.
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [form, setForm] = useState({
    name: params.get('name') || '', email: params.get('email') || '',
    phone: '', company: params.get('company') || '', notes: '',
  });
  const [booking, setBooking] = useState(false);
  const [done, setDone] = useState(null);
  const tz = useMemo(myZone, []);

  useEffect(() => {
    (async () => {
      try { setCfg(await call({ slug, action: 'config' })); }
      catch (e) { setError(e.message); }
    })();
  }, [slug]);

  useEffect(() => {
    if (!cfg) return;
    (async () => {
      setLoadingSlots(true);
      try {
        const from = new Date().toISOString();
        const to = new Date(Date.now() + (cfg.maxDaysAhead || 30) * 86400000).toISOString();
        const d = await call({ slug, action: 'slots', from, to });
        setSlots(d.slots || []);
        setCalendarOk(d.calendarOk !== false);
      } catch (e) { setError(e.message); }
      setLoadingSlots(false);
    })();
  }, [cfg, slug]);

  // Group by the visitor's day, not the host's: a 5pm California slot is
  // tomorrow morning in the UK, and it must appear under tomorrow.
  const byDay = useMemo(() => {
    const m = new Map();
    for (const s of slots) {
      const k = dayKey(s, tz);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [slots, tz]);

  useEffect(() => { if (!day && byDay.length) setDay(byDay[0][0]); }, [byDay, day]);

  // A time clicked in the pack jumps straight to the form — but only if it is
  // still genuinely free, so a stale link cannot skip the availability check.
  useEffect(() => {
    const want = params.get('slot');
    if (want && !slot && slots.includes(want)) { setSlot(want); setDay(dayKey(want, tz)); }
  }, [slots, params, slot, tz]);

  const confirm = async () => {
    if (!form.name.trim() || !form.email.includes('@')) { alert('Please add your name and email.'); return; }
    setBooking(true);
    try {
      const d = await call({ slug, action: 'book', slot, ...form, timezone: tz });
      setDone(d);
    } catch (e) {
      alert(e.message);
      if (/just been taken/i.test(e.message)) { setSlot(null); setCfg({ ...cfg }); }
    }
    setBooking(false);
  };

  if (error) return <Frame><div className="py-20 text-center text-slate-700">{error}</div></Frame>;
  if (!cfg) return <Frame><div className="py-24 text-center text-slate-400 text-sm">Loading…</div></Frame>;

  if (done) return (
    <Frame>
      <div className="py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 text-3xl flex items-center justify-center mx-auto mb-5">✓</div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">You're booked in</h1>
        <p className="text-[17px] text-slate-800 font-semibold">{longDay(done.starts_at, tz)}</p>
        <p className="text-[15px] text-slate-600">{timeIn(done.starts_at, tz)} · {cfg.durationMins} minutes</p>
        <p className="text-xs text-slate-500 mt-1">Times shown in {tz.replace(/_/g, ' ')}</p>
        {done.calendarInvite && (
          <p className="text-sm text-slate-600 mt-5 max-w-sm mx-auto leading-relaxed">
            A calendar invite with a video link is on its way to <strong>{form.email}</strong>. Accept it and the
            meeting will be in your diary.
          </p>
        )}
      </div>
    </Frame>
  );

  const times = byDay.find(([k]) => k === day)?.[1] || [];

  return (
    <Frame>
      <div className="pt-8 pb-5">
        <h1 className="text-[26px] font-bold text-slate-900 leading-tight">{cfg.name}</h1>
        {cfg.description && <p className="text-[15px] text-slate-600 mt-1.5 leading-relaxed">{cfg.description}</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[13px] text-slate-500">
          <span>🕐 {cfg.durationMins} minutes</span>
          <span>🌍 Times shown in <strong className="text-slate-700">{tz.replace(/_/g, ' ')}</strong></span>
        </div>
      </div>

      {!calendarOk && (
        <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-[13px] text-amber-900">
          We could not reach the calendar just now, so these times may not be current. We will confirm your booking by email.
        </div>
      )}

      {loadingSlots ? (
        <div className="py-16 text-center text-slate-400 text-sm">Finding available times…</div>
      ) : byDay.length === 0 ? (
        <div className="py-16 text-center text-slate-600">No times are available in the next {cfg.maxDaysAhead} days. Please email us and we'll sort something out.</div>
      ) : !slot ? (
        <>
          {/* Days */}
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4">
            {byDay.map(([k, list]) => {
              const active = k === day;
              return (
                <button key={k} onClick={() => setDay(k)}
                  className={`shrink-0 px-3.5 py-2.5 rounded-xl border text-center transition ${
                    active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'}`}>
                  <div className="text-[11px] uppercase font-semibold opacity-70">
                    {new Date(list[0]).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short' })}
                  </div>
                  <div className="text-lg font-bold leading-tight">
                    {new Date(list[0]).toLocaleDateString('en-GB', { timeZone: tz, day: 'numeric' })}
                  </div>
                  <div className="text-[10px] opacity-70">
                    {new Date(list[0]).toLocaleDateString('en-GB', { timeZone: tz, month: 'short' })}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Times */}
          <div className="mt-5">
            <div className="text-sm font-bold text-slate-900 mb-2">
              {times.length ? longDay(times[0], tz) : 'Pick a day'}
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {times.map(s => (
                <button key={s} onClick={() => setSlot(s)}
                  className="px-2 py-3 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-800 hover:border-slate-900 hover:bg-slate-900 hover:text-white transition">
                  {timeIn(s, tz)}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
          <button onClick={() => setSlot(null)} className="text-sm text-slate-500 hover:text-slate-900 mb-3">← Pick a different time</button>
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 mb-4">
            <div className="font-bold text-slate-900">{longDay(slot, tz)}</div>
            <div className="text-slate-600 text-sm">{timeIn(slot, tz)} · {cfg.durationMins} minutes · {tz.replace(/_/g, ' ')}</div>
          </div>
          <div className="space-y-3">
            <Field label="Your name" required value={form.name} onChange={v => setForm({ ...form, name: v })} />
            <Field label="Email" required type="email" value={form.email} onChange={v => setForm({ ...form, email: v })}
              hint="Your calendar invite goes here." />
            <Field label="Phone" value={form.phone} onChange={v => setForm({ ...form, phone: v })} />
            <Field label="Company" value={form.company} onChange={v => setForm({ ...form, company: v })} />
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1">Anything you want to cover?</label>
              <textarea rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                className={INPUT + ' resize-y'} />
            </div>
          </div>
          <button disabled={booking} onClick={confirm}
            className="w-full mt-4 py-3 rounded-xl bg-emerald-600 text-white font-bold hover:bg-emerald-700 disabled:opacity-50">
            {booking ? 'Booking…' : 'Confirm booking'}
          </button>
        </div>
      )}
    </Frame>
  );
}

const INPUT = "w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-xl text-[15px] text-slate-900 focus:outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10";

function Field({ label, value, onChange, required, type = 'text', hint }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-800 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {hint && <div className="text-xs text-slate-500 mb-1">{hint}</div>}
      <input type={type} className={INPUT} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function Frame({ children }) {
  return <div className="min-h-screen bg-slate-100"><div className="max-w-xl mx-auto px-4 pb-16">{children}</div></div>;
}
