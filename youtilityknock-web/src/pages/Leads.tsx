import { useEffect, useState, type FormEvent } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import { Link, useNavigate } from "react-router-dom";
import { auth, db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { isRallyCardOnly } from "../lib/features";
import { bumpStats } from "../lib/stats";
import { DISPOSITIONS, DISP_LABEL, DISP_COLOR } from "../lib/dispositions";
import type { Lead, LeadStatus } from "../types";

const STATUSES = DISPOSITIONS;
const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");

export default function Leads() {
  const { profile, role, companyId, company } = useAuth();
  const navigate = useNavigate();
  const isAdmin = role === "admin" || role === "superadmin";
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LeadStatus | "all">("all");
  const [showAdd, setShowAdd] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false); // admin-only archive view
  const [deleteTarget, setDeleteTarget] = useState<Lead | null>(null);
  const [search, setSearch] = useState("");

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

  // Deleted leads are hidden everywhere except the admin's archive view.
  const active = leads.filter((l) => !l.deleted);
  const deleted = leads.filter((l) => l.deleted);
  const byStatus = showDeleted ? deleted : (filter === "all" ? active : active.filter((l) => l.status === filter));
  // Live search across name, phone (digits only), and address.
  const digits = (s: string) => s.replace(/\D/g, "");
  const q = search.trim().toLowerCase();
  const qDigits = digits(search);
  const shown = !q ? byStatus : byStatus.filter((l) => {
    const hay = [l.ownerName, l.address, l.city, l.state, l.zip].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(q)) return true;
    return qDigits.length >= 3 && !!l.phone && digits(l.phone).includes(qDigits);
  });
  // Autocomplete suggestions (names + addresses) from the current list.
  const suggestions = Array.from(new Set(
    byStatus.flatMap((l) => [l.ownerName, l.address].filter(Boolean) as string[])
  )).slice(0, 50);

  // Restore a soft-deleted lead (admin only).
  const restore = async (lead: Lead) => {
    await updateDoc(doc(db, "leads", lead.id), { deleted: false, updatedAt: Date.now() });
  };

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>{showDeleted ? "Deleted leads" : "Leads"}</h1>
          <p className="page-sub">{shown.length} {showDeleted ? "deleted" : "shown"}</p>
        </div>
        <div className="row">
          {/* RallyCard-only companies have no Dashboard to go back to. */}
          {!isRallyCardOnly(company) && (
            <Link className="btn ghost sm" to="/">← Back to Dashboard</Link>
          )}
          {isAdmin && (
            <button className="btn ghost sm" onClick={() => setShowDeleted((s) => !s)}>
              {showDeleted ? "← Active leads" : `🗑 Deleted (${deleted.length})`}
            </button>
          )}
          {!showDeleted && (
            <button className="btn primary" onClick={() => setShowAdd((s) => !s)}>
              {showAdd ? "Close" : "+ New lead"}
            </button>
          )}
        </div>
      </div>

      {showAdd && !showDeleted && <AddLead onDone={() => setShowAdd(false)} />}

      <div className="row" style={{ marginBottom: 10, alignItems: "center", gap: 8 }}>
        <input
          className="input"
          type="search"
          list="lead-search-suggestions"
          placeholder="🔍 Search name, phone, or address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <datalist id="lead-search-suggestions">
          {suggestions.map((s) => <option key={s} value={s} />)}
        </datalist>
        {search && <button className="btn ghost sm" onClick={() => setSearch("")}>Clear</button>}
      </div>

      {!showDeleted && (
        <div className="filter-bar">
          <button className={"chip-btn" + (filter === "all" ? " active" : "")} onClick={() => setFilter("all")}>All</button>
          {STATUSES.map((s) => (
            <button key={s.value} className={"chip-btn" + (filter === s.value ? " active" : "")} onClick={() => setFilter(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="muted">Loading leads…</div>
      ) : shown.length === 0 ? (
        <div className="empty">{q ? `No leads match "${search.trim()}".` : showDeleted ? "No deleted leads." : "No leads yet. Add one or run an address lookup."}</div>
      ) : (
        <div className="lead-list">
          {shown.map((lead) => (
            <div className="lead-row card" key={lead.id}>
              <div
                className="lead-main"
                title="Double-click to open the full customer history"
                style={{ cursor: "pointer" }}
                onDoubleClick={() => navigate(`/lead/${lead.id}`)}
              >
                <div className="lead-addr">{lead.address}</div>
                <div className="lead-sub muted">
                  {[lead.city, lead.state, lead.zip].filter(Boolean).join(", ")}
                  {lead.ownerName ? ` · ${lead.ownerName}` : ""}
                </div>
                {lead.notes && <div className="lead-notes">{lead.notes}</div>}
                {showDeleted && (
                  <div className="muted small" style={{ marginTop: 4 }}>
                    🗑 Deleted {fmt(lead.deletedAt)}{lead.deletedByName ? ` by ${lead.deletedByName}` : ""}
                    {lead.deleteReason ? ` · "${lead.deleteReason}"` : ""}
                  </div>
                )}
              </div>
              <div className="lead-actions">
                {/* Status is display-only here — dispositioning happens at the
                    door (Map) or via the closer close-out on the customer screen. */}
                <span className="badge" style={{ background: DISP_COLOR[lead.status] || "#888", color: "#06121f", fontWeight: 700 }}>
                  {DISP_LABEL[lead.status] || lead.status}
                </span>
                <button className="btn ghost sm" title="Open customer history" onClick={() => navigate(`/lead/${lead.id}`)}>👁</button>
                {isAdmin && (showDeleted ? (
                  <button className="btn ghost sm" onClick={() => restore(lead)}>Restore</button>
                ) : (
                  <button className="btn ghost sm danger" onClick={() => setDeleteTarget(lead)}>Delete</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <DeleteLeadModal
          lead={deleteTarget}
          adminName={profile?.displayName || ""}
          adminUid={profile?.uid || ""}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// Soft-delete a lead — admins only. Requires a reason and the admin's password
// (re-auth), and never hard-deletes: the lead is archived to the Deleted list.
function DeleteLeadModal({ lead, adminName, adminUid, onClose }: { lead: Lead; adminName: string; adminUid: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const hasPassword = auth.currentUser?.providerData.some((p) => p.providerId === "password") ?? false;

  async function confirm() {
    setErr("");
    if (!reason.trim()) { setErr("A reason is required to delete a lead."); return; }
    const user = auth.currentUser;
    if (!user?.email) { setErr("No account loaded."); return; }
    if (!hasPassword) { setErr("Your account has no password to confirm with (Google sign-in). Contact support."); return; }
    setBusy(true);
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      await updateDoc(doc(db, "leads", lead.id), {
        deleted: true,
        deletedAt: Date.now(),
        deletedBy: adminUid,
        deletedByName: adminName,
        deleteReason: reason.trim(),
        updatedAt: Date.now(),
      });
      onClose();
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      setErr(code === "auth/wrong-password" || code === "auth/invalid-credential"
        ? "That password is incorrect."
        : (e as Error)?.message || "Couldn't delete the lead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="dispo-card" onClick={(e) => e.stopPropagation()}>
        <div className="dispo-head">
          <div>
            <h3>Delete lead</h3>
            <div className="muted small">{lead.address}{lead.ownerName ? ` · ${lead.ownerName}` : ""}</div>
          </div>
          <button className="dispo-x" onClick={onClose}>✕</button>
        </div>
        <div className="banner warn show" style={{ marginBottom: 10 }}>
          Leads are never truly deleted — this archives it to the admin-only Deleted list. Confirm with a reason and your password.
        </div>
        <label className="field">
          <span>Reason (required)</span>
          <textarea rows={2} value={reason} placeholder="Why is this lead being deleted?" onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="field">
          <span>Your password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <div className="banner warn show" style={{ marginBottom: 10 }}>{err}</div>}
        <div className="dispo-foot">
          <span />
          <div className="row">
            <button className="btn ghost sm" onClick={onClose}>Cancel</button>
            <button className="btn primary sm danger" onClick={confirm} disabled={busy}>
              {busy ? "Deleting…" : "Delete lead"}
            </button>
          </div>
        </div>
      </div>
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
