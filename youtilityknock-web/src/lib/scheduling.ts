import type { SchedulingSettings } from "../types";

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The weekday (0=Sun) and minutes-from-midnight of a timestamp, as seen in a
// given IANA time zone. Shared logic mirrored server-side in functions.
export function localParts(ms: number, tz: string): { dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "America/Denver",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let dow = 0, hh = 0, mm = 0;
  for (const p of parts) {
    if (p.type === "weekday") dow = wd[p.value] ?? 0;
    else if (p.type === "hour") hh = parseInt(p.value, 10) % 24;
    else if (p.type === "minute") mm = parseInt(p.value, 10);
  }
  return { dow, minutes: hh * 60 + mm };
}

// Validate a proposed appointment time against company scheduling practices.
export function validAppointmentTime(
  ms: number,
  s: SchedulingSettings
): { ok: boolean; reason?: string } {
  const now = Date.now();
  if (ms < now + (s.apptMinLeadHours || 0) * 3600_000)
    return { ok: false, reason: `needs at least ${s.apptMinLeadHours}h lead time` };
  if (ms > now + (s.apptMaxDaysOut || 30) * 86400_000)
    return { ok: false, reason: `must be within ${s.apptMaxDaysOut} days` };
  const { dow, minutes } = localParts(ms, s.timezone);
  if (Array.isArray(s.workDays) && s.workDays.length && !s.workDays.includes(dow))
    return { ok: false, reason: "that day isn't a working day" };
  if (minutes < (s.dayStartMin ?? 0) || minutes > (s.dayEndMin ?? 1440))
    return { ok: false, reason: `outside business hours (${fmtMin(s.dayStartMin)}–${fmtMin(s.dayEndMin)})` };
  return { ok: true };
}

// minutes-from-midnight → "9:00 AM"
export function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}

export function workDaysLabel(days: number[]): string {
  if (!days?.length) return "none";
  return days.slice().sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(", ");
}
