import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import AgreementSignView from "./AgreementSignView";
import BatteryPlaybook from "./BatteryPlaybook";
import { addDoc, collection, doc, getDoc, getDocs, limit, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import {
  analyzeBill,
  estimateSolarDailyKWh,
  appliancesByCategory,
  computeLoad,
  recommendSystems,
  systemForUnits,
  computeROI,
  batteryContent,
  BATTERIES,
  type SolarInput,
  type LoadResult,
  type SizingGoal,
  type SizingInput,
  type RecommendedSystem,
  type SelectedLoad,
  type LoadCategory,
} from "../lib/batteries";
import {
  fetchAreaIncentives,
  incentiveDates,
  type AreaIncentive,
  type IncentiveReport,
} from "../lib/incentives";
import SolarProposalShow, { type ProposalOption, type ProposalCloseSelection } from "./SolarProposalShow";
import { resolveFinanceOptions, FINANCE_OPTIONS, type FinanceOption } from "../lib/financing";

const fmt = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Fit badge colors — ideal=green, good=blue, undersized=amber.
const FIT_COLOR: Record<RecommendedSystem["fit"], string> = {
  ideal: "#34d399",
  good: "#3b82f6",
  undersized: "#f59e0b",
};
const FIT_LABEL: Record<RecommendedSystem["fit"], string> = {
  ideal: "Ideal fit",
  good: "Good fit",
  undersized: "Undersized",
};

// Recursively drop `undefined` so Firestore never rejects the write.
function clean<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map((v) => clean(v)) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = v === undefined ? null : clean(v);
    }
    return out as T;
  }
  return obj;
}

// Whole-home default: every essential, plus the common HVAC + kitchen loads.
const WHOLE_HOME_IDS = ["furnace_fan", "ac_3ton", "microwave", "range", "dishwasher", "washer", "dryer_e", "waterHeater_e"];

interface SavedProposal {
  id: string;
  customerName?: string;
  address?: string | null;
  leadId?: string | null;
  eventId?: string | null;
  bill?: ReturnType<typeof analyzeBill>;
  solar?: SolarInput;
  load?: LoadResult;
  goal?: SizingGoal;
  backupDays?: number;
  recommendation?: {
    productId: string;
    brand: string;
    model: string;
    units: number;
    totalUsableKWh: number;
    totalContinuousKW: number;
    totalPeakKW: number;
    backupDaysAchieved: number;
  };
  aiSummary?: string | null;
  pricing?: { pricePerUnit: number; installAdder: number };
  incentives?: AreaIncentive[];
  incentivesUtility?: { name: string; rate: number | null } | null;
  roi?: {
    grossCost: number;
    incentives: number;
    netCost: number;
    monthlySavings: number;
    lifetimeSavings: number;
  };
  createdAt?: number;
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

// Injected, scoped styling for the premium dark "brand campaign" restyle.
// Everything is namespaced under `.bt-root` so global app CSS is untouched.
const BT_STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

.bt-root {
  --bt-bg: #0a0712;
  --bt-card: #150f1f;
  --bt-line: rgba(255,255,255,0.08);
  --bt-line-hi: rgba(255,255,255,0.14);
  --bt-accent: #8b5cf6;
  --bt-accent-hi: #a78bfa;
  --bt-gold: #ffd86b;
  --bt-green: #34d399;
  --bt-ink: #ece8f5;
  --bt-dim: #9b93b3;
  position: relative;
  color: var(--bt-ink);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background:
    radial-gradient(1100px 620px at 12% -8%, rgba(139,92,246,0.20), transparent 60%),
    radial-gradient(900px 520px at 100% 8%, rgba(167,139,250,0.10), transparent 60%),
    var(--bt-bg);
  background-attachment: fixed;
  margin: -16px;
  padding: 28px 16px 64px;
  border-radius: 0;
}
@media (min-width: 700px) {
  .bt-root { margin: -24px; padding: 40px 28px 80px; }
}

/* ── Hero header ─────────────────────────────────────────── */
.bt-hero { max-width: 980px; margin: 0 auto 26px; }
.bt-eyebrow {
  font-family: 'JetBrains Mono', monospace;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--bt-accent-hi);
  margin-bottom: 12px;
  opacity: 0.9;
}
.bt-title {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 700;
  font-size: clamp(34px, 6vw, 56px);
  line-height: 1.02;
  letter-spacing: -0.02em;
  background: linear-gradient(120deg, #fff 0%, #cdbcff 55%, var(--bt-accent-hi) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  margin: 0 0 8px;
}
.bt-sub { color: var(--bt-dim); font-size: 15px; max-width: 60ch; margin: 0; }

/* Center the column content like the hero. */
.bt-root > .bt-panel,
.bt-root > .bt-hero,
.bt-root > .section-h,
.bt-root > .bt-kicker,
.bt-root > .lb-list,
.bt-root > .empty { max-width: 980px; margin-left: auto; margin-right: auto; }

/* ── Panels (cards) ──────────────────────────────────────── */
.bt-root .card.bt-panel {
  background: linear-gradient(180deg, rgba(33,24,48,0.72), rgba(21,15,31,0.72));
  border: 1px solid var(--bt-line);
  border-radius: 18px;
  box-shadow: 0 18px 48px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  padding: 22px;
}
@media (min-width: 700px) { .bt-root .card.bt-panel { padding: 26px 28px; } }

/* Nested cards inside a panel get the lighter glass treatment. */
.bt-root .bt-panel .card {
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--bt-line);
  border-radius: 14px;
}

.bt-kicker {
  font-family: 'JetBrains Mono', monospace;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--bt-dim);
  margin-bottom: 8px;
}
.bt-root .bt-section-h {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 600;
  font-size: 22px;
  letter-spacing: -0.01em;
  color: #fff;
  border: none;
  padding: 0;
}
.bt-root .bt-field-label,
.bt-root .field-label {
  font-family: 'JetBrains Mono', monospace;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--bt-dim);
}

/* ── Inputs ──────────────────────────────────────────────── */
.bt-root .field > span { color: var(--bt-dim); font-size: 13px; }
.bt-root input[type="text"],
.bt-root input[type="email"],
.bt-root input[type="number"],
.bt-root input:not([type]) {
  background: rgba(10,7,18,0.6);
  border: 1px solid var(--bt-line);
  border-radius: 12px;
  color: var(--bt-ink);
  padding: 11px 13px;
  font-size: 14px;
  transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
}
.bt-root input::placeholder { color: rgba(155,147,179,0.55); }
.bt-root input:focus {
  outline: none;
  border-color: var(--bt-accent);
  box-shadow: 0 0 0 3px rgba(139,92,246,0.28);
  background: rgba(10,7,18,0.85);
}
.bt-root input[type="checkbox"] { accent-color: var(--bt-accent); width: 17px; height: 17px; }

/* ── Buttons / pills ─────────────────────────────────────── */
.bt-root .btn {
  border-radius: 999px;
  font-family: 'Inter', sans-serif;
  transition: transform .15s ease, box-shadow .2s ease, background .2s ease, border-color .2s ease;
}
.bt-root .btn.ghost {
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--bt-line-hi);
  color: var(--bt-ink);
}
.bt-root .btn.ghost:hover { background: rgba(255,255,255,0.09); border-color: var(--bt-accent); }
.bt-root .btn.primary {
  background: linear-gradient(120deg, var(--bt-accent), var(--bt-accent-hi));
  border: 1px solid rgba(255,255,255,0.18);
  color: #fff;
  box-shadow: 0 8px 22px rgba(139,92,246,0.35);
}
.bt-root .btn.primary:hover { transform: translateY(-1px); box-shadow: 0 12px 30px rgba(139,92,246,0.5); }
.bt-root .btn:active { transform: translateY(0); }
.bt-root .btn:disabled { opacity: 0.5; box-shadow: none; transform: none; }

/* ── Customer search dropdown (contained, themed) ────────── */
.bt-root .field button.row:hover { background: rgba(139,92,246,0.16) !important; }

/* ── Stat cards (mono readouts) ──────────────────────────── */
.bt-root .bt-stat-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--bt-line);
  border-radius: 14px;
  padding: 14px 14px 12px;
  transition: border-color .2s ease, transform .2s ease;
}
.bt-root .bt-stat-card:hover { border-color: var(--bt-line-hi); }
.bt-root .bt-stat-card .stat-value {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 700;
  font-size: 26px;
  letter-spacing: -0.01em;
  color: #fff;
}
.bt-root .bt-stat-card .stat-label {
  font-family: 'JetBrains Mono', monospace;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--bt-dim);
  margin-top: 4px;
}
.bt-root .bt-stat--accent .stat-value { color: var(--bt-accent-hi); }
.bt-root .bt-stat--gold .stat-value { color: var(--bt-gold); }
.bt-root .bt-stat--green .stat-value { color: var(--bt-green); }

/* ── Load list rows ──────────────────────────────────────── */
.bt-root .lb-row.card {
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--bt-line);
  border-radius: 12px;
  transition: border-color .18s ease, background .18s ease;
}
.bt-root .lb-row.card:hover { border-color: var(--bt-line-hi); background: rgba(255,255,255,0.045); }
.bt-root .lb-row-name { color: var(--bt-ink); font-weight: 600; }

/* ── Recommendation hero card ────────────────────────────── */
.bt-root .bt-hero-card {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(700px 300px at 90% -30%, rgba(139,92,246,0.22), transparent 60%),
    linear-gradient(180deg, rgba(40,28,60,0.8), rgba(21,15,31,0.85)) !important;
  border-radius: 18px !important;
  box-shadow: 0 20px 50px rgba(0,0,0,0.5), 0 0 0 1px rgba(139,92,246,0.12);
}
.bt-root .bt-hero-card::before {
  content: "";
  position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: linear-gradient(180deg, var(--bt-fit, var(--bt-accent)), transparent);
}
.bt-root .bt-hero-card .lb-row-name { font-family: 'Space Grotesk', sans-serif; }

/* Stepper */
.bt-root .bt-stepper {
  display: inline-flex; align-items: center; gap: 4px;
  background: rgba(10,7,18,0.55);
  border: 1px solid var(--bt-line-hi);
  border-radius: 999px;
  padding: 3px;
}
.bt-root .bt-stepper .bt-step-btn {
  min-width: 34px; height: 34px; padding: 0;
  border-radius: 999px; font-size: 18px; line-height: 1;
  background: rgba(255,255,255,0.05); border: none;
}
.bt-root .bt-stepper .bt-step-btn:hover:not(:disabled) { background: var(--bt-accent); }
.bt-root .bt-step-val { font-family: 'Space Grotesk', sans-serif; font-size: 16px; padding: 0 4px; }
.bt-root .bt-mono-label {
  font-family: 'JetBrains Mono', monospace; text-transform: uppercase;
  font-size: 10px; letter-spacing: 0.16em; color: var(--bt-dim);
}

/* ── Alternatives / proposal chips ───────────────────────── */
.bt-root .bt-alt {
  border-radius: 14px;
  transition: border-color .18s ease, transform .15s ease, box-shadow .2s ease;
}
.bt-root .bt-alt:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(0,0,0,0.4); }
.bt-root .bt-alt--active {
  background: rgba(139,92,246,0.1) !important;
  box-shadow: 0 0 0 1px rgba(139,92,246,0.4), 0 10px 26px rgba(139,92,246,0.18);
}

