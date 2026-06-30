import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { usePitchRecorder, pitchSupported } from "../lib/pitch";
import type { Pitch } from "../types";

type ChatMsg = { role: "user" | "assistant"; content: string };

interface SuccessPlan {
  summary?: string;
  focusAreas?: string[];
  studyGuide?: string[];
  successionPlan?: string[];
  objectionScripts?: { objection: string; response: string }[];
}

export default function Training() {
  const { profile } = useAuth();
  const { recording, consented, giveConsent, start, stopAndUpload } = usePitchRecorder();

  // ── Certification pitches (this rep's own) ──────────────────────────────
  const [pitches, setPitches] = useState<Pitch[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!profile) return;
    // Single-field equality query → no composite index needed; filter + sort client-side.
    return onSnapshot(
      query(collection(db, "pitches"), where("uid", "==", profile.uid)),
      (snap) => setPitches(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Pitch, "id">) }))
          .filter((p) => p.kind === "certification")
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      ),
      (e) => console.error("my certification pitches", e)
    );
  }, [profile]);

  const latestCert = pitches[0];
  const analyzing = saving || (latestCert && latestCert.status !== "analyzed" && latestCert.status !== "error");

  const onStop = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      await stopAndUpload({
        companyId: profile.companyId,
        uid: profile.uid,
        userName: profile.displayName,
        managerPath: profile.managerPath ?? [],
        kind: "certification",
      });
    } catch (e) {
      console.error("certification upload", e);
    } finally {
      setSaving(false);
    }
  };

  // ── AI homeowner role-play ──────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");

  const sendToHomeowner = async (history: ChatMsg[]) => {
    setChatBusy(true);
    setChatError("");
    try {
      const { data } = await httpsCallable<{ messages: ChatMsg[]; persona?: string }, { reply: string }>(
        functions,
        "aiHomeowner"
      )({ messages: history, persona: "solar" });
      setMessages([...history, { role: "assistant", content: data.reply }]);
    } catch (e) {
      setChatError((e as Error).message || "The AI homeowner is unavailable right now.");
    } finally {
      setChatBusy(false);
    }
  };

  const startRolePlay = () => sendToHomeowner([]);

  const sendMessage = () => {
    const text = draft.trim();
    if (!text || chatBusy) return;
    const next: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    void sendToHomeowner(next);
  };

  const resetChat = () => {
    setMessages([]);
    setDraft("");
    setChatError("");
  };

  // ── Success plan ────────────────────────────────────────────────────────
  const [plan, setPlan] = useState<SuccessPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");

  const generatePlan = async () => {
    setPlanLoading(true);
    setPlanError("");
    try {
      const { data } = await httpsCallable<{ repUid?: string }, { plan: SuccessPlan }>(
        functions,
        "getSuccessPlan"
      )({});
      setPlan(data.plan || {});
    } catch (e) {
      setPlanError((e as Error).message || "Couldn't generate your plan.");
    } finally {
      setPlanLoading(false);
    }
  };

  const certified = !!profile?.pitchCertified;
  const certScore = profile?.pitchCertScore;

  const bubbleStyle = useMemo(
    () => ({
      maxWidth: "80%",
      padding: "8px 12px",
      borderRadius: 12,
      lineHeight: 1.4,
      whiteSpace: "pre-wrap" as const,
    }),
    []
  );

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>🎓 Training</h1>
        <p className="page-sub">Get certified, practice on an AI homeowner, and get a personalized plan.</p>
      </div>

      {/* Certification banner */}
      <div
        className="card"
        style={{ marginBottom: 18, borderLeft: `4px solid ${certified ? "#34d399" : "#f59e0b"}` }}
      >
        {certified ? (
          <div>
            <strong>✅ Pitch certified{typeof certScore === "number" ? ` — ${certScore}/100` : ""}.</strong>
            <div className="muted small" style={{ marginTop: 4 }}>Your knocks count at full credit.</div>
          </div>
        ) : (
          <div>
            <strong>Not certified yet.</strong>
            <div className="muted small" style={{ marginTop: 4 }}>
              Record a certification pitch and score 80+ to unlock full-credit canvassing.
            </div>
          </div>
        )}
      </div>

      {/* Certify your pitch */}
      <h2 className="section-h">Certify your pitch</h2>
      <div className="card" style={{ marginBottom: 22 }}>
        {!pitchSupported ? (
          <p className="muted small">Mic recording needs HTTPS and a supported browser.</p>
        ) : !consented ? (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              We'll record your certification pitch so the AI can grade it. One-time consent required.
            </p>
            <button className="btn primary" onClick={giveConsent}>🎙️ Enable recording</button>
          </>
        ) : (
          <>
            {recording ? (
              <button className="btn primary" onClick={onStop} disabled={saving}>
                <span style={{ color: "#ef4444" }}>●</span> Stop &amp; submit
              </button>
            ) : (
              <button className="btn primary" onClick={start} disabled={!!analyzing}>
                🎙️ Record certification pitch
              </button>
            )}
            {recording && <span className="muted small" style={{ marginLeft: 10 }}>Recording…</span>}
          </>
        )}

        {!recording && analyzing && (
          <p className="muted small" style={{ marginTop: 12 }}>Analyzing your pitch…</p>
        )}

        {!recording && !analyzing && latestCert && latestCert.status === "analyzed" && (
          <div style={{ marginTop: 12 }}>
            {typeof latestCert.score === "number" && (
              <div className="pitch-score-big">{latestCert.score}<small>/100</small></div>
            )}
            {latestCert.feedback && <p className="pitch-fb">{latestCert.feedback}</p>}
            {latestCert.highlight && <p className="pitch-hi"><strong>✅ What worked:</strong> {latestCert.highlight}</p>}
            {latestCert.lowlight && <p className="pitch-lo"><strong>⚠️ To improve:</strong> {latestCert.lowlight}</p>}
          </div>
        )}

        {!recording && !analyzing && latestCert && latestCert.status === "error" && (
          <p className="muted small" style={{ marginTop: 12 }}>
            {latestCert.feedback || "Couldn't analyze that recording. Try again."}
          </p>
        )}
      </div>

      {/* Practice with an AI homeowner */}
      <h2 className="section-h">Practice with an AI homeowner</h2>
      <div className="card" style={{ marginBottom: 22 }}>
        {messages.length === 0 ? (
          <div className="empty" style={{ marginBottom: 12 }}>
            Knock on the door and start a role-play. The AI plays a solar homeowner — pitch them, handle objections, and book the appointment.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  ...bubbleStyle,
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  background: m.role === "user" ? "#2563eb" : "#1f2937",
                  color: "#fff",
                }}
              >
                {m.content}
              </div>
            ))}
          </div>
        )}

        {chatError && <p className="muted small" style={{ color: "#ef4444" }}>{chatError}</p>}

        {messages.length === 0 ? (
          <button className="btn primary" onClick={startRolePlay} disabled={chatBusy}>
            {chatBusy ? "Knocking…" : "🚪 Start role-play"}
          </button>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendMessage(); }}
                placeholder={chatBusy ? "Homeowner is thinking…" : "Say something at the door…"}
                disabled={chatBusy}
                style={{ flex: 1 }}
              />
              <button className="btn primary sm" onClick={sendMessage} disabled={chatBusy || !draft.trim()}>Send</button>
            </div>
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={resetChat} disabled={chatBusy}>Reset</button>
          </>
        )}
      </div>

      {/* Success plan */}
      <h2 className="section-h">Your success plan</h2>
      <div className="card">
        <button className="btn primary" onClick={generatePlan} disabled={planLoading}>
          {planLoading ? "Building your plan…" : "✨ Generate my plan"}
        </button>

        {planError && <p className="muted small" style={{ color: "#ef4444", marginTop: 12 }}>{planError}</p>}

        {plan && !planError && (
          <div style={{ marginTop: 14 }}>
            {plan.summary && <p>{plan.summary}</p>}

            {plan.focusAreas && plan.focusAreas.length > 0 && (
              <>
                <h3 className="section-h" style={{ marginTop: 14 }}>Focus areas</h3>
                <ul className="lb-list">
                  {plan.focusAreas.map((f, i) => <li key={i} className="lb-row card">{f}</li>)}
                </ul>
              </>
            )}

            {plan.studyGuide && plan.studyGuide.length > 0 && (
              <>
                <h3 className="section-h" style={{ marginTop: 14 }}>Study guide</h3>
                <ul className="lb-list">
                  {plan.studyGuide.map((s, i) => <li key={i} className="lb-row card">{s}</li>)}
                </ul>
              </>
            )}

            {plan.successionPlan && plan.successionPlan.length > 0 && (
              <>
                <h3 className="section-h" style={{ marginTop: 14 }}>Succession plan</h3>
                <ul className="lb-list">
                  {plan.successionPlan.map((s, i) => <li key={i} className="lb-row card">{s}</li>)}
                </ul>
              </>
            )}

            {plan.objectionScripts && plan.objectionScripts.length > 0 && (
              <>
                <h3 className="section-h" style={{ marginTop: 14 }}>Objection scripts</h3>
                <div className="lb-list">
                  {plan.objectionScripts.map((o, i) => (
                    <div key={i} className="lb-row card">
                      <div className="lb-row-main">
                        <div className="lb-row-name">🙅 {o.objection}</div>
                        <div className="muted small" style={{ marginTop: 4 }}>💬 {o.response}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {!plan.summary &&
              !plan.focusAreas?.length &&
              !plan.studyGuide?.length &&
              !plan.successionPlan?.length &&
              !plan.objectionScripts?.length && (
                <p className="muted small" style={{ marginTop: 12 }}>No plan details yet. Record a certification pitch and run some role-plays, then try again.</p>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
