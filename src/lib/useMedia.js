import { useEffect, useState } from 'react';

/** True while the viewport matches a media query; re-renders when it changes. */
export function useMedia(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', onChange); else mq.removeListener(onChange); };
  }, [query]);
  return matches;
}

/** The phone layout boundary: below Tailwind's lg (1024px) the tab bar and sheets take over. */
export const useIsMobile = () => useMedia('(max-width: 1023px)');
