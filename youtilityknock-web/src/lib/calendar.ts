import { useCallback, useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { App } from "@capacitor/app";
import { functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { CalendarLinks } from "../types";

const GOOGLE_SCOPE =
  "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const MS_SCOPE = "offline_access Calendars.ReadWrite User.Read";

// On the installed app the WebView origin is capacitor://localhost (iOS) /
// https://localhost (Android) — a redirect URI Google rejects outright ("Error
// 400: invalid_request / doesn't comply with OAuth 2.0 policy"), and popups
// can't post a message back into the native shell anyway. So native uses a
// fixed, registered hosted redirect and gets the code back via a deep link.
const NATIVE = Capacitor.isNativePlatform();
const NATIVE_REDIRECT = "https://youtilityknock.web.app/oauth-callback.html";
const APP_SCHEME = "us.youtility.knock"; // matches the app id / registered URL scheme

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

// Native consent flow: open the provider's screen in the system browser
// (SFSafariViewController / Chrome Custom Tab — allowed by Google, unlike an
// embedded WebView), and wait for oauth-callback.html to bounce the code back
// into the app via the `us.youtility.knock://oauth-callback` deep link.
async function oauthNative(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      urlSub.then((s) => s.remove());
      closeSub.then((s) => s.remove());
      Browser.close().catch(() => {});
      fn();
    };
    const urlSub = App.addListener("appUrlOpen", ({ url: incoming }) => {
      if (!incoming || incoming.indexOf(`${APP_SCHEME}://oauth-callback`) !== 0) return;
      // Parse the query off the custom-scheme URL (URL() may choke on it).
      const q = new URLSearchParams(incoming.split("?")[1] || "");
      const code = q.get("code");
      const error = q.get("error");
      if (error) finish(() => reject(new Error("Connection cancelled.")));
      else if (code) finish(() => resolve(code));
      else finish(() => reject(new Error("No authorization code returned.")));
    });
    // If the user backs out of the browser without granting, don't hang forever.
    const closeSub = Browser.addListener("browserFinished", () => {
      // Give a redirect-in-flight a beat to deliver the code first.
      setTimeout(() => finish(() => reject(new Error("Window closed before finishing."))), 400);
    });
    Browser.open({ url }).catch((e) => finish(() => reject(e instanceof Error ? e : new Error("Couldn't open the sign-in window."))));
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

  // Web: bounce off this same-origin page and postMessage the code back to the
  // opener. Native: use the fixed hosted page, which deep-links the code back.
  const redirectUri = NATIVE ? NATIVE_REDIRECT : window.location.origin + "/oauth-callback.html";
  // The callback page reads `state` to decide how to return the code — the
  // ":native" suffix tells it to deep-link into the app instead of postMessage.
  const stateFor = (p: CalProvider) => (NATIVE ? `${p}:native` : p);

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
          client_id: cfg.google.clientId, redirect_uri: redirectUri, scope: GOOGLE_SCOPE, state: stateFor("google"),
        }).toString();
      } else {
        if (!cfg.microsoft.configured) throw new Error("Ask your admin to configure Outlook calendar sync.");
        url = `https://login.microsoftonline.com/${cfg.microsoft.tenant}/oauth2/v2.0/authorize?` + new URLSearchParams({
          response_type: "code", client_id: cfg.microsoft.clientId, redirect_uri: redirectUri,
          scope: MS_SCOPE, response_mode: "query", prompt: "consent", state: stateFor("microsoft"),
        }).toString();
      }
      const code = NATIVE ? await oauthNative(url) : await oauthPopup(url);
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
