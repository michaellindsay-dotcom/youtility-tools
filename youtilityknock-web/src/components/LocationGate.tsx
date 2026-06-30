import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { App } from "@capacitor/app";

// YoutilityKnock requires location: the map shows nearby homes and a knock only
// counts when you're on-site. On the phone we prompt for permission at launch
// and, if it's denied, block the app with a clear "enable it" screen until the
// rep grants it. The web/admin console isn't gated (managers don't need GPS).
const isNative = Capacitor.isNativePlatform();

export default function LocationGate() {
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async (request: boolean) => {
    if (!isNative) return;
    try {
      let perm = await Geolocation.checkPermissions();
      if (request && perm.location !== "granted" && perm.location !== "denied") {
        // Only the system can show the prompt once; after that it returns the
        // saved choice without prompting.
        perm = await Geolocation.requestPermissions();
      }
      setDenied(perm.location !== "granted");
    } catch {
      setDenied(false); // never hard-lock the app on a plugin error
    }
  }, []);

  useEffect(() => {
    void check(true);
    // Re-check when the app comes back to the foreground (e.g. after the rep
    // flips the toggle in iOS Settings), so the gate clears itself.
    let remove: (() => void) | undefined;
    if (isNative) {
      App.addListener("appStateChange", ({ isActive }) => {
        if (isActive) void check(false);
      }).then((h) => { remove = () => h.remove(); });
    }
    return () => remove?.();
  }, [check]);

  if (!isNative || !denied) return null;

  const retry = async () => {
    setBusy(true);
    await check(true);
    setBusy(false);
  };

  return createPortal(
    <div style={overlay}>
      <div style={card}>
        <div style={{ fontSize: 44 }}>📍</div>
        <h2 style={{ margin: "10px 0 6px", fontFamily: "'Space Grotesk', sans-serif" }}>Turn on Location</h2>
        <p style={{ color: "#b6c2d6", fontSize: 14, lineHeight: 1.5, margin: 0 }}>
          YoutilityKnock needs your location to show the homes around you and to confirm a knock happened
          on-site. It's only used while the app is open — there's no background tracking.
        </p>
        <button style={btn} disabled={busy} onClick={retry}>
          {busy ? "Checking…" : "Allow location"}
        </button>
        <p style={{ color: "#8a97ad", fontSize: 12.5, lineHeight: 1.5, margin: "12px 0 0" }}>
          If it doesn't ask, open <strong>Settings → YoutilityKnock → Location</strong> and choose
          <strong> While Using the App</strong>, then come back — this screen clears automatically.
        </p>
      </div>
    </div>,
    document.body
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 4000,
  background: "radial-gradient(120% 90% at 50% 0%, #14233f 0%, #0a0f1a 60%, #080b12 100%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "max(20px, env(safe-area-inset-top)) 22px max(20px, env(safe-area-inset-bottom))",
  textAlign: "center",
  color: "#f4f7fb",
};
const card: React.CSSProperties = { width: "100%", maxWidth: 380 };
const btn: React.CSSProperties = {
  marginTop: 18,
  width: "100%",
  background: "#0EA5E9",
  color: "#06121f",
  border: 0,
  borderRadius: 12,
  fontWeight: 700,
  fontSize: 16,
  padding: 14,
  fontFamily: "'Space Grotesk', sans-serif",
  cursor: "pointer",
};
