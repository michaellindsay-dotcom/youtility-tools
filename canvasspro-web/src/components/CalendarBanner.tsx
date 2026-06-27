import { useState } from "react";
import { useCalendarConnect } from "../lib/calendar";

// One-tap "connect your calendar" prompt. Shows only when at least one provider
// is configured by the admin and the user hasn't connected anything yet, so it
// quietly disappears once they're set up (or if sync isn't configured at all).
// Dismissible for the session.
export default function CalendarBanner() {
  const { cfg, busy, msg, connect, anyConfigured, anyConnected } = useCalendarConnect();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || anyConnected || !anyConfigured) return null;

  return (
    <div className="card cal-banner" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
      <span style={{ fontSize: 22 }}>📅</span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontWeight: 600 }}>Connect your calendar</div>
        <div className="muted small">Appointments sync both ways — and we won't book you over something you already have.</div>
        {msg && <div className="muted small" style={{ marginTop: 4 }}>{msg}</div>}
      </div>
      <div className="row" style={{ gap: 8 }}>
        {cfg?.google.configured && (
          <button className="btn primary sm" disabled={busy === "google"} onClick={() => connect("google")}>
            {busy === "google" ? "Connecting…" : "🟦 Google"}
          </button>
        )}
        {cfg?.microsoft.configured && (
          <button className="btn primary sm" disabled={busy === "microsoft"} onClick={() => connect("microsoft")}>
            {busy === "microsoft" ? "Connecting…" : "🟪 Outlook"}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => setDismissed(true)} title="Hide for now">✕</button>
      </div>
    </div>
  );
}
