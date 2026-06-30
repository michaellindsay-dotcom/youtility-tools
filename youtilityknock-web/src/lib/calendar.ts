import { useCallback, useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { CalendarLinks } from "../types";

const GOOGLE_SCOPE =
  "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const MS_SCOPE = "offline_access Calendars.ReadWrite User.Read";

export type CalProvider = "google" | "microsoft";
export type PublicConfig = {
  google: { clientId: string; configured: boolean };
  microsoft: { clientId: string; tenant: string; configured: boolean };
};

// Open a provider's consent screen in a popup and resolve with the auth code
// that /oauth-callback.html posts back.
function oauthPopup(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = 520, h = 640;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(url, "yk-oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) return reject(new Error("Popup blocked — allow popups and try again."));
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.source !== "yk-oauth") return;
      window.removeEventListener("message", onMsg);
      clearInterval(closedTimer);
      if (e.data.error) reject(new Error("Connection cancelled."));
      else if (e.data.code) resolve(e.data.code as string);
      else reject(new Error("No authorization code returned."));
    };
    window.addEventListener("message", onMsg);
    const closedTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(closedTimer);
        window.removeEventListener("message", onMsg);
        reject(new Error("Window closed before finishing."));
      }
    }, 600);
  });
}

// One source of truth for connecting/disconnecting calendars — reused by the
// Settings screen and the one-tap connect prompts on the dashboard/schedule.
export function useCalendarConnect() {
  const { profile } = useAuth();
  const [cal, setCal] = useState<CalendarLinks>(profile?.calendar || {});
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [busy, setBusy] = useState<CalProvider | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => setCal(profile?.calendar || {}), [profile]);
  useEffect(() => {
    httpsCallable(functions, "getIntegrationPublicConfig")()
      .then((r) => setCfg(r.data as PublicConfig))
      .catch(() => setCfg(null));
  }, []);

  const redirectUri = window.location.origin + "/oauth-callback.html";

  const connect = useCallback(async (provider: CalProvider) => {
    if (!cfg) return;
    setMsg("");
    setBusy(provider);
    try {
      let url: string;
      if (provider === "google") {
        if (!cfg.google.configured) throw new Error("Ask your admin to configure Google calendar sync.");
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
          response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true",
          client_id: cfg.google.clientId, redirect_uri: redirectUri, scope: GOOGLE_SCOPE, state: "google",
        }).toString();
      } else {
        if (!cfg.microsoft.configured) throw new Error("Ask your admin to configure Outlook calendar sync.");
        url = `https://login.microsoftonline.com/${cfg.microsoft.tenant}/oauth2/v2.0/authorize?` + new URLSearchParams({
          response_type: "code", client_id: cfg.microsoft.clientId, redirect_uri: redirectUri,
          scope: MS_SCOPE, response_mode: "query", prompt: "consent", state: "microsoft",
        }).toString();
      }
      const code = await oauthPopup(url);
      const fn = provider === "google" ? "connectGoogleCalendar" : "connectMicrosoftCalendar";
      const r = await httpsCallable(functions, fn)({ code, redirectUri });
      const email = (r.data as { email?: string }).email || "";
      setCal((c) => ({ ...c, [provider]: { connected: true, email, connectedAt: Date.now() } }));
      setMsg(`${provider === "google" ? "Google" : "Outlook"} connected ✓`);
    } catch (e) {
      setMsg((e as Error).message || "Couldn't connect.");
    } finally {
      setBusy(null);
    }
  }, [cfg, redirectUri]);

  const disconnect = useCallback(async (provider: CalProvider) => {
    setBusy(provider);
    setMsg("");
    try {
      await httpsCallable(functions, "disconnectCalendar")({ provider });
      setCal((c) => ({ ...c, [provider]: { connected: false } }));
      setMsg(`${provider === "google" ? "Google" : "Outlook"} disconnected.`);
    } catch (e) {
      setMsg((e as Error).message || "Couldn't disconnect.");
    } finally {
      setBusy(null);
    }
  }, []);

  const anyConfigured = !!(cfg?.google.configured || cfg?.microsoft.configured);
  const anyConnected = !!(cal.google?.connected || cal.microsoft?.connected);

  return { cfg, cal, busy, msg, connect, disconnect, anyConfigured, anyConnected };
}
