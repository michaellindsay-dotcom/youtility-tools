import { useCallback, useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import SlotPicker from "../components/SlotPicker";
import { DEFAULT_SCHEDULING } from "../types";

// Team dispatch: a Scheduler books appointments for the whole team, reading every
// closer's live calendar so no one is double-booked, and reassigns appointments
// between closers on a day board (drag on desktop, tap on touch).
const createCloserAppointmentFn = httpsCallable<
  { companyId: string; startAt: number; durationMin?: number; title?: string; address?: string; name?: string; notes?: string; candidateCloserUid?: string },
  { ok: boolean; eventId: string; closerUid: string; closerName: string }
>(functions, "createCloserAppointment");
const listTeamAppointmentsFn = httpsCallable<
  { fromMs: number; toMs: number },
  { appts: Appt[]; closers: { uid: string; name: string }[] }
>(functions, "listTeamAppointments");
const reassignAppointmentFn = httpsCallable<{ eventId: string; closerUid: string }, { ok: boolean }>(functions, "reassignAppointment");

type Appt = {
  id: string; title: string; address: string; startAt: number; endAt: number | null;
  durationMin: number | null; closerUid: string | null; closerName: string;
  setterName: string; apptStatus: string | null; type: string;
};

const DAY = 86_400_000;
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

export default function Scheduler() {
  const { companyId, company } = useAuth();
  const sched = company?.scheduling || DEFAULT_SCHEDULING;

  const [closers, setClosers] = useState<{ uid: string; name: string }[]>([]);
  const [appts, setAppts] = useState<Appt[]>([]);
  const [day, setDay] = useState(startOfDay(Date.now()));
  const [loadErr, setLoadErr] = useState("");
  const [reassignFor, setReassignFor] = useState<string | null>(null);

  // Booking form.
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [startAt, setStartAt] = useState<number | null>(null);
  const [closerUid, setCloserUid] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showBook, setShowBook] = useState(true);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const { data } = await listTeamAppointmentsFn({ fromMs: day, toMs: day + DAY });
      setClosers(data.closers || []);
      setAppts(data.appts || []);
      setLoadErr("");
    } catch (e) {
      setLoadErr((e as Error).message || "Couldn't load the calendar.");
    }
  }, [companyId, day]);

  useEffect(() => { void load(); }, [load]);

  // Appointments grouped by closer for the day board.
  const byCloser = useMemo(() => {
    const m: Record<string, Appt[]> = {};
    for (const c of closers) m[c.uid] = [];
    for (const a of appts) { const k = a.closerUid || "__none"; (m[k] ||= []).push(a); }
    for (const k of Object.keys(m)) m[k].sort((x, y) => x.startAt - y.startAt);
    return m;
  }, [appts, closers]);

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
        notes: fullNotes, candidateCloserUid: closerUid || undefined,
      });
      setMsg(`Booked with ${r.data.closerName || "a closer"} ✓`);
      setName(""); setAddress(""); setPhone(""); setNotes(""); setStartAt(null); setCloserUid("");
      setDay(startOfDay(r.data && startAt ? startAt : day));
      await load();
    } catch (e) {
      setMsg((e as Error).message || "Booking failed.");
    } finally { setBusy(false); }
  }

  async function reassign(eventId: string, toCloser: string) {
    setReassignFor(null);
    const prev = appts;
    setAppts((cur) => cur.map((a) => (a.id === eventId ? { ...a, closerUid: toCloser, closerName: closers.find((c) => c.uid === toCloser)?.name || a.closerName } : a)));
    try { await reassignAppointmentFn({ eventId, closerUid: toCloser }); await load(); }
    catch (e) { setAppts(prev); setMsg((e as Error).message || "Reassign failed."); }
  }

  const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayLabel = new Date(day).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const isToday = day === startOfDay(Date.now());

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Scheduler</h1>
        <p className="page-sub">Book for the team and drag appointments between closers — every calendar is checked so no one is double-booked.</p>
      </div>

      {/* Booking */}
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Book an appointment</h3>
          <button className="btn ghost sm" onClick={() => setShowBook((v) => !v)}>{showBook ? "Hide" : "Book"}</button>
        </div>
        {showBook && (
          <>
            <p className="muted small" style={{ margin: "8px 0 12px" }}>
              Only open times are shown (across all closers). Leave the closer on <strong>Auto</strong> for the next free one, or choose a specific closer.
            </p>
            <div className="fields" style={{ display: "grid", gap: 10 }}>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Customer name *</div>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Homeowner" /></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Address</div>
                <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" /></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Phone</div>
                <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567" /></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Notes</div>
                <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Both decision-makers home after 6pm" /></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Closer</div>
                <select value={closerUid} onChange={(e) => setCloserUid(e.target.value)}>
                  <option value="">Auto — next available closer</option>
                  {closers.map((c) => <option key={c.uid} value={c.uid}>{c.name}</option>)}
                </select></div>
              <div><div className="muted small" style={{ marginBottom: 4 }}>Time</div>
                <SlotPicker sched={sched} value={startAt} onChange={setStartAt} pool="closers" /></div>
            </div>
            <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
              <button className="btn primary sm" onClick={book} disabled={busy}>{busy ? "Booking…" : "Book appointment"}</button>
              {msg && <span className="muted small">{msg}</span>}
            </div>
          </>
        )}
      </div>

      {/* Day calendar / dispatch board */}
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>{dayLabel}{isToday ? " · Today" : ""}</h3>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn ghost sm" onClick={() => setDay((d) => d - DAY)}>‹ Prev</button>
            <button className="btn ghost sm" onClick={() => setDay(startOfDay(Date.now()))}>Today</button>
            <button className="btn ghost sm" onClick={() => setDay((d) => d + DAY)}>Next ›</button>
          </div>
        </div>
        <p className="muted small" style={{ margin: "6px 0 12px" }}>Drag an appointment onto another closer to reassign it — or tap it and pick a closer.</p>

        {loadErr ? (
          <p className="muted small" style={{ color: "#f59e0b" }}>{loadErr}</p>
        ) : closers.length === 0 ? (
          <p className="muted small">No closers set up yet.</p>
        ) : (
          <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 6 }}>
            {closers.map((c) => {
              const list = byCloser[c.uid] || [];
              return (
                <div
                  key={c.uid}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { const id = e.dataTransfer.getData("text/plain"); if (id) void reassign(id, c.uid); }}
                  style={{ flex: "0 0 220px", minWidth: 220, border: "1px solid var(--line, #21314a)", borderRadius: 12, padding: 10, background: "var(--panel, rgba(255,255,255,.03))" }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>{c.name}</div>
                  <div className="muted small" style={{ marginBottom: 8 }}>{list.length} appt{list.length === 1 ? "" : "s"}</div>
                  {list.length === 0 ? (
                    <div className="muted small" style={{ opacity: 0.6, padding: "8px 0" }}>—</div>
                  ) : list.map((a) => (
                    <div key={a.id}>
                      <div
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData("text/plain", a.id)}
                        onClick={() => setReassignFor(reassignFor === a.id ? null : a.id)}
                        style={{ cursor: "grab", border: "1px solid var(--line, #21314a)", borderRadius: 9, padding: "8px 10px", marginBottom: 8, background: "var(--bg-1, #0f1727)" }}
                      >
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{time(a.startAt)}{a.apptStatus && a.apptStatus !== "scheduled" ? ` · ${a.apptStatus}` : ""}</div>
                        <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title || "Appointment"}</div>
                        {a.address && <div className="muted small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.address}</div>}
                      </div>
                      {reassignFor === a.id && (
                        <div style={{ margin: "-4px 0 8px", padding: 8, border: "1px solid var(--line, #21314a)", borderRadius: 9 }}>
                          <div className="muted small" style={{ marginBottom: 4 }}>Reassign to…</div>
                          <select defaultValue="" onChange={(e) => { if (e.target.value) void reassign(a.id, e.target.value); }}>
                            <option value="">Pick a closer…</option>
                            {closers.filter((x) => x.uid !== a.closerUid).map((x) => <option key={x.uid} value={x.uid}>{x.name}</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
            {(byCloser["__none"]?.length ?? 0) > 0 && (
              <div style={{ flex: "0 0 220px", minWidth: 220, border: "1px dashed var(--line, #21314a)", borderRadius: 12, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Unassigned</div>
                {byCloser["__none"].map((a) => (
                  <div key={a.id} onClick={() => setReassignFor(reassignFor === a.id ? null : a.id)}
                    style={{ cursor: "pointer", border: "1px solid var(--line, #21314a)", borderRadius: 9, padding: "8px 10px", marginBottom: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{time(a.startAt)}</div>
                    <div style={{ fontSize: 13 }}>{a.title || "Appointment"}</div>
                    {reassignFor === a.id && (
                      <select defaultValue="" style={{ marginTop: 6 }} onChange={(e) => { if (e.target.value) void reassign(a.id, e.target.value); }}>
                        <option value="">Assign to…</option>
                        {closers.map((x) => <option key={x.uid} value={x.uid}>{x.name}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
