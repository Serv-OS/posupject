/* Making an incoming call impossible to miss, and keeping the phone connected.
 *
 * The phone used to alert with the Twilio SDK's own ringtone and one small
 * line in the top bar. Three things made calls go unnoticed or never ring:
 *   - the ringtone is blocked by the browser until the page has been clicked,
 *     and nothing said so;
 *   - a background tab's timers are throttled, so anything timer driven (a
 *     looping sound, a flashing title) slows to a crawl when it matters;
 *   - once the phone dropped its registration (sleep, wifi change) it stayed
 *     offline until someone pressed Go Online, while the screen looked fine.
 *
 * So the ring here is scheduled ahead on the audio clock (no timers), the
 * alert is sound + full screen + tab title + desktop notification, and the
 * reconnect rules are pure functions that can be tested.
 */

// ── Reconnect rules (pure) ──────────────────────────────────────────────────

/** How long to wait before reconnect attempt n (0 based): 1s, 2s, 5s, 10s, then every 30s. */
export function reconnectDelay(attempt) {
  const steps = [1000, 2000, 5000, 10000, 30000];
  const i = Math.max(0, Math.floor(Number(attempt) || 0));
  return steps[Math.min(i, steps.length - 1)];
}

/** Twilio error codes that mean the access token is no good and a new one is needed. */
export function needsFreshToken(err) {
  const code = Number(err?.code);
  return code === 20101 || code === 20104 || code === 31204 || code === 31205 || code === 51007;
}

/**
 * What the watchdog should do on a tick.
 *  'beat'      registered (or on a call): tell the server we are here
 *  'reconnect' we want to be online but the device is not registered
 *  'idle'      the user chose to be offline
 * `gapMs` is the time since the last tick: a gap far longer than the interval
 * means the laptop slept, and the connection should be checked even if the
 * SDK still believes it is registered.
 */
export function watchdogAction({ wantOnline, deviceState, onCall, gapMs = 0, intervalMs = 30000 }) {
  if (!wantOnline) return 'idle';
  if (onCall) return 'beat';
  if (deviceState !== 'registered') return 'reconnect';
  if (gapMs > intervalMs * 3) return 'reconnect';
  return 'beat';
}

/** True when a ring that ended should be shown as missed: nobody else picked it up. */
export function wasMissed({ answeredElsewhere, answeredHere, rejectedHere }) {
  return !answeredHere && !rejectedHere && !answeredElsewhere;
}

// ── Sound ───────────────────────────────────────────────────────────────────

let ctx = null;
const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

/** Call from a click or key press: browsers only let a page make sound after one. */
export function unlockAudio() {
  try {
    if (!Ctx) return false;
    if (!ctx) ctx = new Ctx();
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  } catch { return false; }
}

/** Can this page ring out loud right now? */
export function audioReady() {
  return !!ctx && ctx.state === 'running';
}

/**
 * A loud two tone ring (the UK pattern: ring ring, pause). Every burst for the
 * next `seconds` is scheduled on the audio clock up front, so it keeps perfect
 * time in a background tab where setInterval would fire once a minute.
 */
export function createRinger() {
  let nodes = [];
  const stop = () => {
    for (const n of nodes) { try { n.stop(); } catch { /* already stopped */ } try { n.disconnect(); } catch { /* ignore */ } }
    nodes = [];
  };
  const burst = (t0, dur, volume) => {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.02);
    gain.gain.setValueAtTime(volume, t0 + dur - 0.03);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    gain.connect(ctx.destination);
    for (const hz of [400, 450]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz;
      osc.connect(gain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
      nodes.push(osc);
    }
  };
  const start = ({ seconds = 40, volume = 0.45 } = {}) => {
    stop();
    if (!unlockAudio() || !ctx) return false;
    const t = ctx.currentTime + 0.05;
    for (let at = 0; at < seconds; at += 3) { burst(t + at, 0.4, volume); burst(t + at + 0.6, 0.4, volume); }
    return ctx.state === 'running';
  };
  return { start, stop };
}

// ── Tab title and desktop notification ──────────────────────────────────────

/** Flash the tab title. Returns a function that puts the old title back. */
export function flashTitle(text) {
  if (typeof document === 'undefined') return () => {};
  const original = document.title;
  let on = true;
  document.title = text;
  const timer = setInterval(() => { on = !on; document.title = on ? text : original; }, 1000);
  return () => { clearInterval(timer); document.title = original; };
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function notificationState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * A desktop notification that stays until dealt with and plays the computer's
 * own alert sound, which still works when the page itself is not allowed to
 * make noise yet. Returns a function that closes it.
 */
export function showCallNotification({ title, body, onClick } = {}) {
  try {
    if (notificationState() !== 'granted') return () => {};
    const note = new Notification(title || 'Incoming call', {
      body: body || '', tag: 'servos-call', renotify: true, requireInteraction: true,
    });
    note.onclick = () => { try { window.focus(); } catch { /* ignore */ } onClick?.(); note.close(); };
    return () => { try { note.close(); } catch { /* ignore */ } };
  } catch { return () => {}; }
}
