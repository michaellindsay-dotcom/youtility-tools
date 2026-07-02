import { computePoints, levelInfo, tierFor, initials, avatarColor } from "../lib/points";
import type { UserStats } from "../types";

// One entry on the top-3 podium. `points`/`headline`/`sub` are optional: if
// omitted, points are computed from the stat fields and the headline is the
// point total (the Dashboard passes raw stats; the Leaderboard passes its
// already-ranked rows with a prorated headline).
export interface PodiumEntry extends Partial<UserStats> {
  uid: string;
  points?: number;
  headline?: string;
  sub?: string;
}

function Spot({ e, place, you }: { e: PodiumEntry; place: number; you: boolean }) {
  const points = e.points ?? computePoints(e);
  const lvl = levelInfo(points);
  const tier = tierFor(lvl.level);
  const medal = place === 1 ? "🥇" : place === 2 ? "🥈" : "🥉";
  const headline = e.headline ?? points.toLocaleString();
  return (
    <div className={`podium-spot place-${place}` + (you ? " you" : "")}>
      {place === 1 && <div className="podium-crown">👑</div>}
      <div className="podium-avatar" style={{ background: avatarColor(e.uid) }}>
        {initials(e.userName)}
        <span className="podium-medal">{medal}</span>
      </div>
      <div className="podium-name">{e.userName || "—"}{you && <span className="you-pill">YOU</span>}</div>
      <div className="podium-tier" style={{ color: tier.color }}>{tier.emoji} L{lvl.level}</div>
      <div className="podium-pts">{headline}</div>
      <div className={`podium-base base-${place}`}><span className="podium-base-n">{place}</span></div>
      <div className="muted small podium-sub">{e.sub || `${e.sales ?? 0}💰 · ${e.appointments ?? 0}📅`}</div>
    </div>
  );
}

// The top-3 podium, laid out 2nd · 1st · 3rd. `entries` must already be ranked
// (index 0 = 1st place). Renders nothing if there are no entries.
export default function Podium({ entries, youUid }: { entries: PodiumEntry[]; youUid?: string }) {
  const podium = entries.slice(0, 3);
  if (podium.length === 0) return null;
  // Visual order: silver, gold, bronze — with gold raised in the middle.
  const order = [1, 0, 2];
  return (
    <div className="podium">
      {order.map((idx, i) => {
        const p = podium[idx];
        return p ? (
          <Spot key={p.uid} e={p} place={idx + 1} you={p.uid === youUid} />
        ) : (
          <div key={`empty-${i}`} className="podium-empty" />
        );
      })}
    </div>
  );
}
