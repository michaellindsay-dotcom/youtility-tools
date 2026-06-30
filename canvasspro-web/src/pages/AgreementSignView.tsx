import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import SignaturePad from "./SignaturePad";

// Standalone, no-login page the customer lands on to review + sign the battery
// agreement (…/app/?agreement=<id>&t=<token>). On-device signing (rep hands the
// tablet) and emailed-link signing both land here. Rendered outside the auth
// gate — see main.tsx.

const money = (n: number | undefined) =>
  typeof n === "number" && isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—";

type Agreement = {
  customerName?: string;
  address?: string;
  companyName?: string;
  battery?: { brand?: string; model?: string; units?: number; totalUsableKWh?: number };
  payment?: {
    method?: "finance" | "cash";
    systemPrice?: number;
    finance?: { name?: string; monthly?: number; apr?: number; termYears?: number };
    cash?: { depositUsd?: number; balance?: number };
  };
  reference?: string;
  sections?: Array<{ h: string; body: string }>;
  templateUrl?: string;
  status?: string;
  signedName?: string;
};

export default function AgreementSignView() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("agreement") || "";
  const t = params.get("t") || "";
  // "rep" mode = the rep is signing on their own device, so after signing send
  // them straight into the site survey rather than the customer confirmation.
  const isRep = params.get("mode") === "rep";
  const surveyUrl = `${window.location.origin}/app/projects?capture=${encodeURIComponent(id)}`;

  const [state, setState] = useState<"loading" | "ready" | "error" | "done">("loading");
  const [ag, setAg] = useState<Agreement | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await httpsCallable<{ id: string; t: string }, Agreement>(functions, "getBatteryAgreement")({ id, t });
        if (!alive) return;
        setAg(data);
        setName(data.customerName || "");
        setState(data.status === "signed" ? "done" : "ready");
      } catch (e) {
        if (!alive) return;
        setErr((e as Error)?.message || "This agreement link is no longer available.");
        setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, t]);

  const submit = async () => {
    if (!name.trim() || !agree) return;
    setSubmitting(true);
    try {
      await httpsCallable<{ id: string; t: string; name: string; signatureDataUrl?: string }, { ok?: boolean }>(
        functions,
        "signBatteryAgreement"
      )({ id, t, name: name.trim(), signatureDataUrl: sig || undefined });
      // Rep's own device → go straight to the site-survey / AR capture for this
      // deal. (Customers signing from an emailed link just see "all set".)
      if (isRep) {
        window.location.href = surveyUrl;
        return;
      }
      setState("done");
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't record your signature. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (state === "loading") return <Shell><h1 style={h1}>Loading your agreement…</h1></Shell>;
  if (state === "error")
    return (
      <Shell>
        <h1 style={h1}>Agreement unavailable</h1>
        <p style={dim}>{err || "This link may have expired — ask your rep to resend it."}</p>
      </Shell>
    );
  if (state === "done")
    return (
      <Shell>
        <div style={{ fontSize: 46 }}>✅</div>
        <h1 style={h1}>You're all set{ag?.customerName ? `, ${ag.customerName.split(" ")[0]}` : ""}!</h1>
        <p style={dim}>
          Your battery agreement {ag?.reference ? `(ref ${ag.reference}) ` : ""}is signed. A copy has been emailed to you
          {ag?.companyName ? ` and to ${ag.companyName}` : ""}. Your rep will be in touch about scheduling your site survey
          and installation.
        </p>
        {/* Rep continues into the site-survey flow on the same device. Hidden
            for customers signing from an emailed link (they have no app login). */}
        {isRep && (
          <a href={surveyUrl} style={{ ...repBtn }}>
            Continue to site survey →
          </a>
        )}
      </Shell>
    );

  const pay = ag?.payment;
  return (
    <Shell wide>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: "#a78bfa" }}>
        {ag?.companyName || "Battery Agreement"}{ag?.reference ? ` · ${ag.reference}` : ""}
      </div>
      <h1 style={{ ...h1, fontSize: 30 }}>Battery Purchase &amp; Installation Agreement</h1>
      <p style={dim}>
        {ag?.customerName}{ag?.address ? ` · ${ag.address}` : ""}
      </p>

      {/* Deal summary */}
      <div style={card}>
        <Row label="System" value={`${ag?.battery?.units || 1}× ${ag?.battery?.brand || ""} ${ag?.battery?.model || ""}${ag?.battery?.totalUsableKWh ? ` · ${ag.battery.totalUsableKWh} kWh` : ""}`} />
        {pay?.method === "finance" ? (
          <>
            <Row label="Payment" value={`Financed — ${pay.finance?.name || ""}`} />
            <Row label="Est. monthly" value={`${money(pay.finance?.monthly)}/mo`} accent />
            <Row label="Terms" value={`${((pay.finance?.apr || 0) * 100).toFixed(2)}% APR · ${pay.finance?.termYears || 20} yr (estimate, pending lender approval)`} />
          </>
        ) : (
          <>
            <Row label="Total price" value={money(pay?.systemPrice)} />
            <Row label="Deposit today" value={money(pay?.cash?.depositUsd)} accent />
            <Row label="Balance at install" value={money(pay?.cash?.balance)} />
          </>
        )}
      </div>

      {/* Terms */}
      {ag?.templateUrl ? (
        <p style={{ ...dim, marginTop: 16 }}>
          Your installer's agreement:{" "}
          <a href={ag.templateUrl} target="_blank" rel="noreferrer" style={{ color: "#a78bfa" }}>
            open the document ↗
          </a>
          . Review it, then sign below.
        </p>
      ) : (
        <div style={{ marginTop: 16, maxHeight: 280, overflowY: "auto", textAlign: "left", padding: "4px 4px 4px 0" }}>
          {ag?.sections?.map((s, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 14, color: "#fff" }}>{s.h}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "#c8c3b3" }}>{s.body}</div>
            </div>
          ))}
        </div>
      )}

      {/* Sign */}
      <div style={{ marginTop: 18, textAlign: "left" }}>
        <label style={lbl}>Full legal name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your full name"
          style={input}
        />
        <label style={{ ...lbl, marginTop: 14, display: "block" }}>Signature</label>
        <SignaturePad onChange={setSig} />
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14, fontSize: 13, color: "#d8d1ea", lineHeight: 1.4 }}>
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            I have reviewed and agree to the terms of this Agreement, and I consent to sign electronically. I understand
            estimated payment figures are subject to lender approval and a final site survey.
          </span>
        </label>
        {err && <p style={{ color: "#f87171", fontSize: 13, marginTop: 8 }}>{err}</p>}
        <button
          onClick={submit}
          disabled={!name.trim() || !agree || submitting}
          style={{
            ...cta,
            opacity: !name.trim() || !agree || submitting ? 0.5 : 1,
            cursor: !name.trim() || !agree || submitting ? "default" : "pointer",
          }}
        >
          {submitting ? "Signing…" : "Sign & accept"}
        </button>
      </div>
    </Shell>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px dashed rgba(255,255,255,0.1)", fontSize: 14 }}>
      <span style={{ color: "#b6aecb" }}>{label}</span>
      <strong style={{ color: accent ? "#a78bfa" : "#f4f1fb", fontFamily: "'Space Grotesk', sans-serif", textAlign: "right" }}>{value}</strong>
    </div>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflowY: "auto",
        background: "radial-gradient(120% 90% at 50% 0%, #1a1030 0%, #0a0712 60%, #080512 100%)",
        color: "#f4f1fb",
        fontFamily: "'Inter', system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: wide ? "flex-start" : "center",
        textAlign: "center",
        padding: wide ? "40px 18px 60px" : 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 560 }}>{children}</div>
    </div>
  );
}

