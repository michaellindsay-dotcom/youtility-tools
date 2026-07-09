import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { addDoc, collection, doc, onSnapshot, query, setDoc, where } from "firebase/firestore";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { db, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISP_LABEL, DISP_COLOR } from "../lib/dispositions";
import { APPT_LABEL, APPT_COLOR, isDispositioned } from "../lib/closerDispositions";
import DispositionModal, { type DispoInput } from "../components/DispositionModal";
import CloserDispositionModal from "../components/CloserDispositionModal";
import EditLeadModal from "../components/EditLeadModal";
import type { Lead, LeadHistoryEntry, ScheduleEvent } from "../types";

interface PitchRow { id: string; createdAt: number; status: string; score: number | null; feedback: string; audioPath?: string; address?: string }
interface ProposalRow { id: string; createdAt: number; status?: string; address?: string; pdfUrl?: string; systemKw?: number }

const fmt = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const summarize = (e?: Lead["enrichment"]) => !e ? "" : [
  e.propertyType, e.beds != null ? `${e.beds}bd` : null, e.baths != null ? `${e.baths}ba` : null,
  e.sqft != null ? `${Number(e.sqft).toLocaleString()} sqft` : null, e.yearBuilt ? `built ${e.yearBuilt}` : null,
  e.estValue ? `$${Number(e.estValue).toLocaleString()}` : null,
].filter(Boolean).join(" · ");

