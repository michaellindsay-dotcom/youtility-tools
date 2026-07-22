// Appointment timezones — an appointment happens at a physical ADDRESS, so its
// time is the customer's/on-the-ground local time, NOT the viewer's device zone.
// We only store the address string, so we derive the IANA zone from the US
// state (parsed from the "ST 12345" tail), refining the timezone-split states by
// ZIP prefix. Mirrors tzForAddress() in functions/src/index.ts — keep the two in
// sync.

const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};

// ZIP-3 ranges (inclusive) inside a state that fall in a DIFFERENT zone than the
// state's base entry above — the timezone-split states.
const SPLIT_STATE_TZ: Record<string, Array<[number, number, string]>> = {
  FL: [[324, 325, "America/Chicago"]],                                          // western panhandle → Central
  MI: [[498, 499, "America/Menominee"]],                                        // western UP → Central
  IN: [[463, 464, "America/Chicago"], [476, 477, "America/Chicago"]],           // NW + SW corners → Central
  KY: [[420, 427, "America/Chicago"]],                                          // western KY → Central
  TN: [[373, 374, "America/New_York"], [377, 379, "America/New_York"]],         // east TN → Eastern
  TX: [[798, 799, "America/Denver"], [885, 885, "America/Denver"]],             // El Paso corner → Mountain
  KS: [[677, 677, "America/Denver"], [679, 679, "America/Denver"]],             // far-west KS → Mountain
  NE: [[693, 693, "America/Denver"]],                                           // panhandle → Mountain
  ND: [[586, 586, "America/Denver"]],                                           // SW ND → Mountain
  SD: [[577, 577, "America/Denver"]],                                           // Black Hills → Mountain
  OR: [[979, 979, "America/Denver"]],                                           // Malheur County → Mountain
  ID: [[835, 835, "America/Los_Angeles"], [838, 838, "America/Los_Angeles"]],   // north ID → Pacific
};

// The viewer's own device zone — the sensible fallback when an address can't be
// parsed (a co-located rep's device already matches the customer's zone).
export const DEVICE_TZ =
  (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || "America/Denver";

// IANA timezone for an appointment address. Falls back to `fallback` (default:
// the viewer's device zone) when the address has no recognizable US state.
export function tzForAddress(address?: string | null, fallback?: string): string {
  const fb = fallback || DEVICE_TZ;
  if (!address) return fb;
  const up = String(address).toUpperCase();
  const m = up.match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/); // "ST 12345" tail
  let state = m?.[1] || "";
  const zip3 = m ? parseInt(m[2].slice(0, 3), 10) : NaN;
  if (!(state in STATE_TZ)) {
    const toks = up.split(/[^A-Z]+/).filter((t) => t.length === 2 && t in STATE_TZ);
    state = toks.length ? toks[toks.length - 1] : "";
  }
  if (!(state in STATE_TZ)) return fb;
  if (Number.isFinite(zip3)) {
    for (const [lo, hi, tz] of SPLIT_STATE_TZ[state] || []) {
      if (zip3 >= lo && zip3 <= hi) return tz;
    }
  }
  return STATE_TZ[state];
}

// Offset (localMs − utcMs) of `tz` at the given instant, in ms.
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(utcMs));
  const p: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") p[part.type] = parseInt(part.value, 10);
  const asUTC = Date.UTC(p.year, (p.month || 1) - 1, p.day, (p.hour || 0) % 24, p.minute, p.second);
  return asUTC - utcMs;
}

// Epoch (ms) of a wall-clock time (year, 0-based month, day, minutes-from-
// midnight) interpreted IN a given IANA zone. Two-pass so DST edges resolve.
export function zonedWallClockToEpoch(
  year: number, month0: number, day: number, minutes: number, tz: string,
): number {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const guess = Date.UTC(year, month0, day, hh, mm, 0);
  let epoch = guess - tzOffsetMs(guess, tz);
  epoch = guess - tzOffsetMs(epoch, tz); // refine using the offset at the candidate instant
  return epoch;
}

// Appointment time rendered in the address's local zone, with the zone label so
// the reader never has to guess whose clock it is ("Fri, Aug 1, 9:00 PM EDT").
export function formatApptTime(
  ms: number, address?: string | null, opts?: Intl.DateTimeFormatOptions, fallbackTz?: string,
): string {
  const tz = tzForAddress(address, fallbackTz);
  return new Date(ms).toLocaleString("en-US", {
    timeZone: tz,
    ...(opts || { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    timeZoneName: "short",
  });
}

// Just the clock time (e.g. "9:00 PM EDT") in the address's zone.
export function formatApptClock(ms: number, address?: string | null, fallbackTz?: string): string {
  return formatApptTime(ms, address, { hour: "numeric", minute: "2-digit" }, fallbackTz);
}
