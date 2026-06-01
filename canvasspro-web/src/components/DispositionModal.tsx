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
  const { profile, companyId } = useAuth();
  const { active: onShift, startShift, recordKnock } = useShift();
  const [d, setD] = useState<Form | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState("");
  // Geofence: distance from the rep to this home (ft) and whether it counts.
  const [geo, setGeo] = useState<{ ft: number | null; verified: boolean }>({ ft: null, verified: true });
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
    setGeo({ ft: null, verified: true });
    setSchedule(true);
    setScheduleAt("");
    setPhotos({ home: null, bill: null });
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
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
      const ft = distanceFt({ lat: pos.coords.latitude, lng: pos.coords.longitude }, { lat, lng });
      setGeo({ ft, verified: ft <= ONSITE_FT });
    } catch {
      setGeo({ ft: null, verified: true }); // no GPS → don't penalize
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
    try {
      const now = Date.now();
      // Upload any newly captured photos first, falling back to existing URLs.
      let homeUrl = d.photoHomeUrl ?? null;
      let billUrl = d.photoBillUrl ?? null;
      try {
        if (photos.home) homeUrl = await uploadPhoto(photos.home, "home");
        if (photos.bill) billUrl = await uploadPhoto(photos.bill, "bill");
      } catch (err) {
        console.error("Photo upload failed", err);
        alert("Photo upload failed. Make sure Firebase Storage is enabled — saving without the new photo.");
      }

      const fields = {
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
      };
      let leadId = d.leadId;
      if (leadId) {
        await updateDoc(doc(db, "leads", leadId), fields);
      } else {
        const refDoc = await addDoc(collection(db, "leads"), {
          ...fields,
          address: d.address,
          lat: d.lat ?? null,
          lng: d.lng ?? null,
          companyId,
          assignedTo: profile.uid,
          visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
          createdBy: profile.uid,
          createdAt: now,
        });
        leadId = refDoc.id;
      }

      // On-the-spot scheduling for go-back / pipeline / appointment.
      const cfg = SCHEDULE_FOR[d.status];
      if (cfg && schedule && scheduleAt) {
        await addDoc(collection(db, "events"), {
          companyId,
          userId: profile.uid,
          userName: profile.displayName,
          type: cfg.eventType,
          title: `${cfg.label}${d.name ? ` — ${d.name}` : ""}`,
          address: d.address,
          leadId,
          startAt: new Date(scheduleAt).getTime(),
          notes: d.notes || "",
          visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
          reminded: false,
          createdAt: now,
        });
      }

      if (d.status === "appointment") void bumpStats(profile, { appointments: 1 });
      else if (d.status === "sold") void bumpStats(profile, { sales: 1 });
      void recordKnock(geo.verified); // counts toward the active shift if on-site
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  if (!d) return null;

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

        {geo.ft != null && !geo.verified && (
          <div className="banner warn show" style={{ marginBottom: 10 }}>
            ⚠ You're <strong>{geo.ft} ft</strong> from this home (over {ONSITE_FT} ft). This won't count toward
            your door knocks or stats.
          </div>
        )}

        {!onShift && geo.ft != null && geo.verified && (
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
              <input
                type="datetime-local"
                className="dispo-sched-input"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
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
