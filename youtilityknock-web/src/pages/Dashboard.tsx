import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { hasFeature } from "../lib/features";
import { computePoints } from "../lib/points";
import CalendarBanner from "../components/CalendarBanner";
import BizCardHero from "../components/BizCardHero";
import Podium from "../components/Podium";
import { cardAccentVars, cardThemeBg } from "../lib/cardTheme";
import { CARD_SHARE_BASE_URL } from "./BusinessCard";
import type { EventType, Lead, ScheduleEvent, Shift, UserStats } from "../types";

// Default targets (configurable later via a company `config` doc).
const GOALS = {
  doorsDay: 100,
  doorsWeek: 500,
  doorsMonth: 2000,
  convWeek: 150,
  convMonth: 600,
  apptWeek: 15,
  apptMonth: 60,
  salesWeek: 5,
};
const MIN_PER_DOOR = 2;
const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfWeek() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
const knockTime = (l: Lead) => l.knockedAt || l.createdAt;
// When a deal counts as "closed": its close date. Falls back to updatedAt
// (set when it was marked sold) for leads saved before soldAt existed.
const closeTime = (l: Lead) => l.soldAt ?? l.updatedAt ?? l.knockedAt ?? l.createdAt;

interface Funnel {
  doors: number;
  conv: number;
  appt: number;
  closed: number;
  hours: number;
}

