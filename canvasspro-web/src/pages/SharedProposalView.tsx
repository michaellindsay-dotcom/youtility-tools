import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import SolarProposalShow, { type SolarShowProps } from "./SolarProposalShow";

// Standalone, no-login viewer the homeowner lands on from the emailed link
// (https://…/app/?pid=<id>). It fetches the saved proposal via the public
// getSharedProposal callable and renders the interactive presentation full
// screen. Rendered outside the app's auth gate — see main.tsx.
type Payload = Omit<SolarShowProps, "open" | "onClose">;

export default function SharedProposalView() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [closed, setClosed] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("pid") || "";
    let alive = true;
    (async () => {
      try {
        const { data } = await httpsCallable<{ id: string }, { payload: Payload }>(
          functions,
          "getSharedProposal"
        )({ id });
        if (!alive) return;
        setPayload((data?.payload as Payload) || {});
        setState("ready");
      } catch (e) {
        if (!alive) return;
        setErr((e as Error)?.message || "This proposal link is no longer available.");
        setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state === "loading") return <Msg title="Loading your proposal…" />;
  if (state === "error" || !payload)
    return <Msg title="Proposal unavailable" body={err || "This link may have expired. Ask your rep to resend it."} />;

  if (closed)
    return (
      <Msg
        title="Thanks for watching"
        body="Have questions or ready to move forward? Just reply to the email or reach out to your rep."
        action={{ label: "▶ Watch again", onClick: () => setClosed(false) }}
      />
    );

  return <SolarProposalShow {...payload} open onClose={() => setClosed(true)} />;
}

function Msg({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 14,
        padding: 24,
        background: "radial-gradient(120% 90% at 50% 0%, #1a1030 0%, #0a0712 60%, #080512 100%)",
        color: "#f4f1fb",
        fontFamily: "'Space Grotesk', system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</div>
      {body && <div style={{ maxWidth: 420, color: "#b6aecb", fontSize: 15, lineHeight: 1.55 }}>{body}</div>}
      {action && (
        <button
          onClick={action.onClick}
          style={{
            marginTop: 6,
            background: "#7c3aed",
            color: "#fff",
            border: 0,
            borderRadius: 999,
            fontWeight: 600,
            fontSize: 15,
            padding: "12px 24px",
            cursor: "pointer",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
