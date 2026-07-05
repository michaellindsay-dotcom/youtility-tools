import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { doc, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { Geolocation } from "@capacitor/geolocation";
import { db, functions } from "../firebase";
import { APPT_DISPOSITIONS } from "../lib/closerDispositions";
import type { ApptStatus, Lead, ScheduleEvent } from "../types";

const ONSITE_FT = 100; // a disposition only counts within 100 ft of the home

// Distance between two lat/lng points, in feet.
function distanceFt(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 20925524.9; // earth radius in feet
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

const closerDispositionFn = httpsCallable<
  { eventId: string; status: ApptStatus; notes: string; distanceFt: number | null; verified: boolean; followUpAt?: number; afterTheFact?: boolean },
  { ok: boolean; status: ApptStatus; onSite: boolean; followUpId: string | null }
>(functions, "closerDisposition");

export default function CloserDispositionModal({
  event,
  onClose,
  onDone,
  // After-the-fact: closing out a past appointment from the calendar rather than
  // at the door. Skips the geofence entirely and records it as not-on-the-spot.
  afterTheFact = false,
}: {
  event: ScheduleEvent | null;
  onClose: () => void;
  onDone?: () => void;
  afterTheFact?: boolean;
}) {
  const [status, setStatus] = useState<ApptStatus | null>(null);
  const [notes, setNotes] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Geofence: distance to the home + whether the closer is on-site.
  const [geo, setGeo] = useState<{ ft: number | null; accFt: number; verified: boolean; locating: boolean; hasHome: boolean }>({
    ft: null, accFt: 0, verified: true, locating: false, hasHome: false,
  });

  useEffect(() => {
    if (!event) return;
    setStatus(null);
    setNotes("");
    setFollowUpAt("");
    setErr(null);
    // After-the-fact entries aren't geofenced — go straight to a neutral state.
    if (afterTheFact) {
      setGeo({ ft: null, accFt: 0, verified: true, locating: false, hasHome: false });
    } else {
      setGeo({ ft: null, accFt: 0, verified: true, locating: true, hasHome: false });
      void locate(event);
    }
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id]);

  // The home's coordinates live on the lead, not the event — fetch them so we
  // can geofence the disposition. No coords (or no GPS) → we don't penalize.
  async function locate(ev: ScheduleEvent) {
    let home: { lat: number; lng: number } | null = null;
    try {
      if (ev.leadId) {
        const snap = await getDoc(doc(db, "leads", ev.leadId));
        if (snap.exists()) {
          const l = snap.data() as Lead;
          if (l.lat != null && l.lng != null) home = { lat: l.lat, lng: l.lng };
        }
      }
    } catch { /* ignore */ }
    if (!home) {
      setGeo({ ft: null, accFt: 0, verified: true, locating: false, hasHome: false });
      return;
    }
    setGeo((g) => ({ ...g, hasHome: true, locating: true }));
    try {
      let best: { latitude: number; longitude: number; accuracy: number } | null = null;
      let watchId: string | null = null;
      const stop = () => { if (watchId) Geolocation.clearWatch({ id: watchId }).catch(() => {}); watchId = null; };
      const timer = setTimeout(stop, 8000);
      const evaluate = () => {
        if (!best || !home) return;
        const ft = distanceFt({ lat: best.latitude, lng: best.longitude }, home);
        const accFt = Math.round((best.accuracy || 0) * 3.28084);
        const verified = ft - accFt <= ONSITE_FT;
        setGeo({ ft, accFt, verified, locating: false, hasHome: true });
      };
      watchId = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }, (pos) => {
        if (!pos) return;
        const a = pos.coords.accuracy ?? 9999;
        if (!best || a < best.accuracy) {
          best = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: a };
          evaluate();
        }
        if (a <= 15) { clearTimeout(timer); stop(); }
      });
    } catch {
      setGeo({ ft: null, accFt: 0, verified: true, locating: false, hasHome: true });
    }
  }

  if (!event) return null;

  const chosen = APPT_DISPOSITIONS.find((d) => d.value === status);
  const needsFollowUp = chosen?.value === "pitched_pending"; // mandatory next appt
  const showFollowUp = !!chosen?.followUp && geo.verified; // off-site → becomes no-show, no follow-up
  const offSite = geo.hasHome && !geo.locating && !geo.verified;

  async function submit() {
    if (!event || !status) { setErr("Pick a disposition."); return; }
    if (!notes.trim()) { setErr("Notes are required on every disposition."); return; }
    if (geo.verified && needsFollowUp && !followUpAt) {
      setErr("Pick a follow-up date to schedule the next appointment.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await closerDispositionFn({
        eventId: event.id,
        status,
        notes: notes.trim(),
        distanceFt: afterTheFact ? null : geo.ft,
        verified: geo.verified,
        followUpAt: showFollowUp && followUpAt ? new Date(followUpAt).getTime() : undefined,
        afterTheFact,
      });
      onDone?.();
      onClose();
      if (res.data && !res.data.onSite) {
        // surfaced for the closer's awareness — they were logged off-site
        console.warn("Logged as closer no-show (off-site).");
      }
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't save the disposition.");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="dispo-card" onClick={(e) => e.stopPropagation()}>
        <div className="dispo-head">
          <div>
            <h3>{afterTheFact ? "Close-out (after the fact)" : "Close-out"}</h3>
            <div className="muted small">{event.title || event.address}</div>
          </div>
          <button className="dispo-x" onClick={onClose}>✕</button>
        </div>

        {afterTheFact && (
          <div className="banner info show" style={{ marginBottom: 10 }}>
            📆 Logging this after the fact. It records the real outcome, but counts as
            <strong> not dispositioned on the spot</strong> in your manager's report.
          </div>
        )}

        {geo.locating && <div className="muted small dispo-summary">📍 Getting a precise location…</div>}

        {offSite && (
          <div className="banner warn show" style={{ marginBottom: 10 }}>
            ⚠ You're <strong>{geo.ft} ft</strong> from this home (over {ONSITE_FT} ft
            {geo.accFt > 0 ? `, GPS ±${geo.accFt} ft` : ""}). Saving now logs a <strong>Closer No-Show</strong> for management.
          </div>
        )}

        <div className="field-label">Disposition</div>
        <div className="dispo-grid">
          {APPT_DISPOSITIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={"dispo-pill" + (status === opt.value ? " active" : "")}
              style={{ borderColor: opt.color, ...(status === opt.value ? { background: opt.color, color: "#06121f" } : {}) }}
              onClick={() => setStatus(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {showFollowUp && (
          <div className="dispo-schedule">
            <div className="field-label">
              {needsFollowUp ? "Follow-up date (required)" : "Reschedule for"}
            </div>
            <input
              type="datetime-local"
              className="dispo-sched-input"
              value={followUpAt}
              min={toLocalInput(Date.now())}
              onChange={(e) => setFollowUpAt(e.target.value)}
            />
            <div className="muted small" style={{ marginTop: 6 }}>
              A new appointment will be scheduled for you with this homeowner.
            </div>
          </div>
        )}

        <label className="field">
          <span>Notes (required — sent to the setter)</span>
          <textarea rows={3} value={notes} placeholder="What happened on this appointment…" onChange={(e) => setNotes(e.target.value)} />
        </label>

        {err && <div className="banner warn show" style={{ marginBottom: 10 }}>{err}</div>}

        <div className="dispo-foot">
          <span className="muted small mono">
            {geo.hasHome && geo.ft != null ? `${geo.ft} ft away` : ""}
          </span>
          <div className="row">
            <button className="btn ghost sm" onClick={onClose}>Cancel</button>
            <button className="btn primary sm" onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Save disposition"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
