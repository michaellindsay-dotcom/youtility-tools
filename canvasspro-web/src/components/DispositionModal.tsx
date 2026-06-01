import { useEffect, useState } from "react";
import { addDoc, collection, doc, updateDoc } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { Geolocation } from "@capacitor/geolocation";
import { db, auth, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISPOSITIONS } from "../lib/dispositions";
import { lookupAddress, normalizeKnockstatResponse, buildEnrichment } from "../lib/knockstat";
import { bumpStats } from "../lib/stats";
import { useShift } from "../shift/ShiftContext";
import type { LeadStatus, LeadEnrichment, EventType } from "../types";

const ONSITE_FT = 100; // a knock only counts if you're within 100 ft of the home

// Dispositions that warrant scheduling a follow-up on the spot. Each maps to a
// calendar event type and a sensible default lead time.
const SCHEDULE_FOR: Record<string, { eventType: EventType; label: string; defaultLeadMs: number }> = {
  appointment: { eventType: "appointment", label: "Appointment", defaultLeadMs: 60 * 60 * 1000 },
  go_back: { eventType: "go_back", label: "Go-back", defaultLeadMs: 24 * 60 * 60 * 1000 },
  pipeline: { eventType: "follow_up", label: "Follow-up", defaultLeadMs: 3 * 24 * 60 * 60 * 1000 },
};

// datetime-local helper (local time, no seconds).
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// Recursively drop `undefined` values — Firestore rejects a write if any field
// (however deeply nested, e.g. inside ATTOM enrichment) is undefined.
function clean<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map((v) => clean(v)) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== undefined) out[k] = clean(v);
    }
    return out as T;
  }
  return obj;
}

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

export interface DispoInput {
  leadId?: string;
  address: string;
  lat?: number;
  lng?: number;
  status?: LeadStatus;
  name?: string;
  phone?: string;
  email?: string;
  notes?: string;
  enrichment?: LeadEnrichment;
  photoHomeUrl?: string;
  photoBillUrl?: string;
}

interface Form {
  leadId?: string;
  address: string;
  lat?: number;
  lng?: number;
  status: LeadStatus;
  name: string;
  phone: string;
  email: string;
  notes: string;
  enrichment?: LeadEnrichment;
  photoHomeUrl?: string;
  photoBillUrl?: string;
}

