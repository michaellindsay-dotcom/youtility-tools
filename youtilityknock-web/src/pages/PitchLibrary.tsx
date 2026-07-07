import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { db, functions, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Pitch } from "../types";

const fmtDate = (ms: number) => ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
function scoreClass(s: number) { return s >= 80 ? "ps-hi" : s >= 60 ? "ps-mid" : "ps-lo"; }

type TopPitch = { id: string; userName: string; score: number; address?: string; feedback?: string; highlight?: string; lowlight?: string; audioPath: string; createdAt: number };

export default function PitchLibrary() {
  const { profile, role, companyId } = useAuth();
  const isMgr = role === "admin" || role === "manager";
  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [top, setTop] = useState<TopPitch[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [openRep, setOpenRep] = useState<string | null>(null);

  // Top 3 company pitches this week — everyone sees these.
  useEffect(() => {
    if (!companyId) return;
    httpsCallable(functions, "topCompanyPitches")({})
      .then((r) => setTop(((r.data as { pitches?: TopPitch[] })?.pitches) || []))
      .catch((e) => console.error("topCompanyPitches", e));
  }, [companyId]);

  // Downstream pitches (managers/admins only) for the per-rep drill-in.
  useEffect(() => {
    if (!profile || !companyId || !isMgr) return;
    const base = collection(db, "pitches");
    const q = role === "admin"
      ? query(base, where("companyId", "==", companyId))
      : query(base, where("companyId", "==", companyId), where("visibilityPath", "array-contains", profile.uid));
    return onSnapshot(
      q,
      (snap) => setPitches(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Pitch, "id">) }))),
      (e) => console.error("pitch library", e)
    );
  }, [profile, role, companyId, isMgr]);

  const play = async (id: string, audioPath: string) => {
    if (urls[id] || !audioPath) return;
    try {
      const url = await getDownloadURL(storageRef(storage, audioPath));
      setUrls((u) => ({ ...u, [id]: url }));
    } catch (e) { console.error("pitch audio url", e); }
  };

  // Group the downline's scored pitches by rep for the roster.
  const reps = useMemo(() => {
    const scored = pitches.filter((p) => p.status === "analyzed" && typeof p.score === "number");
    const byUid = new Map<string, { uid: string; name: string; items: Pitch[]; best: number }>();
    for (const p of scored) {
      const g = byUid.get(p.uid) ?? { uid: p.uid, name: p.userName || "Rep", items: [], best: 0 };
      g.items.push(p);
      g.best = Math.max(g.best, p.score!);
      byUid.set(p.uid, g);
    }
    return [...byUid.values()]
      .map((g) => ({ ...g, items: g.items.sort((a, b) => (b.score! - a.score!)) }))
      .sort((a, b) => b.best - a.best);
  }, [pitches]);

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>🎬 Pitch Library</h1>
        <p className="page-sub">Learn from the best — this week's top company pitches, plus your team's recordings.</p>
      </div>

      {/* Everyone: top 3 company pitches this week. */}
      <h2 className="section-h">🏆 Top 3 Company Pitches · This Week</h2>
      {top.length === 0 ? (
        <div className="empty">No graded pitches yet this week. Record a pitch — the AI scores it and the best ones show here.</div>
      ) : (
        <div className="pl-list">
          {top.map((p, i) => (
            <div className="card pl-row" key={p.id}>
              <div className={"pl-rank " + scoreClass(p.score)}>{["🥇", "🥈", "🥉"][i] || `#${i + 1}`}</div>
              <div className="pl-main">
                <div className="pl-top">
                  <span className="pl-name">{p.userName}</span>
                  <span className={"pl-score " + scoreClass(p.score)}>{p.score}<small>/100</small></span>
                </div>
                <div className="muted small">{fmtDate(p.createdAt)}{p.address ? ` · ${p.address}` : ""}</div>
                {p.feedback && <p className="pitch-fb">{p.feedback}</p>}
                {p.highlight && <p className="pitch-hi"><strong>✅ Best:</strong> {p.highlight}</p>}
                {urls[p.id]
                  ? <audio controls preload="none" src={urls[p.id]} style={{ width: "100%", marginTop: 8 }} />
                  : <button className="btn sm" style={{ marginTop: 8 }} onClick={() => play(p.id, p.audioPath)}>▶️ Play recording</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Managers/admins: pick a rep in your downline to review their pitches. */}
      {isMgr && (
        <>
          <h2 className="section-h" style={{ marginTop: 22 }}>👥 Your Team</h2>
          <p className="muted small" style={{ marginTop: -8, marginBottom: 12 }}>Tap a rep to review their graded pitches.</p>
          {reps.length === 0 ? (
            <div className="empty">No graded pitches from your team yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {reps.map((rep) => (
                <div className="card" key={rep.uid}>
                  <button className="row between" style={{ width: "100%", background: "none", border: "none", cursor: "pointer", color: "inherit", alignItems: "center" }}
                    onClick={() => setOpenRep((o) => (o === rep.uid ? null : rep.uid))}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span>{openRep === rep.uid ? "▾" : "▸"}</span>
                      <strong>{rep.name}</strong>
                      <span className="muted small">{rep.items.length} pitch{rep.items.length === 1 ? "" : "es"}</span>
                    </span>
                    <span className={"pl-score " + scoreClass(rep.best)}>best {rep.best}<small>/100</small></span>
                  </button>
                  {openRep === rep.uid && (
                    <div className="pl-list" style={{ marginTop: 10 }}>
                      {rep.items.map((p, i) => (
                        <div className="card pl-row" key={p.id}>
                          <div className={"pl-rank " + scoreClass(p.score!)}>#{i + 1}</div>
                          <div className="pl-main">
                            <div className="pl-top">
                              <span className="pl-name">{p.userName || "Rep"}</span>
                              <span className={"pl-score " + scoreClass(p.score!)}>{p.score}<small>/100</small></span>
                            </div>
                            <div className="muted small">{fmtDate(p.createdAt)}{p.address ? ` · ${p.address}` : ""}</div>
                            {p.feedback && <p className="pitch-fb">{p.feedback}</p>}
                            {p.highlight && <p className="pitch-hi"><strong>✅ Best:</strong> {p.highlight}</p>}
                            {p.lowlight && <p className="pitch-lo"><strong>⚠️ Fix:</strong> {p.lowlight}</p>}
                            {urls[p.id]
                              ? <audio controls preload="none" src={urls[p.id]} style={{ width: "100%", marginTop: 8 }} />
                              : <button className="btn sm" style={{ marginTop: 8 }} onClick={() => play(p.id, p.audioPath)}>▶️ Play recording</button>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!isMgr && (
        <p className="muted small" style={{ marginTop: 18 }}>
          Want to review your own recordings? Head to <Link to="/pitches">My Pitches →</Link>
        </p>
      )}
    </div>
  );
}
