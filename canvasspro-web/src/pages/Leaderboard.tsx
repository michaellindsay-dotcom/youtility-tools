import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import {
  PTS, LEVEL_PTS, computePoints, levelInfo, tierFor, initials, avatarColor, pointLines,
} from "../lib/points";
import type { UserStats } from "../types";

interface Ranked extends UserStats { points: number; rank: number; }

export default function Leaderboard() {
  const { profile, role, companyId } = useAuth();
  const [rows, setRows] = useState<UserStats[]>([]);
  const [showHow, setShowHow] = useState(false);

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "userStats");
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId))
        : query(base, where("companyId", "==", companyId), where("managerPath", "array-contains", profile.uid));
    return onSnapshot(q, (snap) =>
      setRows(snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserStats, "uid">) })))
    );
  }, [profile, role, companyId]);

  const ranked: Ranked[] = useMemo(
    () =>
      [...rows]
        .map((r) => ({ ...r, points: computePoints(r), rank: 0 }))
        .sort((a, b) => b.points - a.points)
        .map((r, i) => ({ ...r, rank: i + 1 })),
    [rows]
  );

  const leaderPts = ranked[0]?.points || 1;
  const me = ranked.find((r) => r.uid === profile?.uid);
  const podium = ranked.slice(0, 3);
  const rest = ranked.slice(3);

  return (
    <div className="page-body lb">
      <div className="page-head row">
        <div>
          <h1>🏆 Leaderboard</h1>
          <p className="page-sub">{role === "admin" ? "Company" : "Your team"} rankings · all-time points</p>
        </div>
        <button className="chip-btn" onClick={() => setShowHow((v) => !v)}>
          {showHow ? "Hide" : "How points work"}
        </button>
      </div>

      {showHow && (
        <div className="card lb-how">
          {pointLines({}).map((l) => (
            <span key={l.key} className="lb-how-chip">
              {l.emoji} {l.label} <strong>+{l.per}</strong>
            </span>
          ))}
          <span className="muted small">Closes are worth {PTS.sale}× a door — book and close to rocket up.</span>
        </div>
      )}

      {me && <StandingHero me={me} total={ranked.length} />}

      {podium.length > 0 && (
        <div className="podium">
          {/* 2nd · 1st · 3rd for the classic podium silhouette */}
          {[podium[1], podium[0], podium[2]].map((p, i) =>
            p ? (
              <PodiumSpot key={p.uid} r={p} you={p.uid === profile?.uid} />
            ) : (
              <div key={`empty-${i}`} className="podium-empty" />
            )
          )}
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="empty">No points yet — they pile up as the team knocks, books, and closes. 🚪→💰</div>
      ) : (
        <div className="lb-list">
          {rest.map((r) => (
            <RankRow key={r.uid} r={r} you={r.uid === profile?.uid} leaderPts={leaderPts} />
          ))}
        </div>
      )}
    </div>
  );
}

function StandingHero({ me, total }: { me: Ranked; total: number }) {
  const lvl = levelInfo(me.points);
  const tier = tierFor(lvl.level);
  const lines = pointLines(me).filter((l) => l.count > 0);
  return (
    <div className="lb-hero card" style={{ ["--tier" as string]: tier.color }}>
      <div className="lb-hero-rank">
        <div className="lb-hero-rank-n">#{me.rank}</div>
        <div className="muted small">of {total}</div>
      </div>
      <div className="lb-hero-mid">
        <div className="lb-hero-name">{me.userName || "You"}</div>
        <div className="lb-tier" style={{ background: tier.color }}>{tier.emoji} {tier.name} · L{lvl.level}</div>
        <div className="lb-xp">
          <div className="lb-xp-bar"><span style={{ width: `${lvl.pct}%` }} /></div>
          <div className="muted small">{lvl.into}/{LEVEL_PTS} XP · {lvl.toNext} to L{lvl.level + 1}</div>
        </div>
        <div className="lb-hero-chips">
          {lines.map((l) => (
            <span key={l.key} className="lb-chip" title={`${l.count} × ${l.per} = ${l.total}`}>{l.emoji} {l.count}</span>
          ))}
        </div>
      </div>
      <div className="lb-hero-pts">
        <div className="lb-hero-pts-n">{me.points.toLocaleString()}</div>
        <div className="muted small">points</div>
      </div>
    </div>
  );
}

function PodiumSpot({ r, you }: { r: Ranked; you: boolean }) {
  const place = r.rank; // 1, 2, or 3
  const lvl = levelInfo(r.points);
  const tier = tierFor(lvl.level);
  const medal = place === 1 ? "🥇" : place === 2 ? "🥈" : "🥉";
  return (
    <div className={`podium-spot place-${place}` + (you ? " you" : "")}>
      {place === 1 && <div className="podium-crown">👑</div>}
      <div className="podium-avatar" style={{ background: avatarColor(r.uid) }}>
        {initials(r.userName)}
        <span className="podium-medal">{medal}</span>
      </div>
      <div className="podium-name">
        {r.userName || "—"}
        {you && <span className="you-pill">YOU</span>}
      </div>
      <div className="podium-tier" style={{ color: tier.color }}>{tier.emoji} L{lvl.level}</div>
      <div className="podium-pts">{r.points.toLocaleString()}</div>
      <div className={`podium-base base-${place}`}>
        <span className="podium-base-n">{place}</span>
      </div>
      <div className="muted small podium-sub">{r.sales ?? 0}💰 · {r.appointments ?? 0}📅</div>
    </div>
  );
}

function RankRow({ r, you, leaderPts }: { r: Ranked; you: boolean; leaderPts: number }) {
  const lvl = levelInfo(r.points);
  const tier = tierFor(lvl.level);
  const barPct = Math.max(4, Math.round((r.points / leaderPts) * 100));
  return (
    <div className={"lb-row card" + (you ? " you" : "")}>
      <div className="lb-row-rank">{r.rank}</div>
      <div className="lb-avatar" style={{ background: avatarColor(r.uid) }}>{initials(r.userName)}</div>
      <div className="lb-row-main">
        <div className="lb-row-top">
          <span className="lb-row-name">
            {r.userName || r.uid}
            {you && <span className="you-pill">YOU</span>}
          </span>
          <span className="lb-row-tier" style={{ color: tier.color }}>{tier.emoji} {tier.name} · L{lvl.level}</span>
        </div>
        <div className="lb-row-bar"><span style={{ width: `${barPct}%`, background: tier.color }} /></div>
        <div className="lb-row-stats muted small">
          {r.sales ?? 0} 💰 · {r.appointments ?? 0} 📅 · {r.doorsKnocked ?? 0} 🚪 · {r.shifts ?? 0} ⏱️
        </div>
      </div>
      <div className="lb-row-pts">
        <div className="lb-row-pts-n">{r.points.toLocaleString()}</div>
        <div className="muted small">pts</div>
      </div>
    </div>
  );
}
