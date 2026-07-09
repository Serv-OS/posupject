import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabase';

// Single source of truth for the personal Google (Gmail + Calendar) connection.
import { getGoogleClientId } from './googleClientId';
const REDIRECT_URI = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-oauth-callback`;
const SCOPES = 'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.memberships.readonly https://www.googleapis.com/auth/directory.readonly';

// Launch the Google OAuth popup. Resolves the user's session token into the
// `state` so the callback knows which profile to attach the tokens to.
export async function connectGoogle() {
  // Open the popup synchronously (inside the click gesture) BEFORE any await, or
  // the browser blocks it. We point it at the auth URL once the session/client-id
  // work resolves.
  const w = 500, h = 640;
  const popup = window.open('', 'google-oauth', `width=${w},height=${h},left=${(screen.width - w) / 2},top=${(screen.height - h) / 2}`);
  const { data: { session } } = await supabase.auth.getSession();
  const clientId = await getGoogleClientId();
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&access_type=offline&prompt=consent` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent('personal:' + (session?.access_token || ''))}`;
  if (popup) popup.location.href = url; else window.location.href = url;
}

// Hook: tracks whether the current user has connected Google, auto-refreshing
// when the OAuth popup reports success. Returns { connected, connect, refresh }.
//   connected: null = loading, false = not connected, object = connected ({ email })
export function useGoogleConnection(profileId) {
  const [connected, setConnected] = useState(null);

  const refresh = useCallback(() => {
    if (!profileId) return;
    supabase.from('user_integrations').select('email').eq('profile_id', profileId).maybeSingle()
      .then(r => setConnected(r.data || false));
  }, [profileId]);

  useEffect(() => {
    refresh();
    const handler = (e) => {
      if (e.data?.type === 'google-oauth-result' && e.data.success) setTimeout(refresh, 500);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [profileId, refresh]);

  return { connected, connect: connectGoogle, refresh };
}
