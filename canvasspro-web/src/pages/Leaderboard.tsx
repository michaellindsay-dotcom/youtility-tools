import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import {
  PTS, LEVEL_PTS, computePoints, levelInfo, tierFor, initials, avatarColor, pointLines,
} from "../lib/points";
import { periodKey, seasonDocId, activeDaysThisYear, SEASON_LABEL, type SeasonView } from "../lib/season";
import type { UserStats } from "../types";

interface Ranked extends UserStats {
  points: number; // raw season points
  score: number; // sort key (rate for the prorated yearly board)
  rank: number;
  headline: string; // big number shown
  sub?: string; // secondary line
}

const VIEWS: SeasonView[] = ["week", "month", "year", "alltime"];

export default function Leaderboard() {
  const { profile, role, companyId } = useAuth();
  const [view, setView] = useState<SeasonView>("week");
  const [rows, setRows] = useState<UserStats[]>([]);
  const [selfRow, setSelfRow] = useState<UserStats | null>(null);
  const [showHow, setShowHow] = useState(false);

  useEffect(() => {
    if (!profile || !companyId) return;
    // All-time reads userStats; seasons read the matching seasonStats bucket.
    const coll = view === "alltime" ? "userStats" : "seasonStats";
    const base = collection(db, coll);
    const filters = [where("companyId", "==", companyId)] as ReturnType<typeof where>[];
    if (view !== "alltime") filters.push(where("period", "==", periodKey(view)));
    if (role !== "admin") filters.push(where("managerPath", "array-contains", profile.uid));
    return onSnapshot(
      query(base, ...filters),
      (snap) => setRows(snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserStats, "uid">) }))),
      (e) => console.error("leaderboard query", e)
    );
  }, [profile, role, companyId, view]);

  // The managerPath filter above excludes the viewer's own doc (managerPath
  // omits self), so a non-admin would never see themselves on the board.
  // Subscribe to their own stats doc separately and merge it in.
  useEffect(() => {
    if (!profile) return;
    const ref = view === "alltime"
      ? doc(db, "userStats", profile.uid)
      : doc(db, "seasonStats", seasonDocId(profile.uid, view));
    return onSnapshot(
      ref,
      (snap) => setSelfRow(snap.exists() ? { uid: snap.id, ...(snap.data() as Omit<UserStats, "uid">) } : null),
      (e) => console.error("self stats", e)
    );
  }, [profile, view]);

  const ranked: Ranked[] = useMemo(() => {
    const prorate = view === "year";
    const merged = selfRow && !rows.some((r) => r.uid === selfRow.uid) ? [...rows, selfRow] : rows;
    const built = merged.map((r) => {
      const points = computePoints(r);
      if (prorate) {
        const rate = points / activeDaysThisYear(r.joinedAt);
        return {
          ...r, points, score: rate, rank: 0,
          headline: `${Math.round(rate).toLocaleString()}/day`,
          sub: `${points.toLocaleString()} pts`,
        };
      }
      return { ...r, points, score: points, rank: 0, headline: points.toLocaleString(), sub: undefined };
    });
    return built.sort((a, b) => b.score - a.score).map((r, i) => ({ ...r, rank: i + 1 }));
  }, [rows, selfRow, view]);

  const leaderScore = ranked[0]?.score || 1;
  const me = ranked.find((r) => r.uid === profile?.uid);
  const podium = ranked.slice(0, 3);
  const rest = ranked.slice(3);

  return (
    <div className="page-body lb">
      <div className="page-head row">
        <div>
          <h1>🏆 Leaderboard</h1>
          <p className="page-sub">{role === "admin" ? "Company" : "Your team"} · {SEASON_LABEL[view]}</p>
        </div>
        <button className="chip-btn" onClick={() => setShowHow((v) => !v)}>
          {showHow ? "Hide" : "How points work"}
        </button>
      </div>

      <div className="type-pills" style={{ marginBottom: 14 }}>
        {VIEWS.map((v) => (
          <button key={v} className={"pill" + (view === v ? " active" : "")} onClick={() => setView(v)}>
            {SEASON_LABEL[v]}
          </button>
        ))}
      </div>

      {view === "year" && (
        <div className="card lb-prorate-note">
          ⚖️ The yearly board is ranked by <strong>points per day since you joined</strong> — so newcomers get a
          fair shot at the top, not buried under full-year veterans.
        </div>
      )}

      {showHow && (
        <div className="card lb-how">
          {pointLines({}).map((l) => (
            <span key={l.key} className="lb-how-chip">{l.emoji} {l.label} <strong>+{l.per}</strong></span>
          ))}
          <span className="muted small">Closes are worth {PTS.sale}× a door — book and close to rocket up.</span>
        </div>
      )}

      {me && <StandingHero me={me} total={ranked.length} prorated={view === "year"} />}

      {podium.length > 0 && (
        <div className="podium">
          {[podium[1], podium[0], podium[2]].map((p, i) =>
            p ? <PodiumSpot key={p.uid} r={p} you={p.uid === profile?.uid} /> : <div key={`e-${i}`} className="podium-empty" />
          )}
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="empty">No points yet {view !== "alltime" ? `for ${SEASON_LABEL[view].toLowerCase()}` : ""} — they pile up as the team knocks, books, and closes. 🚪→💰</div>
      ) : (
        <div className="lb-list">
          {rest.map((r) => <RankRow key={r.uid} r={r} you={r.uid === profile?.uid} leaderScore={leaderScore} />)}
        </div>
      )}
    </div>
  );
}

