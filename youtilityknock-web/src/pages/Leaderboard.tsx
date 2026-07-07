import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { collection, doc, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { isRallyCardOnly } from "../lib/features";
import {
  PTS, LEVEL_PTS, computePoints, levelInfo, tierFor, initials, avatarColor, pointLines,
} from "../lib/points";
import { periodKey, seasonDocId, activeDaysThisYear, SEASON_LABEL, type SeasonView } from "../lib/season";
import Podium from "../components/Podium";
import type { Team, UserProfile, UserStats } from "../types";

interface Ranked extends UserStats {
  points: number; // raw season points
  score: number; // sort key (rate for the prorated yearly board)
  rank: number;
  headline: string; // big number shown
  sub?: string; // secondary line
}

const VIEWS: SeasonView[] = ["week", "month", "year", "alltime"];

// Window start (ms) for the funnel rankings — the week is Monday-based to match
// the admin Town Hall; all-time is 0 (everything).
function periodStartMs(view: SeasonView): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (view === "week") { const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.getTime(); }
  if (view === "month") { d.setDate(1); return d.getTime(); }
  if (view === "year") { return new Date(d.getFullYear(), 0, 1).getTime(); }
  return 0; // alltime
}

interface FunnelRow { uid: string; name: string; doors: number; conv: number; appt: number; closed: number }

// Close rate = closes ÷ appointments. "—" when no appointments yet, so it
// never reads as a misleading 0% / 100%.
const closeRate = (sales?: number, appts?: number) =>
  (appts && appts > 0 ? `${Math.round(((sales ?? 0) / appts) * 100)}%` : "—");

