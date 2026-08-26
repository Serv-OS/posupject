import { useEffect, useState, useRef, useCallback } from 'react';
import { Device } from '@twilio/voice-sdk';
import { supabase } from '../lib/supabase';
import { toE164, loadRegions } from '../lib/region';

export default function PhoneBar({ profile }) {
  const [status, setStatus] = useState('offline'); // offline, connecting, online, ringing, on-call
  const [device, setDevice] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [callInfo, setCallInfo] = useState(null); // { from, callerName }
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [dialNumber, setDialNumber] = useState('');
  const [showDialer, setShowDialer] = useState(false);
  const [ourNumber, setOurNumber] = useState(null);
  const [usNumber, setUsNumber] = useState(null);
  const timerRef = useRef(null);
  const deviceRef = useRef(null);
  const pendingCallRef = useRef(null);
  const autoOnlineRef = useRef(false);

  useEffect(() => {
    supabase.from('support_settings').select('twilio_number').eq('id', 1).maybeSingle()
      .then(({ data }) => setOurNumber(data?.twilio_number || null));
    // Show the US line alongside the UK one once a US number is provisioned
    loadRegions().then(rs => setUsNumber(rs.find(r => r.code === 'US')?.twilio_number || null));
  }, []);

  // Go online: get token and connect Twilio Device
  const goOnline = async () => {
    setStatus('connecting');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/twilio-voice-token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
        }
      );
      const { token, identity, error } = await res.json();
      if (error) { alert('Failed to connect phone: ' + error); setStatus('offline'); return; }

      const newDevice = new Device(token, {
        codecPreferences: ['opus', 'pcmu'],
        logLevel: 1,
      });

      newDevice.on('registered', () => {
        setStatus('online');
        // If a call was requested while offline, place it now that we're connected
        if (pendingCallRef.current) {
          const num = pendingCallRef.current;
          pendingCallRef.current = null;
          setTimeout(() => makeCall(num), 400);
        }
      });

      newDevice.on('incoming', (call) => {
        setStatus('ringing');
        setActiveCall(call);
        setCallInfo({
          from: call.parameters.From || 'Unknown',
          callerName: call.customParameters?.get('callerName') || call.parameters.From || 'Unknown',
          callerNumber: call.customParameters?.get('callerNumber') || call.parameters.From,
        });

        call.on('accept', () => {
          setStatus('on-call');
          startTimer();
        });

        call.on('disconnect', () => {
          endCall();
        });

        call.on('cancel', () => {
          setStatus('online');
          setActiveCall(null);
          setCallInfo(null);
        });
      });

      newDevice.on('error', (err) => {
        console.error('Twilio Device error:', err);
        if (status !== 'on-call') setStatus('online');
      });

      // Access tokens last 1 hour. Without this the device silently drops its
      // registration while the heartbeat below still reports the agent online,
      // so inbound calls ring a dead client and fall through to voicemail.
      newDevice.on('tokenWillExpire', async () => {
        try {
          const { data: { session: s2 } } = await supabase.auth.getSession();
          const r2 = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/twilio-voice-token`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s2?.access_token}` } }
          );
          const { token: fresh } = await r2.json();
          if (fresh) newDevice.updateToken(fresh);
          else console.error('Twilio token refresh returned no token');
        } catch (e) {
          console.error('Twilio token refresh failed:', e);
        }
      });

      newDevice.on('unregistered', () => {
        setStatus('offline');
      });

      await newDevice.register();
      setDevice(newDevice);
      deviceRef.current = newDevice;

    } catch (err) {
      console.error('Phone connect error:', err);
      alert('Failed to connect: ' + err.message);
      setStatus('offline');
    }
  };

  // Go offline
  const goOffline = async () => {
    if (deviceRef.current) {
      deviceRef.current.unregister();
      deviceRef.current.destroy();
      deviceRef.current = null;
      setDevice(null);
    }
    setStatus('offline');
    await supabase.from('agent_status').upsert({
      profile_id: profile.id,
      status: 'offline',
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'profile_id' });
  };

  // Answer incoming call
  const answerCall = () => {
    if (activeCall) {
      activeCall.accept();
    }
  };

  // Reject incoming call
  const rejectCall = () => {
    if (activeCall) {
      activeCall.reject();
      setStatus('online');
      setActiveCall(null);
      setCallInfo(null);
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
    setIsMuted(false);
    setStatus(deviceRef.current ? 'online' : 'offline');
  };

  // Auto go online once on login, so incoming calls ring without clicking "Go Online".
  useEffect(() => {
    if (autoOnlineRef.current) return;
    autoOnlineRef.current = true;
    goOnline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat: keep agent status fresh
  useEffect(() => {
    if (status === 'online' || status === 'on-call') {
      const interval = setInterval(() => {
        // Never claim to be online when the device isn't actually registered —
        // a stale 'online' row makes callers wait through 25s of ringing nothing
        // before voicemail. (Guarded: if the SDK exposes no state, behave as before.)
        const devState = deviceRef.current?.state;
        if (devState && devState !== 'registered' && status !== 'on-call') {
          setStatus('offline');
          return;
        }
        supabase.from('agent_status').upsert({
          profile_id: profile.id,
          status: status === 'on-call' ? 'busy' : 'online',
          last_seen_at: new Date().toISOString(),
        }, { onConflict: 'profile_id' });
      }, 30000); // Every 30s
      return () => clearInterval(interval);
    }
  }, [status, profile.id]);

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
      } else if (status === 'connecting') {
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (deviceRef.current) {
        deviceRef.current.unregister();
        deviceRef.current.destroy();
      }
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const statusColors = {
    offline: 'bg-slate-400',
    connecting: 'bg-amber-400 animate-pulse',
    online: 'bg-emerald-400',
    ringing: 'bg-blue-400 animate-pulse',
    'on-call': 'bg-red-400',
  };

  return (
    <div className="glass px-4 py-2 flex items-center gap-3 h-full overflow-x-auto">
      {/* Status indicator */}
      <div className="flex items-center gap-2">
        <div className={`w-2.5 h-2.5 rounded-full ${statusColors[status]}`} />
        <span className="text-xs font-medium text-paper capitalize">{status === 'on-call' ? 'On Call' : status}</span>
      </div>

      {/* Online/Offline toggle */}
      {(status === 'offline' || status === 'connecting') && (
        <button onClick={goOnline} disabled={status === 'connecting'}
          className="px-3 py-1 text-xs font-semibold rounded-xl bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200 transition disabled:opacity-50">
          {status === 'connecting' ? 'Connecting...' : 'Go Online'}
        </button>
      )}

      {status === 'online' && (
        <>
          <button onClick={goOffline}
            className="px-3 py-1 text-xs font-semibold rounded-xl bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 transition">
            Go Offline
          </button>
          <button onClick={() => setShowDialer(!showDialer)}
            className="px-3 py-1 text-xs font-semibold rounded-xl bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-200 transition">
            {'\u{1F4DE}'} Dial
          </button>
        </>
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
    </div>
  );
}
