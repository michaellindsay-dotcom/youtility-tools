import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "firebase/auth";
import { auth, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { CalendarLinks } from "../types";

const GOOGLE_SCOPE =
  "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const MS_SCOPE = "offline_access Calendars.ReadWrite User.Read";

type PublicConfig = {
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

export default function Settings() {
  const { profile, role } = useAuth();
  const [phone, setPhone] = useState(profile?.phone || "");
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState("");
  const [cal, setCal] = useState<CalendarLinks>(profile?.calendar || {});
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [calMsg, setCalMsg] = useState("");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const hasPassword = auth.currentUser?.providerData.some((p) => p.providerId === "password") ?? true;

  async function changePassword() {
    setPwMsg("");
    if (newPw.length < 6) return setPwMsg("New password must be at least 6 characters.");
    if (newPw !== newPw2) return setPwMsg("New passwords don't match.");
    const user = auth.currentUser;
    if (!user?.email) return setPwMsg("No account loaded.");
    setPwBusy(true);
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, curPw));
      await updatePassword(user, newPw);
      setCurPw(""); setNewPw(""); setNewPw2("");
      setPwMsg("Password updated ✓");
    } catch (e: any) {
      setPwMsg(
        e?.code === "auth/wrong-password" || e?.code === "auth/invalid-credential"
          ? "Current password is incorrect."
          : e?.message || "Couldn't update password."
      );
    } finally {
      setPwBusy(false);
    }
  }

  useEffect(() => {
    setPhone(profile?.phone || "");
    setCal(profile?.calendar || {});
  }, [profile]);

  useEffect(() => {
    httpsCallable(functions, "getIntegrationPublicConfig")()
      .then((r) => setCfg(r.data as PublicConfig))
      .catch(() => setCfg(null));
  }, []);

  const redirectUri = window.location.origin + "/oauth-callback.html";

  async function savePhone() {
    setSavingPhone(true);
    setPhoneMsg("");
    try {
      const r = await httpsCallable(functions, "setMyProfile")({ phone });
      setPhone((r.data as { phone?: string }).phone || phone);
      setPhoneMsg("Saved ✓");
    } catch (e) {
      setPhoneMsg((e as Error).message || "Save failed.");
    } finally {
      setSavingPhone(false);
    }
  }

  async function connect(provider: "google" | "microsoft") {
    if (!cfg) return;
    setCalMsg("");
    setBusy(provider);
    try {
      let url: string;
      if (provider === "google") {
        if (!cfg.google.configured) throw new Error("Ask your admin to configure Google calendar sync.");
        url =
          "https://accounts.google.com/o/oauth2/v2/auth?" +
          new URLSearchParams({
            response_type: "code",
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true",
            client_id: cfg.google.clientId,
            redirect_uri: redirectUri,
            scope: GOOGLE_SCOPE,
            state: "google",
          }).toString();
      } else {
        if (!cfg.microsoft.configured) throw new Error("Ask your admin to configure Outlook calendar sync.");
        url =
          `https://login.microsoftonline.com/${cfg.microsoft.tenant}/oauth2/v2.0/authorize?` +
          new URLSearchParams({
            response_type: "code",
            client_id: cfg.microsoft.clientId,
            redirect_uri: redirectUri,
            scope: MS_SCOPE,
            response_mode: "query",
            prompt: "consent",
            state: "microsoft",
          }).toString();
      }
      const code = await oauthPopup(url);
      const fn = provider === "google" ? "connectGoogleCalendar" : "connectMicrosoftCalendar";
      const r = await httpsCallable(functions, fn)({ code, redirectUri });
      const email = (r.data as { email?: string }).email || "";
      setCal((c) => ({ ...c, [provider]: { connected: true, email, connectedAt: Date.now() } }));
      setCalMsg(`${provider === "google" ? "Google" : "Outlook"} connected ✓`);
    } catch (e) {
      setCalMsg((e as Error).message || "Couldn't connect.");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(provider: "google" | "microsoft") {
    setBusy(provider);
    setCalMsg("");
    try {
      await httpsCallable(functions, "disconnectCalendar")({ provider });
      setCal((c) => ({ ...c, [provider]: { connected: false } }));
      setCalMsg(`${provider === "google" ? "Google" : "Outlook"} disconnected.`);
    } catch (e) {
      setCalMsg((e as Error).message || "Couldn't disconnect.");
    } finally {
      setBusy(null);
    }
  }

  const row = (provider: "google" | "microsoft", label: string, icon: string) => {
    const link = cal[provider];
    const connected = !!link?.connected;
    return (
      <div className="cal-row">
        <span className="cal-ico">{icon}</span>
        <div className="cal-info">
          <div className="cal-name">{label}</div>
          <div className="muted small">
            {connected ? `Connected${link?.email ? ` · ${link.email}` : ""}` : "Not connected"}
          </div>
        </div>
        {connected ? (
          <button className="btn ghost sm" disabled={busy === provider} onClick={() => disconnect(provider)}>
            Disconnect
          </button>
        ) : (
          <button className="btn primary sm" disabled={busy === provider} onClick={() => connect(provider)}>
            {busy === provider ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Settings</h1>
        <p className="page-sub">Your account, contact info, and calendar.</p>
      </div>

      <div className="card">
        <dl className="fields">
          <div className="field-row">
            <dt>Name</dt>
            <dd>{profile?.displayName}</dd>
          </div>
          <div className="field-row">
            <dt>Email</dt>
            <dd>{profile?.email}</dd>
          </div>
          <div className="field-row">
            <dt>Role</dt>
            <dd>
              <span className={`role-badge role-${role}`}>{role}</span>
            </dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Mobile number</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          For appointment + message alerts by text when you're not in the app.
        </p>
        <div className="row" style={{ alignItems: "center" }}>
          <input
            className="input"
            style={{ maxWidth: 240 }}
            placeholder="(555) 123-4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button className="btn primary sm" onClick={savePhone} disabled={savingPhone}>
            {savingPhone ? "Saving…" : "Save"}
          </button>
          {phoneMsg && <span className="muted small">{phoneMsg}</span>}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Change password</h3>
        {hasPassword ? (
          <>
            <p className="muted small" style={{ marginBottom: 12 }}>
              Enter your current password, then a new one.
            </p>
            <div className="pw-grid">
              <input className="input" type="password" placeholder="Current password" autoComplete="current-password"
                value={curPw} onChange={(e) => setCurPw(e.target.value)} />
              <input className="input" type="password" placeholder="New password" autoComplete="new-password"
                value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              <input className="input" type="password" placeholder="Confirm new password" autoComplete="new-password"
                value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
            </div>
            <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
              <button className="btn primary sm" onClick={changePassword} disabled={pwBusy}>
                {pwBusy ? "Updating…" : "Update password"}
              </button>
              {pwMsg && <span className="muted small">{pwMsg}</span>}
            </div>
          </>
        ) : (
          <p className="muted small">You sign in with Google — manage your password in your Google account.</p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Calendar</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Link your calendar so appointments sync both ways — we won't book you over
          something you already have.
        </p>
        {row("google", "Google Calendar", "🟦")}
        {row("microsoft", "Outlook / Microsoft", "🟪")}
        {calMsg && <div className="muted small" style={{ marginTop: 10 }}>{calMsg}</div>}
        {cfg && !cfg.google.configured && !cfg.microsoft.configured && (
          <div className="muted small" style={{ marginTop: 10 }}>
            Calendar sync isn't set up for your platform yet — ask your admin.
          </div>
        )}
      </div>

      <p className="muted small">Need a role change? Ask an admin from the Admin · Users screen.</p>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>About</h3>
        <p className="muted small" style={{ marginBottom: 10 }}>
          YoutilityKnock by Sun Service
        </p>
        <p className="muted small">
          <a href="https://youtilityknock.web.app/privacy" target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>
          {" · "}
          <a href="https://youtilityknock.web.app/terms" target="_blank" rel="noopener noreferrer">
            Terms of Service
          </a>
        </p>
      </div>
    </div>
  );
}