/* ── Badges (kept contained) ─────────────────────────────── */
.bt-root .badge { border-radius: 999px; max-width: 100%; white-space: nowrap; }

/* ── Present CTA ─────────────────────────────────────────── */
.bt-root .bt-present {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
  padding: 16px;
  border-radius: 16px;
  background: linear-gradient(120deg, var(--bt-accent), #c4b5fd) !important;
  box-shadow: 0 14px 36px rgba(139,92,246,0.45);
}
.bt-root .bt-present:hover { box-shadow: 0 18px 46px rgba(139,92,246,0.6); }

/* ── Misc ────────────────────────────────────────────────── */
.bt-root .muted, .bt-root .small { color: var(--bt-dim); }
.bt-root a.small { color: var(--bt-accent-hi); }
.bt-root .empty {
  background: rgba(255,255,255,0.02);
  border: 1px dashed var(--bt-line-hi);
  border-radius: 14px;
  color: var(--bt-dim);
}

@media (prefers-reduced-motion: reduce) {
  .bt-root *, .bt-root *::before, .bt-root *::after {
    transition: none !important;
    animation: none !important;
  }
}
`;

// Read a File into a bare base64 string (drops the `data:...;base64,` prefix).
const fileToBase64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(f);
  });

// Result shapes returned by the analyzeEnergyDocument callable.
interface BillDocData {
  monthlyKWh?: number | null;
  monthlyCost?: number | null;
  ratePerKWh?: number | null;
  utilityName?: string | null;
  billingDays?: number | null;
  notes?: string | null;
}
interface SolarDocData {
  systemKwDc?: number | null;
  annualProductionKWh?: number | null;
  monthlyProductionKWh?: number | null;
  inverterBrand?: string | null;
  notes?: string | null;
}

export default function BatteryTool() {
  const { profile, companyId, role, company } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // When the rep signs on this device, show the agreement sign view as an in-app
  // overlay (never navigate out to the web URL — that drops the native session).
  const [signOverlay, setSignOverlay] = useState<{ id: string; token: string } | null>(null);
  // Rep-facing sales playbook (grid-down demo, utility intel, door calculators).
  const [playbookOpen, setPlaybookOpen] = useState(false);

  // 1. Customer
  const [customerName, setCustomerName] = useState("");
  const [address, setAddress] = useState("");
  const [leadId, setLeadId] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  useEffect(() => {
    const lid = searchParams.get("leadId");
    if (lid) setLeadId(lid);
    const eid = searchParams.get("eventId");
    if (eid) setEventId(eid);
  }, [searchParams]);

  // Customer geo (from a linked lead), used to sharpen incentive lookups.
  const [leadGeo, setLeadGeo] = useState<{ lat?: number; lng?: number }>({});

  // Customer picker — search the company's leads/customers by name or address so
  // the proposal auto-fills regardless of how the tool was opened.
  type LeadHit = { id: string; ownerName: string; address: string; lat?: number; lng?: number };
  const [custQuery, setCustQuery] = useState("");
  const [custResults, setCustResults] = useState<LeadHit[]>([]);
  const [custOpen, setCustOpen] = useState(false);
  const allLeadsRef = useRef<LeadHit[] | null>(null);

  const ensureLeads = async (): Promise<LeadHit[]> => {
    if (allLeadsRef.current) return allLeadsRef.current;
    if (!companyId || !profile) return [];
    const base = collection(db, "leads");
    // Admins read the whole company; everyone else reads only their visible leads
    // (matches the Firestore rules so the query isn't rejected). Single-field
    // filters only — no composite index needed.
    const q = role === "admin"
      ? query(base, where("companyId", "==", companyId), limit(800))
      : query(base, where("visibilityPath", "array-contains", profile.uid), limit(800));
    try {
      const snap = await getDocs(q);
      const hits = snap.docs.map((d) => {
        const v = d.data() as { ownerName?: string; address?: string; lat?: number; lng?: number };
        return { id: d.id, ownerName: v.ownerName || "", address: v.address || "", lat: v.lat, lng: v.lng };
      }).filter((h) => h.ownerName || h.address);
      allLeadsRef.current = hits;
      return hits;
    } catch (e) {
      console.warn("customer search", e);
      allLeadsRef.current = [];
      return [];
    }
  };

  const onCustQuery = async (text: string) => {
    setCustQuery(text);
    setCustOpen(true);
    const t = text.trim().toLowerCase();
    if (!t) { setCustResults([]); return; }
    const leads = await ensureLeads();
    setCustResults(
      leads.filter((h) => h.ownerName.toLowerCase().includes(t) || h.address.toLowerCase().includes(t)).slice(0, 8)
    );
  };

  const pickCustomer = (h: LeadHit) => {
    setCustomerName(h.ownerName);
    setAddress(h.address);
    setLeadGeo({ lat: h.lat, lng: h.lng });
    setLeadId(h.id); // also pulls geo + any setter-captured incentives via the lead-hydration effect
    setCustQuery(h.ownerName || h.address);
    setCustOpen(false);
    setCustResults([]);
  };

  // Auto-populate from an appointment/event: read the event, derive its lead
  // (or a name from the title) and address. Runs once per eventId.
  const eventHydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!eventId || eventHydratedRef.current === eventId) return;
    eventHydratedRef.current = eventId;
    let active = true;
    getDoc(doc(db, "events", eventId))
      .then((snap) => {
        if (!active || !snap.exists()) return;
        const d = snap.data() as { address?: string; leadId?: string; title?: string } | undefined;
        if (d?.address) setAddress((cur) => cur || d.address || "");
        if (d?.leadId) {
          setLeadId((cur) => cur || d.leadId || null);
        } else if (d?.title) {
          const name = d.title.replace(/^\s*(?:Appointment|Closing)\s+—\s+/i, "").trim();
          if (name) setCustomerName((cur) => cur || name);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [eventId]);

  // Auto-populate from a lead (whether passed directly or derived from an event):
  // prefill name/address, capture geo for incentives, and seed any incentives the
  // setter already captured. Runs once per leadId; never clobbers typed values.
  const leadHydratedRef = useRef<string | null>(null);

  // 2. Bill analyzer
  const [monthlyKWh, setMonthlyKWh] = useState("");
  const [monthlyCost, setMonthlyCost] = useState("");
  const [ratePerKWh, setRatePerKWh] = useState("");
  const bill = useMemo(
    () =>
      analyzeBill({
        monthlyKWh: monthlyKWh ? Number(monthlyKWh) : undefined,
        monthlyCost: monthlyCost ? Number(monthlyCost) : undefined,
        ratePerKWh: ratePerKWh ? Number(ratePerKWh) : undefined,
      }),
    [monthlyKWh, monthlyCost, ratePerKWh]
  );

  // 3. Existing solar
  const [hasSolar, setHasSolar] = useState(false);
  const [systemKwDc, setSystemKwDc] = useState("");
  const [annualProductionKWh, setAnnualProductionKWh] = useState("");
  const solar = useMemo<SolarInput>(
    () => ({
      hasSolar,
      systemKwDc: systemKwDc ? Number(systemKwDc) : undefined,
      annualProductionKWh: annualProductionKWh ? Number(annualProductionKWh) : undefined,
    }),
    [hasSolar, systemKwDc, annualProductionKWh]
  );
  const solarDaily = useMemo(() => estimateSolarDailyKWh(solar), [solar]);

  // Upload a bill / solar-production photo or PDF and AI-extract its numbers.
  const [docLoading, setDocLoading] = useState<"bill" | "solar" | null>(null);
  const [docError, setDocError] = useState<{ bill?: string; solar?: string }>({});
  const [docNote, setDocNote] = useState<{ bill?: string; solar?: string }>({});
  const analyzeDocument = async (e: React.ChangeEvent<HTMLInputElement>, kind: "bill" | "solar") => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setDocError((c) => ({ ...c, [kind]: undefined }));
    setDocNote((c) => ({ ...c, [kind]: undefined }));
    if (file.size > 7 * 1024 * 1024) {
      setDocError((c) => ({ ...c, [kind]: "File is too large — keep it under 7 MB." }));
      return;
    }
    setDocLoading(kind);
    try {
      const base64 = await fileToBase64(file);
      const { data } = await httpsCallable<
        { base64: string; mediaType: string; kind: "bill" | "solar" },
        { kind: "bill" | "solar"; data: BillDocData | SolarDocData }
      >(functions, "analyzeEnergyDocument")({ base64, mediaType: file.type, kind });
      const notes: string[] = [];
      if (kind === "bill") {
        const d = data.data as BillDocData;
        if (d.monthlyKWh != null) setMonthlyKWh(String(d.monthlyKWh));
        if (d.monthlyCost != null) setMonthlyCost(String(d.monthlyCost));
        if (d.ratePerKWh != null) setRatePerKWh(String(d.ratePerKWh));
        if (d.utilityName) notes.push(`Utility: ${d.utilityName}`);
        if (d.billingDays != null) notes.push(`${d.billingDays}-day billing period`);
        if (d.notes) notes.push(d.notes);
      } else {
        const d = data.data as SolarDocData;
        setHasSolar(true);
        if (d.systemKwDc != null) setSystemKwDc(String(d.systemKwDc));
        if (d.annualProductionKWh != null) setAnnualProductionKWh(String(d.annualProductionKWh));
        else if (d.monthlyProductionKWh != null) setAnnualProductionKWh(String(Math.round(d.monthlyProductionKWh * 12)));
        if (d.inverterBrand) notes.push(`Inverter: ${d.inverterBrand}`);
        if (d.notes) notes.push(d.notes);
      }
      setDocNote((c) => ({ ...c, [kind]: notes.join(" · ") || "Done — fields filled in. Edit as needed." }));
    } catch (err) {
      setDocError((c) => ({ ...c, [kind]: (err as Error).message || "Couldn't analyze that document." }));
    } finally {
      setDocLoading(null);
    }
  };

  // 4. Load calculator
  const [mode, setMode] = useState<"essentials" | "whole">("essentials");
  const [selected, setSelected] = useState<SelectedLoad[]>([]);
  const categories = useMemo(() => appliancesByCategory(), []);

  // Pre-select sensible defaults on first switch into a mode.
  const applyMode = (next: "essentials" | "whole") => {
    setMode(next);
    if (next === "essentials") {
      const ess: SelectedLoad[] = [];
      categories.forEach((arr) => arr.forEach((a) => { if (a.essential) ess.push({ applianceId: a.id, qty: 1 }); }));
      setSelected(ess);
    } else {
      const ids = new Set(WHOLE_HOME_IDS);
      const whole: SelectedLoad[] = [];
      categories.forEach((arr) => arr.forEach((a) => { if (a.essential || ids.has(a.id)) whole.push({ applianceId: a.id, qty: 1 }); }));
      setSelected(whole);
    }
  };
  // Seed the default essentials selection on first mount.
  useEffect(() => { applyMode("essentials"); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const diversity = mode === "essentials" ? 1.0 : 0.6;
  const qtyOf = (id: string) => selected.find((s) => s.applianceId === id)?.qty ?? 0;
  const setQty = (id: string, qty: number) =>
    setSelected((cur) => {
      const rest = cur.filter((s) => s.applianceId !== id);
      return qty > 0 ? [...rest, { applianceId: id, qty }] : rest;
    });
  const load = useMemo(() => computeLoad(selected, diversity), [selected, diversity]);

  // 5. Goal & backup
  const [goal, setGoal] = useState<SizingGoal>("both");
  const [backupDays, setBackupDays] = useState("1");
  const [preferLFP, setPreferLFP] = useState(false);

  // 6. Recommendation
  // Limit recommendations to the products the company offers. Unset or empty =
  // offer the full catalog (don't break existing companies).
  const offeredProducts = useMemo(() => {
    const ids = company?.batteryOffered;
    return (Array.isArray(ids) && ids.length) ? BATTERIES.filter((b) => ids.includes(b.id)) : BATTERIES;
  }, [company?.batteryOffered]);

  // Sizing input — extracted so it can be reused when the rep overrides the unit count.
  const sizing = useMemo<SizingInput>(
    () => ({
      load,
      goal,
      backupDays: Number(backupDays) || 1,
      dailyUsageKWh: bill.dailyKWh,
      solarDailyKWh: solarDaily,
      preferLFP,
    }),
    [load, goal, backupDays, bill.dailyKWh, solarDaily, preferLFP]
  );

  const recs = useMemo(
    () => recommendSystems(sizing, offeredProducts),
    [sizing, offeredProducts]
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  // Default the chosen system to the best rec; reset when the top rec changes.
  useEffect(() => { setChosenId(recs[0]?.product.id ?? null); }, [recs]);
  const chosen = useMemo(() => recs.find((r) => r.product.id === chosenId) ?? recs[0], [recs, chosenId]);

  // Per-proposal override of the battery count. Null = use the auto recommendation.
  const [unitsOverride, setUnitsOverride] = useState<number | null>(null);
  // When restoring a saved proposal we set the product *and* its override together;
  // skip the product-change reset for that one transition so the override survives.
  const restoreUnitsForProduct = useRef<string | null>(null);
  // Switching to a different product returns to its recommended count.
  useEffect(() => {
    const pid = chosen?.product.id ?? null;
    if (pid && restoreUnitsForProduct.current === pid) {
      restoreUnitsForProduct.current = null;
      return;
    }
    setUnitsOverride(null);
  }, [chosen?.product.id]);
  // The effective system everything downstream (pricing, ROI, save, UI) reads from.
  const system = useMemo(() => {
    if (!chosen) return chosen;
    return unitsOverride != null ? systemForUnits(chosen.product, unitsOverride, sizing) : chosen;
  }, [chosen, unitsOverride, sizing]);

  useEffect(() => {
    if (!leadId || leadHydratedRef.current === leadId) return;
    leadHydratedRef.current = leadId;
    let active = true;
    getDoc(doc(db, "leads", leadId))
      .then((snap) => {
        if (!active || !snap.exists()) return;
        const d = snap.data() as
          | {
              ownerName?: string;
              address?: string;
              lat?: number;
              lng?: number;
              incentives?: AreaIncentive[];
              incentivesUtility?: { name: string; rate: number | null } | null;
            }
          | undefined;
        if (d?.ownerName) setCustomerName((cur) => cur || d.ownerName || "");
        if (d?.address) setAddress((cur) => cur || d.address || "");
        setLeadGeo(d?.lat != null && d?.lng != null ? { lat: d.lat, lng: d.lng } : {});
        // Seed any incentives the setter already captured for this lead.
        if (d?.incentives && d.incentives.length) {
          const incs = d.incentives;
          setIncReport((cur) =>
            cur ?? {
              location: d.address || "",
              utility: d.incentivesUtility ?? null,
              incentives: incs,
              sources: [],
              usedWeb: false,
              generatedAt: Date.now(),
              cacheId: "",
              cached: true,
            }
          );
          // Default-apply incentives that carry a dollar estimate.
          setAppliedKeys((cur) => {
            if (cur.size) return cur;
            const checked = new Set<string>();
            incs.forEach((i, idx) => {
              if (typeof i.estValueUsd === "number") checked.add(incKey(i, idx));
            });
            return checked;
          });
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [leadId]);

  // 6b. Pricing — seed from company catalog for the chosen product, but allow a
  // per-proposal override. Re-seed only when the chosen product *id* changes so
  // we never clobber a value the rep has typed.
  const [pricePerUnit, setPricePerUnit] = useState("");
  const [installAdder, setInstallAdder] = useState("");
  const seededProductId = useRef<string | null>(null);
  useEffect(() => {
    const pid = chosen?.product.id ?? null;
    if (pid === seededProductId.current) return;
    seededProductId.current = pid;
    const entry = pid ? company?.batteryPricing?.[pid] : undefined;
    setPricePerUnit(entry?.price != null ? String(entry.price) : "0");
    setInstallAdder(entry?.adder != null ? String(entry.adder) : "0");
  }, [chosen?.product.id, company?.batteryPricing]);

  // Admin company-pricing editor (admin only).
  const [showPricingAdmin, setShowPricingAdmin] = useState(false);
  const [pricingDraft, setPricingDraft] = useState<Record<string, { price: string; adder: string }>>({});
  const [pricingSaving, setPricingSaving] = useState(false);
  const [pricingSaved, setPricingSaved] = useState(false);
  const [pricingError, setPricingError] = useState("");
  useEffect(() => {
    const draft: Record<string, { price: string; adder: string }> = {};
    for (const b of BATTERIES) {
      const e = company?.batteryPricing?.[b.id];
      draft[b.id] = { price: e?.price != null ? String(e.price) : "", adder: e?.adder != null ? String(e.adder) : "" };
    }
    setPricingDraft(draft);
  }, [company?.batteryPricing]);

  const saveCompanyPricing = async () => {
    if (!companyId) return;
    setPricingSaving(true);
    setPricingSaved(false);
    setPricingError("");
    try {
      const pricing: Record<string, { price: number; adder: number }> = {};
      for (const [pid, v] of Object.entries(pricingDraft)) {
        pricing[pid] = { price: Number(v.price) || 0, adder: Number(v.adder) || 0 };
      }
      await httpsCallable<
        { companyId: string; pricing: Record<string, { price: number; adder: number }> },
        { ok?: boolean; error?: string }
      >(functions, "setBatteryPricing")({ companyId, pricing });
      setPricingSaved(true);
    } catch (e) {
      setPricingError((e as Error).message || "Couldn't save pricing.");
    } finally {
      setPricingSaving(false);
    }
  };

  // 6b. Company financing plans editor (admin). Seeded from the company's saved
  // plans, falling back to the built-in defaults so there's always a starting
  // point. Edits include ALL plans (even disabled ones) so they can be toggled.
  const [showFinanceAdmin, setShowFinanceAdmin] = useState(false);
  const [financeDraft, setFinanceDraft] = useState<FinanceOption[]>([]);
  const [financeSaving, setFinanceSaving] = useState(false);
  const [financeSaved, setFinanceSaved] = useState(false);
  const [financeError, setFinanceError] = useState("");
  useEffect(() => {
    const seed = Array.isArray(company?.financeOptions) && company?.financeOptions?.length
      ? company.financeOptions : FINANCE_OPTIONS;
    setFinanceDraft(seed.map((o) => ({ ...o, enabled: o.enabled !== false })));
  }, [company?.financeOptions]);
  const updateFin = (i: number, patch: Partial<FinanceOption>) =>
    setFinanceDraft((cur) => cur.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  const addFin = () =>
    setFinanceDraft((cur) => [...cur, {
      id: `fin${cur.length}_${Math.round(Number(String(Date.now()).slice(-6)))}`,
      name: "New plan", financeCompany: "", blurb: "", termYears: 20,
      apr: 0.0999, dealerFee: 0, kind: "level", applyUrl: "", enabled: true,
    }]);
  const removeFin = (i: number) => setFinanceDraft((cur) => cur.filter((_, idx) => idx !== i));
  const saveFinance = async () => {
    if (!companyId) return;
    setFinanceSaving(true); setFinanceSaved(false); setFinanceError("");
    try {
      await httpsCallable<{ companyId: string; financeOptions: FinanceOption[] }, { ok?: boolean }>(
        functions, "setBatteryPricing"
      )({ companyId, financeOptions: financeDraft });
      setFinanceSaved(true);
    } catch (e) { setFinanceError((e as Error).message || "Couldn't save financing."); }
    finally { setFinanceSaving(false); }
  };

  // 6c. Incentives
  const [incLoading, setIncLoading] = useState(false);
  const [incError, setIncError] = useState("");
  const [incReport, setIncReport] = useState<IncentiveReport | null>(null);
  const [appliedKeys, setAppliedKeys] = useState<Set<string>>(new Set());
  const incKey = (i: AreaIncentive, idx: number) => `${i.name || "incentive"}#${idx}`;

  const findIncentives = async () => {
    setIncLoading(true);
    setIncError("");
    try {
      const st = address.match(/\b([A-Z]{2})\b/);
      const zp = address.match(/\b(\d{5})\b/);
      const report = await fetchAreaIncentives({
        address: address || undefined,
        state: st ? st[1] : undefined,
        zip: zp ? zp[1] : undefined,
        ...(leadGeo.lat != null ? { lat: leadGeo.lat } : {}),
        ...(leadGeo.lng != null ? { lng: leadGeo.lng } : {}),
      });
      setIncReport(report);
      // Default-check incentives that carry a dollar estimate.
      const checked = new Set<string>();
      report.incentives.forEach((i, idx) => {
        if (typeof i.estValueUsd === "number") checked.add(incKey(i, idx));
      });
      setAppliedKeys(checked);
    } catch (e) {
      setIncReport(null);
      setIncError((e as Error).message || "Couldn't find incentives.");
    } finally {
      setIncLoading(false);
    }
  };

  const toggleApplied = (key: string) =>
    setAppliedKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const appliedIncentives = useMemo(
    () => (incReport?.incentives ?? []).filter((i, idx) => appliedKeys.has(incKey(i, idx))),
    [incReport, appliedKeys]
  );
  const incentivesTotalUsd = useMemo(
    () => appliedIncentives.reduce((s, i) => s + (typeof i.estValueUsd === "number" ? i.estValueUsd : 0), 0),
    [appliedIncentives]
  );

  // Email incentives to homeowner.
  const [homeownerEmail, setHomeownerEmail] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState("");
  const emailIncentives = async () => {
    if (!incReport) return;
    setEmailSending(true);
    setEmailSent(false);
    setEmailError("");
    try {
      const items = appliedIncentives.length ? appliedIncentives : incReport.incentives;
      await httpsCallable<
        {
          to: string;
          customerName: string;
          address: string;
          incentives: AreaIncentive[];
          utility: IncentiveReport["utility"];
          companyName?: string;
        },
        { ok?: boolean; error?: string }
      >(functions, "emailIncentivesToHomeowner")({
        to: homeownerEmail,
        customerName,
        address,
        incentives: items,
        utility: incReport.utility ?? null,
        companyName: company?.name,
      });
      setEmailSent(true);
    } catch (e) {
      setEmailError((e as Error).message || "Couldn't send the email.");
    } finally {
      setEmailSending(false);
    }
  };

  // ROI for the chosen system at the current price + applied incentives.
  const roi = useMemo(
    () =>
      system
        ? computeROI({
            rec: system,
            pricePerUnit: Number(pricePerUnit) || 0,
            installAdder: Number(installAdder) || 0,
            incentivesTotalUsd,
            ratePerKWh: bill.ratePerKWh,
            dailyUsageKWh: bill.dailyKWh,
          })
        : null,
    [system, pricePerUnit, installAdder, incentivesTotalUsd, bill.ratePerKWh, bill.dailyKWh]
  );

  // Cash-reservation deposit shown on the pricing slide. A company % override
  // takes precedence over a flat $ override; both default to $2,500.
  const depositUsd = useMemo(() => {
    const pct = Number(company?.batteryDepositPct);
    if (pct > 0 && roi && roi.netCost > 0) return Math.max(0, Math.round((roi.netCost * pct) / 100));
    const usd = Number(company?.batteryDepositUsd);
    return usd > 0 ? Math.round(usd) : 2500;
  }, [company?.batteryDepositPct, company?.batteryDepositUsd, roi]);

  // Build the full option set for the interactive CRM proposal: every offered
  // recommendation, with marketing content + per-product pricing/ROI so the show
  // can re-theme to whichever battery the rep selects in front of the homeowner.
  const proposalOptions = useMemo<ProposalOption[]>(() => {
    const topId = recs[0]?.product.id;
    return recs.map((rec) => {
      const content = batteryContent(rec.product.id);
      // Per-product pricing from the company catalog. Fall back to the page's
      // current typed price only for the chosen product (so the live edit shows
      // through); otherwise use the company entry, defaulting to 0.
      const entry = company?.batteryPricing?.[rec.product.id];
      const isChosen = rec.product.id === (system?.product.id ?? chosen?.product.id);
      const ppu = isChosen ? (Number(pricePerUnit) || 0) : (entry?.price ?? 0);
      const adder = isChosen ? (Number(installAdder) || 0) : (entry?.adder ?? 0);
      const roiFor = (s: typeof rec) =>
        computeROI({
          rec: s,
          pricePerUnit: ppu,
          installAdder: adder,
          incentivesTotalUsd,
          ratePerKWh: bill.ratePerKWh,
          dailyUsageKWh: bill.dailyKWh,
        });
      const r = roiFor(rec);
      // Precompute a variant for every stackable unit count so the homeowner can
      // change the quantity inside the proposal and have everything recompute.
      const unitOptions = Array.from({ length: rec.product.maxUnits }, (_, i) => i + 1).map((u) => {
        const sys = systemForUnits(rec.product, u, sizing);
        const sr = roiFor(sys);
        return {
          units: sys.units,
          totalUsableKWh: sys.totalUsableKWh,
          totalContinuousKW: sys.totalContinuousKW,
          totalPeakKW: sys.totalPeakKW,
          backupDaysAchieved: sys.backupDaysAchieved,
          roi: {
            grossCost: sr.grossCost,
            incentives: sr.incentives,
            netCost: sr.netCost,
            monthlySavings: sr.monthlySavings,
            lifetimeSavings: sr.lifetimeSavings,
          },
        };
      });
      return {
        productId: rec.product.id,
        brand: rec.product.brand,
        model: rec.product.model,
        units: rec.units,
        totalUsableKWh: rec.totalUsableKWh,
        totalContinuousKW: rec.totalContinuousKW,
        totalPeakKW: rec.totalPeakKW,
        backupDaysAchieved: rec.backupDaysAchieved,
        warrantyYears: rec.product.warrantyYears,
        chemistry: rec.product.chemistry,
        tagline: content.tagline,
        features: content.features,
        benefits: content.benefits,
        accent: content.accent,
        roi: {
          grossCost: r.grossCost,
          incentives: r.incentives,
          netCost: r.netCost,
          monthlySavings: r.monthlySavings,
          lifetimeSavings: r.lifetimeSavings,
        },
        recommended: rec.product.id === topId,
        maxUnits: rec.product.maxUnits,
        unitOptions,
      };
    });
  }, [recs, company?.batteryPricing, system?.product.id, chosen?.product.id, pricePerUnit, installAdder, incentivesTotalUsd, bill.ratePerKWh, bill.dailyKWh, sizing]);

  // The proposal shown/sent to the homeowner reflects ONLY the battery the rep
  // selected, pinned to the quantity they chose — not the full multi-battery
  // compare. (A single option makes SolarProposalShow skip the Compare slide,
  // and locking unitOptions to the chosen count fixes the quantity.)
  const chosenProposalOptions = useMemo<ProposalOption[]>(() => {
    const sel = proposalOptions.find((o) => o.productId === system?.product.id) || proposalOptions[0];
    if (!sel) return [];
    const units = system?.units ?? sel.units;
    const variant = (sel.unitOptions || []).find((v) => v.units === units);
    return [{
      ...sel,
      units,
      ...(variant
        ? {
            totalUsableKWh: variant.totalUsableKWh,
            totalContinuousKW: variant.totalContinuousKW,
            totalPeakKW: variant.totalPeakKW,
            backupDaysAchieved: variant.backupDaysAchieved,
            roi: variant.roi,
          }
        : {}),
      unitOptions: variant ? [variant] : (sel.unitOptions || []),
      maxUnits: units,
      recommended: true,
    }];
  }, [proposalOptions, system?.product.id, system?.units]);

  // 7. Proposal
  const [aiSummary, setAiSummary] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Interactive proposal "show" overlay.
  const [showOpen, setShowOpen] = useState(false);

  // "Let's do this" → create the battery agreement and finalize (sign on this
  // device, or email the customer to sign).
  const [closeSel, setCloseSel] = useState<ProposalCloseSelection | null>(null);
  const [closeBusy, setCloseBusy] = useState<"" | "device" | "email">("");
  const [closeMsg, setCloseMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const handleLetsDoIt = (sel: ProposalCloseSelection) => {
    setShowOpen(false);
    setCloseMsg(null);
    setCloseSel(sel);
  };
  const createAgreement = async (delivery: "device" | "email") => {
    if (!closeSel) return;
    if (delivery === "email" && !homeownerEmail) {
      setCloseMsg({ ok: false, text: "Enter the customer's email to send it for signature." });
      return;
    }
    setCloseBusy(delivery);
    setCloseMsg(null);
    try {
      const q = new URLSearchParams(window.location.search);
      const { data } = await httpsCallable<{ delivery: string } & Record<string, unknown>, { ok?: boolean; signUrl?: string; id?: string; token?: string }>(
        functions,
        "createBatteryAgreement"
      )({
        delivery,
        customerName,
        customerEmail: homeownerEmail || undefined,
        address,
        leadId: q.get("leadId") || undefined,
        eventId: q.get("eventId") || undefined,
        closerName: profile?.displayName || profile?.email || "",
        battery: closeSel.battery,
        payment: { method: closeSel.method, systemPrice: closeSel.systemPrice, finance: closeSel.finance, cash: closeSel.cash },
      });
      if (delivery === "device" && data?.id && data?.token) {
        // Sign in-app as an overlay — DON'T navigate to the web signUrl, which
        // would leave the native bundle and drop the rep's session ("account not
        // active"). Once signed we route straight to the site survey in-app.
        setCloseBusy("");
        setCloseSel(null);
        setSignOverlay({ id: data.id, token: data.token });
        return;
      }
      setCloseMsg({ ok: true, text: `Agreement sent to ${homeownerEmail} to sign.` });
    } catch (e) {
      setCloseMsg({ ok: false, text: (e as Error).message || "Couldn't create the agreement." });
    } finally {
      setCloseBusy("");
    }
  };

  // EV charger is in the selected loads?
  const hasEv = useMemo(() => selected.some((s) => s.applianceId === "ev_l2" && s.qty > 0), [selected]);

  // Real photo of the customer's home (Street View / satellite) for the show.
  const [homeImg, setHomeImg] = useState<string | null>(null);
  const [homeIsSV, setHomeIsSV] = useState(false);
  const [homeImgLoading, setHomeImgLoading] = useState(false);
  const [homeImgErr, setHomeImgErr] = useState("");
  const [homeImgTried, setHomeImgTried] = useState(false); // an attempt finished (success, empty, or error)
  // Remember which address/geo the current photo was fetched for, so a changed
  // address can re-fetch. `attempted` marks a key we've already tried (even if it
  // returned nothing) so auto-load runs once per address, not on every render.
  const homeImgKeyRef = useRef<string | null>(null);
  const homeImgAttemptedRef = useRef<string | null>(null);

  const homeKey = () => {
    const latNum = typeof leadGeo.lat === "number" && isFinite(leadGeo.lat) ? leadGeo.lat : undefined;
    const lngNum = typeof leadGeo.lng === "number" && isFinite(leadGeo.lng) ? leadGeo.lng : undefined;
    return { addr: address.trim(), latNum, lngNum, key: `${address.trim()}|${latNum ?? ""}|${lngNum ?? ""}` };
  };

  const loadHomeImagery = async () => {
    const { addr, latNum, lngNum, key } = homeKey();
    // Guard: nothing to look up.
    if (!addr && (latNum == null || lngNum == null)) return;
    homeImgAttemptedRef.current = key; // mark attempted up front so auto-load fires once
    setHomeImgLoading(true);
    setHomeImgErr("");
    try {
      const { data } = await httpsCallable<
        { lat?: number; lng?: number; address?: string },
        { streetView: string | null; satellite: string | null; hasStreetView: boolean; lat: number; lng: number }
      >(functions, "getHomeImagery")({
        ...(latNum != null && lngNum != null ? { lat: latNum, lng: lngNum } : {}),
        ...(addr ? { address: addr } : {}),
      });
      const img = data.streetView || data.satellite || null;
      setHomeImg(img);
      setHomeIsSV(!!data.streetView);
      homeImgKeyRef.current = key;
    } catch (e) {
      setHomeImgErr((e as Error).message || "Couldn't load the home photo.");
    } finally {
      setHomeImgLoading(false);
      setHomeImgTried(true);
    }
  };

  // If the address/geo no longer matches the photo we have, clear the stale
  // image + attempt marker so it can re-fetch for the new address.
  useEffect(() => {
    const { key } = homeKey();
    if (homeImgKeyRef.current && homeImgKeyRef.current !== key) {
      setHomeImg(null);
      setHomeIsSV(false);
      homeImgKeyRef.current = null;
    }
    if (homeImgAttemptedRef.current && homeImgAttemptedRef.current !== key) {
      homeImgAttemptedRef.current = null;
      setHomeImgErr("");
      setHomeImgTried(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, leadGeo.lat, leadGeo.lng]);

  // Auto-load the home photo as soon as we have an address/geo — once per target
  // (debounced so typing an address doesn't fire on every keystroke).
  useEffect(() => {
    const { addr, latNum, lngNum, key } = homeKey();
    if (!addr && (latNum == null || lngNum == null)) return;
    if (homeImgAttemptedRef.current === key) return; // already tried this target
    const t = setTimeout(() => { void loadHomeImagery(); }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, leadGeo.lat, leadGeo.lng]);

  // Open the show; the auto-loader usually has the photo already, but pull it
  // best-effort if we haven't tried this address yet.
  const presentShow = async () => {
    const { addr, latNum, lngNum, key } = homeKey();
    const haveTarget = !!addr || (latNum != null && lngNum != null);
    if (!homeImg && haveTarget && !homeImgLoading && homeImgAttemptedRef.current !== key) {
      try { await loadHomeImagery(); } catch { /* best-effort — open regardless */ }
    }
    setShowOpen(true);
  };

  // Email the interactive proposal to the homeowner: persist it server-side and
  // send a link to the no-login viewer (same data the "Present" overlay uses).
  const [propEmailing, setPropEmailing] = useState(false);
  const [propEmailMsg, setPropEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // The proposal payload the homeowner viewer renders — the SAME shape whether
  // it's emailed or saved, so both open the identical single-battery proposal.
  const buildProposalPayload = () => {
    if (!system) return null;
    return {
      customerName: customerName || undefined,
      address: address || undefined,
      companyName: company?.name,
      monthlyBill: bill.monthlyCost,
      monthlyKWh: bill.monthlyKWh,
      recommendation: {
        brand: system.product.brand,
        model: system.product.model,
        units: system.units,
        totalUsableKWh: system.totalUsableKWh,
        backupDaysAchieved: system.backupDaysAchieved,
      },
      roi: roi
        ? {
            grossCost: roi.grossCost,
            incentives: roi.incentives,
            netCost: roi.netCost,
            monthlySavings: roi.monthlySavings,
            lifetimeSavings: roi.lifetimeSavings,
          }
        : null,
      incentives: appliedIncentives.length ? appliedIncentives : incReport?.incentives ?? [],
      hasEv,
      hasExistingSolar: solar.hasSolar,
      options: chosenProposalOptions,
      chosenProductId: system.product.id,
      depositUsd,
      sungageApplyUrl: company?.sungageApplyUrl,
      financeOptions: resolveFinanceOptions(company),
      // homeImage intentionally omitted — too large to persist; the viewer
      // uses the photoreal scene.
    };
  };

  const emailProposal = async () => {
    if (!system || !homeownerEmail) return;
    setPropEmailing(true);
    setPropEmailMsg(null);
    try {
      const payload = buildProposalPayload();
      const { data } = await httpsCallable<{ to: string; payload: unknown; leadId?: string | null }, { ok?: boolean; url?: string; pid?: string }>(
        functions,
        "emailProposalToHomeowner"
      )({ to: homeownerEmail, payload, leadId: leadId || null });
      setPropEmailMsg(
        data?.ok ? { ok: true, text: `Sent to ${homeownerEmail}.` } : { ok: false, text: "Couldn't send the email." }
      );
    } catch (e) {
      setPropEmailMsg({ ok: false, text: (e as Error).message || "Couldn't send the email." });
    } finally {
      setPropEmailing(false);
    }
  };

  const generateSummary = async () => {
    if (!system) return;
    setAiLoading(true);
    setAiError("");
    try {
      const { data } = await httpsCallable<
        {
          customerName: string;
          bill: typeof bill;
          load: LoadResult;
          solar: SolarInput;
          recommendation: RecommendedSystem;
          goal: SizingGoal;
          backupDays: number;
        },
        { summary: string; error?: string }
      >(functions, "batteryProposalSummary")({
        customerName,
        bill,
        load,
        solar,
        recommendation: system,
        goal,
        backupDays: Number(backupDays) || 1,
      });
      if (data.summary) setAiSummary(data.summary);
      else setAiError(data.error || "No summary returned — showing the numbers.");
    } catch (e) {
      setAiError((e as Error).message || "AI summary is unavailable right now.");
    } finally {
      setAiLoading(false);
    }
  };

  const save = async () => {
    if (!profile || !companyId || !system) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const visibilityPath = [...new Set([profile.uid, ...(profile.managerPath ?? []), ...(profile.closerManagerPath ?? [])])];
      await addDoc(
        collection(db, "proposals"),
        clean({
          companyId,
          closerUid: profile.uid,
          closerName: profile.displayName || profile.email || "",
          visibilityPath,
          customerName,
          address: address || null,
          leadId: leadId || null,
          eventId: eventId || null,
          bill,
          solar,
          load,
          goal,
          backupDays: Number(backupDays) || 1,
          recommendation: {
            productId: system.product.id,
            brand: system.product.brand,
            model: system.product.model,
            units: system.units,
            totalUsableKWh: system.totalUsableKWh,
            totalContinuousKW: system.totalContinuousKW,
            totalPeakKW: system.totalPeakKW,
            backupDaysAchieved: system.backupDaysAchieved,
          },
          aiSummary: aiSummary || null,
          pricing: { pricePerUnit: Number(pricePerUnit) || 0, installAdder: Number(installAdder) || 0 },
          incentives: appliedIncentives,
          incentivesUtility: incReport?.utility || null,
          roi: roi
            ? {
                grossCost: roi.grossCost,
                incentives: roi.incentives,
                netCost: roi.netCost,
                monthlySavings: roi.monthlySavings,
                lifetimeSavings: roi.lifetimeSavings,
              }
            : null,
          createdAt: Date.now(),
        })
      );
      // Also store a reopenable proposal record and drop it into the homeowner's
      // history (same as the email path), so a saved proposal can be pulled back
      // up from the customer page for a follow-up or sale. Best-effort.
      if (leadId) {
        const payload = buildProposalPayload();
        if (payload) {
          await httpsCallable<{ payload: unknown; leadId?: string | null }, { pid?: string }>(
            functions,
            "saveProposalRecord"
          )({ payload, leadId }).catch(() => {});
        }
      }
      setSaved(true);
    } catch (e) {
      setSaveError((e as Error).message || "Couldn't save the proposal. Try again.");
    } finally {
      setSaving(false);
    }
  };

  // My proposals
  const [myProposals, setMyProposals] = useState<SavedProposal[]>([]);
  useEffect(() => {
    if (!profile) return;
    // Single-field equality query → no composite index needed; sort client-side.
    return onSnapshot(
      query(collection(db, "proposals"), where("closerUid", "==", profile.uid)),
      (snap) =>
        setMyProposals(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<SavedProposal, "id">) }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        ),
      (e) => console.error("my proposals", e)
    );
  }, [profile]);

  // Repopulate the form from a saved proposal (best-effort).
  const loadProposal = (p: SavedProposal) => {
    setCustomerName(p.customerName || "");
    setAddress(p.address || "");
    setLeadId(p.leadId || null);
    setEventId(p.eventId || null);
    if (p.bill) {
      setMonthlyKWh(String(p.bill.monthlyKWh ?? ""));
      setMonthlyCost(String(p.bill.monthlyCost ?? ""));
      setRatePerKWh(String(p.bill.ratePerKWh ?? ""));
    }
    if (p.solar) {
      setHasSolar(!!p.solar.hasSolar);
      setSystemKwDc(p.solar.systemKwDc != null ? String(p.solar.systemKwDc) : "");
      setAnnualProductionKWh(p.solar.annualProductionKWh != null ? String(p.solar.annualProductionKWh) : "");
    }
    if (p.goal) setGoal(p.goal);
    if (p.backupDays != null) setBackupDays(String(p.backupDays));
    if (p.recommendation?.productId) {
      // Tell the product-change effect to preserve the override we set below.
      restoreUnitsForProduct.current = p.recommendation.productId;
      setChosenId(p.recommendation.productId);
      // Restore the rep's chosen quantity (shows as an override if it differs
      // from the auto recommendation — that's fine).
      setUnitsOverride(p.recommendation.units ?? null);
      // Force the pricing seeder to re-run for the restored override values below.
      seededProductId.current = p.recommendation.productId;
    }
    if (p.pricing) {
      setPricePerUnit(String(p.pricing.pricePerUnit ?? 0));
      setInstallAdder(String(p.pricing.installAdder ?? 0));
    }
    if (p.incentives && p.incentives.length) {
      setIncReport({
        location: p.address || "",
        utility: p.incentivesUtility ?? null,
        incentives: p.incentives,
        sources: [],
        usedWeb: false,
        generatedAt: p.createdAt || Date.now(),
        cacheId: "",
        cached: true,
      });
      setAppliedKeys(new Set(p.incentives.map((i, idx) => `${i.name || "incentive"}#${idx}`)));
    } else {
      setIncReport(null);
      setAppliedKeys(new Set());
    }
    setAiSummary(p.aiSummary || "");
    setSaved(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="page-body bt-root">
      <style>{BT_STYLES}</style>
      <div className="bt-hero">
        <div className="bt-eyebrow">· Energy storage studio</div>
        <h1 className="bt-title">Battery Tool</h1>
        <p className="bt-sub">Analyze the bill, size the load, and craft a premium battery proposal.</p>
        <button className="btn ghost" style={{ marginTop: 14 }} onClick={() => setPlaybookOpen(true)}>
          📖 Field Playbook
        </button>
      </div>

      {/* 1. Customer */}
      <div className="card bt-panel" style={{ marginBottom: 18 }}>
        <div className="bt-kicker">· 01 — Who</div>
        <h2 className="section-h bt-section-h" style={{ marginTop: 0 }}>Customer</h2>
        <label className="field" style={{ position: "relative" }}>
          <span>Find a customer <span className="muted small">(search your leads by name or address)</span></span>
          <input
            value={custQuery}
            placeholder="Start typing a name or address…"
            onChange={(e) => onCustQuery(e.target.value)}
            onFocus={() => { void ensureLeads(); if (custResults.length) setCustOpen(true); }}
            onBlur={() => setTimeout(() => setCustOpen(false), 150)}
          />
          {custOpen && custResults.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "var(--card, #150f1f)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, marginTop: 4, maxHeight: 260, overflowY: "auto", boxShadow: "0 12px 32px rgba(0,0,0,0.45)" }}>
              {custResults.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="row"
                  style={{ width: "100%", textAlign: "left", padding: "9px 12px", background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", display: "block" }}
                  onMouseDown={(e) => { e.preventDefault(); pickCustomer(h); }}
                >
                  <div style={{ fontWeight: 600 }}>{h.ownerName || "(no name)"}</div>
                  <div className="muted small">{h.address || "no address"}</div>
                </button>
              ))}
            </div>
          )}
        </label>
        <label className="field">
          <span>Customer name</span>
          <input value={customerName} placeholder="Full name" onChange={(e) => setCustomerName(e.target.value)} />
        </label>
        <label className="field">
          <span>Address <span className="muted small">(optional)</span></span>
          <input value={address} placeholder="123 Main St" onChange={(e) => setAddress(e.target.value)} />
        </label>
        {leadId && <div className="muted small">Linked to lead {leadId}</div>}
        {eventId && <div className="muted small">Linked to appointment {eventId}</div>}

        {/* Real photo of the home — used as the hero in the interactive proposal. */}
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
          <button
            className="btn ghost sm"
            onClick={loadHomeImagery}
            disabled={homeImgLoading || (!address.trim() && (leadGeo.lat == null || leadGeo.lng == null))}
          >
            {homeImgLoading ? "🏠 Loading…" : homeImg ? "🏠 Refresh home photo" : "🏠 Add home photo"}
          </button>
          {homeImg && (
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <img
                src={homeImg}
                alt="Customer's home"
                style={{ width: 72, height: 54, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,0.14)" }}
              />
              <span className="muted small">{homeIsSV ? "Street View" : "Satellite"}</span>
            </div>
          )}
        </div>
        {/* Tell the rep why the real photo isn't showing instead of failing
            silently — the proposal still works with the stylized scene. */}
        {homeImgTried && !homeImg && !homeImgLoading && (
          <p className="muted small" style={{ color: "#f59e0b", marginTop: 8 }}>
            🏠 No home photo available for this address — the proposal will use the stylized scene.{" "}
            A Google Cloud admin needs to enable the <strong>Street View Static</strong> + <strong>Maps Static</strong> APIs on the project.
          </p>
        )}
        {homeImgErr && <p className="muted small" style={{ color: "#94a3b8", marginTop: 4 }}>{homeImgErr}</p>}
      </div>

      {/* 2. Bill analyzer */}
      <div className="card bt-panel" style={{ marginBottom: 18 }}>
        <div className="bt-kicker">· 02 — Usage</div>
        <h2 className="section-h bt-section-h" style={{ marginTop: 0 }}>Bill analyzer</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Enter any two — we'll derive the rest.</p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <label className="btn ghost sm" style={{ cursor: "pointer", margin: 0 }}>
            {docLoading === "bill" ? "📄 Analyzing…" : "📄 Upload bill photo/PDF to auto-fill"}
            <input
              type="file"
              accept="image/*,application/pdf"
              style={{ display: "none" }}
              disabled={docLoading === "bill"}
              onChange={(e) => analyzeDocument(e, "bill")}
            />
          </label>
        </div>
        {docError.bill && <p className="muted small" style={{ color: "#ef4444", marginTop: 0 }}>{docError.bill}</p>}
        {docNote.bill && <p className="muted small" style={{ marginTop: 0 }}>{docNote.bill}</p>}
        <div className="grid-2">
          <label className="field">
            <span>Monthly usage (kWh)</span>
            <input type="number" inputMode="decimal" value={monthlyKWh} placeholder="900" onChange={(e) => setMonthlyKWh(e.target.value)} />
          </label>
          <label className="field">
            <span>Monthly bill ($)</span>
            <input type="number" inputMode="decimal" value={monthlyCost} placeholder="153" onChange={(e) => setMonthlyCost(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Rate ($/kWh)</span>
          <input type="number" inputMode="decimal" value={ratePerKWh} placeholder="0.17" onChange={(e) => setRatePerKWh(e.target.value)} />
        </label>
        <div className="stat-grid" style={{ marginTop: 8 }}>
          <div className="stat-card"><div className="stat-value">{bill.dailyKWh}</div><div className="stat-label">kWh / day</div></div>
          <div className="stat-card"><div className="stat-value">{bill.monthlyKWh}</div><div className="stat-label">kWh / mo</div></div>
          <div className="stat-card"><div className="stat-value">${bill.ratePerKWh}</div><div className="stat-label">$ / kWh</div></div>
          <div className="stat-card"><div className="stat-value">${Math.round(bill.annualCost).toLocaleString()}</div><div className="stat-label">Annual cost</div></div>
        </div>
        {bill.source !== "complete" && (
          <div className="muted small" style={{ marginTop: 8 }}>
            {bill.source === "derived" ? "Derived from the values entered." : "Estimated from US averages — enter two values for accuracy."}
          </div>
        )}
      </div>

      {/* 3. Existing solar */}
      <div className="card bt-panel" style={{ marginBottom: 18 }}>
        <div className="bt-kicker">· 03 — Solar</div>
        <h2 className="section-h bt-section-h" style={{ marginTop: 0 }}>Existing solar</h2>
        <label className="row" style={{ gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={hasSolar} onChange={(e) => setHasSolar(e.target.checked)} />
          <span>Homeowner already has solar</span>
        </label>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
          <label className="btn ghost sm" style={{ cursor: "pointer", margin: 0 }}>
            {docLoading === "solar" ? "📄 Analyzing…" : "📄 Upload solar app screenshot/PDF"}
            <input
              type="file"
              accept="image/*,application/pdf"
              style={{ display: "none" }}
              disabled={docLoading === "solar"}
              onChange={(e) => analyzeDocument(e, "solar")}
            />
          </label>
        </div>
        {docError.solar && <p className="muted small" style={{ color: "#ef4444", marginTop: 8 }}>{docError.solar}</p>}
        {docNote.solar && <p className="muted small" style={{ marginTop: 8 }}>{docNote.solar}</p>}
        {hasSolar && (
          <>
            <div className="grid-2" style={{ marginTop: 10 }}>
              <label className="field">
                <span>System size (kW DC)</span>
                <input type="number" inputMode="decimal" value={systemKwDc} placeholder="7.5" onChange={(e) => setSystemKwDc(e.target.value)} />
              </label>
              <label className="field">
                <span>Annual production (kWh) <span className="muted small">from their monitoring app, if available</span></span>
                <input type="number" inputMode="decimal" value={annualProductionKWh} placeholder="11000" onChange={(e) => setAnnualProductionKWh(e.target.value)} />
              </label>
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>≈ {solarDaily} kWh/day</div>
            <div className="muted small" style={{ marginTop: 4 }}>
              Live monitoring-app sync (Enphase/SolarEdge/Tesla) is coming — enter from their app for now.
            </div>
          </>
        )}
      </div>

      {/* 4. Load calculator */}
      <div className="card bt-panel" style={{ marginBottom: 18 }}>
        <div className="bt-kicker">· 04 — Loads</div>
        <h2 className="section-h bt-section-h" style={{ marginTop: 0 }}>Load calculator</h2>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <button className={"btn sm" + (mode === "essentials" ? " primary" : " ghost")} onClick={() => applyMode("essentials")}>Essentials backup</button>
          <button className={"btn sm" + (mode === "whole" ? " primary" : " ghost")} onClick={() => applyMode("whole")}>Whole home</button>
        </div>

        {[...categories.entries()].map(([cat, arr]) => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div className="field-label">{cat as LoadCategory}</div>
            <div className="lb-list">
              {arr.map((a) => {
                const q = qtyOf(a.id);
                return (
                  <div key={a.id} className="lb-row card" style={{ alignItems: "center" }}>
                    <div className="lb-row-main">
                      <div className="lb-row-name">{a.name}</div>
                      <div className="muted small">{a.runningW.toLocaleString()} W run · {a.startingW.toLocaleString()} W surge</div>
                    </div>
                    <div className="row" style={{ gap: 6, alignItems: "center" }}>
                      <button className="btn ghost sm" onClick={() => setQty(a.id, Math.max(0, q - 1))}>−</button>
                      <span style={{ minWidth: 18, textAlign: "center" }}>{q}</span>
                      <button className="btn ghost sm" onClick={() => setQty(a.id, q + 1)}>+</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="stat-grid bt-stat-grid" style={{ marginTop: 8 }}>
          <div className="stat-card bt-stat-card bt-stat--gold"><div className="stat-value">{load.dailyKWh}</div><div className="stat-label">Daily energy</div><div className="muted small">kWh</div></div>
          <div className="stat-card bt-stat-card bt-stat--accent"><div className="stat-value">{load.continuousKW}</div><div className="stat-label">Continuous</div><div className="muted small">kW</div></div>
          <div className="stat-card bt-stat-card bt-stat--green"><div className="stat-value">{load.peakKW}</div><div className="stat-label">Surge</div><div className="muted small">kW</div></div>
        </div>
      </div>

      {/* 5. Goal & backup */}
      <div className="card bt-panel" style={{ marginBottom: 18 }}>
        <div className="bt-kicker">· 05 — Intent</div>
        <h2 className="section-h bt-section-h" style={{ marginTop: 0 }}>Goal &amp; backup</h2>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          {(["backup", "savings", "both"] as SizingGoal[]).map((g) => (
            <button key={g} className={"btn sm" + (goal === g ? " primary" : " ghost")} onClick={() => setGoal(g)}>
              {g === "backup" ? "Backup" : g === "savings" ? "Savings" : "Both"}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Days of backup</span>
          <input type="number" inputMode="decimal" value={backupDays} onChange={(e) => setBackupDays(e.target.value)} />
        </label>
        <label className="row" style={{ gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={preferLFP} onChange={(e) => setPreferLFP(e.target.checked)} />
          <span>Prefer LFP chemistry</span>
        </label>
      </div>

      {/* 6. Recommendation */}
      <div className="card bt-panel" style={{ marginBottom: 18 }}>
        <div className="bt-kicker">· 06 — System</div>
        <h2 className="section-h bt-section-h" style={{ marginTop: 0 }}>Recommendation</h2>
        {!system ? (
          <div className="empty">Add some loads to size a system.</div>
        ) : (
          <>
            <div
              className="card bt-hero-card"
              style={{ border: `1px solid ${FIT_COLOR[system.fit]}`, marginBottom: 12, "--bt-fit": FIT_COLOR[system.fit] } as React.CSSProperties}
            >
              <div className="lb-row-top" style={{ marginBottom: 8 }}>
                <span className="lb-row-name" style={{ fontSize: 18 }}>
                  {system.units}× {system.product.brand} {system.product.model}
                </span>
                <span className="badge" style={{ background: FIT_COLOR[system.fit], color: "#06121f", fontWeight: 700 }}>
                  {FIT_LABEL[system.fit]}
                </span>
              </div>

              {/* Quantity stepper — rep can tune the number of batteries. */}
              <div className="row bt-stepper-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <span className="muted small bt-mono-label">Batteries</span>
                <div className="bt-stepper">
                  <button
                    className="btn ghost sm bt-step-btn"
                    disabled={system.units <= 1}
                    onClick={() => setUnitsOverride(Math.max(1, system.units - 1))}
                  >
                    −
                  </button>
                  <span className="bt-step-val" style={{ minWidth: 24, textAlign: "center", fontWeight: 700 }}>{system.units}</span>
                  <button
                    className="btn ghost sm bt-step-btn"
                    disabled={system.units >= system.product.maxUnits}
                    onClick={() => setUnitsOverride(Math.min(system.product.maxUnits, system.units + 1))}
                  >
                    +
                  </button>
                </div>
                {unitsOverride != null && chosen && unitsOverride !== chosen.units ? (
                  <span className="muted small">
                    Recommended: {chosen.units} ·{" "}
                    <button className="btn ghost sm" onClick={() => setUnitsOverride(null)}>Reset</button>
                  </span>
                ) : (
                  <span className="muted small">Recommended</span>
                )}
              </div>

              <div className="stat-grid bt-stat-grid bt-hero-stats" style={{ marginBottom: 8 }}>
                <div className="stat-card bt-stat-card bt-stat--accent"><div className="stat-value">{system.totalUsableKWh}</div><div className="stat-label">Usable kWh</div></div>
                <div className="stat-card bt-stat-card bt-stat--accent"><div className="stat-value">{system.totalContinuousKW}</div><div className="stat-label">Continuous kW</div></div>
                <div className="stat-card bt-stat-card bt-stat--accent"><div className="stat-value">{system.totalPeakKW}</div><div className="stat-label">Surge kW</div></div>
                <div className="stat-card bt-stat-card bt-stat--green"><div className="stat-value">{system.backupDaysAchieved}</div><div className="stat-label">Backup days</div></div>
              </div>
              <div className="muted small">
                {system.product.chemistry} · {system.product.warrantyYears}-yr warranty
                {system.product.acCoupled ? " · AC-coupled" : ""}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <span className="badge" style={{ background: system.meetsContinuous ? "#34d399" : "#ef4444", color: "#06121f", fontWeight: 700 }}>
                  {system.meetsContinuous ? "✓" : "✗"} Meets continuous power
                </span>
                <span className="badge" style={{ background: system.meetsSurge ? "#34d399" : "#ef4444", color: "#06121f", fontWeight: 700 }}>
                  {system.meetsSurge ? "✓" : "✗"} Meets surge
                </span>
              </div>
              {system.product.notes && <div className="muted small" style={{ marginTop: 8 }}>{system.product.notes}</div>}
            </div>

            {recs.length > 1 && (
              <>
                <div className="field-label bt-field-label">Alternatives</div>
                <div className="lb-list bt-alts">
                  {recs.slice(1, 5).map((r) => (
                    <div
                      key={r.product.id}
                      className={"lb-row card bt-alt" + (r.product.id === chosenId ? " bt-alt--active" : "")}
                      style={{ alignItems: "center", cursor: "pointer", ...(r.product.id === chosenId ? { borderColor: FIT_COLOR[r.fit] } : {}) }}
                      onClick={() => setChosenId(r.product.id)}
                    >
                      <div className="lb-row-main">
                        <div className="lb-row-top">
                          <span className="lb-row-name">{r.units}× {r.product.brand} {r.product.model}</span>
                          <span className="badge" style={{ background: FIT_COLOR[r.fit], color: "#06121f", fontWeight: 700 }}>
                            {FIT_LABEL[r.fit]}
                          </span>
                        </div>
                        <div className="muted small">
                          {r.totalUsableKWh} kWh · {r.totalContinuousKW} kW cont · {r.backupDaysAchieved} day backup · {r.product.chemistry}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Pricing for the chosen system (per-proposal override). */}
            <div className="field-label" style={{ marginTop: 14 }}>Pricing</div>
            <div className="grid-2">
              <label className="field">
                <span>Price per unit $</span>
                <input type="number" inputMode="decimal" value={pricePerUnit} placeholder="0" onChange={(e) => setPricePerUnit(e.target.value)} />
              </label>
              <label className="field">
                <span>Install adder $</span>
                <input type="number" inputMode="decimal" value={installAdder} placeholder="0" onChange={(e) => setInstallAdder(e.target.value)} />
              </label>
            </div>
            <div className="muted small">
              {system.units}× {money(Number(pricePerUnit) || 0)} + {money(Number(installAdder) || 0)} install
              {company?.batteryPricing?.[system.product.id] ? " · seeded from company pricing" : ""}
            </div>

            {/* Admin-only company catalog pricing. */}
            {role === "admin" && (
              <div className="card" style={{ marginTop: 14 }}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <span className="lb-row-name">Company battery pricing (admin)</span>
                  <button className="btn ghost sm" onClick={() => setShowPricingAdmin((v) => !v)}>
                    {showPricingAdmin ? "Hide" : "Edit"}
                  </button>
                </div>
                {showPricingAdmin && (
                  <>
                    <div className="lb-list" style={{ marginTop: 10 }}>
                      {BATTERIES.map((b) => {
                        const d = pricingDraft[b.id] || { price: "", adder: "" };
                        return (
                          <div key={b.id} className="lb-row card" style={{ alignItems: "center" }}>
                            <div className="lb-row-main">
                              <div className="lb-row-name">{b.brand} {b.model}</div>
                              <div className="muted small">{b.usableKWh} kWh · {b.chemistry}</div>
                            </div>
                            <div className="grid-2" style={{ gap: 8 }}>
                              <label className="field" style={{ marginBottom: 0 }}>
                                <span>Price $</span>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  value={d.price}
                                  placeholder="0"
                                  onChange={(e) =>
                                    setPricingDraft((cur) => ({ ...cur, [b.id]: { ...cur[b.id], price: e.target.value } }))
                                  }
                                />
                              </label>
                              <label className="field" style={{ marginBottom: 0 }}>
                                <span>Adder $</span>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  value={d.adder}
                                  placeholder="0"
                                  onChange={(e) =>
                                    setPricingDraft((cur) => ({ ...cur, [b.id]: { ...cur[b.id], adder: e.target.value } }))
                                  }
                                />
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
                      <button className="btn primary sm" onClick={saveCompanyPricing} disabled={pricingSaving}>
                        {pricingSaving ? "Saving…" : "Save pricing"}
                      </button>
                      {pricingSaved && <span className="muted small" style={{ color: "#34d399" }}>✅ Saved.</span>}
                      {pricingError && <span className="muted small" style={{ color: "#ef4444" }}>{pricingError}</span>}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Admin-only proposal financing plans. */}
            {role === "admin" && (
              <div className="card" style={{ marginTop: 14 }}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <span className="lb-row-name">Financing plans (admin)</span>
                  <button className="btn ghost sm" onClick={() => setShowFinanceAdmin((v) => !v)}>
                    {showFinanceAdmin ? "Hide" : "Edit"}
                  </button>
                </div>
                {showFinanceAdmin && (
                  <>
                    <p className="muted small" style={{ marginTop: 8 }}>
                      Set the lender, rate, term, and dealer fee for each plan. Toggle a plan off to hide it on the proposal. These drive the proposal's payment estimate.
                    </p>
                    <div className="lb-list" style={{ marginTop: 10 }}>
                      {financeDraft.map((o, i) => (
                        <div key={i} className="lb-row card" style={{ display: "block" }}>
                          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <label className="day-chip">
                              <input type="checkbox" checked={o.enabled !== false} onChange={(e) => updateFin(i, { enabled: e.target.checked })} />
                              {o.enabled !== false ? " Shown on proposal" : " Hidden"}
                            </label>
                            <button className="btn ghost sm danger" onClick={() => removeFin(i)}>Remove</button>
                          </div>
                          <div className="grid-2">
                            <label className="field"><span>Plan name</span>
                              <input value={o.name} onChange={(e) => updateFin(i, { name: e.target.value })} /></label>
                            <label className="field"><span>Finance company</span>
                              <input value={o.financeCompany || ""} placeholder="e.g. Sungage" onChange={(e) => updateFin(i, { financeCompany: e.target.value })} /></label>
                            <label className="field"><span>APR %</span>
                              <input type="number" inputMode="decimal" value={+(o.apr * 100).toFixed(2)} onChange={(e) => updateFin(i, { apr: (Number(e.target.value) || 0) / 100 })} /></label>
                            <label className="field"><span>Term (years)</span>
                              <input type="number" inputMode="numeric" value={o.termYears} onChange={(e) => updateFin(i, { termYears: Number(e.target.value) || 0 })} /></label>
                            <label className="field"><span>Dealer fee %</span>
                              <input type="number" inputMode="decimal" value={+(o.dealerFee * 100).toFixed(2)} onChange={(e) => updateFin(i, { dealerFee: (Number(e.target.value) || 0) / 100 })} /></label>
                            <label className="field"><span>Plan type</span>
                              <select value={o.kind} onChange={(e) => updateFin(i, { kind: e.target.value as FinanceOption["kind"] })}>
                                <option value="level">Level payment</option>
                                <option value="escalator">Escalator (steps up)</option>
                                <option value="deferred">Deferred start</option>
                              </select></label>
                            {o.kind === "escalator" && (
                              <label className="field"><span>Yearly step-up %</span>
                                <input type="number" inputMode="decimal" value={+((o.escalator || 0) * 100).toFixed(2)} onChange={(e) => updateFin(i, { escalator: (Number(e.target.value) || 0) / 100 })} /></label>
                            )}
                            {o.kind === "deferred" && (
                              <>
                                <label className="field"><span>Defer months</span>
                                  <input type="number" inputMode="numeric" value={o.deferMonths || 0} onChange={(e) => updateFin(i, { deferMonths: Number(e.target.value) || 0 })} /></label>
                                <label className="field"><span>Deferred %</span>
                                  <input type="number" inputMode="decimal" value={+((o.deferPct || 0) * 100).toFixed(2)} onChange={(e) => updateFin(i, { deferPct: (Number(e.target.value) || 0) / 100 })} /></label>
                              </>
                            )}
                          </div>
                          <label className="field"><span>Short description (shown on the proposal)</span>
                            <input value={o.blurb || ""} onChange={(e) => updateFin(i, { blurb: e.target.value })} /></label>
                          <label className="field"><span>Apply link (where the homeowner applies)</span>
                            <input value={o.applyUrl || ""} placeholder="https://…" onChange={(e) => updateFin(i, { applyUrl: e.target.value })} /></label>
                        </div>
                      ))}
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <button className="btn ghost sm" onClick={addFin}>+ Add finance company</button>
                      <button className="btn primary sm" onClick={saveFinance} disabled={financeSaving}>
                        {financeSaving ? "Saving…" : "Save financing"}
                      </button>
                      {financeSaved && <span className="muted small" style={{ color: "#34d399" }}>✅ Saved.</span>}
                      {financeError && <span className="muted small" style={{ color: "#ef4444" }}>{financeError}</span>}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Local & utility incentives */}
      <div className="card bt-panel" style={{ marginBottom: 18 }}>
        <div className="bt-kicker">· 07 — Incentives</div>
        <h2 className="section-h bt-section-h" style={{ marginTop: 0 }}>⚡ Local &amp; utility incentives</h2>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary sm" onClick={findIncentives} disabled={incLoading}>
            {incLoading ? "Searching…" : "Find incentives for this address"}
          </button>
        </div>
        {incError && <p className="muted small" style={{ color: "#f59e0b", marginTop: 10 }}>{incError}</p>}

        {incReport && (
          <>
            {incReport.utility && (
              <div className="muted small" style={{ marginTop: 10 }}>
                Utility: <strong>{incReport.utility.name}</strong>
                {incReport.utility.rate != null ? ` · $${incReport.utility.rate}/kWh residential` : ""}
              </div>
            )}

            {incReport.incentives.length === 0 ? (
              <div className="empty" style={{ marginTop: 10 }}>No incentives found for this area.</div>
            ) : (
              <div className="lb-list" style={{ marginTop: 10 }}>
                {incReport.incentives.map((i, idx) => {
                  const key = incKey(i, idx);
                  return (
                    <div key={key} className="lb-row card">
                      <div className="lb-row-main">
                        <div className="lb-row-top">
                          <span className="lb-row-name">{i.name}</span>
                          {typeof i.estValueUsd === "number" && (
                            <span className="badge" style={{ background: "#34d399", color: "#06121f", fontWeight: 700 }}>
                              {money(i.estValueUsd)}
                            </span>
                          )}
                        </div>
                        <div className="muted small">
                          {[i.administrator, i.type].filter(Boolean).join(" · ")}
                          {(i.administrator || i.type) ? " · " : ""}
                          {i.amount || ""}{i.amount ? " · " : ""}{incentiveDates(i)}
                        </div>
                        {i.summary && <div className="muted small" style={{ marginTop: 4 }}>{i.summary}</div>}
                        <div className="row" style={{ gap: 12, alignItems: "center", marginTop: 6 }}>
                          <label className="row" style={{ gap: 6, alignItems: "center" }}>
                            <input
                              type="checkbox"
                              checked={appliedKeys.has(key)}
                              onChange={() => toggleApplied(key)}
                            />
                            <span className="small">Apply to net cost</span>
                          </label>
                          {i.url && (
                            <a className="small" href={i.url} target="_blank" rel="noreferrer">Verify source ↗</a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="muted small" style={{ marginTop: 10 }}>
              {incReport.usedWeb
                ? "Researched live from official sources — verify each at its link."
                : "From AI knowledge — verify each at its link."}
            </div>

            <div className="field-label" style={{ marginTop: 14 }}>Email to homeowner</div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="field" style={{ marginBottom: 0, flex: "1 1 220px" }}>
                <span>Homeowner email</span>
                <input type="email" value={homeownerEmail} placeholder="homeowner@email.com" onChange={(e) => setHomeownerEmail(e.target.value)} />
              </label>
              <button className="btn primary sm" onClick={emailIncentives} disabled={emailSending || !homeownerEmail}>
                {emailSending ? "Sending…" : "✉️ Email incentives to homeowner"}
              </button>
            </div>
            {emailSent && <p className="muted small" style={{ color: "#34d399" }}>✅ Email sent.</p>}
            {emailError && <p className="muted small" style={{ color: "#ef4444" }}>{emailError}</p>}
          </>
        )}
      </div>

      {/* 7. Proposal */}
      <div className="card bt-panel bt-proposal" style={{ marginBottom: 18 }}>
        <div className="bt-kicker">· 08 — Proposal</div>
        <h2 className="section-h bt-section-h" style={{ marginTop: 0 }}>Proposal</h2>
        {system ? (
          <>
            <div className="muted small" style={{ marginBottom: 10 }}>
              {customerName || "Customer"}{address ? ` · ${address}` : ""} — {system.units}× {system.product.brand} {system.product.model}
              {" · "}{system.totalUsableKWh} kWh usable · {bill.dailyKWh} kWh/day usage
              {solar.hasSolar ? ` · ${solarDaily} kWh/day solar` : ""}
            </div>

            {roi && (
              <>
                <div className="field-label bt-field-label">Return on investment</div>
                <div className="stat-grid bt-stat-grid bt-roi-grid" style={{ marginBottom: 8 }}>
                  <div className="stat-card bt-stat-card"><div className="stat-value">{money(roi.grossCost)}</div><div className="stat-label">Gross system cost</div></div>
                  <div className="stat-card bt-stat-card bt-stat--green"><div className="stat-value" style={{ color: "#34d399" }}>− {money(roi.incentives)}</div><div className="stat-label">Incentives applied</div></div>
                  <div className="stat-card bt-stat-card bt-stat--accent"><div className="stat-value">{money(roi.netCost)}</div><div className="stat-label">Net cost</div></div>
                  <div className="stat-card bt-stat-card bt-stat--gold"><div className="stat-value">{money(roi.monthlySavings)}</div><div className="stat-label">Est. monthly savings</div></div>
                  <div className="stat-card bt-stat-card bt-stat--gold"><div className="stat-value">{money(roi.lifetimeSavings)}</div><div className="stat-label">Lifetime savings ({roi.warrantyYears} yr)</div></div>
                </div>
              </>
            )}

            <button
              className="btn primary block bt-present"
              style={{ marginBottom: 12 }}
              onClick={presentShow}
            >
              {homeImgLoading ? "🎬 Loading home photo…" : "🎬 Present interactive proposal"}
            </button>

            {/* Email the interactive proposal to the homeowner (link to no-login viewer). */}
            <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                type="email"
                value={homeownerEmail}
                placeholder="homeowner@email.com"
                onChange={(e) => setHomeownerEmail(e.target.value)}
                style={{ flex: "1 1 200px", minWidth: 0 }}
              />
              <button className="btn primary sm" onClick={emailProposal} disabled={propEmailing || !homeownerEmail}>
                {propEmailing ? "Emailing…" : "📧 Email proposal to homeowner"}
              </button>
            </div>
            {propEmailMsg && (
              <p className="muted small" style={{ color: propEmailMsg.ok ? "#34d399" : "#ef4444", marginTop: 0 }}>
                {propEmailMsg.ok ? "✅ " : ""}
                {propEmailMsg.text}
              </p>
            )}

            <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <button className="btn primary sm" onClick={generateSummary} disabled={aiLoading}>
                {aiLoading ? "Generating…" : "✨ Generate AI summary"}
              </button>
              <button className="btn primary sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "💾 Save proposal"}
              </button>
              <button className="btn ghost sm" onClick={() => window.print()}>🖨 Print</button>
            </div>

            {aiError && <p className="muted small" style={{ color: "#f59e0b" }}>{aiError}</p>}
            {aiSummary && <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{aiSummary}</p>}
            {saved && <p className="muted small" style={{ color: "#34d399" }}>✅ Proposal saved.</p>}
            {saveError && <p className="muted small" style={{ color: "#ef4444" }}>{saveError}</p>}
          </>
        ) : (
          <div className="empty">Size a system above to build the proposal.</div>
        )}
      </div>

      {/* My proposals */}
      <div className="bt-kicker" style={{ marginTop: 4 }}>· Archive</div>
      <h2 className="section-h bt-section-h">My proposals</h2>
      {myProposals.length === 0 ? (
        <div className="empty">No saved proposals yet. Build one above and hit 💾 Save.</div>
      ) : (
        <div className="lb-list bt-alts">
          {myProposals.map((p) => (
            <div key={p.id} className="lb-row card bt-alt" style={{ alignItems: "center", cursor: "pointer" }} onClick={() => loadProposal(p)}>
              <div className="lb-row-main">
                <div className="lb-row-top">
                  <span className="lb-row-name">{p.customerName || "Customer"}</span>
                  <span className="muted small">{p.createdAt ? fmt(p.createdAt) : ""}</span>
                </div>
                <div className="muted small">
                  {p.recommendation
                    ? `${p.recommendation.units}× ${p.recommendation.brand} ${p.recommendation.model}`
                    : "—"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <SolarProposalShow
        open={showOpen}
        onClose={() => setShowOpen(false)}
        customerName={customerName || undefined}
        address={address || undefined}
        companyName={company?.name}
        monthlyBill={bill.monthlyCost}
        monthlyKWh={bill.monthlyKWh}
        recommendation={
          system
            ? {
                brand: system.product.brand,
                model: system.product.model,
                units: system.units,
                totalUsableKWh: system.totalUsableKWh,
                backupDaysAchieved: system.backupDaysAchieved,
              }
            : null
        }
        roi={
          roi
            ? {
                grossCost: roi.grossCost,
                incentives: roi.incentives,
                netCost: roi.netCost,
                monthlySavings: roi.monthlySavings,
                lifetimeSavings: roi.lifetimeSavings,
              }
            : null
        }
        incentives={appliedIncentives.length ? appliedIncentives : incReport?.incentives ?? []}
        hasEv={hasEv}
        hasExistingSolar={solar.hasSolar}
        homeImage={homeImg || undefined}
        homeImageIsStreetView={homeIsSV}
        options={chosenProposalOptions}
        chosenProductId={system?.product.id}
        depositUsd={depositUsd}
        sungageApplyUrl={company?.sungageApplyUrl}
        financeOptions={resolveFinanceOptions(company)}
        onLetsDoIt={handleLetsDoIt}
      />

      {/* Rep-facing sales playbook — a full-screen overlay (portaled) with the
          grid-down demo, local utility intel, and quick door calculators. */}
      {playbookOpen && (
        <BatteryPlaybook
          companyName={company?.name}
          overrides={company?.batteryPlaybook}
          onClose={() => setPlaybookOpen(false)}
        />
      )}

      {/* In-app agreement signing (rep's device). Portaled so its fixed overlay
          isn't trapped by a blurred ancestor. On success we route to the site
          survey for this deal — all without leaving the native app. */}
      {signOverlay && createPortal(
        <AgreementSignView
          idProp={signOverlay.id}
          tProp={signOverlay.token}
          embedded
          onSigned={() => {
            const pid = signOverlay.id;
            setSignOverlay(null);
            navigate(`/projects?capture=${encodeURIComponent(pid)}`);
          }}
        />,
        document.body
      )}

      {/* Finalize: create the agreement & choose how to sign. */}
      {closeSel && (
        <div
          onClick={() => !closeBusy && setCloseSel(null)}
          style={{ position: "fixed", inset: 0, zIndex: 6000, background: "rgba(6,4,14,0.72)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: "relative", width: "min(460px,96vw)", background: "#150f1f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, padding: "22px 22px 18px", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}
          >
            <button
              onClick={() => !closeBusy && setCloseSel(null)}
              aria-label="Close"
              style={{ position: "absolute", top: 12, right: 12, width: 32, height: 32, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.18)", background: "transparent", color: "#fff", cursor: "pointer" }}
            >
              ✕
            </button>
            <div className="bt-kicker">· Finalize</div>
            <h2 className="section-h" style={{ marginTop: 2 }}>Create the agreement</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              {customerName || "Customer"} · {closeSel.battery ? `${closeSel.battery.units}× ${closeSel.battery.brand} ${closeSel.battery.model}` : ""}
              {" · "}
              {closeSel.method === "finance"
                ? `${closeSel.finance?.name} — ${money(closeSel.finance?.monthly || 0)}/mo`
                : `Cash — ${money(closeSel.cash?.depositUsd || 0)} deposit`}
            </p>
            <label className="field-label bt-field-label" htmlFor="bt-close-email">Customer email (for signing or a copy)</label>
            <input id="bt-close-email" type="email" value={homeownerEmail} placeholder="homeowner@email.com" onChange={(e) => setHomeownerEmail(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn primary" onClick={() => createAgreement("device")} disabled={!!closeBusy}>
                {closeBusy === "device" ? "Opening…" : "✍️ Sign on this device"}
              </button>
              <button className="btn primary" onClick={() => createAgreement("email")} disabled={!!closeBusy || !homeownerEmail}>
                {closeBusy === "email" ? "Sending…" : "✉️ Email to customer"}
              </button>
            </div>
            {closeMsg && (
              <p className="muted small" style={{ color: closeMsg.ok ? "#34d399" : "#ef4444", marginBottom: 0 }}>
                {closeMsg.ok ? "✅ " : ""}{closeMsg.text}
              </p>
            )}
            <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
              On signature the agreement is emailed to everyone, the appointment is closed/won, and it's recorded in the sold-customer list.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
