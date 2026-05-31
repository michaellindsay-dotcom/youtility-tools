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
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Lead, LeadStatus } from "../types";

const STATUSES: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "appointment", label: "Appointment" },
  { value: "not_home", label: "Not home" },
  { value: "not_interested", label: "Not interested" },
  { value: "sold", label: "Sold" },
];

export default function Leads() {
  const { profile, role, companyId } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LeadStatus | "all">("all");
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "leads");
    // Always scope to the company; reps further to their own leads (also
    // enforced by security rules).
    const q =
      role === "rep"
        ? query(
            base,
            where("companyId", "==", companyId),
            where("assignedTo", "==", profile.uid),
            orderBy("updatedAt", "desc")
          )
        : query(base, where("companyId", "==", companyId), orderBy("updatedAt", "desc"));
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
    await updateDoc(doc(db, "leads", id), { status, updatedAt: Date.now() });
  };

  const remove = async (id: string) => {
    if (confirm("Delete this lead?")) await deleteDoc(doc(db, "leads", id));
  };

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>Leads</h1>
          <p className="page-sub">{shown.length} shown</p>
        </div>
        <button className="btn primary" onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? "Close" : "+ New lead"}
        </button>
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
              <div className="lead-main">
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
        createdBy: profile.uid,
        createdAt: now,
        updatedAt: now,
      });
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
