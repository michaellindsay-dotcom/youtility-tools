import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import SlotPicker from "../components/SlotPicker";
import { DEFAULT_SCHEDULING } from "../types";

// Team dispatch. A Scheduler sees every unassigned appointment in a rail, the
// suggested available closer with the highest close rate, and a time-grid
// calendar (by closer for a day, by day for a week). Drag an appointment onto a
// closer to assign it, or open it to review the notes and pick a closer — every
// closer's live calendar is checked so no one is double-booked.
type Appt = {
  id: string; title: string; address: string; startAt: number; endAt: number | null;
  durationMin: number | null; closerUid: string | null; closerName: string;
  setterName: string; apptStatus: string | null; type: string;
  notes?: string; apptNotes?: string; phone?: string; dispatchPending?: boolean; leadId?: string | null;
};
type Closer = { uid: string; name: string; closes: number; sits: number; closeRate: number | null };

const createCloserAppointmentFn = httpsCallable<
  { companyId: string; startAt: number; durationMin?: number; title?: string; address?: string; name?: string; notes?: string; candidateCloserUid?: string },
  { ok: boolean; eventId: string; closerUid: string; closerName: string; pending?: boolean }
>(functions, "createCloserAppointment");
const listTeamAppointmentsFn = httpsCallable<{ fromMs: number; toMs: number }, { appts: Appt[]; closers: Closer[] }>(functions, "listTeamAppointments");
const reassignAppointmentFn = httpsCallable<{ eventId: string; closerUid: string }, { ok: boolean }>(functions, "reassignAppointment");

const DAY = 86_400_000;
const HOUR_PX = 54;
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = (ms: number) => { const s = startOfDay(ms); return s - ((new Date(s).getDay() + 6) % 7) * DAY; }; // Monday
const overlaps = (a1: number, a2: number, b1: number, b2: number) => a1 < b2 && b1 < a2;

