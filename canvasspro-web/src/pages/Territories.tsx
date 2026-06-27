import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
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
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Territory, UserProfile } from "../types";

const COLORS = ["#0EA5E9", "#34D399", "#F59E0B", "#F87171", "#A78BFA", "#F472B6"];
type TerrStat = { homes: number; completion: number; success: number; complete?: boolean; doors?: number };

// How many areas stay "live" per rep — the rest fall into Historical.
const LIVE_PER_REP = 2;

interface Recommendation {
  name: string;
  polygon: { lat: number; lng: number }[];
  basedOnTerritoryId: string;
  basedOnName: string;
  successRate: number;
  doors: number;
  sold: number;
  rationale: string;
  education: string;
}

export default function Territories() {
  const { profile, role, companyId } = useAuth();
  const navigate = useNavigate();
  const canManage = role === "admin" || role === "manager";
  const [items, setItems] = useState<Territory[]>([]);
  const [stats, setStats] = useState<Record<string, TerrStat>>({});
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [assignee, setAssignee] = useState("");
  const [reps, setReps] = useState<UserProfile[]>([]);
  const [proposing, setProposing] = useState(false);

  // Historical panel state.
  const [showHistory, setShowHistory] = useState(false);
  const [histRep, setHistRep] = useState<string>("");
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recErr, setRecErr] = useState("");

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

  // Per-territory stats (homes / completion / success / complete) from the server.
  useEffect(() => {
    if (!companyId) return;
    httpsCallable(functions, "getTerritoryStats")({ companyId })
      .then((r) => setStats(((r.data as { stats?: Record<string, TerrStat> }).stats) || {}))
      .catch((e) => console.warn("territory stats", e));
  }, [companyId, items.length]);

  const nameFor = (uid: string) =>
    reps.find((r) => r.uid === uid)?.displayName ||
    reps.find((r) => r.uid === uid)?.email ||
    (uid === profile?.uid ? profile?.displayName || profile?.email : "") ||
    items.find((t) => t.assignedTo === uid)?.assignedToName ||
    "Rep";

  // Split into pending proposals, live areas (2 most recent per rep + unassigned)
  // and historical areas (everything older than a rep's 2 most recent).
  const { pending, liveItems, historicalByRep } = useMemo(() => {
    const pending = items.filter((t) => t.status === "pending");
    const active = items.filter((t) => t.status !== "pending" && t.status !== "rejected");
    const liveIds = new Set<string>();
    const byRep = new Map<string, Territory[]>();
    for (const t of active) {
      if (!t.assignedTo) { liveIds.add(t.id); continue; } // unassigned = available/live
      const arr = byRep.get(t.assignedTo) || [];
      arr.push(t);
      byRep.set(t.assignedTo, arr);
    }
    const historicalByRep = new Map<string, Territory[]>();
    for (const [uid, list] of byRep) {
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      list.slice(0, LIVE_PER_REP).forEach((t) => liveIds.add(t.id));
      const hist = list.slice(LIVE_PER_REP);
      if (hist.length) historicalByRep.set(uid, hist);
    }
    return {
      pending,
      liveItems: active.filter((t) => liveIds.has(t.id)),
      historicalByRep,
    };
  }, [items]);

  // Reps whose history this viewer may browse: managers see everyone with
  // history; a rep sees only their own.
  const histReps = useMemo(() => {
    const ids = [...historicalByRep.keys()];
    return canManage ? ids : ids.filter((id) => id === profile?.uid);
  }, [historicalByRep, canManage, profile]);

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
      status: "active",
      createdAt: Date.now(),
    });
    setName("");
    setDescription("");
    setAssignee("");
  };

  // Rep proposes an area; a manager approves it later.
  const propose = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setProposing(true);
    try {
      await httpsCallable(functions, "proposeTerritory")({ name: name.trim(), description: description.trim() || null });
      setName("");
      setDescription("");
      alert("Proposed! Your manager will review it.");
    } catch (err) {
      console.error(err);
      alert((err as { message?: string })?.message || "Couldn't propose that area.");
    } finally {
      setProposing(false);
    }
  };

  const approveProposal = async (id: string) => {
    await updateDoc(doc(db, "territories", id), { status: "active" });
  };
  const rejectProposal = async (id: string) => {
    if (confirm("Reject this proposed area?")) await updateDoc(doc(db, "territories", id), { status: "rejected" });
  };

  const remove = async (id: string) => {
    if (confirm("Delete this territory?")) await deleteDoc(doc(db, "territories", id));
  };

  const reassign = async (id: string, uid: string) => {
    const rep = reps.find((r) => r.uid === uid);
    await updateDoc(doc(db, "territories", id), {
      assignedTo: rep ? rep.uid : null,
      assignedToName: rep ? rep.displayName || rep.email || null : null,
    });
  };

  // Ask the server to recommend a pre-drawn area from this rep's best converter.
  const getRecommendation = async (repUid: string) => {
    setRec(null);
    setRecErr("");
    setRecLoading(true);
    try {
      const r = await httpsCallable(functions, "recommendTerritory")({ repUid });
      setRec((r.data as { recommendation: Recommendation }).recommendation);
    } catch (err) {
      setRecErr((err as { message?: string })?.message || "Couldn't build a recommendation yet.");
    } finally {
      setRecLoading(false);
    }
  };

  const approveRecommendation = async () => {
    if (!rec || !profile || !companyId || !histRep) return;
    await addDoc(collection(db, "territories"), {
      name: rec.name,
      description: rec.rationale,
      color: "#34D399",
      companyId,
      managerId: profile.uid,
      assignedTo: histRep,
      assignedToName: nameFor(histRep),
      polygon: rec.polygon,
      status: "active",
      createdAt: Date.now(),
    });
    setRec(null);
    alert("Area created and assigned. It's now one of the rep's live areas.");
  };

  const openHistory = (repUid: string) => {
    setHistRep(repUid);
    setRec(null);
    setRecErr("");
  };

  const card = (t: Territory) => {
    const s = stats[t.id];
    return (
      <div
        className="card territory-card"
        key={t.id}
        style={{ cursor: "pointer" }}
        title="Double-click to view on the map"
        onDoubleClick={() => navigate(`/map?focus=${t.id}`)}
      >
        <div className="territory-dot" style={{ background: t.color || COLORS[0] }} />
        <div className="territory-body">
          <div className="territory-name">
            {t.name}
            {s?.complete && <span className="badge" style={{ marginLeft: 8, background: "#22C55E", color: "#06121f", fontWeight: 700 }}>✓ Complete</span>}
          </div>
          {t.description && <div className="muted">{t.description}</div>}
          <div className="muted small" style={{ display: "flex", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
            <span>🏠 {s?.homes ?? 0} homes</span>
            <span>📊 {s?.completion ?? 0}% complete</span>
            <span>💰 {s?.success ?? 0}% success</span>
          </div>
          {canManage ? (
            <label className="field" style={{ marginTop: 6, marginBottom: 0 }} onDoubleClick={(e) => e.stopPropagation()}>
              <span>Assign to</span>
              <select value={t.assignedTo || ""} onChange={(e) => reassign(t.id, e.target.value)}>
                <option value="">— Unassigned —</option>
                {reps.map((r) => (
                  <option key={r.uid} value={r.uid}>
                    {(r.displayName || r.email) + (r.uid === profile?.uid ? " (me)" : "")}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="muted small">{t.assignedToName ? `Assigned to ${t.assignedToName}` : "Unassigned"}</div>
          )}
        </div>
        {canManage && (
          <button className="btn ghost sm" onClick={() => remove(t.id)} onDoubleClick={(e) => e.stopPropagation()}>
            Delete
          </button>
        )}
      </div>
    );
  };

  const histCards = histRep ? historicalByRep.get(histRep) || [] : [];

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Territories</h1>
        <p className="page-sub">Each rep keeps their {LIVE_PER_REP} most recent areas live — the rest move to history.</p>
      </div>

      {canManage ? (
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
            <button className="btn primary" type="submit">Add territory</button>
          </div>
        </form>
      ) : (
        <form className="card add-form" onSubmit={propose}>
          <p className="muted small" style={{ marginTop: 0 }}>
            Reps can’t assign their own areas — propose one and your manager will approve it. To draw the boundary, use the Map.
          </p>
          <div className="grid-2">
            <label className="field">
              <span>Proposed area name *</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="field">
              <span>Why this area?</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
          <div className="row end">
            <button className="btn primary" type="submit" disabled={proposing}>
              {proposing ? "Proposing…" : "Propose area"}
            </button>
          </div>
        </form>
      )}

      {/* Manager proposals inbox */}
      {canManage && pending.length > 0 && (
        <>
          <h2 className="section-h">⏳ Proposed areas ({pending.length})</h2>
          <div className="lb-list" style={{ marginBottom: 18 }}>
            {pending.map((t) => (
              <div key={t.id} className="lb-row card" style={{ alignItems: "center" }}>
                <div className="lb-row-main">
                  <div className="lb-row-top">
                    <span className="lb-row-name">{t.name}</span>
                    <span className="muted small">{t.assignedToName || nameFor(t.assignedTo || "")}</span>
                  </div>
                  {t.description && <div className="muted small">{t.description}</div>}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn primary sm" onClick={() => approveProposal(t.id)}>Approve</button>
                  <button className="btn ghost sm" onClick={() => rejectProposal(t.id)}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Rep's own pending proposals */}
      {!canManage && items.some((t) => t.status === "pending" && t.assignedTo === profile?.uid) && (
        <div className="muted small" style={{ marginBottom: 12 }}>
          {items.filter((t) => t.status === "pending" && t.assignedTo === profile?.uid).map((t) => (
            <div key={t.id}>⏳ “{t.name}” — pending your manager’s approval.</div>
          ))}
        </div>
      )}

      <div className="row between" style={{ alignItems: "center", marginBottom: 10 }}>
        <h2 className="section-h" style={{ margin: 0 }}>Live areas</h2>
        {histReps.length > 0 && (
          <button className="btn sm" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Hide" : "🗂 Historical territories"}
          </button>
        )}
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : liveItems.length === 0 ? (
        <div className="empty">No live territories yet.</div>
      ) : (
        <div className="territory-grid">{liveItems.map(card)}</div>
      )}

      {/* Historical territories: pick a rep → see their older areas + a
          data-driven recommended area the manager can approve or learn from. */}
      {showHistory && (
        <div className="card" style={{ marginTop: 18 }}>
          <h2 className="section-h" style={{ marginTop: 0 }}>🗂 Historical territories</h2>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {histReps.map((uid) => (
              <button
                key={uid}
                className={"btn sm" + (histRep === uid ? " primary" : "")}
                onClick={() => openHistory(uid)}
              >
                {nameFor(uid)} ({(historicalByRep.get(uid) || []).length})
              </button>
            ))}
          </div>

          {histRep && (
            <>
              <div className="territory-grid">{histCards.map(card)}</div>

              {canManage && (
                <div style={{ marginTop: 16 }}>
                  {!rec && (
                    <button className="btn primary" disabled={recLoading} onClick={() => getRecommendation(histRep)}>
                      {recLoading ? "Analyzing this rep’s areas…" : "✨ Recommend a new area"}
                    </button>
                  )}
                  {recErr && <div className="muted small" style={{ marginTop: 8 }}>{recErr}</div>}
                  {rec && (
                    <div className="card" style={{ marginTop: 12, borderColor: "#34D399" }}>
                      <div className="territory-name">✨ {rec.name}</div>
                      <div className="muted small" style={{ marginTop: 4 }}>{rec.rationale}</div>
                      <div className="muted small" style={{ display: "flex", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
                        <span>📐 Modeled on “{rec.basedOnName}”</span>
                        <span>💰 {rec.successRate}% success</span>
                        <span>🚪 {rec.sold}/{rec.doors} doors</span>
                      </div>
                      {rec.education && (
                        <p className="pitch-fb" style={{ marginTop: 10 }}><strong>🎓 Coaching:</strong> {rec.education}</p>
                      )}
                      <div className="row" style={{ gap: 8, marginTop: 10 }}>
                        <button className="btn primary sm" onClick={approveRecommendation}>Approve &amp; assign</button>
                        <button className="btn ghost sm" onClick={() => setRec(null)}>Just use for education</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
