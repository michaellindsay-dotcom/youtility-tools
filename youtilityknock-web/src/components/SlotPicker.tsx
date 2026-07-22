import { useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import type { SchedulingSettings } from "../types";
import { tzForAddress, zonedWallClockToEpoch, formatApptClock, DEVICE_TZ } from "../lib/timezones";

const DAY = 86_400_000;
const getTeamFreeSlotsFn = httpsCallable<
  { durationMin: number; candidates: number[] },
  { free: number[] }
>(functions, "getTeamFreeSlots");
const getFreeSlotsFn = httpsCallable<
  { uid?: string; durationMin?: number; candidates: number[] },
  { free: number[] }
>(functions, "getFreeSlots");

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dayLabel(ms: number): string {
  const diff = Math.round((startOfDay(ms) - startOfDay(Date.now())) / DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function timeLabel(ms: number, tz: string): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz });
}
// "YYYY-MM-DD" for an <input type=date> in local time.
function dateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Availability picker: shows the hours open on a day; if a day has none it
// auto-advances to the next day that does. Step days with ‹ ›, and once you're
// more than 2 days out a date picker appears to jump straight to a date.
export default function SlotPicker({
  sched, value, onChange, uid, pool, address,
}: {
  sched: SchedulingSettings;
  value: number | null;
  onChange: (ms: number) => void;
  uid?: string;
  pool?: "closers"; // "closers" = offer a slot if ANY closer is free (union)
  address?: string; // appointment address — its timezone is the customer's local time
}) {
  const today = startOfDay(Date.now());
  const minLeadMs = (sched.apptMinLeadHours ?? 1) * 3_600_000;
  const maxDaysOut = sched.apptMaxDaysOut ?? 30;
  const lastAt = today + (maxDaysOut + 1) * DAY;
  const durationMin = sched.apptDurationMin ?? 60;
  // The picked time means the CUSTOMER's local time — build and label every slot
  // in the address's zone, not the device's. With no/unparseable address this is
  // the device zone, so a co-located rep sees no change.
  const tz = tzForAddress(address);
  const showZone = tz !== DEVICE_TZ;

  const [dayMs, setDayMs] = useState(today);
  const [slots, setSlots] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);

  // Candidate hourly starts for a calendar day, within business hours + window.
  const candidatesFor = useMemo(() => (d: number): number[] => {
    const dow = new Date(d).getDay();
    if (Array.isArray(sched.workDays) && sched.workDays.length && !sched.workDays.includes(dow)) return [];
    const startMin = sched.dayStartMin ?? 540;
    const endMin = sched.dayEndMin ?? 1200;
    const firstAt = Date.now() + minLeadMs;
    const base = new Date(d);
    const y = base.getFullYear(), mo = base.getMonth(), day = base.getDate();
    const out: number[] = [];
    for (let m = startMin; m <= endMin - durationMin; m += 60) {
      // Business hours are the customer's local hours — build the instant for
      // this wall-clock minute IN the address's zone.
      const ms = zonedWallClockToEpoch(y, mo, day, m, tz);
      if (ms >= firstAt && ms <= lastAt) out.push(ms);
    }
    return out;
  }, [sched.workDays, sched.dayStartMin, sched.dayEndMin, durationMin, minLeadMs, lastAt, tz]);

  // Find free slots for the requested day, advancing to the next day that has
  // any. Lands `dayMs` on the first day with openings.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let probe = startOfDay(dayMs);
      for (let i = 0; i < maxDaysOut + 1 && probe <= lastAt; i++, probe += DAY) {
        const cands = candidatesFor(probe);
        if (!cands.length) continue;
        try {
          const { data } = pool === "closers"
            ? await getTeamFreeSlotsFn({ durationMin, candidates: cands })
            : await getFreeSlotsFn({ uid, durationMin, candidates: cands });
          if (cancelled) return;
          const free = (data?.free || []).slice().sort((a, b) => a - b);
          if (free.length) {
            if (probe !== dayMs) setDayMs(probe);
            setSlots(free);
            setLoading(false);
            return;
          }
        } catch { /* treat as no openings */ }
      }
      if (!cancelled) { setSlots([]); setLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayMs, candidatesFor, uid, durationMin, pool]);

  const canPrev = dayMs > today;
  const canNext = dayMs + DAY <= lastAt;
  const showDatePicker = dayMs > today + 2 * DAY;

  return (
    <div className="slot-picker">
      <div className="row between" style={{ alignItems: "center", gap: 8 }}>
        <button type="button" className="btn ghost sm" disabled={!canPrev}
          onClick={() => setDayMs((d) => Math.max(today, startOfDay(d) - DAY))}>‹</button>
        <strong style={{ flex: 1, textAlign: "center" }}>{dayLabel(dayMs)}</strong>
        <button type="button" className="btn ghost sm" disabled={!canNext}
          onClick={() => setDayMs((d) => startOfDay(d) + DAY)}>›</button>
      </div>

      {(showDatePicker || slots.length === 0) && (
        <label className="field" style={{ marginTop: 8 }}>
          <span className="muted small">Jump to a date</span>
          <input
            type="date"
            value={dateInputValue(dayMs)}
            min={dateInputValue(today)}
            max={dateInputValue(lastAt - DAY)}
            onChange={(e) => {
              if (!e.target.value) return;
              const [y, m, dd] = e.target.value.split("-").map(Number);
              setDayMs(startOfDay(new Date(y, m - 1, dd).getTime()));
            }}
          />
        </label>
      )}

      <div style={{ marginTop: 10 }}>
        {loading ? (
          <div className="muted small">Checking availability…</div>
        ) : slots.length === 0 ? (
          <div className="muted small">No openings within the booking window — try another date above.</div>
        ) : (
          <div className="slot-grid" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {slots.map((ms) => (
              <button
                key={ms}
                type="button"
                className={"pill" + (value === ms ? " active" : "")}
                onClick={() => onChange(ms)}
              >
                {timeLabel(ms, tz)}
              </button>
            ))}
          </div>
        )}
      </div>

      {showZone && (
        <div className="muted small" style={{ marginTop: 8 }}>
          Times shown in the customer's local time zone.
        </div>
      )}

      {value != null && (
        <div className="muted small" style={{ marginTop: 8 }}>
          Selected: {dayLabel(value)} · {formatApptClock(value, address)}
        </div>
      )}
    </div>
  );
}