function StandingHero({ me, total, prorated }: { me: Ranked; total: number; prorated: boolean }) {
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
        <div className="lb-hero-pts-n">{me.headline}</div>
        <div className="muted small">{prorated ? me.sub : "points"}</div>
      </div>
    </div>
  );
}

function PodiumSpot({ r, you }: { r: Ranked; you: boolean }) {
  const place = r.rank;
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
      <div className="podium-name">{r.userName || "—"}{you && <span className="you-pill">YOU</span>}</div>
      <div className="podium-tier" style={{ color: tier.color }}>{tier.emoji} L{lvl.level}</div>
      <div className="podium-pts">{r.headline}</div>
      <div className={`podium-base base-${place}`}><span className="podium-base-n">{place}</span></div>
      <div className="muted small podium-sub">{r.sub || `${r.sales ?? 0}💰 · ${r.appointments ?? 0}📅`}</div>
    </div>
  );
}

function RankRow({ r, you, leaderScore }: { r: Ranked; you: boolean; leaderScore: number }) {
  const lvl = levelInfo(r.points);
  const tier = tierFor(lvl.level);
  const barPct = Math.max(4, Math.round((r.score / leaderScore) * 100));
  return (
    <div className={"lb-row card" + (you ? " you" : "")}>
      <div className="lb-row-rank">{r.rank}</div>
      <div className="lb-avatar" style={{ background: avatarColor(r.uid) }}>{initials(r.userName)}</div>
      <div className="lb-row-main">
        <div className="lb-row-top">
          <span className="lb-row-name">{r.userName || r.uid}{you && <span className="you-pill">YOU</span>}</span>
          <span className="lb-row-tier" style={{ color: tier.color }}>{tier.emoji} {tier.name} · L{lvl.level}</span>
        </div>
        <div className="lb-row-bar"><span style={{ width: `${barPct}%`, background: tier.color }} /></div>
        <div className="lb-row-stats muted small">
          {r.sales ?? 0} 💰 · {r.appointments ?? 0} 📅 · {r.doorsKnocked ?? 0} 🚪 · {r.shifts ?? 0} ⏱️
        </div>
      </div>
      <div className="lb-row-pts">
        <div className="lb-row-pts-n">{r.headline}</div>
        <div className="muted small">{r.sub || "pts"}</div>
      </div>
    </div>
  );
}
