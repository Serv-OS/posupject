import { useEffect, useState, useRef } from 'react';
import { Device } from '@twilio/voice-sdk';
import { supabase } from '../lib/supabase';
import { toE164, loadRegions } from '../lib/region';
import {
  createRinger, unlockAudio, audioReady, flashTitle, showCallNotification, notificationState,
  reconnectDelay, needsFreshToken, watchdogAction, wasMissed,
} from '../lib/phoneRing';
import IncomingCallOverlay from './IncomingCallOverlay.jsx';

const BEAT_MS = 30000;   // how often we tell the server this agent can take calls
const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/twilio-voice-token`;

export default function PhoneBar({ profile, onNavigate }) {
  const [status, setStatus] = useState('offline'); // offline, connecting, reconnecting, online, ringing, on-call
  const [device, setDevice] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [callInfo, setCallInfo] = useState(null); // { from, callerName }
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [dialNumber, setDialNumber] = useState('');
  const [showDialer, setShowDialer] = useState(false);
  const [ourNumber, setOurNumber] = useState(null);
  const [usNumber, setUsNumber] = useState(null);
  const [ticketId, setTicketId] = useState(null);   // the ticket behind the call on screen
  const [missed, setMissed] = useState(null);       // { name, number }: rang here, nobody picked up
  const [testing, setTesting] = useState(false);
  // Whether a call can actually reach this person: sound, desktop alerts, microphone.
  const [ready, setReady] = useState({ sound: false, alerts: 'default', mic: 'unknown' });
  const timerRef = useRef(null);
  const deviceRef = useRef(null);
  const pendingCallRef = useRef(null);
  const aliveRef = useRef(false);         // false once the bar has left the screen
  // Refs the device's event handlers read: they are attached once and would
  // otherwise see the state as it was when the device was built.
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  const wantOnlineRef = useRef(true);      // false only after the agent presses Go Offline
  const connectingRef = useRef(false);     // one connect at a time
  const retryRef = useRef({ attempt: 0, timer: null });
  const sessionRef = useRef(null);         // last access token, for the goodbye sent as the tab closes
  const ringerRef = useRef(null);
  if (!ringerRef.current) ringerRef.current = createRinger();
  const alertRef = useRef({ stopFlash: null, closeNote: null });
  const testTimerRef = useRef(null);

  useEffect(() => {
    supabase.from('support_settings').select('twilio_number').eq('id', 1).maybeSingle()
      .then(({ data }) => setOurNumber(data?.twilio_number || null));
    // Show the US line alongside the UK one once a US number is provisioned
    loadRegions().then(rs => setUsNumber(rs.find(r => r.code === 'US')?.twilio_number || null));
  }, []);

  // ── Can a call reach this person? ─────────────────────────────────────────
  const refreshReady = async () => {
    let mic = 'unknown';
    try {
      const p = await navigator.permissions?.query({ name: 'microphone' });
      if (p) { mic = p.state; p.onchange = () => setReady(r => ({ ...r, mic: p.state })); }
    } catch { /* this browser will not say; the first call asks */ }
    setReady({ sound: audioReady(), alerts: notificationState(), mic });
  };
  const askForAlerts = async () => {
    try { if (notificationState() === 'default') await Notification.requestPermission(); } catch { /* ignore */ }
    refreshReady();
  };

  // ── The alert: loud ring, flashing tab, desktop notification ──────────────
  const stopAlert = () => {
    ringerRef.current.stop();
    alertRef.current.stopFlash?.();
    alertRef.current.closeNote?.();
    alertRef.current = { stopFlash: null, closeNote: null };
  };
  const startAlert = (name, { test = false } = {}) => {
    stopAlert();
    const words = test ? 'Test ring' : 'Incoming call';
    ringerRef.current.start({ seconds: test ? 8 : 40 });
    alertRef.current.stopFlash = flashTitle(`\u{1F4DE} ${words}: ${name}`);
    alertRef.current.closeNote = showCallNotification({ title: `\u{1F4DE} ${words}`, body: name });
    refreshReady();
  };
  const stopTest = () => {
    if (testTimerRef.current) { clearTimeout(testTimerRef.current); testTimerRef.current = null; }
    stopAlert(); setTesting(false);
  };
  const testRing = () => {
    if (statusRef.current === 'ringing' || statusRef.current === 'on-call') return;
    unlockAudio();
    setTesting(true);
    startAlert('Test caller', { test: true });
    testTimerRef.current = setTimeout(stopTest, 8000);
  };

  // ── Telling the server whether this agent can take calls ──────────────────
  const beat = (extra = {}) => supabase.from('agent_status').upsert({
    profile_id: profile.id,
    status: statusRef.current === 'on-call' ? 'busy' : 'online',
    last_seen_at: new Date().toISOString(),
    ...extra,
  }, { onConflict: 'profile_id' }).then(() => {}, () => {});
  // Said the moment the phone drops, so callers are not left ringing a dead
  // line for 25 seconds before voicemail.
  const markOffline = () => supabase.from('agent_status').upsert({
    profile_id: profile.id, status: 'offline', current_call_sid: null, last_seen_at: new Date().toISOString(),
  }, { onConflict: 'profile_id' }).then(() => {}, () => {});

  const fetchToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    sessionRef.current = session?.access_token || null;
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
    });
    const body = await res.json().catch(() => ({}));
    // The only refusal this function gives is 401, and straight after a laptop
    // wakes that is usually just a login token still being renewed. So every
    // failure is retried; someone really signed out is sent to the login page
    // and this bar goes with it.
    return { token: body.token, error: body.error || (res.ok ? null : `HTTP ${res.status}`) };
  };

  const teardownDevice = () => {
    const d = deviceRef.current;
    deviceRef.current = null;
    if (!d) return;
    try { d.removeAllListeners(); } catch { /* ignore */ }
    try { d.destroy(); } catch { /* ignore */ }
  };

  const scheduleReconnect = () => {
    if (!wantOnlineRef.current || !aliveRef.current) return;
    if (retryRef.current.timer) clearTimeout(retryRef.current.timer);
    const delay = reconnectDelay(retryRef.current.attempt);
    retryRef.current.attempt += 1;
    setStatus('reconnecting');
    retryRef.current.timer = setTimeout(() => { retryRef.current.timer = null; goOnline({ silent: true }); }, delay);
  };

  // Did a colleague pick this call up? The one who answers writes the call's
  // id onto their agent_status row, so everyone else can tell "answered by
  // someone" from "nobody got to it".
  const answeredElsewhere = async (parentSid) => {
    if (!parentSid) return false;
    await new Promise(r => setTimeout(r, 1500));
    const { data } = await supabase.from('agent_status').select('profile_id')
      .eq('current_call_sid', parentSid).neq('profile_id', profile.id).limit(1);
    return !!(data && data.length);
  };

  const buildDevice = (token) => {
    const newDevice = new Device(token, { codecPreferences: ['opus', 'pcmu'], logLevel: 1 });
    // Our own ring replaces the SDK's: it is louder and keeps time in a
    // background tab. Two ringtones at once is just noise.
    try { newDevice.audio?.incoming(false); } catch { /* older SDK: both will play */ }

    newDevice.on('registered', () => {
      retryRef.current.attempt = 0;
      setStatus(s => (s === 'on-call' || s === 'ringing' ? s : 'online'));
      statusRef.current = statusRef.current === 'on-call' || statusRef.current === 'ringing' ? statusRef.current : 'online';
      beat();
      // If a call was requested while offline, place it now that we're connected
      if (pendingCallRef.current) {
        const num = pendingCallRef.current;
        pendingCallRef.current = null;
        setTimeout(() => makeCall(num), 400);
      }
    });

    newDevice.on('incoming', (call) => {
      const p = call.customParameters;
      const callerName = p?.get('callerName') || call.parameters.From || 'Unknown';
      const callerNumber = p?.get('callerNumber') || call.parameters.From || '';
      const parentSid = p?.get('callSid') || null;
      const ring = { answeredHere: false, rejectedHere: false };
      call._servosRing = ring;
      stopTest();
      setMissed(null);
      setStatus('ringing');
      setActiveCall(call);
      setCallInfo({ from: call.parameters.From || 'Unknown', callerName, callerNumber });
      setTicketId(p?.get('ticketId') || null);
      startAlert(callerName);

      call.on('accept', () => {
        ring.answeredHere = true;
        stopAlert();
        setStatus('on-call'); statusRef.current = 'on-call';
        startTimer();
        beat({ current_call_sid: parentSid });   // so colleagues' screens know it was answered
      });

      call.on('disconnect', () => { stopAlert(); endCall(); });

      // The caller hung up, a colleague answered, or it timed out to voicemail.
      call.on('cancel', async () => {
        stopAlert();
        if (deviceRef.current?.state === 'registered') setStatus('online');
        else scheduleReconnect();
        setActiveCall(null);
        setCallInfo(null);
        setTicketId(null);
        const elsewhere = await answeredElsewhere(parentSid).catch(() => false);
        if (wasMissed({ answeredElsewhere: elsewhere, answeredHere: ring.answeredHere, rejectedHere: ring.rejectedHere })) {
          setMissed({ name: callerName, number: callerNumber });
        }
      });
    });

    newDevice.on('error', (err) => {
      console.error('Twilio Device error:', err);
      if (needsFreshToken(err) && statusRef.current !== 'on-call') scheduleReconnect();
    });

    // Access tokens last 1 hour. Without this the device silently drops its
    // registration while the heartbeat below still reports the agent online,
    // so inbound calls ring a dead client and fall through to voicemail.
    newDevice.on('tokenWillExpire', async () => {
      try {
        const { token: fresh } = await fetchToken();
        if (fresh) newDevice.updateToken(fresh);
        else console.error('Twilio token refresh returned no token');
      } catch (e) {
        console.error('Twilio token refresh failed:', e);
      }
    });

    // Lost the connection (sleep, wifi change, server restart). Unless the
    // agent asked to be offline, say so to the server and get it back.
    newDevice.on('unregistered', () => {
      if (deviceRef.current !== newDevice) return;   // an old device being torn down
      if (!wantOnlineRef.current) { setStatus('offline'); return; }
      if (statusRef.current === 'on-call') return;   // the call itself carries on
      markOffline();
      scheduleReconnect();
    });

    return newDevice;
  };

  // Go online: get a token and register the Twilio Device. `silent` is for the
  // automatic attempts (on load, after a drop), which must never throw alerts
  // at someone who did not press anything.
  const goOnline = async ({ silent = false } = {}) => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    wantOnlineRef.current = true;
    if (retryRef.current.timer) { clearTimeout(retryRef.current.timer); retryRef.current.timer = null; }
    setStatus(s => (s === 'reconnecting' ? s : 'connecting'));
    try {
      teardownDevice();
      const { token, error } = await fetchToken();
      if (!aliveRef.current) return;               // the bar left the screen while we waited
      if (error || !token) throw new Error(error || 'no token');
      const newDevice = buildDevice(token);
      deviceRef.current = newDevice;
      setDevice(newDevice);
      await newDevice.register();
    } catch (err) {
      console.error('Phone connect error:', err);
      if (!aliveRef.current) return;
      if (!silent) alert('Failed to connect: ' + (err?.message || err) + '\n\nIt will keep trying.');
      scheduleReconnect();
    } finally {
      connectingRef.current = false;
    }
  };

  // Go offline: the agent's own choice, so nothing tries to reconnect.
  const goOffline = async () => {
    wantOnlineRef.current = false;
    if (retryRef.current.timer) { clearTimeout(retryRef.current.timer); retryRef.current.timer = null; }
    retryRef.current.attempt = 0;
    if (deviceRef.current) {
      try { deviceRef.current.unregister(); } catch { /* ignore */ }
      teardownDevice();
      setDevice(null);
    }
    setStatus('offline');
    await markOffline();
  };

  // Answer incoming call
  const answerCall = () => {
    if (activeCall) {
      stopAlert();
      activeCall.accept();
    }
  };

  // Reject incoming call
  const rejectCall = () => {
    if (activeCall) {
      if (activeCall._servosRing) activeCall._servosRing.rejectedHere = true;
      stopAlert();
      activeCall.reject();
      setStatus('online');
      setActiveCall(null);
      setCallInfo(null);
      setTicketId(null);
    }
  };

  // Hang up
  const hangUp = () => {
    if (activeCall) {
      activeCall.disconnect();
    }
    endCall();
  };

  // Make outbound call
  const makeCall = async (number) => {
    if (!deviceRef.current) { alert('Phone not connected. Click "Go Online" first.'); return; }
    try {
      const call = await deviceRef.current.connect({
        params: { To: number },
      });
      setMissed(null);
      setActiveCall(call);
      setStatus('on-call');
      setCallInfo({ from: number, callerName: number, callerNumber: number });
      startTimer();
      setShowDialer(false);

      call.on('disconnect', () => { endCall(); });
    } catch (err) {
      alert('Call failed: ' + err.message);
    }
  };

  // Toggle mute
  const toggleMute = () => {
    if (activeCall) {
      activeCall.mute(!isMuted);
      setIsMuted(!isMuted);
    }
  };

  // Timer
  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCallDuration(0);
    timerRef.current = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);
  };

  const endCall = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCallDuration(0);
    setActiveCall(null);
    setCallInfo(null);
    setTicketId(null);
    setIsMuted(false);
    const next = deviceRef.current?.state === 'registered' ? 'online' : (wantOnlineRef.current ? 'reconnecting' : 'offline');
    setStatus(next); statusRef.current = next;
    // Free to take calls again, and no longer holding this one.
    if (next === 'online') beat({ current_call_sid: null });
    else if (wantOnlineRef.current) scheduleReconnect();
  };

  // Go online on login, so incoming calls ring without clicking "Go Online",
  // and take the phone down when the bar leaves the screen. One effect, so a
  // remount (React runs effects twice in development) ends up online, not
  // stuck offline with the first attempt torn down.
  useEffect(() => {
    aliveRef.current = true;
    wantOnlineRef.current = true;
    goOnline({ silent: true });
    return () => {
      aliveRef.current = false;
      if (retryRef.current.timer) { clearTimeout(retryRef.current.timer); retryRef.current.timer = null; }
      if (testTimerRef.current) clearTimeout(testTimerRef.current);
      stopAlert();
      if (deviceRef.current) {
        try { deviceRef.current.unregister(); } catch { /* ignore */ }
        teardownDevice();
      }
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browsers only let a page make sound, or ask to show notifications, after a
  // click or key press. Take the first one, then show what is still missing.
  useEffect(() => {
    refreshReady();
    const unlock = () => {
      unlockAudio();
      askForAlerts();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watchdog: every 30 s say "I am here" when the phone really is registered,
  // and get it back when it is not. Also runs the moment the tab is looked at
  // again, the network returns, or the laptop wakes (a tick that arrives
  // minutes late), which is when a dropped phone used to sit dead and silent.
  useEffect(() => {
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const gapMs = now - last;
      last = now;
      const action = watchdogAction({
        wantOnline: wantOnlineRef.current,
        deviceState: deviceRef.current?.state,
        onCall: statusRef.current === 'on-call' || statusRef.current === 'ringing',
        gapMs, intervalMs: BEAT_MS,
      });
      if (action === 'beat') beat();
      else if (action === 'reconnect' && !connectingRef.current && !retryRef.current.timer) goOnline({ silent: true });
    };
    const interval = setInterval(tick, BEAT_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    const onNetwork = () => { if (wantOnlineRef.current && deviceRef.current?.state !== 'registered' && !connectingRef.current) goOnline({ silent: true }); };
    // As the tab closes, say goodbye so callers are not sent to a closed tab.
    // keepalive lets the request outlive the page.
    const onLeave = () => {
      if (!sessionRef.current || !wantOnlineRef.current) return;
      try {
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/agent_status?profile_id=eq.${profile.id}`, {
          method: 'PATCH', keepalive: true,
          headers: {
            'Content-Type': 'application/json', Prefer: 'return=minimal',
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${sessionRef.current}`,
          },
          body: JSON.stringify({ status: 'offline', current_call_sid: null, last_seen_at: new Date().toISOString() }),
        });
      } catch { /* the 5 minute freshness rule on the server covers it */ }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onNetwork);
    window.addEventListener('pagehide', onLeave);
    // Holding a lock asks the browser not to freeze this tab in the background.
    try { navigator.locks?.request(`servos-phone-${profile.id}`, { mode: 'shared' }, () => new Promise(() => {})); } catch { /* ignore */ }
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onNetwork);
      window.removeEventListener('pagehide', onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  // Global click-to-call: listen for 'servos:call' events fired from anywhere in the app
  useEffect(() => {
    const handler = (e) => {
      const number = e.detail?.number;
      if (!number) return;
      if (status === 'on-call' || status === 'ringing' || activeCall) {
        alert('You are already on a call.');
        return;
      }
      if (deviceRef.current && status === 'online') {
        makeCall(number);
      } else if (status === 'connecting' || status === 'reconnecting') {
        // Already connecting — queue the number to dial once registered
        pendingCallRef.current = number;
      } else {
        // Offline: connect first, then auto-dial in the 'registered' handler
        pendingCallRef.current = number;
        goOnline();
      }
    };
    window.addEventListener('servos:call', handler);
    return () => window.removeEventListener('servos:call', handler);
  }, [status, activeCall]);

  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const canCallBack = missed?.number && /^[+\d]/.test(missed.number);

  const statusColors = {
    offline: 'bg-slate-400',
    connecting: 'bg-amber-400 animate-pulse',
    reconnecting: 'bg-amber-400 animate-pulse',
    online: 'bg-emerald-400',
    ringing: 'bg-blue-400 animate-pulse',
    'on-call': 'bg-red-400',
  };
  const chip = 'px-2.5 py-1 text-[11px] font-semibold rounded-xl border whitespace-nowrap';

  return (
    <div className="glass px-4 py-2 flex items-center gap-3 h-full overflow-x-auto">
      {/* Status indicator */}
      <div className="flex items-center gap-2 shrink-0">
        <div className={`w-2.5 h-2.5 rounded-full ${statusColors[status]}`} />
        <span className="text-xs font-medium text-paper capitalize">{status === 'on-call' ? 'On Call' : status}</span>
      </div>

      {/* Online/Offline toggle */}
      {(status === 'offline' || status === 'connecting') && (
        <button onClick={() => goOnline()} disabled={status === 'connecting'}
          className="px-3 py-1 text-xs font-semibold rounded-xl bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200 transition disabled:opacity-50">
          {status === 'connecting' ? 'Connecting...' : 'Go Online'}
        </button>
      )}
      {status === 'reconnecting' && (
        <>
          <span className="text-[11px] text-amber-700 whitespace-nowrap">Phone dropped. Getting it back.</span>
          <button onClick={() => goOnline()} className={`${chip} bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-200`}>Retry now</button>
          <button onClick={goOffline} className={`${chip} bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200`}>Go Offline</button>
        </>
      )}

      {status === 'online' && (
        <>
          <button onClick={goOffline}
            className="px-3 py-1 text-xs font-semibold rounded-xl bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 transition whitespace-nowrap">
            Go Offline
          </button>
          <button onClick={() => setShowDialer(!showDialer)}
            className="px-3 py-1 text-xs font-semibold rounded-xl bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-200 transition whitespace-nowrap">
            {'\u{1F4DE}'} Dial
          </button>
          <button onClick={testRing} title="Hear the ring and see the alert, so you know a call will reach you"
            className={`${chip} bg-card text-muted border-bdr hover:text-paper`}>Test ring</button>
          {/* What would stop a call reaching this person, said plainly. */}
          {!ready.sound && (
            <button onClick={() => { unlockAudio(); refreshReady(); }} className={`${chip} bg-amber-100 text-amber-800 border-amber-200`}
              title="Browsers keep a page silent until it has been clicked">
              Ring sound is off. Click to turn on
            </button>
          )}
          {ready.alerts === 'default' && (
            <button onClick={askForAlerts} className={`${chip} bg-amber-100 text-amber-800 border-amber-200`}>Turn on desktop alerts</button>
          )}
          {ready.alerts === 'denied' && (
            <span className={`${chip} bg-red-50 text-red-700 border-red-200`}
              title="Click the icon left of the web address, find Notifications, and choose Allow">
              Desktop alerts are blocked
            </span>
          )}
          {ready.mic === 'denied' && (
            <span className={`${chip} bg-red-50 text-red-700 border-red-200`}
              title="Click the icon left of the web address, find Microphone, and choose Allow">
              Microphone is blocked. You cannot answer
            </span>
          )}
        </>
      )}

      {/* Rang here and nobody picked up */}
      {missed && status !== 'ringing' && status !== 'on-call' && (
        <div className="flex items-center gap-2 px-2.5 py-1 rounded-xl bg-red-50 border border-red-200 shrink-0">
          <span className="text-[11px] font-semibold text-red-700 whitespace-nowrap">Missed call: {missed.name}</span>
          {canCallBack && status === 'online' && (
            <button onClick={() => makeCall(missed.number)} className="text-[11px] font-bold text-emerald-700 hover:underline whitespace-nowrap">Call back</button>
          )}
          <button onClick={() => setMissed(null)} aria-label="Dismiss missed call" className="text-red-400 hover:text-red-700 leading-none">&times;</button>
        </div>
      )}

      {/* Incoming call */}
      {status === 'ringing' && callInfo && (
        <div className="flex items-center gap-3 flex-1">
          <div className="flex-1">
            <span className="text-sm font-bold text-paper animate-pulse">{'\u{1F4F1}'} Incoming call</span>
            <span className="text-xs text-muted ml-2">{callInfo.callerName}</span>
          </div>
          <button onClick={answerCall}
            className="px-4 py-1.5 text-xs font-bold rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 transition">
            Answer
          </button>
          <button onClick={rejectCall}
            className="px-3 py-1.5 text-xs font-bold rounded-xl bg-red-500 text-white hover:bg-red-600 transition">
            Reject
          </button>
        </div>
      )}

      {/* Active call */}
      {status === 'on-call' && callInfo && (
        <div className="flex items-center gap-3 flex-1">
          <div className="flex-1 flex items-center gap-2">
            <span className="text-xs text-paper font-medium">{callInfo.callerName}</span>
            <span className="text-xs text-ember font-mono font-bold">{formatTime(callDuration)}</span>
          </div>
          {ticketId && onNavigate && (
            <button onClick={() => onNavigate('ticket', ticketId)}
              className="px-3 py-1 text-xs font-semibold rounded-xl bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-200 transition whitespace-nowrap">
              Open ticket
            </button>
          )}
          <button onClick={toggleMute}
            className={`px-3 py-1 text-xs font-semibold rounded-xl transition ${
              isMuted ? 'bg-amber-100 text-amber-700 border border-amber-200' : 'bg-slate-100 text-slate-600 border border-slate-200'
            }`}>
            {isMuted ? 'Unmute' : 'Mute'}
          </button>
          <button onClick={hangUp}
            className="px-4 py-1.5 text-xs font-bold rounded-xl bg-red-500 text-white hover:bg-red-600 transition">
            Hang Up
          </button>
        </div>
      )}

      {/* Dialer */}
      {showDialer && status === 'online' && (
        <div className="flex items-center gap-2">
          <input
            value={dialNumber}
            onChange={e => setDialNumber(e.target.value)}
            placeholder="+44… or +1…"
            className="px-3 py-1 text-sm bg-card border border-bdr rounded-xl text-paper placeholder-dim focus:outline-none focus:border-ember w-40"
          />
          <button onClick={() => {
              if (!dialNumber.trim()) return;
              // Normalise free-typed input (07…, 10-digit US, etc.) before it hits Twilio
              const e164 = toE164(dialNumber.trim());
              if (!e164) { alert('Could not read that number. Use +44… or +1… format.'); return; }
              makeCall(e164);
            }}
            disabled={!dialNumber.trim()}
            className="px-3 py-1 text-xs font-semibold rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 transition">
            Call
          </button>
          <button onClick={() => setShowDialer(false)}
            className="px-2 py-1 text-xs text-muted hover:text-paper">&times;</button>
        </div>
      )}

      {/* Spacer + phone number(s) — both lines once the US number exists */}
      {ourNumber && (
        <div className="ml-auto text-[10px] text-dim font-mono hidden md:block">
          {usNumber ? `UK ${ourNumber} · US ${usNumber}` : ourNumber}
        </div>
      )}

      {/* The alert nobody can miss */}
      {status === 'ringing' && callInfo && (
        <IncomingCallOverlay callerName={callInfo.callerName} callerNumber={callInfo.callerNumber}
          soundOn={ready.sound} onAnswer={answerCall} onDecline={rejectCall} />
      )}
      {testing && status !== 'ringing' && (
        <IncomingCallOverlay test callerName="Test caller" callerNumber="This is only a test" soundOn={ready.sound} onDecline={stopTest} />
      )}
    </div>
  );
}
