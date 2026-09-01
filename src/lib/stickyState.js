import { useEffect, useState } from 'react';

// Filters that survive going into a record and coming back.
//
// The CRM navigates by replacing the whole view, so every list remounted with
// fresh state: filter the tickets, open one, come back, and you are staring at
// "all" again. Anyone working a filtered queue had to re-set it on every single
// item, which is exactly when it is most annoying.
//
// sessionStorage rather than localStorage on purpose: a filter is about what
// you are doing right now, not forever. A new tab, or tomorrow, starts clean —
// otherwise people hit a list that looks empty and think the data is gone.

const KEY = (name) => `crm.filter.${name}`;

export function useStickyState(name, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = sessionStorage.getItem(KEY(name));
      if (raw === null) return initial;
      const saved = JSON.parse(raw);
      // Shapes change as screens gain filters. Merge onto the current default
      // so an old saved object can never resurrect a field that no longer
      // exists, or miss one that was added since.
      if (initial && typeof initial === 'object' && !Array.isArray(initial)
          && saved && typeof saved === 'object' && !Array.isArray(saved)) {
        return { ...initial, ...saved };
      }
      return saved;
    } catch {
      return initial;   // private mode, or corrupt JSON — never break the page
    }
  });

  useEffect(() => {
    try { sessionStorage.setItem(KEY(name), JSON.stringify(value)); } catch { /* ignore */ }
  }, [name, value]);

  return [value, setValue];
}

/** Wipe a screen's remembered filters — for an explicit "Clear filters" button. */
export function clearSticky(name) {
  try { sessionStorage.removeItem(KEY(name)); } catch { /* ignore */ }
}