const h1: React.CSSProperties = { fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, letterSpacing: "-0.02em", margin: "8px 0 6px" };
const dim: React.CSSProperties = { color: "#b6aecb", fontSize: 14, lineHeight: 1.55, margin: 0 };
const card: React.CSSProperties = { marginTop: 16, textAlign: "left", background: "rgba(18,12,30,0.5)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: "8px 16px" };
const lbl: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "#8a8199" };
const input: React.CSSProperties = { width: "100%", marginTop: 6, padding: "11px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(8,5,18,0.6)", color: "#fff", fontSize: 15, fontFamily: "'Space Grotesk', sans-serif" };
const cta: React.CSSProperties = { width: "100%", marginTop: 18, background: "#7c3aed", color: "#fff", border: 0, borderRadius: 12, fontWeight: 700, fontSize: 16, padding: 14, fontFamily: "'Space Grotesk', sans-serif", boxShadow: "0 10px 30px rgba(139,92,246,0.35)" };
const repBtn: React.CSSProperties = { display: "inline-block", marginTop: 22, background: "#7c3aed", color: "#fff", textDecoration: "none", fontWeight: 700, fontSize: 15, padding: "13px 24px", borderRadius: 999, fontFamily: "'Space Grotesk', sans-serif", boxShadow: "0 10px 30px rgba(139,92,246,0.35)" };
