import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Pitch } from "../types";

type Sort = "best" | "worst" | "recent";
const fmtDate = (ms: number) => ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

function scoreClass(s: number) { return s >= 80 ? "ps-hi" : s >= 60 ? "ps-mid" : "ps-lo"; }

export default function PitchLibrary() {
  const { profile, role, companyId } = useAuth();
  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [sort, setSort] = useState<Sort>("best");
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!profile || !companyId) return;
    // Admins see the whole company; managers see their team (downstream).
    const base = collection(db, "pitches");
    const q = role === "admin"
      ? query(base, where("companyId", "==", companyId))
      : query(base, where("companyId", "==", companyId), where("visibilityPath", "array-contains", profile.uid));
    return onSnapshot(
      q,
      (snap) => setPitches(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Pitch, "id">) }))),
      (e) => console.error("pitch library", e)
    );
  }, [profile, role, companyId]);

  const ranked = useMemo(() => {
    const scored = pitches.filter((p) => p.status === "analyzed" && typeof p.score === "number");
    if (sort === "recent") return [...scored].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return [...scored].sort((a, b) => sort === "best" ? (b.score! - a.score!) : (a.score! - b.score!));
  }, [pitches, sort]);

  const play = async (p: Pitch) => {
    if (urls[p.id]) return;
    try {
      const url = await getDownloadURL(storageRef(storage, p.audioPath));
      setUrls((u) => ({ ...u, [p.id]: url }));
    } catch (e) {
      console.error("pitch audio url", e);
    }
  };

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>🎬 Pitch Library</h1>
        <p className="page-sub">{role === "admin" ? "Company" : "Your team"} pitches, ranked by AI score — pull these up in training.</p>
      </div>

      <div className="type-pills" style={{ marginBottom: 14 }}>
        {(["best", "worst", "recent"] as Sort[]).map((s) => (
          <button key={s} className={"pill" + (sort === s ? " active" : "")} onClick={() => setSort(s)}>
            {s === "best" ? "🏆 Top scored" : s === "worst" ? "📉 Needs work" : "🕑 Most recent"}
          </button>
        ))}
      </div>

      {ranked.length === 0 ? (
        <div className="empty">No graded pitches yet. They appear here once reps record pitches and the AI scores them.</div>
      ) : (
        <div className="pl-list">
          {ranked.map((p, i) => (
            <div className="card pl-row" key={p.id}>
              <div className={"pl-rank " + (sort !== "recent" ? scoreClass(p.score!) : "")}>{sort === "recent" ? "•" : `#${i + 1}`}</div>
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
                  : <button className="btn sm" style={{ marginTop: 8 }} onClick={() => play(p)}>▶️ Play recording</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
