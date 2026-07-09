// Shared business-hours helper — phone routing (out-of-hours → voicemail) and
// out-of-hours auto-replies. business_hours shape:
//   { mon:{open:"09:00",close:"17:00",closed:false}, ..., sun:{closed:true} }
// Times are "HH:MM" 24h in the configured IANA timezone (business_timezone).

type Day = { open?: string; close?: string; closed?: boolean };
export interface HoursSettings {
  business_hours_enabled?: boolean;
  business_timezone?: string | null;
  business_hours?: Record<string, Day> | null;
}

/** True if `now` falls within configured open hours. When hours aren't
 *  enabled/configured, defaults to OPEN so nothing changes until it's set up. */
export function isOpenNow(s: HoursSettings | null | undefined, now: Date = new Date()): boolean {
  if (!s?.business_hours_enabled) return true;
  const tz = s.business_timezone || "UTC";
  const hours = s.business_hours || {};
  let wd: string, cur: string;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    wd = get("weekday").toLowerCase().slice(0, 3);
    let hh = get("hour"); if (hh === "24") hh = "00";
    cur = `${hh.padStart(2, "0")}:${get("minute").padStart(2, "0")}`;
  } catch { return true; } // bad timezone → never block a caller
  const day = hours[wd];
  if (!day || day.closed || !day.open || !day.close) return false;
  return cur >= day.open && cur < day.close;
}
