// Closer appointment dispositions — the single source of truth for the outcomes
// a closer can record on an assigned appointment, mirrored server-side in
// functions. A "sit" (a real pitch happened) drives both the setter's sit % and
// the closer's close %; closed_won additionally counts as a close.
import type { ApptStatus, ScheduleEvent } from "../types";

export interface ApptDispo {
  value: ApptStatus;
  label: string;
  color: string;
  /** Counts as a sit (the closer actually pitched the homeowner). */
  sit: boolean;
  /** Requires a follow-up date + a new appointment to be scheduled. */
  followUp?: boolean;
}

// The six outcomes a closer chooses from. closer_no_show is never chosen — it's
// applied automatically when the closer dispositions away from the home.
export const APPT_DISPOSITIONS: ApptDispo[] = [
  { value: "pitched_pending", label: "Pitched — Pending", color: "#A78BFA", sit: true, followUp: true },
  { value: "pitched_not_interested", label: "Pitched — Not Interested", color: "#F87171", sit: true },
  { value: "pitched_failed_credit", label: "Pitched — Failed Credit", color: "#FB923C", sit: true },
  { value: "closed_won", label: "Closed / Won", color: "#22C55E", sit: true },
  { value: "no_show", label: "No Show", color: "#64748B", sit: false },
  // Homeowner was there but turned the closer away before a pitch. Not a sit,
  // and deliberately NOT counted as a "pitched appointment" against the setter's
  // sit rate (server drops it from the setter's denominator).
  { value: "turned_away", label: "Turned Away", color: "#EAB308", sit: false },
  { value: "reschedule", label: "Reschedule", color: "#38BDF8", sit: false, followUp: true },
];

export const APPT_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  closer_no_show: "Closer No Show",
  ...Object.fromEntries(APPT_DISPOSITIONS.map((d) => [d.value, d.label])),
};
export const APPT_COLOR: Record<string, string> = {
  scheduled: "#94A3B8",
  closer_no_show: "#EF4444",
  ...Object.fromEntries(APPT_DISPOSITIONS.map((d) => [d.value, d.color])),
};

// Statuses that count as a sit (a real pitch happened).
export const SIT_STATUSES: ReadonlySet<ApptStatus> = new Set<ApptStatus>(
  APPT_DISPOSITIONS.filter((d) => d.sit).map((d) => d.value)
);

export function isSit(status?: ApptStatus | string | null): boolean {
  return !!status && SIT_STATUSES.has(status as ApptStatus);
}

// An appointment routed to a closer (the source rows for closer metrics).
export function isCloserAppt(e: Pick<ScheduleEvent, "type" | "closerUid">): boolean {
  return e.type === "appointment" && !!e.closerUid;
}

// "Dispositioned" = the closer recorded a real outcome (past the initial
// "scheduled" / blank state).
export function isDispositioned(e: Pick<ScheduleEvent, "apptStatus">): boolean {
  return !!e.apptStatus && e.apptStatus !== "scheduled";
}

// A closer appointment whose time has passed but still has no outcome — the
// actionable "you owe a disposition" set (drives the dashboard alert).
export function isUndispositionedPast(
  e: Pick<ScheduleEvent, "type" | "closerUid" | "apptStatus" | "startAt">,
  now = Date.now()
): boolean {
  return isCloserAppt(e) && !isDispositioned(e) && e.startAt < now;
}

// "On the spot" = closed out AT the appointment (on-site, right then), not later
// from the calendar. New dispositions store the flag; for legacy events we infer
// it — on-site AND recorded the same calendar day as the appointment.
export function wasOnSpot(
  e: Pick<ScheduleEvent, "apptStatus" | "dispositionedOnSpot" | "dispositionVerified" | "dispositionedAt" | "startAt">
): boolean {
  if (!isDispositioned(e)) return false;
  if (typeof e.dispositionedOnSpot === "boolean") return e.dispositionedOnSpot;
  const sameDay =
    e.dispositionedAt != null &&
    new Date(e.dispositionedAt).toDateString() === new Date(e.startAt).toDateString();
  return e.dispositionVerified !== false && sameDay;
}