export default function Leaderboard() {
  const { profile, role, companyId, company } = useAuth();
  const [view, setView] = useState<SeasonView>("week");
  const [rows, setRows] = useState<UserStats[]>([]);
  const [selfRow, setSelfRow] = useState<UserStats | null>(null);
  const [showHow, setShowHow] = useState(false);

  useEffect(() => {
    if (!profile || !companyId) return;
    // All-time reads userStats; seasons read the matching seasonStats bucket.
    const coll = view === "alltime" ? "userStats" : "seasonStats";
    const base = collection(db, coll);
    // Company-wide: every rep sees the whole company's leaderboard.
    const filters = [where("companyId", "==", companyId)] as ReturnType<typeof where>[];
    if (view !== "alltime") filters.push(where("period", "==", periodKey(view)));
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

  // Current-period stats by user, for the team ratings section. Both userStats
  // and seasonStats docs carry a real `uid` field, so this keys correctly on
  // every view.
  const statsByUid = useMemo(() => {
    const m = new Map<string, UserStats>();
    for (const r of rows) m.set(r.uid, r);
    if (selfRow) m.set(selfRow.uid, selfRow);
    return m;
  }, [rows, selfRow]);

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

  // Top 3 for each raw metric (independent of the points formula).
  const metricTops = useMemo(() => {
    const merged = selfRow && !rows.some((r) => r.uid === selfRow.uid) ? [...rows, selfRow] : rows;
    const top3 = (key: "doorsKnocked" | "appointments" | "sales") =>
      merged
        .map((r) => ({ uid: r.uid, name: r.userName || r.uid, value: (r[key] as number) ?? 0 }))
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 3);
    return { doors: top3("doorsKnocked"), appts: top3("appointments"), sales: top3("sales") };
  }, [rows, selfRow]);

  return (
    <div className="page-body lb">
      <div className="page-head row">
        <div>
          <h1>🏆 Leaderboard</h1>
          <p className="page-sub">Company · {SEASON_LABEL[view]}</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {/* RallyCard-only companies have no Dashboard to go back to. */}
          {!isRallyCardOnly(company) && (
            <Link className="btn ghost sm" to="/">← Back to Dashboard</Link>
          )}
          <button className="chip-btn" onClick={() => setShowHow((v) => !v)}>
            {showHow ? "Hide" : "How points work"}
          </button>
        </div>
      </div>

      <div className="type-pills" style={{ marginBottom: 14 }}>
        {VIEWS.map((v) => (
          <button key={v} className={"pill" + (view === v ? " active" : "")} onClick={() => setView(v)}>
            {SEASON_LABEL[v]}
          </button>
        ))}
      </div>

      <div className="lb-tops">
        <MetricTop title="🚪 Doors knocked" rows={metricTops.doors} mine={profile?.uid} />
        <MetricTop title="📅 Appointments" rows={metricTops.appts} mine={profile?.uid} />
        <MetricTop title="💰 Sales" rows={metricTops.sales} mine={profile?.uid} />
      </div>

      <RoleLeaderboard view={view} mine={profile?.uid} />

      {(role === "admin" || role === "manager") && <TeamRatings statsByUid={statsByUid} />}

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

      <Podium entries={podium} youUid={profile?.uid} />

      {ranked.length === 0 ? (
        <div className="empty">No points yet {view !== "alltime" ? `for ${SEASON_LABEL[view].toLowerCase()}` : ""} — they pile up as the team knocks, books, and closes. 🚪→💰</div>
      ) : (
        <div className="lb-list">
          {rest.map((r) => <RankRow key={r.uid} r={r} you={r.uid === profile?.uid} leaderScore={leaderScore} />)}
        </div>
      )}

      <RepRankings view={view} mine={profile?.uid} />
    </div>
  );
}

// Company-wide rep funnel table (doors / convos / appts / closed / close%) for
// the selected period — the same board the admin Town Hall shows. Computed
// server-side so every rep sees the whole company, and no reps are missing.
function RepRankings({ view, mine }: { view: SeasonView; mine?: string }) {
  const [rows, setRows] = useState<FunnelRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    httpsCallable(functions, "companyFunnelRankings")({ startMs: periodStartMs(view) })
      .then((r) => { if (!cancelled) setRows(((r.data as { rankings?: FunnelRow[] })?.rankings) || []); })
      .catch((e) => { console.error("rep rankings", e); if (!cancelled) setRows([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view]);

  const medal = ["🥇", "🥈", "🥉"];
  return (
    <div className="card lb-reprank" style={{ marginTop: 18 }}>
      <h2 className="section-h" style={{ margin: "0 0 8px" }}>🏆 Rep Rankings · {SEASON_LABEL[view]}</h2>
      {loading ? (
        <div className="muted small">Loading rankings…</div>
      ) : rows.length === 0 ? (
        <div className="muted small">No rep activity yet {view !== "alltime" ? `for ${SEASON_LABEL[view].toLowerCase()}` : ""}.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--ink-dim)", fontSize: 12 }}>
                <th style={{ padding: "6px 8px" }}>Rep</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Doors</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Convos</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Appts</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Closed</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Close %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.uid} style={{ borderTop: "1px solid var(--line)", fontWeight: r.uid === mine ? 700 : 400 }}>
                  <td style={{ padding: "8px" }}>{i < 3 ? `${medal[i]} ` : ""}{r.uid === mine ? "You" : r.name}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{r.doors}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{r.conv}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{r.appt}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{r.closed}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{closeRate(r.closed, r.appt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Setter and closer leaderboards, split by lane. A setter sees where they rank
// among other setters (doors / appts / sat / sit %); a closer among other
// closers (assigned / sat / closed / close %). Regular reps see only their own
// lane; managers & admins get a toggle to see either.
interface SetterRow { uid: string; name: string; doors: number; appts: number; sits: number; pitchedAppts: number; sitRate: number | null }
interface CloserRow { uid: string; name: string; appts: number; sits: number; closes: number; turnedAways: number; closeRate: number | null }

function RoleLeaderboard({ view, mine }: { view: SeasonView; mine?: string }) {
  const { profile, role } = useAuth();
  const isMgr = role === "admin" || role === "manager" || role === "superadmin";
  // Default lane: closers land on the closer board, everyone else on setters.
  const [lane, setLane] = useState<"setters" | "closers">(profile?.isCloser ? "closers" : "setters");
  const [setters, setSetters] = useState<SetterRow[]>([]);
  const [closers, setClosers] = useState<CloserRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    httpsCallable(functions, "roleLeaderboards")({ view })
      .then((r) => {
        if (cancelled) return;
        const d = r.data as { setters?: SetterRow[]; closers?: CloserRow[] };
        setSetters(d.setters || []);
        setClosers(d.closers || []);
      })
      .catch((e) => { console.error("role leaderboards", e); if (!cancelled) { setSetters([]); setClosers([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view]);

  const medal = ["🥇", "🥈", "🥉"];
  const th = { padding: "6px 8px", textAlign: "right" as const };
  const td = { padding: "8px", textAlign: "right" as const };
  const showClosers = lane === "closers";
  const rows = showClosers ? closers : setters;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <h2 className="section-h" style={{ margin: 0 }}>
          {showClosers ? "🤝 Closer Rankings" : "🎯 Setter Rankings"} · {SEASON_LABEL[view]}
        </h2>
        {/* Only managers/admins can flip lanes; a rep sees their own lane only. */}
        {isMgr && (
          <div className="type-pills">
            <button className={"pill" + (!showClosers ? " active" : "")} onClick={() => setLane("setters")}>Setters</button>
            <button className={"pill" + (showClosers ? " active" : "")} onClick={() => setLane("closers")}>Closers</button>
          </div>
        )}
      </div>
      {loading ? (
        <div className="muted small">Loading rankings…</div>
      ) : rows.length === 0 ? (
        <div className="muted small">No {showClosers ? "closer" : "setter"} activity yet {view !== "alltime" ? `for ${SEASON_LABEL[view].toLowerCase()}` : ""}.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--ink-dim)", fontSize: 12 }}>
                <th style={{ padding: "6px 8px" }}>{showClosers ? "Closer" : "Setter"}</th>
                {showClosers ? (
                  <>
                    <th style={th}>Assigned</th>
                    <th style={th}>Sat</th>
                    <th style={th}>Closed</th>
                    <th style={th}>Close %</th>
                  </>
                ) : (
                  <>
                    <th style={th}>Doors</th>
                    <th style={th}>Appts</th>
                    <th style={th}>Sat</th>
                    <th style={th}>Sit %</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {(showClosers ? closers : setters).map((r, i) => (
                <tr key={r.uid} style={{ borderTop: "1px solid var(--line)", fontWeight: r.uid === mine ? 700 : 400 }}>
                  <td style={{ padding: "8px" }}>{i < 3 ? `${medal[i]} ` : ""}{r.uid === mine ? "You" : r.name}</td>
                  {showClosers ? (
                    <>
                      <td style={td}>{(r as CloserRow).appts}</td>
                      <td style={td}>{(r as CloserRow).sits}</td>
                      <td style={td}>{(r as CloserRow).closes}</td>
                      <td style={td}>{(r as CloserRow).closeRate == null ? "—" : `${(r as CloserRow).closeRate}%`}</td>
                    </>
                  ) : (
                    <>
                      <td style={td}>{(r as SetterRow).doors}</td>
                      <td style={td}>{(r as SetterRow).appts}</td>
                      <td style={td}>{(r as SetterRow).sits}</td>
                      <td style={td}>{(r as SetterRow).sitRate == null ? "—" : `${(r as SetterRow).sitRate}%`}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Team ratings (managers & admins) ─────────────────────────────────────────
// Each team expands into its hierarchy (downline order, indented). Every member
// gets a 0–100 rating for the selected period: 75% production — closes for
// closers, appointments set + sat for setters, each normalized against the best
// in that function — and 25% overall activity (gamify points: doors, shifts,
// conversations, hours on the grind). Production is deliberately king.
const scoreColor = (n: number) =>
  n >= 75 ? "#34D399" : n >= 45 ? "#38BDF8" : n >= 20 ? "#FBBF24" : "#94A3B8";

function TeamRatings({ statsByUid }: { statsByUid: Map<string, UserStats> }) {
  const { profile, role, companyId } = useAuth();
  const [members, setMembers] = useState<UserProfile[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!profile || !companyId) return;
    let cancelled = false;
    (async () => {
      try {
        // Same visibility as the Team page: admins see the whole company,
        // managers their downline (self merged back in).
        const base = collection(db, "users");
        const q =
          role === "admin"
            ? query(base, where("companyId", "==", companyId))
            : query(base, where("companyId", "==", companyId), where("managerPath", "array-contains", profile.uid));
        const snap = await getDocs(q);
        let list = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserProfile, "uid">) }));
        if (role !== "admin" && !list.some((u) => u.uid === profile.uid)) list = [profile, ...list];
        const teamSnap = await getDocs(collection(db, "companies", companyId, "teams")).catch(() => null);
        if (cancelled) return;
        setMembers(list.filter((u) => !u.disabled));
        setTeams(teamSnap ? teamSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Team, "id">) })) : []);
      } catch (err) {
        console.warn("team ratings fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile, role, companyId]);

  // Per-member rating, normalized within function (closer vs setter) so a
  // 5-person setter squad isn't measured against the top closer's sales.
  const rating = useMemo(() => {
    const primaryOf = (u: UserProfile, s?: UserStats) =>
      u.isCloser ? (s?.sales ?? 0) + (s?.closerCloses ?? 0) : (s?.appointments ?? 0) + (s?.sits ?? 0);
    const maxPrim = { closer: 0, setter: 0 };
    let maxAct = 0;
    const raw = members.map((u) => {
      const s = statsByUid.get(u.uid);
      const p = primaryOf(u, s);
      const a = computePoints(s ?? {});
      const g: "closer" | "setter" = u.isCloser ? "closer" : "setter";
      maxPrim[g] = Math.max(maxPrim[g], p);
      maxAct = Math.max(maxAct, a);
      return { uid: u.uid, p, a, g };
    });
    const m = new Map<string, { score: number; p: number; a: number; closer: boolean }>();
    for (const r of raw) {
      const pn = maxPrim[r.g] > 0 ? r.p / maxPrim[r.g] : 0;
      const an = maxAct > 0 ? r.a / maxAct : 0;
      m.set(r.uid, { score: Math.round(100 * (0.75 * pn + 0.25 * an)), p: r.p, a: r.a, closer: r.g === "closer" });
    }
    return m;
  }, [members, statsByUid]);

  // Group members by team (unknown/absent team → "No team" bucket).
  const groups = useMemo(() => {
    const byTeam = new Map<string, UserProfile[]>();
    for (const u of members) {
      const key = u.teamId && teams.some((t) => t.id === u.teamId) ? u.teamId : "__none";
      const arr = byTeam.get(key) ?? [];
      arr.push(u);
      byTeam.set(key, arr);
    }
    const named = teams
      .filter((t) => byTeam.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, members: byTeam.get(t.id)! }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (byTeam.has("__none")) named.push({ id: "__none", name: "No team", members: byTeam.get("__none")! });
    return named;
  }, [members, teams]);

  // Downline order inside a team: managers first, their reports indented under
  // them; siblings sorted by rating so the strongest performers float up.
  const branchRows = (group: UserProfile[]) => {
    const ids = new Set(group.map((g) => g.uid));
    const byScore = (a: UserProfile, b: UserProfile) =>
      (rating.get(b.uid)?.score ?? 0) - (rating.get(a.uid)?.score ?? 0);
    const kids = (uid: string) => group.filter((u) => u.managerId === uid).sort(byScore);
    const roots = group.filter((u) => !u.managerId || !ids.has(u.managerId)).sort(byScore);
    const out: { u: UserProfile; depth: number }[] = [];
    const walk = (u: UserProfile, depth: number) => {
      out.push({ u, depth });
      for (const k of kids(u.uid)) walk(k, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out;
  };

  if (members.length === 0) return null;

  return (
    <div className="lb-teams">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h2 className="section-h" style={{ margin: "4px 0" }}>⛩ Team Ratings</h2>
        <Link to="/team" className="btn ghost sm">Org chart &amp; accounts →</Link>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Tap a team to open its downline. Ratings follow the period selected above — 75% production
        (closes for closers, appointments set &amp; sat for setters) + 25% activity (doors, shifts, points).
      </p>
      {groups.map((g) => {
        const scores = g.members.map((u) => rating.get(u.uid)?.score ?? 0);
        const avg = Math.round(scores.reduce((s, n) => s + n, 0) / (scores.length || 1));
        const isOpen = !!open[g.id];
        return (
          <div className="card team-acc" key={g.id}>
            <button className="team-acc-head" onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}>
              <span>{isOpen ? "▾" : "▸"}</span>
              <span className="team-acc-name">{g.name}</span>
              <span className="muted small">{g.members.length} {g.members.length === 1 ? "member" : "members"}</span>
              <span className="muted small" style={{ marginLeft: "auto" }}>
                avg <strong style={{ color: scoreColor(avg) }}>{avg}</strong>
              </span>
            </button>
            {isOpen && (
              <div className="team-acc-body">
                {branchRows(g.members).map(({ u, depth }) => {
                  const r = rating.get(u.uid);
                  return (
                    <div
                      className={"tr-row" + (u.uid === profile?.uid ? " you" : "")}
                      key={u.uid}
                      style={{ marginLeft: Math.min(depth, 4) * 18 }}
                    >
                      <div className="lb-avatar" style={{ background: avatarColor(u.uid) }}>{initials(u.displayName)}</div>
                      <div className="tr-main">
                        <div>{u.displayName || u.email}</div>
                        <div className="muted small">
                          {u.isCloser ? "Closer" : "Setter"}
                          {u.title ? ` · ${u.title}` : ""}
                          {" · "}
                          {r?.closer ? `${r?.p ?? 0} closes` : `${r?.p ?? 0} appts set+sat`}
                          {" · "}
                          {(r?.a ?? 0).toLocaleString()} pts
                        </div>
                      </div>
                      <div className="tr-score" style={{ color: scoreColor(r?.score ?? 0) }}>{r?.score ?? 0}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MetricTop({ title, rows, mine }: { title: string; rows: { uid: string; name: string; value: number }[]; mine?: string }) {
  const medal = ["🥇", "🥈", "🥉"];
  return (
    <div className="card lb-top">
      <h3 className="lb-top-h">{title}</h3>
      {rows.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>No activity yet.</p>
      ) : (
        <ol className="lb-top-list">
          {rows.map((r, i) => (
            <li key={r.uid} className={r.uid === mine ? "me" : ""}>
              <span className="lb-top-medal">{medal[i]}</span>
              <span className="lb-top-name">{r.uid === mine ? "You" : r.name}</span>
              <span className="lb-top-val">{r.value}</span>
            </li>
          ))}
        </ol>
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
          <span className="lb-chip" title="Closes ÷ appointments">🎯 {closeRate(me.sales, me.appointments)} close rate</span>
        </div>
      </div>
      <div className="lb-hero-pts">
        <div className="lb-hero-pts-n">{me.headline}</div>
        <div className="muted small">{prorated ? me.sub : "points"}</div>
      </div>
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
          {r.sales ?? 0} 💰 · {r.appointments ?? 0} 📅 · {r.doorsKnocked ?? 0} 🚪 · {closeRate(r.sales, r.appointments)} close
        </div>
      </div>
      <div className="lb-row-pts">
        <div className="lb-row-pts-n">{r.headline}</div>
        <div className="muted small">{r.sub || "pts"}</div>
      </div>
    </div>
  );
}
