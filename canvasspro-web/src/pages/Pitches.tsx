import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Pitch } from "../types";

const fmtDate = (ms: number) => ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export default function Pitches() {
  const { profile } = useAuth();
  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});

  const play = async (p: Pitch) => {
    if (urls[p.id]) return;
    try {
      const url = await getDownloadURL(storageRef(storage, p.audioPath));
      setUrls((u) => ({ ...u, [p.id]: url }));
    } catch (e) {
      console.error("pitch audio url", e);
    }
  };

  useEffect(() => {
    if (!profile) return;
    return onSnapshot(
      query(collection(db, "pitches"), where("uid", "==", profile.uid)),
      (snap) => setPitches(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Pitch, "id">) }))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      ),
      (e) => console.error("my pitches", e)
    );
  }, [profile]);

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>🎙️ My Pitches</h1>
        <p className="page-sub">AI coaching on the pitches you recorded at the door.</p>
      </div>

      {pitches.length === 0 ? (
        <div className="empty">No pitch recordings yet. They show up here after you record a pitch on a door and get AI feedback.</div>
      ) : (
        <div className="pitch-cards">
          {pitches.map((p) => (
            <div className="card pitch-card" key={p.id}>
              <div className="pitch-card-head">
                <div>
                  <div className="muted small">{fmtDate(p.createdAt)}</div>
                  {p.address && <div className="pitch-addr">{p.address}</div>}
                </div>
                {p.status === "analyzed" && typeof p.score === "number" && (
                  <div className="pitch-score-big">{p.score}<small>/100</small></div>
                )}
              </div>

              {p.status === "analyzed" ? (
                <>
                  {p.feedback && <p className="pitch-fb">{p.feedback}</p>}
                  {p.highlight && <p className="pitch-hi"><strong>✅ What worked:</strong> {p.highlight}</p>}
                  {p.lowlight && <p className="pitch-lo"><strong>⚠️ To improve:</strong> {p.lowlight}</p>}
                  {urls[p.id]
                    ? <audio controls preload="none" src={urls[p.id]} style={{ width: "100%", marginTop: 8 }} />
                    : <button className="btn sm" style={{ marginTop: 8 }} onClick={() => play(p)}>▶️ Play recording</button>}
                </>
              ) : p.status === "error" ? (
                <p className="muted small">{p.feedback || "Couldn't analyze this recording."}</p>
              ) : (
                <p className="muted small">Analyzing your pitch…</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