function summarize(e?: LeadEnrichment): string {
  if (!e) return "";
  return [
    e.propertyType,
    e.beds != null ? `${e.beds}bd` : null,
    e.baths != null ? `${e.baths}ba` : null,
    e.sqft != null ? `${Number(e.sqft).toLocaleString()} sqft` : null,
    e.yearBuilt ? `built ${e.yearBuilt}` : null,
    e.estValue ? `$${Number(e.estValue).toLocaleString()}` : null,
    e.lastSaleDate ? `sold ${e.lastSaleDate}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function DispositionModal({
  target,
  autoEnrich = true,
  onClose,
  onSaved,
}: {
  target: DispoInput | null;
  autoEnrich?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { profile, companyId, company } = useAuth();
  const { active: onShift, startShift, recordKnock } = useShift();
  const [d, setD] = useState<Form | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  // Geofence: distance to the home, the GPS accuracy margin, whether it counts,
  // and whether we're still acquiring a precise fix.
  const [geo, setGeo] = useState<{ ft: number | null; accFt: number; verified: boolean; locating: boolean }>({
    ft: null,
    accFt: 0,
    verified: true,
    locating: false,
  });
  // On-the-spot scheduling (shown for go-back / pipeline / appointment).
  const [schedule, setSchedule] = useState(true);
  const [scheduleAt, setScheduleAt] = useState("");
  // Photo capture: front of home + utility bill (File = newly picked).
  const [photos, setPhotos] = useState<{ home: File | null; bill: File | null }>({ home: null, bill: null });

  useEffect(() => {
    if (!target) {
      setD(null);
      return;
    }
    setD({
      status: "new",
      name: "",
      phone: "",
      email: "",
      notes: "",
      ...target,
    });
    setSummary(summarize(target.enrichment));
    setGeo({ ft: null, accFt: 0, verified: true, locating: target.lat != null && target.lng != null });
    setSchedule(true);
    setScheduleAt("");
    setPhotos({ home: null, bill: null });
    setErr(null);
    if (autoEnrich && !target.enrichment) void enrich(target.address);
    // Check how far the rep is from the home.
    if (target.lat != null && target.lng != null) void checkGeo(target.lat, target.lng);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // When a schedulable disposition is chosen, prefill a sensible default time.
  useEffect(() => {
    const cfg = d ? SCHEDULE_FOR[d.status] : undefined;
    if (cfg && !scheduleAt) setScheduleAt(toLocalInput(Date.now() + cfg.defaultLeadMs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.status]);

  async function checkGeo(lat: number, lng: number) {
    try {
      // A single getCurrentPosition often returns a coarse first fix (50–70 m
      // off). Watch for a few seconds and keep the most accurate sample, then
      // re-evaluate on each better fix so the badge tightens as GPS settles.
      let best: { latitude: number; longitude: number; accuracy: number } | null = null;
      const evaluate = () => {
        if (!best) return;
        const ft = distanceFt({ lat: best.latitude, lng: best.longitude }, { lat, lng });
        const accFt = Math.round((best.accuracy || 0) * 3.28084);
        // On-site if you're within range — or close enough that the GPS error
        // margin could place you within range.
        const verified = ft - accFt <= ONSITE_FT;
        setGeo({ ft, accFt, verified, locating: false });
      };

      let watchId: string | null = null;
      const stop = () => {
        if (watchId) Geolocation.clearWatch({ id: watchId }).catch(() => {});
        watchId = null;
      };
      // Hard stop after 8s regardless.
      const timer = setTimeout(stop, 8000);

      watchId = await Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
        (pos) => {
          if (!pos) return;
          const a = pos.coords.accuracy ?? 9999;
          if (!best || a < best.accuracy) {
            best = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: a };
            evaluate();
          }
          // Good enough — stop early once we have a tight fix.
          if (a <= 15) {
            clearTimeout(timer);
            stop();
          }
        }
      );
    } catch {
      setGeo({ ft: null, accFt: 0, verified: true, locating: false }); // no GPS → don't penalize
    }
  }

  async function enrich(address: string) {
    setEnriching(true);
    try {
      const token = await auth.currentUser!.getIdToken();
      const rec = normalizeKnockstatResponse(await lookupAddress(address, token));
      const { ownerName, phone, email, enrichment } = buildEnrichment(rec);
      setSummary(summarize(enrichment));
      setD((cur) =>
        cur && cur.address === address
          ? {
              ...cur,
              name: cur.name || ownerName || "",
              phone: cur.phone || phone || "",
              email: cur.email || email || "",
              enrichment,
            }
          : cur
      );
    } catch {
      /* leave fields blank */
    } finally {
      setEnriching(false);
    }
  }

  async function uploadPhoto(file: File, kind: string): Promise<string> {
    const safe = file.name.replace(/[^\w.-]/g, "_");
    const r = storageRef(storage, `leads/${companyId}/${Date.now()}_${kind}_${safe}`);
    await uploadBytes(r, file);
    return getDownloadURL(r);
  }

  async function save() {
    if (!profile || !companyId || !d) return;
    setSaving(true);
    setErr(null);
    try {
      const now = Date.now();

      // Upload any newly captured photos. Non-blocking: a Storage failure must
      // never stop the lead from saving.
      let homeUrl = d.photoHomeUrl ?? null;
      let billUrl = d.photoBillUrl ?? null;
      try {
        if (photos.home) homeUrl = await uploadPhoto(photos.home, "home");
        if (photos.bill) billUrl = await uploadPhoto(photos.bill, "bill");
      } catch (e) {
        console.error("Photo upload failed", e);
        setErr("Photo upload failed (is Storage enabled?) — saved the lead without the new photo.");
      }

      // Strip undefined so Firestore never rejects the whole write (ATTOM
      // enrichment can contain undefined nested values).
      const fields = clean({
        ownerName: d.name || null,
        phone: d.phone || null,
        email: d.email || null,
        notes: d.notes || null,
        status: d.status,
        enrichment: d.enrichment ?? null,
        enriched: !!d.enrichment,
        photoHomeUrl: homeUrl,
        photoBillUrl: billUrl,
        verified: geo.verified,
        distanceFt: geo.ft ?? null,
        knockedAt: now,
        updatedAt: now,
      });

      // The lead is the core deliverable — save it first, on its own.
      let leadId = d.leadId;
      if (leadId) {
        await updateDoc(doc(db, "leads", leadId), fields);
      } else {
        const refDoc = await addDoc(collection(db, "leads"), clean({
          ...fields,
          address: d.address,
          lat: d.lat ?? null,
          lng: d.lng ?? null,
          companyId,
          assignedTo: profile.uid,
          visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
          createdBy: profile.uid,
          createdAt: now,
        }));
        leadId = refDoc.id;
      }

      if (d.status === "appointment") void bumpStats(profile, { appointments: 1 });
      else if (d.status === "sold") void bumpStats(profile, { sales: 1 });
      void recordKnock(geo.verified); // counts toward the active shift if on-site

      // On-the-spot scheduling. Non-blocking: the lead is already saved, so a
      // scheduling failure surfaces a warning but doesn't lose the lead.
      const cfg = SCHEDULE_FOR[d.status];
      if (cfg && schedule && scheduleAt) {
        try {
          await addDoc(collection(db, "events"), clean({
            companyId,
            userId: profile.uid,
            userName: profile.displayName,
            type: cfg.eventType,
            title: `${cfg.label}${d.name ? ` — ${d.name}` : ""}`,
            address: d.address || "",
            leadId,
            startAt: new Date(scheduleAt).getTime(),
            durationMin: company?.scheduling?.apptDurationMin ?? 60,
            endAt: new Date(scheduleAt).getTime() + (company?.scheduling?.apptDurationMin ?? 60) * 60000,
            source: "self_gen",
            notes: d.notes || "",
            visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
            reminded: false,
            createdAt: now,
          }));
        } catch (e) {
          console.error("Scheduling failed", e);
          setErr("Saved the lead, but couldn't add the calendar event. Add it from the Schedule page.");
          onSaved?.();
          return; // keep modal open so the warning is visible
        }
      }

      onSaved?.();
      onClose();
    } catch (e) {
      console.error("Save failed", e);
      setErr((e as Error)?.message || "Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!d) return null;

  // Appointment booking window from company scheduling settings.
  const sched = company?.scheduling;
  const apptMin = sched ? toLocalInput(Date.now() + (sched.apptMinLeadHours || 0) * 3600_000) : undefined;
  const apptMax = sched ? toLocalInput(Date.now() + (sched.apptMaxDaysOut || 30) * 86400_000) : undefined;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="dispo-card" onClick={(e) => e.stopPropagation()}>
        <div className="dispo-head">
          <div>
            <h3>{d.leadId ? "Home / Disposition" : "Log Disposition"}</h3>
            <div className="muted small">{d.address}</div>
          </div>
          <button className="dispo-x" onClick={onClose}>✕</button>
        </div>

        <div className="field-label">Disposition</div>
        <div className="dispo-grid">
          {DISPOSITIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={"dispo-pill" + (d.status === opt.value ? " active" : "")}
              style={{
                borderColor: opt.color,
                ...(d.status === opt.value ? { background: opt.color, color: "#06121f" } : {}),
              }}
              onClick={() => setD({ ...d, status: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {(summary || enriching) && (
          <div className="muted small dispo-summary">{enriching ? "Looking up home data…" : summary}</div>
        )}

        {geo.locating && (
          <div className="muted small dispo-summary">📍 Getting a precise location…</div>
        )}

        {geo.ft != null && !geo.locating && !geo.verified && (
          <div className="banner warn show" style={{ marginBottom: 10 }}>
            ⚠ You're <strong>{geo.ft} ft</strong> from this home (over {ONSITE_FT} ft
            {geo.accFt > 0 ? `, GPS ±${geo.accFt} ft` : ""}). This won't count toward your door knocks or stats.
          </div>
        )}

        {!onShift && geo.ft != null && !geo.locating && geo.verified && (
          <div className="banner info show start-shift-prompt" style={{ marginBottom: 10 }}>
            <span>You're on-site but not on a shift — start one so this knock counts.</span>
            <button className="btn primary sm" onClick={() => startShift()}>▶ Start Shift</button>
          </div>
        )}

        <label className="field">
          <span>Address</span>
          <input value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Name</span>
            <input value={d.name} placeholder="Full name" onChange={(e) => setD({ ...d, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Phone</span>
            <input value={d.phone} placeholder="(555) 000-0000" onChange={(e) => setD({ ...d, phone: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Email</span>
          <input value={d.email} placeholder="email@example.com" onChange={(e) => setD({ ...d, email: e.target.value })} />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={d.notes} placeholder="Add notes…" onChange={(e) => setD({ ...d, notes: e.target.value })} />
        </label>

        {SCHEDULE_FOR[d.status] && (
          <div className="dispo-schedule">
            <label className="dispo-sched-toggle">
              <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} />
              <span>📅 Schedule {SCHEDULE_FOR[d.status].label.toLowerCase()}</span>
            </label>
            {schedule && (
              <>
                <input
                  type="datetime-local"
                  className="dispo-sched-input"
                  value={scheduleAt}
                  min={d.status === "appointment" ? apptMin : undefined}
                  max={d.status === "appointment" ? apptMax : undefined}
                  onChange={(e) => setScheduleAt(e.target.value)}
                />
                {d.status === "appointment" && company?.scheduling && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    {company.scheduling.apptDurationMin}-min appointment · book {company.scheduling.apptMinLeadHours}h+
                    out, within {company.scheduling.apptMaxDaysOut} days
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {SCHEDULE_FOR[d.status] && (
          <div className="dispo-photos">
            <div className="field-label">Photos</div>
            <div className="photo-grid">
              <PhotoSlot
                label="Front of home"
                icon="🏠"
                file={photos.home}
                existingUrl={d.photoHomeUrl}
                onPick={(f) => setPhotos((p) => ({ ...p, home: f }))}
              />
              <PhotoSlot
                label="Utility bill"
                icon="🧾"
                file={photos.bill}
                existingUrl={d.photoBillUrl}
                onPick={(f) => setPhotos((p) => ({ ...p, bill: f }))}
              />
            </div>
          </div>
        )}

        {err && (
          <div className="banner warn show" style={{ marginBottom: 10 }}>
            {err}
          </div>
        )}

        <div className="dispo-foot">
          <span className="muted small mono">
            {d.lat != null && d.lng != null ? `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}` : ""}
          </span>
          <div className="row">
            <button className="btn ghost sm" onClick={onClose}>Cancel</button>
            <button className="btn primary sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : d.leadId ? "Save" : "Add Lead"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// A single photo capture slot. On mobile, `capture` opens the camera directly;
// on desktop it falls back to a file picker. Shows a thumbnail once chosen.
function PhotoSlot({
  label,
  icon,
  file,
  existingUrl,
  onPick,
}: {
  label: string;
  icon: string;
  file: File | null;
  existingUrl?: string;
  onPick: (f: File | null) => void;
}) {
  const [preview, setPreview] = useState<string | undefined>(existingUrl);
  useEffect(() => {
    if (!file) {
      setPreview(existingUrl);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, existingUrl]);

  const id = `photo-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="photo-slot">
      <input
        id={id}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <label htmlFor={id} className="photo-drop">
        {preview ? (
          <img src={preview} alt={label} className="photo-thumb" />
        ) : (
          <span className="photo-ico">{icon}</span>
        )}
        <span className="photo-label">{preview ? `${label} ✓` : `📷 ${label}`}</span>
      </label>
      {file && (
        <button type="button" className="btn ghost sm photo-clear" onClick={() => onPick(null)}>
          Remove
        </button>
      )}
    </div>
  );
}
