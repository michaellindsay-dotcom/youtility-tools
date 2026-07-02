import { useEffect, useState, type FormEvent } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { Link } from "react-router-dom";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { isRallyCardOnly } from "../lib/features";
import { bumpStats } from "../lib/stats";
import { DISPOSITIONS } from "../lib/dispositions";
import DispositionModal, { type DispoInput } from "../components/DispositionModal";
import type { Lead, LeadStatus } from "../types";

const STATUSES = DISPOSITIONS;

export default function Leads() {
  const { profile, role, companyId, company } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LeadStatus | "all">("all");
  const [showAdd, setShowAdd] = useState(false);
  const [dispoTarget, setDispoTarget] = useState<DispoInput | null>(null);

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "leads");
    // Company admins see the whole company; everyone else sees only their
    // downstream (their uid in the lead's visibilityPath) — own leads included.
    // Mirrors the security rules.
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId), orderBy("updatedAt", "desc"))
        : query(
            base,
            where("companyId", "==", companyId),
            where("visibilityPath", "array-contains", profile.uid),
            orderBy("updatedAt", "desc")
          );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setLeads(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Lead, "id">) })));
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
      }
    );
    return unsub;
  }, [profile, role, companyId]);

  const shown = filter === "all" ? leads : leads.filter((l) => l.status === filter);

  const setStatus = async (id: string, status: LeadStatus) => {
    // Stamp the close date when a deal is marked sold, so "closed today" tracks
    // the close (not the original knock). We deliberately don't touch knockedAt
    // here — closing an old lead shouldn't count as a door knocked today.
    const now = Date.now();
    await updateDoc(doc(db, "leads", id), { status, updatedAt: now, ...(status === "sold" ? { soldAt: now } : {}) });
    if (profile) {
      if (status === "appointment") void bumpStats(profile, { appointments: 1 });
      else if (status === "sold") void bumpStats(profile, { sales: 1 });
    }
  };

  const remove = async (id: string) => {
    if (confirm("Delete this lead?")) await deleteDoc(doc(db, "leads", id));
  };

  const clearAll = async () => {
    if (!confirm(`Delete ALL ${leads.length} leads? This cannot be undone.`)) return;
    for (const lead of leads) {
      await deleteDoc(doc(db, "leads", lead.id)).catch(() => {});
    }
  };

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>Leads</h1>
          <p className="page-sub">{shown.length} shown</p>
        </div>
        <div className="row">
          {/* RallyCard-only companies have no Dashboard to go back to. */}
          {!isRallyCardOnly(company) && (
            <Link className="btn ghost sm" to="/">← Back to Dashboard</Link>
          )}
          {(role === "admin" || role === "manager") && leads.length > 0 && (
            <button className="btn ghost sm danger" onClick={clearAll}>
              Clear all ({leads.length})
            </button>
          )}
          <button className="btn primary" onClick={() => setShowAdd((s) => !s)}>
            {showAdd ? "Close" : "+ New lead"}
          </button>
        </div>
      </div>

      {showAdd && <AddLead onDone={() => setShowAdd(false)} />}

      <div className="filter-bar">
        <button
          className={"chip-btn" + (filter === "all" ? " active" : "")}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        {STATUSES.map((s) => (
          <button
            key={s.value}
            className={"chip-btn" + (filter === s.value ? " active" : "")}
            onClick={() => setFilter(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="muted">Loading leads…</div>
      ) : shown.length === 0 ? (
        <div className="empty">No leads yet. Add one or run an address lookup.</div>
      ) : (
        <div className="lead-list">
          {shown.map((lead) => (
            <div className="lead-row card" key={lead.id}>
              <div
                className="lead-main"
                title="Double-click to view home & owner details"
                onDoubleClick={() =>
                  setDispoTarget({
                    leadId: lead.id,
                    address: lead.address,
                    lat: lead.lat,
                    lng: lead.lng,
                    status: lead.status,
                    name: lead.ownerName || "",
                    phone: lead.phone || "",
                    email: lead.email || "",
                    notes: lead.notes || "",
                    enrichment: lead.enrichment,
                    photoHomeUrl: lead.photoHomeUrl,
                    photoBillUrl: lead.photoBillUrl,
                  })
                }
              >
                <div className="lead-addr">{lead.address}</div>
                <div className="lead-sub muted">
                  {[lead.city, lead.state, lead.zip].filter(Boolean).join(", ")}
                  {lead.ownerName ? ` · ${lead.ownerName}` : ""}
                </div>
                {lead.notes && <div className="lead-notes">{lead.notes}</div>}
              </div>
              <div className="lead-actions">
                <select
                  value={lead.status}
                  onChange={(e) => setStatus(lead.id, e.target.value as LeadStatus)}
                  className={`status-select status-${lead.status}`}
                >
                  {STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {(role === "admin" || role === "manager") && (
                  <button className="btn ghost sm" onClick={() => remove(lead.id)}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <DispositionModal target={dispoTarget} onClose={() => setDispoTarget(null)} />
    </div>
  );
}

function AddLead({ onDone }: { onDone: () => void }) {
  const { profile, companyId } = useAuth();
  const [address, setAddress] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!profile || !companyId || !address.trim()) return;
    setBusy(true);
    try {
      const now = Date.now();
      await addDoc(collection(db, "leads"), {
        address: address.trim(),
        ownerName: ownerName.trim() || null,
        notes: notes.trim() || null,
        status: "new" as LeadStatus,
        companyId,
        assignedTo: profile.uid,
        // owner + their management chain → drives downstream visibility.
        visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
        createdBy: profile.uid,
        createdAt: now,
        updatedAt: now,
      });
      void bumpStats(profile, { leadsCreated: 1 });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card add-form" onSubmit={submit}>
      <div className="grid-2">
        <label className="field">
          <span>Address *</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} required />
        </label>
        <label className="field">
          <span>Owner name</span>
          <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </label>
      <div className="row end">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Add lead"}
        </button>
      </div>
    </form>
  );
}