const PALETTE = ["#0ea5e9", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#ef4444", "#14b8a6", "#6366f1", "#f97316", "#84cc16"];
function colorFor(key: string): string {
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export default function Scheduler() {
  const { companyId, company } = useAuth();
  const sched = company?.scheduling || DEFAULT_SCHEDULING;

  const [view, setView] = useState<"day" | "week">("day");
  const [anchor, setAnchor] = useState(startOfDay(Date.now()));
  const [closers, setClosers] = useState<Closer[]>([]);
  const [appts, setAppts] = useState<Appt[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Booking form (collapsed by default so the board leads).
  const [showBook, setShowBook] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [startAt, setStartAt] = useState<number | null>(null);
  const [bookCloser, setBookCloser] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const range = useMemo(() => (
    view === "day" ? { from: anchor, to: anchor + DAY } : { from: startOfWeek(anchor), to: startOfWeek(anchor) + 7 * DAY }
  ), [view, anchor]);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const { data } = await listTeamAppointmentsFn({ fromMs: range.from, toMs: range.to });
      setClosers(data.closers || []);
      setAppts(data.appts || []);
      setLoadErr("");
    } catch (e) { setLoadErr((e as Error).message || "Couldn't load the calendar."); }
  }, [companyId, range.from, range.to]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(t); }, []);

  const closerByUid = useMemo(() => Object.fromEntries(closers.map((c) => [c.uid, c])), [closers]);
  const apptEnd = useCallback((a: Appt) => a.endAt ?? a.startAt + (a.durationMin ?? sched.apptDurationMin ?? 60) * 60000, [sched.apptDurationMin]);

  // A closer is free for [s,e) if none of their other appts overlap it.
  const closerBusy = useCallback((uid: string, s: number, e: number, exceptId?: string) =>
    appts.some((x) => x.closerUid === uid && x.id !== exceptId && overlaps(s, e, x.startAt, apptEnd(x))),
  [appts, apptEnd]);

  // Rank closers for an appointment: available first, then highest close rate.
  const rankFor = useCallback((a: Appt): Array<Closer & { available: boolean }> => {
    const e = apptEnd(a);
    return closers
      .map((c) => ({ ...c, available: !closerBusy(c.uid, a.startAt, e, a.id) }))
      .sort((x, y) => Number(y.available) - Number(x.available) || (y.closeRate ?? -1) - (x.closeRate ?? -1) || x.name.localeCompare(y.name));
  }, [closers, closerBusy, apptEnd]);

  const unassigned = useMemo(() => appts.filter((a) => !a.closerUid).sort((a, b) => a.startAt - b.startAt), [appts]);

  // Business-hours window for the grid.
  const startHour = Math.max(0, Math.floor((sched.dayStartMin ?? 8 * 60) / 60));
  const endHourRaw = Math.ceil((sched.dayEndMin ?? 20 * 60) / 60);
  const endHour = endHourRaw > startHour ? endHourRaw : startHour + 12;
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i);
  const bodyH = (endHour - startHour) * HOUR_PX;
  const pxPerMin = HOUR_PX / 60;
  const topFor = (ms: number) => (( (ms - startOfDay(ms)) / 60000 ) - startHour * 60) * pxPerMin;

  const reassign = useCallback(async (eventId: string, toCloser: string) => {
    const prev = appts;
    const cn = closerByUid[toCloser]?.name || "";
    setAppts((cur) => cur.map((a) => (a.id === eventId ? { ...a, closerUid: toCloser, closerName: cn, dispatchPending: false } : a)));
    try { await reassignAppointmentFn({ eventId, closerUid: toCloser }); await load(); }
    catch (e) { setAppts(prev); setMsg((e as Error).message || "Assign failed."); }
  }, [appts, closerByUid, load]);

  async function book() {
    if (!companyId) return;
    if (!name.trim()) { setMsg("Add a customer name."); return; }
    if (!startAt) { setMsg("Pick a time."); return; }
    setBusy(true); setMsg("");
    try {
      const fullNotes = [notes.trim(), phone.trim() ? `Phone: ${phone.trim()}` : ""].filter(Boolean).join(" · ");
      const r = await createCloserAppointmentFn({
        companyId, startAt, durationMin: sched.apptDurationMin,
        title: `Appointment — ${name.trim()}`, name: name.trim(), address: address.trim(),
        notes: fullNotes, candidateCloserUid: bookCloser || undefined,
      });
      setMsg(r.data.pending ? "Booked — added to the dispatch queue to assign a closer ✓" : `Booked with ${r.data.closerName || "a closer"} ✓`);
      setName(""); setAddress(""); setPhone(""); setNotes(""); setStartAt(null); setBookCloser("");
      setAnchor(startOfDay(startAt)); if (view === "week") setAnchor(startOfWeek(startAt));
      await load();
    } catch (e) { setMsg((e as Error).message || "Booking failed."); } finally { setBusy(false); }
  }

  // Columns for the grid: closers (day view) or days (week view).
  const cols = useMemo(() => {
    if (view === "day") {
      return closers.map((c) => ({
        key: c.uid, dropUid: c.uid, isToday: false,
        name: c.name, rate: c.closeRate,
        head: <span className="name">{c.name}{c.closeRate != null && <span className="sched2-rate">{c.closeRate}%</span>}</span>,
        appts: appts.filter((a) => a.closerUid === c.uid && startOfDay(a.startAt) === anchor),
      }));
    }
    const ws = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => {
      const dayMs = ws + i * DAY;
      return {
        key: String(dayMs), dropUid: null as string | null, isToday: dayMs === startOfDay(Date.now()),
        name: new Date(dayMs).toLocaleDateString(undefined, { weekday: "short" }),
        rate: null as number | null,
        head: <span className="name">{new Date(dayMs).toLocaleDateString(undefined, { weekday: "short" })} {new Date(dayMs).getDate()}</span>,
        appts: appts.filter((a) => a.closerUid && startOfDay(a.startAt) === dayMs),
      };
    });
  }, [view, closers, appts, anchor]);

  const detail = detailId ? appts.find((a) => a.id === detailId) || null : null;
  const rangeLabel = view === "day"
    ? new Date(anchor).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + (anchor === startOfDay(Date.now()) ? " · Today" : "")
    : `${new Date(range.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(range.to - DAY).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const step = view === "day" ? DAY : 7 * DAY;
  const showNow = startOfDay(now) >= range.from && startOfDay(now) < range.to;
  const nowTop = topFor(now);

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Scheduler</h1>
        <p className="page-sub">Assign appointments to closers — drag one onto a closer, or open it to review the notes and pick from the ranked list. Every calendar is checked so no one's double-booked.</p>
      </div>

      {/* Booking */}
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Book an appointment</h3>
          <button className="btn ghost sm" onClick={() => setShowBook((v) => !v)}>{showBook ? "Hide" : "＋ New"}</button>
        </div>
        {showBook && (
          <>
            <p className="muted small" style={{ margin: "8px 0 12px" }}>Only open times are shown (across all closers). Leave the closer unset to send it to the dispatch queue, or assign one now.</p>
            <div className="fields" style={{ display: "grid", gap: 10 }}>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Customer name *</div><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Homeowner" /></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Address</div><input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" /></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Phone</div><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567" /></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Notes</div><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Both decision-makers home after 6pm" /></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Closer</div>
                <select value={bookCloser} onChange={(e) => setBookCloser(e.target.value)}>
                  <option value="">Leave for dispatch (assign later)</option>
                  {closers.map((c) => <option key={c.uid} value={c.uid}>{c.name}{c.closeRate != null ? ` · ${c.closeRate}%` : ""}</option>)}
                </select></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Time</div><SlotPicker sched={sched} value={startAt} onChange={setStartAt} pool="closers" address={address} /></div>
            </div>
            <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
              <button className="btn primary sm" onClick={book} disabled={busy}>{busy ? "Booking…" : "Book appointment"}</button>
              {msg && <span className="muted small">{msg}</span>}
            </div>
          </>
        )}
      </div>

      {/* Toolbar */}
      <div className="card" style={{ paddingBottom: 10 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <h3 style={{ margin: 0 }}>{rangeLabel}</h3>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <div className="type-pills">
              <button className={`pill ${view === "day" ? "active" : ""}`} onClick={() => setView("day")}>Day</button>
              <button className={`pill ${view === "week" ? "active" : ""}`} onClick={() => setView("week")}>Week</button>
            </div>
            <button className="btn ghost sm" onClick={() => setAnchor((d) => (view === "day" ? d : startOfWeek(d)) - step)}>‹</button>
            <button className="btn ghost sm" onClick={() => setAnchor(view === "day" ? startOfDay(Date.now()) : startOfWeek(Date.now()))}>Today</button>
            <button className="btn ghost sm" onClick={() => setAnchor((d) => (view === "day" ? d : startOfWeek(d)) + step)}>›</button>
          </div>
        </div>
        {msg && !showBook && <p className="muted small" style={{ margin: "8px 0 0" }}>{msg}</p>}

        <div className="sched2-wrap" style={{ marginTop: 12 }}>
          {/* Unassigned rail */}
          <div className="sched2-rail">
            <div className="rail-h">📥 Unassigned {unassigned.length > 0 && <span className="sched2-count">{unassigned.length}</span>}</div>
            {unassigned.length === 0 ? (
              <p className="muted small">Nothing waiting — every appointment has a closer. 🎉</p>
            ) : unassigned.map((a) => {
              const best = rankFor(a).find((c) => c.available) || rankFor(a)[0];
              return (
                <div key={a.id} className="sched2-railcard" draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", a.id)}
                  onClick={() => setDetailId(a.id)}>
                  <div className="t">{fmtTime(a.startAt)} · {a.title || "Appointment"}</div>
                  {a.address && <div className="sub">{a.address}</div>}
                  {a.setterName && <div className="sub">Set by {a.setterName}</div>}
                  {best && <div className="sched2-suggest">⭐ {best.available ? "Suggested" : "Best"}: {best.name}{best.closeRate != null ? ` · ${best.closeRate}%` : ""}</div>}
                </div>
              );
            })}
          </div>

          {/* Calendar grid */}
          {loadErr ? (
            <p className="muted small" style={{ color: "#f59e0b" }}>{loadErr}</p>
          ) : cols.length === 0 ? (
            <p className="muted small">No closers set up yet — turn a rep into a closer in Team settings.</p>
          ) : (
            <div className="sched2-cal">
              <div style={{ minWidth: 54 + cols.length * 140 }}>
                <div className="sched2-head">
                  <div className="sched2-gutter-h" />
                  {cols.map((col) => (
                    <div key={col.key} className={`sched2-colh ${col.isToday ? "today" : ""}`}>
                      {col.head}
                      <div className="meta">{col.appts.length} appt{col.appts.length === 1 ? "" : "s"}</div>
                    </div>
                  ))}
                </div>
                <div className="sched2-body" style={{ height: bodyH + 6 }}>
                  <div className="sched2-gutter" style={{ height: bodyH }}>
                    {hours.map((h, i) => (
                      <div key={h} className="h" style={{ top: i * HOUR_PX }}>
                        {new Date(0, 0, 0, h).toLocaleTimeString(undefined, { hour: "numeric" })}
                      </div>
                    ))}
                  </div>
                  {cols.map((col) => (
                    <div key={col.key} className={`sched2-col ${dropCol === col.key ? "drop" : ""}`} style={{ height: bodyH }}
                      onDragOver={col.dropUid ? (e) => { e.preventDefault(); if (dropCol !== col.key) setDropCol(col.key); } : undefined}
                      onDragLeave={col.dropUid ? () => setDropCol((c) => (c === col.key ? null : c)) : undefined}
                      onDrop={col.dropUid ? (e) => { e.preventDefault(); setDropCol(null); const id = e.dataTransfer.getData("text/plain"); if (id) void reassign(id, col.dropUid!); } : undefined}>
                      {hours.map((h, i) => (<div key={h} className="sched2-hr" style={{ top: i * HOUR_PX }} />))}
                      {hours.slice(0, -1).map((h, i) => (<div key={`hf${h}`} className="sched2-hr half" style={{ top: i * HOUR_PX + HOUR_PX / 2 }} />))}
                      {col.isToday && showNow && <div className="sched2-now" style={{ top: nowTop }} />}
                      {col.appts.map((a) => {
                        const bcolor = colorFor(a.closerUid || a.id);
                        const top = Math.max(0, topFor(a.startAt));
                        const height = Math.max(20, ((apptEnd(a) - a.startAt) / 60000) * pxPerMin);
                        const done = !!a.apptStatus && a.apptStatus !== "scheduled";
                        return (
                          <div key={a.id} className={`sched2-block ${done ? "done" : ""}`}
                            style={{ top, height, background: bcolor }}
                            draggable={view === "day"}
                            onDragStart={view === "day" ? (e) => e.dataTransfer.setData("text/plain", a.id) : undefined}
                            onClick={() => setDetailId(a.id)}
                            title={`${a.title} · ${fmtTime(a.startAt)}`}>
                            <div className="bt">{fmtTime(a.startAt)}{done ? ` · ${(a.apptStatus || "").replace(/_/g, " ")}` : ""}</div>
                            <div className="bttl">{a.title || "Appointment"}</div>
                            <div className="bad">{view === "week" ? a.closerName : a.address}</div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {detail && createPortal(
        <div className="modal-overlay" onClick={() => setDetailId(null)}>
          <div className="card sched2-detail" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <h3 style={{ margin: 0 }}>{detail.title || "Appointment"}</h3>
              <button className="btn ghost sm" onClick={() => setDetailId(null)}>✕</button>
            </div>
            <div style={{ margin: "12px 0" }}>
              <div className="sched2-detrow"><div className="k">When</div><div className="v">{new Date(detail.startAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – {fmtTime(apptEnd(detail))}</div></div>
              {detail.address && <div className="sched2-detrow"><div className="k">Address</div><div className="v">{detail.address}</div></div>}
              {detail.phone && <div className="sched2-detrow"><div className="k">Phone</div><div className="v"><a href={`tel:${detail.phone}`}>{detail.phone}</a></div></div>}
              {detail.setterName && <div className="sched2-detrow"><div className="k">Set by</div><div className="v">{detail.setterName}</div></div>}
              <div className="sched2-detrow"><div className="k">Status</div><div className="v">{detail.closerUid ? `Assigned to ${detail.closerName}` : "Unassigned — needs a closer"}{detail.apptStatus && detail.apptStatus !== "scheduled" ? ` · ${detail.apptStatus.replace(/_/g, " ")}` : ""}</div></div>
              {(detail.notes || detail.apptNotes) && <div className="sched2-detrow"><div className="k">Notes</div><div className="v" style={{ whiteSpace: "pre-wrap" }}>{[detail.notes, detail.apptNotes].filter(Boolean).join("\n")}</div></div>}
            </div>
            <div className="muted small" style={{ margin: "4px 0 8px", fontWeight: 700 }}>Assign a closer</div>
            {rankFor(detail).map((c, i) => {
              const isSuggested = c.available && i === 0;
              return (
                <button key={c.uid} className={`sched2-closer ${!c.available ? "busy" : ""} ${isSuggested ? "suggested" : ""} ${detail.closerUid === c.uid ? "current" : ""}`}
                  onClick={() => { if (detail.closerUid !== c.uid) void reassign(detail.id, c.uid); setDetailId(null); }}>
                  <span className="sched2-dot" style={{ background: colorFor(c.uid) }} />
                  <span>
                    <span style={{ fontWeight: 700 }}>{c.name}</span>
                    {isSuggested && <span style={{ color: "#34d399", fontWeight: 700, fontSize: 12 }}> · ⭐ Suggested</span>}
                    {detail.closerUid === c.uid && <span className="muted small"> · current</span>}
                    <div className="muted small">{c.available ? "Free at this time" : "Busy — has an overlapping appt"}{c.sits > 0 ? ` · ${c.closes}/${c.sits} sits` : ""}</div>
                  </span>
                  <span className="sched2-badge">{c.closeRate != null ? `${c.closeRate}%` : "—"}</span>
                </button>
              );
            })}
            {closers.length === 0 && <p className="muted small">No closers available.</p>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
