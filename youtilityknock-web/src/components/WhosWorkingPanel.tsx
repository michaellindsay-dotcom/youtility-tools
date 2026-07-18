import { useEffect, useState } from "react";
import { addDoc, collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { fmtElapsed } from "../shift/ShiftContext";
import { initials, avatarColor } from "../lib/points";
import type { Shift } from "../types";

// The live "who's on shift right now" board, plus the shout-out / rally-the-team
// actions that post into Team Chat. Shared by the standalone Who's Working page
// and the Chat page (where it lives as a rail view).
export default function WhosWorkingPanel() {
  const { profile, role, companyId } = useAuth();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [now, setNow] = useState(Date.now());
  const [shouted, setShouted] = useState<Set<string>>(new Set());
  const [rallySent, setRallySent] = useState(false);

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "shifts");
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId), where("status", "==", "active"))
        : query(
            base,
            where("companyId", "==", companyId),
            where("status", "==", "active"),
            where("visibilityPath", "array-contains", profile.uid)
          );
    return onSnapshot(
      q,
      (snap) => setShifts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Shift, "id">) }))),
      (e) => console.error("working query", e)
    );
  }, [profile, role, companyId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const active = [...shifts].sort((a, b) => (b.doorsKnocked ?? 0) - (a.doorsKnocked ?? 0));

  // Shout-outs / rally post to the poster's TEAM chat (not the company channel),
  // so hype stays with the crew it's about. Reps with no team fall back to the
  // company channel so nothing is silently dropped.
  async function postChat(text: string) {
    if (!profile || !companyId) return;
    const teamId = profile.teamId || null;
    if (teamId) {
      await addDoc(collection(db, "teamChat"), {
        companyId, teamId, userId: profile.uid, userName: profile.displayName, text, createdAt: Date.now(),
      });
    } else {
      await addDoc(collection(db, "chat"), {
        companyId, userId: profile.uid, userName: profile.displayName, text, createdAt: Date.now(),
      });
    }
  }

  async function shout(s: Shift) {
    const mins = Math.floor((now - s.startAt) / 60000);
    await postChat(`🔥 Shoutout to ${s.userName || "a teammate"} — out working ${s.doorsKnocked ?? 0} doors deep (${mins}m on shift)! Who's matching that energy? 💪`);
    setShouted((prev) => new Set(prev).add(s.id));
  }

  async function rally() {
    const n = active.length;
    await postChat(
      n > 0
        ? `📣 ${n} rep${n === 1 ? "" : "s"} out grinding right now — let's go! Get on a door and let's stack some wins today. 🚪💰`
        : `📣 Nobody's on shift yet — be the one who sets the pace today. Start a shift and let's get after it! 🔥`
    );
    setRallySent(true);
    setTimeout(() => setRallySent(false), 4000);
  }

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>🔥 Who's Working</h1>
          <p className="page-sub">
            {active.length === 0 ? "No one is on shift right now." : `${active.length} rep${active.length === 1 ? "" : "s"} out putting in work right now.`}
          </p>
        </div>
        <button className="btn primary sm" onClick={rally}>{rallySent ? "Sent to chat ✓" : "📣 Rally the team"}</button>
      </div>

      {active.length === 0 ? (
        <div className="empty">
          Nobody's clocked in. Hit <strong>Rally the team</strong> to light a fire — or start your own shift and lead from the front.
        </div>
      ) : (
        <div className="working-grid">
          {active.map((s) => {
            const elapsed = Math.max(0, Math.floor((now - s.startAt) / 1000));
            const mine = s.userId === profile?.uid;
            return (
              <div key={s.id} className={"working-card card" + (mine ? " you" : "")}>
                <div className="working-live"><span className="pulse-dot" /> LIVE</div>
                <div className="working-avatar" style={{ background: avatarColor(s.userId) }}>
                  {initials(s.userName)}
                </div>
                <div className="working-name">{s.userName || "Rep"}{mine && <span className="you-pill">YOU</span>}</div>
                <div className="working-stats">
                  <div><span className="working-n">{s.doorsKnocked ?? 0}</span><span className="muted small">doors</span></div>
                  <div><span className="working-n mono">{fmtElapsed(elapsed)}</span><span className="muted small">on shift</span></div>
                </div>
                {!mine && (
                  <button className="btn sm" onClick={() => shout(s)} disabled={shouted.has(s.id)}>
                    {shouted.has(s.id) ? "Shouted 🎉" : "🔥 Shout out"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="muted small" style={{ marginTop: 16 }}>
        Shout-outs post to <strong>Team Chat</strong> so the whole crew sees who's grinding — and gets pushed to get out there too.
      </p>
    </>
  );
}