export default function CustomerLead() {
  const { leadId } = useParams();
  const navigate = useNavigate();
  const { profile, role } = useAuth();
  const [lead, setLead] = useState<Lead | null>(null);
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [pitches, setPitches] = useState<PitchRow[]>([]);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [audio, setAudio] = useState<Record<string, string>>({});
  const [dispoOpen, setDispoOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [closeoutTarget, setCloseoutTarget] = useState<ScheduleEvent | null>(null);
  const [nudgeState, setNudgeState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [loading, setLoading] = useState(true);
  const isMgr = role === "admin" || role === "manager";

  // Not the closer? Nudge the assigned closer in a DM to close out the appt.
  async function nudgeCloser(e: ScheduleEvent) {
    if (!profile || !e.closerUid) return;
    setNudgeState("sending");
    try {
      const cid = [profile.uid, e.closerUid].sort().join("__");
      const when = new Date(e.startAt).toLocaleDateString([], { month: "short", day: "numeric" });
      const body = `Hey ${e.closerName || "there"}, the ${when} appointment for ${lead?.ownerName || e.address || "this home"} still needs a disposition — can you close it out?`;
      await setDoc(doc(db, "dms", cid), {
        members: [profile.uid, e.closerUid],
        memberNames: { [profile.uid]: profile.displayName || "", [e.closerUid]: e.closerName || "" },
        companyId: lead?.companyId || "",
        lastMessage: body, lastAt: Date.now(),
      }, { merge: true });
      await addDoc(collection(db, "dms", cid, "messages"), {
        channelId: cid, userId: profile.uid, userName: profile.displayName || "", text: body, createdAt: Date.now(),
      });
      setNudgeState("sent");
    } catch { setNudgeState("error"); }
  }

  // Live lead doc.
  useEffect(() => {
    if (!leadId) return;
    return onSnapshot(doc(db, "leads", leadId), (snap) => {
      setLead(snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<Lead, "id">) }) : null);
      setLoading(false);
    }, (e) => { console.error("lead", e); setLoading(false); });
  }, [leadId]);

  // Everything linked to this lead: appointments, recordings, proposals.
  useEffect(() => {
    if (!leadId) return;
    const unsubs = [
      onSnapshot(query(collection(db, "events"), where("leadId", "==", leadId)),
        (s) => setEvents(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) }))),
        () => {}),
      onSnapshot(query(collection(db, "pitches"), where("leadId", "==", leadId)),
        (s) => setPitches(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PitchRow, "id">) }))),
        () => {}),
      onSnapshot(query(collection(db, "proposals"), where("leadId", "==", leadId)),
        (s) => setProposals(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProposalRow, "id">) }))),
        () => {}),
    ];
    return () => unsubs.forEach((u) => u());
  }, [leadId]);

  // Resolve pitch audio download URLs on demand.
  useEffect(() => {
    let cancelled = false;
    pitches.forEach((p) => {
      if (!p.audioPath || audio[p.id]) return;
      getDownloadURL(storageRef(storage, p.audioPath))
        .then((url) => { if (!cancelled) setAudio((a) => ({ ...a, [p.id]: url })); })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [pitches, audio]);

  // Knock timeline: prefer the recorded history array; fall back to a single
  // synthesized entry for legacy leads that predate history recording.
  const timeline = useMemo<LeadHistoryEntry[]>(() => {
    if (!lead) return [];
    const h = Array.isArray(lead.history) ? [...lead.history] : [];
    if (h.length === 0 && lead.status) {
      h.push({ at: lead.knockedAt || lead.updatedAt || lead.createdAt, status: lead.status, notes: lead.notes, verified: lead.verified, distanceFt: lead.distanceFt ?? null });
    }
    return h.sort((a, b) => b.at - a.at);
  }, [lead]);

  const appts = useMemo(() => [...events].filter((e) => e.type === "appointment").sort((a, b) => b.startAt - a.startAt), [events]);
  const otherEvents = useMemo(() => [...events].filter((e) => e.type !== "appointment").sort((a, b) => b.startAt - a.startAt), [events]);
  // A closer appointment still awaiting a close-out — if present, the header
  // action becomes a close-out (for the closer) or a red "No Disposition" nag.
  const openAppt = useMemo(() => appts.find((e) => e.closerUid && !isDispositioned(e)), [appts]);
  const photos = useMemo(() => {
    const urls = new Set<string>();
    if (lead?.photoHomeUrl) urls.add(lead.photoHomeUrl);
    if (lead?.photoBillUrl) urls.add(lead.photoBillUrl);
    (lead?.history || []).forEach((h) => { if (h.photoHomeUrl) urls.add(h.photoHomeUrl); if (h.photoBillUrl) urls.add(h.photoBillUrl); });
    return [...urls];
  }, [lead]);

  const dispoTarget: DispoInput | null = lead ? {
    leadId: lead.id, address: lead.address, lat: lead.lat, lng: lead.lng, status: lead.status,
    name: lead.ownerName || "", phone: lead.phone || "", email: lead.email || "", notes: lead.notes || "",
    enrichment: lead.enrichment, photoHomeUrl: lead.photoHomeUrl, photoBillUrl: lead.photoBillUrl, smsOptIn: lead.smsOptIn,
  } : null;

  if (loading) return <div className="page-body"><div className="muted">Loading customer…</div></div>;
  if (!lead) return <div className="page-body"><div className="empty">Customer not found (or you don't have access).</div></div>;

  const canManage = lead.assignedTo === profile?.uid || (lead.visibilityPath || []).includes(profile?.uid || "") || isMgr;

  return (
    <div className="page-body cust">
      <div className="page-head">
        <div className="row between" style={{ alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ marginBottom: 2 }}>{lead.ownerName || "Homeowner"}</h1>
            <div className="muted small">{[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ")}</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {canManage && <button className="btn ghost sm" onClick={() => setEditOpen(true)}>✏️ Edit</button>}
            <button className="btn ghost sm" onClick={() => navigate(-1)}>← Back</button>
          </div>
        </div>
        {summarize(lead.enrichment) && <p className="page-sub" style={{ marginTop: 6 }}>{summarize(lead.enrichment)}</p>}
      </div>

      {/* Contact + current status + quick actions */}
      <div className="card">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="badge" style={{ background: DISP_COLOR[lead.status] || "#888", color: "#06121f", fontWeight: 700 }}>
            {DISP_LABEL[lead.status] || lead.status}
          </span>
          {lead.knockCount ? <span className="muted small">{lead.knockCount} knock{lead.knockCount === 1 ? "" : "s"}</span> : null}
          {lead.phone && <a className="btn ghost sm" href={`tel:${lead.phone}`}>📞 {lead.phone}</a>}
          {lead.phone && <a className="btn ghost sm" href={`sms:${lead.phone}`}>💬 Text</a>}
          {lead.email && <a className="btn ghost sm" href={`mailto:${lead.email}`}>✉️ Email</a>}
          {lead.address && <a className="btn ghost sm" href={`https://maps.google.com/?q=${encodeURIComponent(lead.address)}`} target="_blank" rel="noreferrer">🗺️ Map</a>}
          {openAppt ? (
            profile?.uid === openAppt.closerUid ? (
              // The assigned closer closes out the appointment (close status).
              <button className="btn primary sm" onClick={() => setCloseoutTarget(openAppt)}>✍️ Log disposition</button>
            ) : canManage ? (
              // Setter / managers / admins can't disposition it — they see the
              // red nag, which pings the closer to close it out.
              <button
                className="btn sm dispo-owed-alert"
                title={`Awaiting ${openAppt.closerName || "the closer"}'s close-out — tap to nudge them`}
                disabled={nudgeState === "sending" || nudgeState === "sent"}
                onClick={() => nudgeCloser(openAppt)}
              >
                {nudgeState === "sent" ? "✓ Closer nudged" : `⚠ No Disposition${openAppt.closerName ? ` — ${openAppt.closerName}` : ""}`}
              </button>
            ) : null
          ) : (
            canManage && <button className="btn primary sm" onClick={() => setDispoOpen(true)}>✍️ Log disposition</button>
          )}
        </div>
        {lead.incentives && lead.incentives.length > 0 && (
          <div className="muted small" style={{ marginTop: 10 }}>
            ⚡ {lead.incentives.length} area incentive{lead.incentives.length === 1 ? "" : "s"} captured{lead.incentivesUtility?.name ? ` · ${lead.incentivesUtility.name}` : ""}
          </div>
        )}
      </div>

      {/* Knock / disposition timeline */}
      <h2 className="section-h">Knock history <span className="muted small">({timeline.length})</span></h2>
      {timeline.length === 0 ? (
        <div className="empty">No knocks recorded yet.</div>
      ) : (
        <div className="cust-timeline">
          {timeline.map((h, i) => (
            <div className="cust-tl-row card" key={`${h.at}-${i}`}>
              <span className="cust-tl-dot" style={{ background: DISP_COLOR[h.status] || "#888" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row between" style={{ alignItems: "baseline", gap: 8 }}>
                  <strong>{DISP_LABEL[h.status] || h.status}</strong>
                  <span className="muted small">{fmt(h.at)}</span>
                </div>
                <div className="muted small">
                  {h.byName ? `by ${h.byName}` : ""}
                  {h.verified === false ? " · ⚠ off-site" : ""}
                  {typeof h.distanceFt === "number" && h.verified !== false ? ` · ${h.distanceFt} ft` : ""}
                </div>
                {h.notes && <div className="cust-notes">📝 {h.notes}</div>}
                {(h.photoHomeUrl || h.photoBillUrl) && (
                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    {h.photoHomeUrl && <a href={h.photoHomeUrl} target="_blank" rel="noreferrer"><img src={h.photoHomeUrl} className="cust-thumb" alt="home" /></a>}
                    {h.photoBillUrl && <a href={h.photoBillUrl} target="_blank" rel="noreferrer"><img src={h.photoBillUrl} className="cust-thumb" alt="bill" /></a>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Appointments + close-out */}
      {appts.length > 0 && (
        <>
          <h2 className="section-h">Appointments <span className="muted small">({appts.length})</span></h2>
          <div className="cust-timeline">
            {appts.map((e) => (
              <div className="cust-tl-row card" key={e.id}>
                <span className="cust-tl-dot" style={{ background: APPT_COLOR[e.apptStatus || "scheduled"] }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row between" style={{ alignItems: "baseline", gap: 8 }}>
                    <strong>{fmt(e.startAt)}</strong>
                    <span className="badge" style={{ background: APPT_COLOR[e.apptStatus || "scheduled"], color: "#06121f", fontWeight: 700 }}>
                      {APPT_LABEL[e.apptStatus || "scheduled"]}
                    </span>
                  </div>
                  <div className="muted small">
                    {e.closerName ? `Closer: ${e.closerName}` : "Awaiting closer"}
                    {e.setterName ? ` · set by ${e.setterName}` : ""}
                    {e.dispositionVerified === false && e.apptStatus && e.apptStatus !== "scheduled" ? " · logged off-site / after the fact" : ""}
                  </div>
                  {e.apptNotes && <div className="cust-notes">📝 {e.apptNotes}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Follow-ups / go-backs */}
      {otherEvents.length > 0 && (
        <>
          <h2 className="section-h">Follow-ups &amp; go-backs</h2>
          <div className="cust-timeline">
            {otherEvents.map((e) => (
              <div className="cust-tl-row card" key={e.id}>
                <span className="cust-tl-dot" style={{ background: "#38bdf8" }} />
                <div style={{ flex: 1 }}>
                  <div className="row between" style={{ alignItems: "baseline", gap: 8 }}>
                    <strong>{e.title || e.type}</strong>
                    <span className="muted small">{fmt(e.startAt)}</span>
                  </div>
                  {e.notes && <div className="cust-notes">📝 {e.notes}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Recordings */}
      {pitches.length > 0 && (
        <>
          <h2 className="section-h">🎙️ Recordings <span className="muted small">({pitches.length})</span></h2>
          <div className="cust-timeline">
            {[...pitches].sort((a, b) => b.createdAt - a.createdAt).map((p) => (
              <div className="cust-tl-row card" key={p.id}>
                <div style={{ flex: 1 }}>
                  <div className="row between" style={{ alignItems: "baseline", gap: 8 }}>
                    <strong>{p.status === "analyzed" && p.score != null ? `${p.score}/100` : "Pitch"}</strong>
                    <span className="muted small">{fmt(p.createdAt)}</span>
                  </div>
                  {p.feedback && <div className="muted small" style={{ marginTop: 2 }}>{p.feedback}</div>}
                  {audio[p.id] && <audio controls src={audio[p.id]} style={{ width: "100%", marginTop: 8 }} />}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Photos */}
      {photos.length > 0 && (
        <>
          <h2 className="section-h">Photos &amp; attachments</h2>
          <div className="cust-photos">
            {photos.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer"><img src={url} className="cust-photo" alt="attachment" /></a>
            ))}
          </div>
        </>
      )}

      {/* Proposals */}
      {proposals.length > 0 && (
        <>
          <h2 className="section-h">📄 Proposals <span className="muted small">({proposals.length})</span></h2>
          <div className="cust-timeline">
            {[...proposals].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((p) => (
              <div className="cust-tl-row card" key={p.id}>
                <div style={{ flex: 1 }} className="row between">
                  <div>
                    <strong>{p.systemKw ? `${p.systemKw} kW system` : "Proposal"}</strong>
                    <div className="muted small">{p.createdAt ? fmt(p.createdAt) : ""}{p.status ? ` · ${p.status}` : ""}</div>
                  </div>
                  {p.pdfUrl && <a className="btn ghost sm" href={p.pdfUrl} target="_blank" rel="noreferrer">Open PDF ↗</a>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="muted small" style={{ marginTop: 18 }}>
        Work this home from the <Link to="/map">Map</Link> or <Link to="/leads">Leads</Link> screen.
      </p>

      <DispositionModal
        target={dispoOpen ? dispoTarget : null}
        autoEnrich={false}
        onClose={() => setDispoOpen(false)}
      />

      {/* Closer close-out for an open appointment (after the fact, from here). */}
      <CloserDispositionModal
        event={closeoutTarget}
        afterTheFact
        onClose={() => setCloseoutTarget(null)}
      />

      {editOpen && <EditLeadModal lead={lead} onClose={() => setEditOpen(false)} />}
    </div>
  );
}
