import { useEffect, useState, type FormEvent } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Territory } from "../types";

const COLORS = ["#0EA5E9", "#34D399", "#F59E0B", "#F87171", "#A78BFA", "#F472B6"];

export default function Territories() {
  const { profile, role } = useAuth();
  const canManage = role === "admin" || role === "manager";
  const [items, setItems] = useState<Territory[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(COLORS[0]);

  useEffect(() => {
    const q = query(collection(db, "territories"), orderBy("createdAt", "desc"));
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
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!profile || !name.trim()) return;
    await addDoc(collection(db, "territories"), {
      name: name.trim(),
      description: description.trim() || null,
      color,
      managerId: profile.uid,
      createdAt: Date.now(),
    });
    setName("");
    setDescription("");
  };

  const remove = async (id: string) => {
    if (confirm("Delete this territory?")) await deleteDoc(doc(db, "territories", id));
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
          <label className="field">
            <span>Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
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
