import { useEffect, useState, type FormEvent } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Territory, UserProfile } from "../types";

const COLORS = ["#0EA5E9", "#34D399", "#F59E0B", "#F87171", "#A78BFA", "#F472B6"];

export default function Territories() {
  const { profile, role, companyId } = useAuth();
  const canManage = role === "admin" || role === "manager";
  const [items, setItems] = useState<Territory[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [assignee, setAssignee] = useState("");
  const [reps, setReps] = useState<UserProfile[]>([]);

  // Load assignable reps (the manager's downstream / whole company for admins).
  useEffect(() => {
    if (!companyId || !profile || !canManage) return;
    let cancelled = false;
    (async () => {
      try {
        const base = collection(db, "users");
        const q =
          role === "admin"
            ? query(base, where("companyId", "==", companyId))
            : query(base, where("companyId", "==", companyId), where("managerPath", "array-contains", profile.uid));
        const snap = await getDocs(q);
        let list = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserProfile, "uid">) }));
        if (!list.some((u) => u.uid === profile.uid)) list = [profile as UserProfile, ...list];
        list = list.filter((u) => !u.disabled).sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
        if (!cancelled) setReps(list);
      } catch (err) {
        console.error(err);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, profile, role, canManage]);

  useEffect(() => {
    if (!companyId) return;
    const q = query(
      collection(db, "territories"),
      where("companyId", "==", companyId),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Territory, "id">) })));
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
      }
    );
    return unsub;
  }, [companyId]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!profile || !companyId || !name.trim()) return;
    const rep = reps.find((r) => r.uid === assignee);
    await addDoc(collection(db, "territories"), {
      name: name.trim(),
      description: description.trim() || null,
      color,
      companyId,
      managerId: profile.uid,
      assignedTo: rep ? rep.uid : null,
      assignedToName: rep ? rep.displayName || rep.email || null : null,
      createdAt: Date.now(),
    });
    setName("");
    setDescription("");
    setAssignee("");
  };

  const remove = async (id: string) => {
    if (confirm("Delete this territory?")) await deleteDoc(doc(db, "territories", id));
  };

  // Reassign an existing area to a rep (downstream / company, self included).
  const reassign = async (id: string, uid: string) => {
    const rep = reps.find((r) => r.uid === uid);
    await updateDoc(doc(db, "territories", id), {
      assignedTo: rep ? rep.uid : null,
      assignedToName: rep ? rep.displayName || rep.email || null : null,
    });
  };

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Territories</h1>
        <p className="page-sub">Group leads into canvassing zones.</p>
      </div>

      {canManage && (
        <form className="card add-form" onSubmit={add}>
          <div className="grid-2">
            <label className="field">
              <span>Name *</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="field">
              <span>Color</span>
              <div className="color-row">
                {COLORS.map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={"swatch" + (color === c ? " active" : "")}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    aria-label={c}
                  />
                ))}
              </div>
            </label>
          </div>
          <div className="grid-2">
            <label className="field">
              <span>Description</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label className="field">
              <span>Assign to</span>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">— Unassigned —</option>
                {reps.map((r) => (
                  <option key={r.uid} value={r.uid}>
                    {(r.displayName || r.email) + (r.uid === profile?.uid ? " (me)" : "")}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row end">
            <button className="btn primary" type="submit">
              Add territory
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="empty">No territories yet.</div>
      ) : (
        <div className="territory-grid">
          {items.map((t) => (
            <div className="card territory-card" key={t.id}>
              <div className="territory-dot" style={{ background: t.color || COLORS[0] }} />
              <div className="territory-body">
                <div className="territory-name">{t.name}</div>
                {t.description && <div className="muted">{t.description}</div>}
                {canManage ? (
                  <label className="field" style={{ marginTop: 6, marginBottom: 0 }}>
                    <span>Assign to</span>
                    <select
                      value={t.assignedTo || ""}
                      onChange={(e) => reassign(t.id, e.target.value)}
                    >
                      <option value="">— Unassigned —</option>
                      {reps.map((r) => (
                        <option key={r.uid} value={r.uid}>
                          {(r.displayName || r.email) + (r.uid === profile?.uid ? " (me)" : "")}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="muted small">
                    {t.assignedToName ? `Assigned to ${t.assignedToName}` : "Unassigned"}
                  </div>
                )}
              </div>
              {canManage && (
                <button className="btn ghost sm" onClick={() => remove(t.id)}>
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
