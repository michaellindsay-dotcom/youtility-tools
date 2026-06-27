import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { addDoc, collection, doc, increment, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { Geolocation } from "@capacitor/geolocation";
import { db, auth, storage, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISPOSITIONS } from "../lib/dispositions";
import { lookupAddress, normalizeKnockstatResponse, buildEnrichment } from "../lib/knockstat";
import { bumpStats } from "../lib/stats";
import { hasFeature } from "../lib/features";
import { fetchAreaIncentives, incentiveDates, type AreaIncentive } from "../lib/incentives";
import { usePitchRecorder, pitchSupported } from "../lib/pitch";
import { validAppointmentTime } from "../lib/scheduling";
import { useShift } from "../shift/ShiftContext";
import type { LeadStatus, LeadEnrichment, EventType } from "../types";

const ONSITE_FT = 100; // a knock only counts if you're within 100 ft of the home

const createCloserAppointmentFn = httpsCallable<
  { companyId: string; startAt: number; durationMin?: number; title?: string; address?: string; name?: string; notes?: string; leadId?: string; candidateCloserUid?: string },
  { ok: boolean; eventId: string; closerUid: string; closerName: string }
>(functions, "createCloserAppointment");
const listClosersFn = httpsCallable<Record<string, never>, { closers: { uid: string; name: string }[] }>(functions, "listClosers");

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
  // Pitch coaching: record the rep's pitch while this modal is open, upload on
  // save, and let the AI pipeline grade it. Opt-in feature + one-time consent.
  const pitch = usePitchRecorder();
  const pitchOn = pitchSupported && hasFeature(company, "pitch") && !!profile;
  const [d, setD] = useState<Form | null>(null);
  // Two-step flow: step 1 = disposition + contact details; step 2 (only for
  // dispositions that schedule a follow-up or are sold) = appointment + photos.
  const [step, setStep] = useState<1 | 2>(1);
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
  // Closer workflow: when enabled, an appointment routes to a closer. For the
  // "setter_select" method the setter picks the closer here.
  const closersOn = !!company?.scheduling?.closersEnabled;
  const setterSelect = closersOn && company?.scheduling?.closerAssignment === "setter_select";
  const [closers, setClosers] = useState<{ uid: string; name: string }[]>([]);
  const [closerUid, setCloserUid] = useState("");
  // Area energy incentives — loaded on demand so the setter can mention them,
  // and saved onto the lead so they travel to the closer with the appointment.
  const [incentives, setIncentives] = useState<AreaIncentive[]>([]);
  const [incUtility, setIncUtility] = useState<{ name: string; rate: number | null } | null>(null);
  const [incLoading, setIncLoading] = useState(false);
  const [incErr, setIncErr] = useState("");

  const loadIncentives = async () => {
    if (!d) return;
    setIncErr("");
    setIncLoading(true);
    try {
      const m = (d.address || "").match(/\b([A-Z]{2})\b[ ,]+(\d{5})/);
      const rep = await fetchAreaIncentives({
        address: d.address || "",
        state: m?.[1], zip: m?.[2],
        lat: typeof d.lat === "number" ? d.lat : undefined,
        lng: typeof d.lng === "number" ? d.lng : undefined,
      });
      setIncentives(rep.incentives || []);
      setIncUtility(rep.utility || null);
    } catch (e) {
      setIncErr((e as { message?: string })?.message || "Couldn't load incentives.");
    } finally {
      setIncLoading(false);
    }
  };

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
    setStep(1);
    setSummary(summarize(target.enrichment));
    setGeo({ ft: null, accFt: 0, verified: true, locating: target.lat != null && target.lng != null });
    setSchedule(true);
    setScheduleAt("");
    setPhotos({ home: null, bill: null });
    setCloserUid("");
    setErr(null);
    // Pre-fill any incentives captured earlier on this lead; otherwise clear.
    setIncentives(Array.isArray((target as { incentives?: AreaIncentive[] }).incentives) ? (target as { incentives?: AreaIncentive[] }).incentives! : []);
    setIncUtility((target as { incentivesUtility?: { name: string; rate: number | null } | null }).incentivesUtility || null);
    setIncErr("");
    // Load the closer list once if the setter must pick one.
    if (setterSelect && closers.length === 0) {
      listClosersFn({}).then((r) => setClosers(r.data.closers || [])).catch(() => {});
    }
    if (autoEnrich && !target.enrichment) void enrich(target.address);
    // Check how far the rep is from the home.
    if (target.lat != null && target.lng != null) void checkGeo(target.lat, target.lng);
    // Start recording the pitch (only once consent has been given).
    if (pitchOn && pitch.consented) void pitch.start();
    // Discard the recording if the modal closes without saving (save() uploads).
    return () => pitch.discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // While the modal is open, flag the body so the floating chat button hides
  // (it otherwise overlaps the Cancel / Add Lead actions).
  useEffect(() => {
    if (!target) return;
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
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
    // Require a closer up-front (setter_select) so we never save the lead +
    // count the appointment, then bail before routing — which would double-count
    // the setter's appointment when they re-save with a closer chosen.
    if (d.status === "appointment" && setterSelect && schedule && !closerUid) {
      setErr("Pick a closer for this appointment before saving.");
      return;
    }
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
        // Area incentives captured for this lead (travel to the closer).
        incentives: incentives.length ? incentives : undefined,
        incentivesUtility: incentives.length ? incUtility : undefined,
        incentivesAt: incentives.length ? now : undefined,
        // Close date — set the moment a deal is marked sold so "closed today"
        // tracks when it closed, not when the door was first knocked. clean()
        // drops it (undefined) for any non-sold disposition.
        soldAt: d.status === "sold" ? now : undefined,
        updatedAt: now,
      });

      // The lead is the core deliverable — save it first, on its own. Each
      // disposition is a knock, so bump knockCount (drives "3 knocks = a
      // not-home is complete" in territory completion).
      let leadId = d.leadId;
      if (leadId) {
        await updateDoc(doc(db, "leads", leadId), { ...fields, knockCount: increment(1) });
      } else {
        const refDoc = await addDoc(collection(db, "leads"), clean({
          ...fields,
          address: d.address,
          lat: d.lat ?? null,
          lng: d.lng ?? null,
          knockCount: 1,
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

      // Stop + upload the recorded pitch (best-effort; never blocks the save).
      if (pitchOn) void pitch.stopAndUpload({
        companyId: companyId as string, uid: profile.uid, userName: profile.displayName,
        managerPath: profile.managerPath ?? [], leadId, address: d.address,
      });

      // On-the-spot scheduling. Non-blocking: the lead is already saved, so a
      // scheduling failure surfaces a warning but doesn't lose the lead.
      const cfg = SCHEDULE_FOR[d.status];
      if (cfg && schedule && scheduleAt) {
        // Appointments must fall inside the company's booking practices.
        if (d.status === "appointment" && company?.scheduling) {
          const v = validAppointmentTime(new Date(scheduleAt).getTime(), company.scheduling);
          if (!v.ok) {
            setErr(`Saved the lead, but the appointment time ${v.reason} — pick a valid time and save again.`);
            onSaved?.();
            return; // keep modal open so they can fix the time
          }
        }
        try {
          // Appointments route to a closer when the company runs that workflow;
          // go-backs / follow-ups always stay on the setter's own calendar.
          if (d.status === "appointment" && closersOn) {
            await createCloserAppointmentFn({
              companyId: companyId as string,
              startAt: new Date(scheduleAt).getTime(),
              durationMin: company?.scheduling?.apptDurationMin ?? 60,
              title: `Appointment${d.name ? ` — ${d.name}` : ""}`,
              address: d.address || "",
              name: d.name || "",
              notes: d.notes || "",
              leadId,
              candidateCloserUid: setterSelect ? closerUid : undefined,
            });
          } else {
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
          }
        } catch (e) {
          console.error("Scheduling failed", e);
          setErr((e as Error)?.message || "Saved the lead, but couldn't add the calendar event. Add it from the Schedule page.");
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

  // Dispositions that warrant a second screen for scheduling + photos. Everyone
  // else saves straight from step 1 so the initial card stays short.
  const needsStep2 = !!SCHEDULE_FOR[d.status] || d.status === "sold";
  const emailValid = !d.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim());

  // Step 1 primary action: advance to step 2 when needed, otherwise save.
  function next() {
    if (!d) return;
    if (!d.name.trim()) {
      setErr("Add the homeowner's name before continuing.");
      return;
    }
    if (!emailValid) {
      setErr("That email doesn't look right — fix it or clear it.");
      return;
    }
    setErr(null);
    if (needsStep2) setStep(2);
    else void save();
  }

  const step1 = (
    <>
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
    </>
  );

  const step2 = (
    <>
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
              {d.status === "appointment" && setterSelect && (
                <label className="field" style={{ marginTop: 10 }}>
                  <span>Closer for this appointment</span>
                  <select value={closerUid} onChange={(e) => setCloserUid(e.target.value)}>
                    <option value="">— pick a closer —</option>
                    {closers.map((c) => (
                      <option key={c.uid} value={c.uid}>{c.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {d.status === "appointment" && closersOn && !setterSelect && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  🤝 This appointment will be auto-assigned to a closer.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {d.address && (
        <div className="dispo-schedule" style={{ marginTop: 10 }}>
          <div className="row between" style={{ alignItems: "center" }}>
            <span>⚡ Area incentives</span>
            <button type="button" className="btn sm" disabled={incLoading} onClick={loadIncentives}>
              {incLoading ? "Finding…" : incentives.length ? "Refresh" : "Find incentives"}
            </button>
          </div>
          {incUtility?.name && (
            <div className="muted small" style={{ marginTop: 4 }}>
              Utility: {incUtility.name}{typeof incUtility.rate === "number" ? ` · $${incUtility.rate}/kWh` : ""}
            </div>
          )}
          {incErr && <div className="muted small" style={{ marginTop: 4 }}>{incErr}</div>}
          {incentives.length > 0 ? (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              {incentives.map((i, idx) => (
                <div key={idx} className="muted small" style={{ borderLeft: "2px solid #34D399", paddingLeft: 8 }}>
                  <strong style={{ color: "var(--text, #e5e7eb)" }}>{i.name}</strong>
                  {i.amount ? ` — ${i.amount}` : ""}
                  <div>{[i.administrator, incentiveDates(i)].filter(Boolean).join(" · ")}</div>
                  {i.url && <a href={i.url} target="_blank" rel="noreferrer">Verify source ↗</a>}
                </div>
              ))}
              <div className="muted small">Saved to this lead — they travel to the closer with the appointment.</div>
            </div>
          ) : (
            !incLoading && !incErr && <div className="muted small" style={{ marginTop: 4 }}>Tap “Find incentives” to pull local & utility programs for this address.</div>
          )}
        </div>
      )}

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
    </>
  );

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="dispo-card" onClick={(e) => e.stopPropagation()}>
        <div className="dispo-head">
          <div>
            <h3>
              {step === 2
                ? "Appointment & Photos"
                : d.leadId
                ? "Home / Disposition"
                : "Log Disposition"}
            </h3>
            <div className="muted small">{step === 2 ? d.name || d.address : d.address}</div>
          </div>
          {pitchOn && pitch.recording && (
            <span className="pitch-rec" title="Recording your pitch for coaching">● REC</span>
          )}
          <button className="dispo-x" onClick={onClose}>✕</button>
        </div>

        {pitchOn && !pitch.consented && (
          <div className="pitch-consent">
            🎙️ Record this pitch for AI coaching feedback? Audio is stored for your team's review.
            By starting, you confirm you may record this conversation where you are.
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <button className="btn primary sm" onClick={() => { pitch.giveConsent(); void pitch.start(); }}>Allow &amp; record</button>
              <span className="muted small">You can stop by closing this card.</span>
            </div>
          </div>
        )}

        {step === 1 ? step1 : step2}

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
            {step === 2 ? (
              <button className="btn ghost sm" onClick={() => { setErr(null); setStep(1); }}>
                ← Back
              </button>
            ) : (
              <button className="btn ghost sm" onClick={onClose}>Cancel</button>
            )}
            {step === 1 ? (
              <button className="btn primary sm" onClick={next} disabled={saving}>
                {needsStep2 ? "Next →" : saving ? "Saving…" : d.leadId ? "Save" : "Add Lead"}
              </button>
            ) : (
              <button className="btn primary sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : d.leadId ? "Save" : "Add Lead"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
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