export default function Dashboard() {
  const { profile, company, role } = useAuth();
  const showPlanner = hasFeature(company, "planner"); // Success Planner is an optional service
  const [leads, setLeads] = useState<Lead[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  // Sold leads are fetched separately (all-time, not just this month) so a deal
  // closed in a window still counts even if the lead was created earlier.
  const [soldLeads, setSoldLeads] = useState<Lead[]>([]);
  const [top, setTop] = useState<UserStats[]>([]);
  const [myStats, setMyStats] = useState<UserStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    (async () => {
      try {
        const monthStart = startOfMonth();
        const leadSnap = await getDocs(
          query(collection(db, "leads"), where("assignedTo", "==", profile.uid), where("createdAt", ">=", monthStart))
        );
        const shiftSnap = await getDocs(
          query(collection(db, "shifts"), where("userId", "==", profile.uid), where("startAt", ">=", monthStart))
        );
        // All of the rep's sold leads (small set) — closes are counted from
        // these by close date, regardless of when the lead was first created.
        // We need the FULL sold history (not just this month) so a deal created
        // in a prior month but closed this week still counts. The two-field
        // assignedTo+status query needs a composite index that the deploy
        // workflow doesn't ship; if it's missing, fall back to a single-field
        // assignedTo query (no composite index required) and filter sold in JS —
        // still all-time, so prior-month closes are never dropped.
        let soldDocs;
        try {
          soldDocs = (await getDocs(
            query(collection(db, "leads"), where("assignedTo", "==", profile.uid), where("status", "==", "sold"))
          )).docs;
        } catch (err) {
          console.warn("sold+status query failed (index building?) — falling back to assignedTo only", err);
          try {
            soldDocs = (await getDocs(
              query(collection(db, "leads"), where("assignedTo", "==", profile.uid))
            )).docs.filter((d) => (d.data() as Lead).status === "sold");
          } catch (err2) {
            console.warn("assignedTo-only sold fallback failed", err2);
            soldDocs = leadSnap.docs.filter((d) => (d.data() as Lead).status === "sold");
          }
        }
        // Top performers — scope to what this user is allowed to read (admins
        // see the company; everyone else their downstream), matching the
        // userStats rules. No orderBy here so we don't depend on the
        // companyId+sales composite index being deployed — sort client-side.
        const topFilters = [where("companyId", "==", profile.companyId)] as ReturnType<typeof where>[];
        if (role !== "admin") topFilters.push(where("managerPath", "array-contains", profile.uid));
        let topSnap;
        try {
          topSnap = await getDocs(query(collection(db, "userStats"), ...topFilters));
        } catch (err) {
          console.warn("top performers query failed", err);
          topSnap = null;
        }
        const topRows = topSnap
          ? topSnap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserStats, "uid">) }))
          : [];
        // managerPath excludes the viewer themselves, so the query above never
        // returns the viewer's own stats — merge their own doc in so a rep
        // always sees their own production (rules allow reading your own doc).
        if (!topRows.some((r) => r.uid === profile.uid)) {
          try {
            const mine = await getDoc(doc(db, "userStats", profile.uid));
            if (mine.exists()) topRows.push({ uid: mine.id, ...(mine.data() as Omit<UserStats, "uid">) });
          } catch (err) {
            console.warn("own stats fetch failed", err);
          }
        }
        if (cancelled) return;
        setLeads(leadSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Lead, "id">) })));
        setShifts(shiftSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Shift, "id">) })));
        setSoldLeads(soldDocs.map((d) => ({ id: d.id, ...(d.data() as Omit<Lead, "id">) })));
        topRows.sort((a, b) => (b.sales ?? 0) - (a.sales ?? 0));
        setTop(topRows.slice(0, 5));
        setMyStats(topRows.find((r) => r.uid === profile.uid) ?? null);
        setLoading(false);
      } catch (e) {
        console.error(e);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile, role]);

  const f = useMemo(() => {
    const windows = { today: startOfToday(), week: startOfWeek(), month: startOfMonth() };
    const verified = leads.filter((l) => l.verified !== false);
    const verifiedSold = soldLeads.filter((l) => l.verified !== false);
    const since = (ts: number): Funnel => {
      // Doors / conversations / appts are counted by when the door was knocked.
      const ls = verified.filter((l) => knockTime(l) >= ts);
      // Closes are counted by their close date from the full sold-lead set, so a
      // deal set earlier (even a prior month) but sold in this window counts.
      const closed = verifiedSold.filter((l) => closeTime(l) >= ts).length;
      const hrs =
        shifts
          .filter((s) => s.startAt >= ts)
          .reduce((sum, s) => sum + ((s.endAt ?? Date.now()) - s.startAt), 0) /
        3600000;
      return {
        doors: ls.length,
        conv: ls.filter((l) => CONVO.has(l.status)).length,
        appt: ls.filter((l) => l.status === "appointment").length,
        closed,
        hours: Math.round(hrs * 10) / 10,
      };
    };
    return { today: since(windows.today), week: since(windows.week), month: since(windows.month) };
  }, [leads, shifts, soldLeads]);

  // Top-3 for the dashboard podium, ranked by leaderboard points (closes,
  // appointments, shifts, …) so it previews the all-time leaderboard podium.
  const podiumTop = useMemo(
    () => [...top].sort((a, b) => computePoints(b) - computePoints(a)).slice(0, 3),
    [top]
  );

  // Success planner — what they need to hit goals at current pace.
  const plan = useMemo(() => {
    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeftWeek = Math.max(1, 7 - ((now.getDay() + 6) % 7));
    const daysLeftMonth = Math.max(1, dim - now.getDate() + 1);
    const todayLeft = Math.max(0, GOALS.doorsDay - f.today.doors);
    const weekLeft = Math.max(0, GOALS.doorsWeek - f.week.doors);
    const monthLeft = Math.max(0, GOALS.doorsMonth - f.month.doors);
    return {
      todayLeft,
      todayMin: todayLeft * MIN_PER_DOOR,
      weekPerDay: Math.ceil(weekLeft / daysLeftWeek),
      monthPerDay: Math.ceil(monthLeft / daysLeftMonth),
      monthlyPct: Math.min(100, Math.round((f.month.doors / GOALS.doorsMonth) * 100)),
    };
  }, [f]);

  const pct = (n: number, d: number) => Math.min(100, Math.round((n / d) * 100));
  // Close rate = closes ÷ appointments. Show "—" when there are no
  // appointments yet so it never reads as a misleading 0% or 100%.
  const closeRate = (closed: number, appt: number) => (appt > 0 ? `${Math.round((closed / appt) * 100)}%` : "—");
  // Sit rate = of the appointments this setter set, how many actually sat
  // (a closer pitched them). All-time, from rolled-up stats.
  const sitRate =
    myStats && (myStats.appointments ?? 0) > 0
      ? `${Math.round(((myStats.sits ?? 0) / (myStats.appointments ?? 1)) * 100)}%`
      : null;
  return (
    <div className="page-body dash">
      <RallyCardHero />

      <CalendarBanner />

      <div className="dash-2col">
        {/* Success planner (optional service) — whole card opens the full planner */}
        {showPlanner && (
          <Link to="/shifts" className="card planner link-card">
            <div className="planner-top">
              <h2 className="planner-h">◎ Success Planner <span className="muted small" style={{ fontWeight: 400 }}>→</span></h2>
              <div className="planner-ring">
                <div className="ring-pct">{plan.monthlyPct}%</div>
                <div className="muted small">monthly</div>
              </div>
            </div>
            <p className="muted small">Based on your pace, here's what you need to hit your goals:</p>
            <ul className="planner-list">
              <li><strong>Today:</strong> {plan.todayLeft} more doors <span className="muted">({f.today.doors}/{GOALS.doorsDay} done · ~{plan.todayMin} min)</span></li>
              <li><strong>This week:</strong> {plan.weekPerDay} doors/day <span className="muted">({f.week.doors}/{GOALS.doorsWeek} done)</span></li>
              <li><strong>This month:</strong> {plan.monthPerDay} doors/day <span className="muted">({f.month.doors}/{GOALS.doorsMonth} done)</span></li>
            </ul>
            <span className="muted small">Open full planner →</span>
          </Link>
        )}

        {/* Top performers — whole card links to the leaderboard */}
        <Link to="/leaderboard" className="card link-card top-performers">
          <h2>🏆 Top Performers <span className="muted small" style={{ fontWeight: 400 }}>→</span></h2>
          {top.length === 0 ? (
            <p className="muted small">No team production logged yet — sold deals and appointments show up here.</p>
          ) : (
            <ol className="top-list">
              {top.slice(0, 3).map((t) => (
                <li key={t.uid}>
                  <span>{t.userName || t.uid}</span>
                  <span className="muted">{t.sales ?? 0} sold · {t.appointments ?? 0} appts</span>
                </li>
              ))}
            </ol>
          )}
          <span className="muted small">View full leaderboard →</span>
        </Link>

        {/* Today's agenda — whole card links to the full schedule */}
        <TodayScheduleCard />
      </div>

      {/* Top-3 podium — a preview of the leaderboard; tap through to the team
          breakdown (Team Ratings live on the Leaderboard). */}
      {podiumTop.length > 0 && (
        <Link to="/leaderboard" className="card link-card dash-podium">
          <h2>🏆 Top 3 <span className="muted small" style={{ fontWeight: 400 }}>→</span></h2>
          <Podium entries={podiumTop} youUid={profile?.uid} />
          <span className="muted small">Tap for the full team breakdown →</span>
        </Link>
      )}

      {/* Today's funnel */}
      <div className="row" style={{ alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 className="section-h" style={{ marginBottom: 0 }}>Today's Funnel</h2>
        <span className="muted small">
          This week: <strong>{f.week.closed}</strong> closed · <strong>{closeRate(f.week.closed, f.week.appt)}</strong> close rate
          {sitRate != null && <> · <strong>{sitRate}</strong> sit rate</>}
        </span>
      </div>
      <div className="stat-grid">
        <FunnelCard n={f.today.doors} label="Doors Knocked" sub={`${f.today.hours}h on shift`} />
        <FunnelCard n={f.today.conv} label="Conversations" sub={`${pct(f.today.conv, f.today.doors || 1)}% conv rate`} />
        <FunnelCard n={f.today.appt} label="Appts Set" sub={`${pct(f.today.appt, f.today.conv || 1)}% set rate`} />
        <FunnelCard n={f.today.closed} label="Closed" sub={`${closeRate(f.today.closed, f.today.appt)} close rate`} />
      </div>

      {/* Goal progress (part of the Success Planner service) */}
      {showPlanner && (
        <>
          <h2 className="section-h">◎ Goal Progress</h2>
          <div className="dash-2col">
            <GoalCard title="This Week" rows={[
              ["Doors", f.week.doors, GOALS.doorsWeek],
              ["Conversations", f.week.conv, GOALS.convWeek],
              ["Appointments", f.week.appt, GOALS.apptWeek],
              ["Sales", f.week.closed, GOALS.salesWeek],
            ]} note={`${plan.weekPerDay} doors/day to goal · ${closeRate(f.week.closed, f.week.appt)} close rate`} />
          </div>
        </>
      )}

      {loading && <p className="muted small" style={{ marginTop: 16 }}>Loading your numbers…</p>}
    </div>
  );
}

const EVENT_META: Record<EventType, { label: string; icon: string; color: string }> = {
  appointment: { label: "Appointment", icon: "📅", color: "#38bdf8" },
  go_back: { label: "Go-back", icon: "↩", color: "#fbbf24" },
  follow_up: { label: "Follow-up", icon: "🔁", color: "#a78bfa" },
};

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Today's agenda, mini-calendar style: the rep's appointments, go-backs and
// follow-ups for the day — including appointments they set that were routed to
// a closer (mirrors the Schedule page's feed). Whole card opens the Schedule.
function TodayScheduleCard() {
  const { profile } = useAuth();
  const [events, setEvents] = useState<ScheduleEvent[]>([]);

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    const dayStart = startOfToday();
    const dayEnd = dayStart + 24 * 3600000;
    (async () => {
      try {
        // My own events from today on (same index the Schedule page uses)…
        const mineSnap = await getDocs(
          query(
            collection(db, "events"),
            where("userId", "==", profile.uid),
            where("startAt", ">=", dayStart),
            orderBy("startAt", "asc"),
            limit(20)
          )
        );
        // …plus appointments I set that were routed to a closer (single-field
        // query; today-filtered client-side), so setters see their bookings.
        const routedSnap = await getDocs(
          query(collection(db, "events"), where("setterUid", "==", profile.uid))
        ).catch(() => null);
        if (cancelled) return;
        const byId = new Map<string, ScheduleEvent>();
        for (const d of mineSnap.docs) byId.set(d.id, { id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) });
        for (const d of routedSnap?.docs ?? []) {
          if (!byId.has(d.id)) byId.set(d.id, { id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) });
        }
        setEvents(
          [...byId.values()]
            .filter((e) => e.startAt >= dayStart && e.startAt < dayEnd)
            .sort((a, b) => a.startAt - b.startAt)
        );
      } catch (err) {
        console.warn("today's schedule fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile]);

  return (
    <Link to="/schedule" className="card link-card">
      <h2>📅 Today's Schedule <span className="muted small" style={{ fontWeight: 400 }}>→</span></h2>
      <p className="muted small" style={{ marginTop: 2 }}>
        {new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
      </p>
      {events.length === 0 ? (
        <p className="muted small">
          Nothing booked today — appointments, go-backs and follow-ups you schedule show up here.
        </p>
      ) : (
        <div className="today-sched">
          {events.map((e) => {
            const m = EVENT_META[e.type] ?? EVENT_META.follow_up;
            return (
              <div className="today-sched-row" key={e.id} style={{ borderLeftColor: m.color }}>
                <span className="today-sched-time">{fmtTime(e.startAt)}</span>
                <span>{m.icon}</span>
                <span className="today-sched-title">
                  {e.title || m.label}
                  {e.address ? <span className="muted"> · {e.address}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <span className="muted small">Open full schedule →</span>
    </Link>
  );
}

// The rep's live RallyCard, front and center where "Welcome back" used to be —
// show it at the door, send it, or let the homeowner scan the QR on the card.
// Tapping anywhere except a button/link opens the card settings.
function RallyCardHero() {
  const { profile, company } = useAuth();
  const navigate = useNavigate();
  const [msg, setMsg] = useState("");

  const shareUrl = profile?.cardSlug ? `${CARD_SHARE_BASE_URL}/${profile.cardSlug}` : "";
  const shareText = `Check out my digital business card${profile?.displayName ? ` — ${profile.displayName}` : ""}: ${shareUrl}`;

  // No card yet — the hero becomes the setup prompt.
  if (!profile || !profile.cardEnabled || !shareUrl) {
    return (
      <div className="card row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <strong>🪪 Set up your RallyCard</strong>
          <p className="muted small" style={{ marginTop: 2 }}>
            A shareable digital business card — photo, reviews, and a lead-capture form homeowners
            can fill out right on the doorstep. It'll live right here for easy access.
          </p>
        </div>
        <Link className="btn primary sm" to="/card">Get started</Link>
      </div>
    );
  }

  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl)
      .then(() => setMsg("Link copied ✓"))
      .catch(() => {});
  };
  const shareCard = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: "My RallyCard", text: shareText, url: shareUrl });
      } catch {
        // user cancelled the share sheet — nothing to do
      }
    } else {
      copyLink();
    }
  };

  const openSettings = (e: React.MouseEvent) => {
    // The send buttons and the card's own tap-to-call/text/email links keep
    // doing their thing; a tap anywhere else edits the card.
    if ((e.target as HTMLElement).closest("a, button")) return;
    navigate("/card");
  };

  return (
    <div
      className="card"
      onClick={openSettings}
      title="Tap to edit your RallyCard"
      style={{
        textAlign: "center",
        cursor: "pointer",
        background: cardThemeBg(profile.cardTheme || "default"),
        ...cardAccentVars(profile.cardAccentColor || "#38bdf8"),
      }}
    >
      <BizCardHero
        displayName={profile.displayName || ""}
        title={profile.cardTitle || profile.title}
        companyName={company?.name}
        logoUrl={profile.cardLogoUrl || company?.logoUrl || ""}
        photoUrl={profile.cardPhotoUrl}
        bgImageUrl={company?.bgImageUrl}
        memberId={profile.cardMemberId ?? null}
        idPrefix={company?.idPrefix}
        phone={profile.phone}
        email={profile.email}
        website={company?.website}
        companyPhone={company?.phone}
        companyAddress={company?.address}
        vcfUrl={profile.cardSlug ? `https://youtilityknock.web.app/vcf/${profile.cardSlug}` : undefined}
      />
      <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <button className="btn primary sm" onClick={shareCard}>📤 Share</button>
        <a className="btn ghost sm" href={`sms:?&body=${encodeURIComponent(shareText)}`}>💬 Text it</a>
        <a
          className="btn ghost sm"
          href={`mailto:?subject=${encodeURIComponent("My digital business card")}&body=${encodeURIComponent(shareText)}`}
        >
          ✉️ Email it
        </a>
        <button className="btn ghost sm" onClick={copyLink}>🔗 Copy link</button>
      </div>
      <div className="muted small" style={{ marginTop: 8 }}>
        {msg || "Tap the card to edit it"}
      </div>
    </div>
  );
}

function GoalCard({ title, rows, note }: { title: string; rows: [string, number, number][]; note: string }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <dl className="fields">
        {rows.map(([label, n, goal]) => (
          <div className="field-row goal-row" key={label}>
            <dt>{label}</dt>
            <dd>
              {n} / {goal}
              <div className="goal-bar">
                <span style={{ width: `${Math.min(100, (n / goal) * 100)}%` }} />
              </div>
            </dd>
          </div>
        ))}
      </dl>
      <div className="muted small">{note}</div>
    </div>
  );
}

function FunnelCard({ n, label, sub }: { n: number; label: string; sub: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{n}</div>
      <div className="stat-label">{label}</div>
      <div className="muted small">{sub}</div>
    </div>
  );
}

