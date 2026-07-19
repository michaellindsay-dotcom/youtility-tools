import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import SlotPicker from "../components/SlotPicker";
import { DEFAULT_SCHEDULING } from "../types";
import type { ScheduleEvent } from "../types";

// Team dispatch: a Scheduler books appointments for the whole team, reading every
// closer's live calendar so no one is double-booked. "Auto" lets the company's
// closer-assignment method pick a free closer; or the Scheduler picks one.
const createCloserAppointmentFn = httpsCallable<
  { companyId: string; startAt: number; durationMin?: number; title?: string; address?: string; name?: string; notes?: string; candidateCloserUid?: string },
  { ok: boolean; eventId: string; closerUid: string; closerName: string }
>(functions, "createCloserAppointment");
const listClosersFn = httpsCallable<Record<string, never>, { closers: { uid: string; name: string }[] }>(functions, "listClosers");

export default function Scheduler() {
  const { companyId, company } = useAuth();
  const sched = company?.scheduling || DEFAULT_SCHEDULING;

  const [closers, setClosers] = useState<{ uid: string; name: string }[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [startAt, setStartAt] = useState<number | null>(null);
  const [closerUid, setCloserUid] = useState(""); // "" = auto-assign a free closer
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [listErr, setListErr] = useState(false);

  useEffect(() => {
    listClosersFn({}).then((r) => setClosers(r.data.closers || [])).catch(() => {});
  }, []);

  // Best-effort upcoming team appointments (requires company read access).
  useEffect(() => {
    if (!companyId) return;
    const now = Date.now() - 60 * 60 * 1000;
    const q = query(collection(db, "events"), where("companyId", "==", companyId), orderBy("startAt", "asc"));
    return onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) }))
          .filter((e) => (e.endAt || e.startAt) >= now && (!!e.closerUid || e.type === "appointment"));
        setEvents(rows.slice(0, 60));
        setListErr(false);
      },
      () => setListErr(true)
    );
  }, [companyId]);

  async function book() {
    if (!companyId) return;
    if (!name.trim()) { setMsg("Add a customer name."); return; }
    if (!startAt) { setMsg("Pick a time."); return; }
    setBusy(true);
    setMsg("");
    try {
      const fullNotes = [notes.trim(), phone.trim() ? `Phone: ${phone.trim()}` : ""].filter(Boolean).join(" · ");
      const r = await createCloserAppointmentFn({
        companyId,
        startAt,
        durationMin: sched.apptDurationMin,
        title: `Appointment — ${name.trim()}`,
        name: name.trim(),
        address: address.trim(),
        notes: fullNotes,
        candidateCloserUid: closerUid || undefined,
      });
      setMsg(`Booked with ${r.data.closerName || "a closer"} ✓`);
      setName(""); setAddress(""); setPhone(""); setNotes(""); setStartAt(null); setCloserUid("");
    } catch (e) {
      setMsg((e as Error).message || "Booking failed.");
    } finally {
      setBusy(false);
    }
  }

  const fmt = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Scheduler</h1>
        <p className="page-sub">Book appointments for the team — every closer's calendar is checked so no one is double-booked.</p>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Book an appointment</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Only open times are shown (across all closers). Leave the closer on <strong>Auto</strong> to
          assign the next free one, or choose a specific closer.
        </p>
        <div className="fields" style={{ display: "grid", gap: 10 }}>
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>Customer name *</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Homeowner" />
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>Address</div>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" />
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>Phone</div>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567" />
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>Notes</div>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Both decision-makers home after 6pm" />
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>Closer</div>
            <select value={closerUid} onChange={(e) => setCloserUid(e.target.value)}>
              <option value="">Auto — next available closer</option>
              {closers.map((c) => (
                <option key={c.uid} value={c.uid}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 4 }}>Time</div>
            <SlotPicker sched={sched} value={startAt} onChange={setStartAt} pool="closers" />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
          <button className="btn primary sm" onClick={book} disabled={busy}>
            {busy ? "Booking…" : "Book appointment"}
          </button>
          {msg && <span className="muted small">{msg}</span>}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Upcoming team appointments</h3>
        {listErr ? (
          <p className="muted small">You don't have access to the full team calendar — booking above still works.</p>
        ) : events.length === 0 ? (
          <p className="muted small">No upcoming appointments.</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {events.map((e) => (
              <div key={e.id} className="row" style={{ justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid var(--line, #21314a)", padding: "6px 0", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{e.title || "Appointment"}</div>
                  <div className="muted small">{fmt(e.startAt)}{e.address ? ` · ${e.address}` : ""}</div>
                </div>
                <div className="muted small" style={{ whiteSpace: "nowrap" }}>{e.closerName || "—"}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
