import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { CalendarLinks } from "../types";

const GOOGLE_SCOPE =
  "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const MS_SCOPE = "offline_access Calendars.ReadWrite User.Read";

type PublicConfig = {
  google: { clientId: string; configured: boolean };
  microsoft: { clientId: string; tenant: string; configured: boolean };
};

type CrmStatus = {
  enabled: boolean;
  leadWebhookUrl: string;
  appointmentWebhookUrl: string;
  orgId: string;
  configured: boolean;
  keyMask: string;
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

  const isAdmin = role === "admin" || role === "superadmin";
  const companyId = profile?.companyId;
  const [crm, setCrm] = useState<CrmStatus | null>(null);
  const [crmForm, setCrmForm] = useState({ leadWebhookUrl: "", appointmentWebhookUrl: "", orgId: "", apiKey: "" });
  const [crmSaving, setCrmSaving] = useState(false);
  const [crmMsg, setCrmMsg] = useState("");

  useEffect(() => {
    setPhone(profile?.phone || "");
    setCal(profile?.calendar || {});
  }, [profile]);

  useEffect(() => {
    httpsCallable(functions, "getIntegrationPublicConfig")()
      .then((r) => setCfg(r.data as PublicConfig))
      .catch(() => setCfg(null));
  }, []);

  useEffect(() => {
    if (!isAdmin || !companyId) return;
    httpsCallable(functions, "getCrmIntegration")({ companyId })
      .then((r) => {
        const s = r.data as CrmStatus;
        setCrm(s);
        setCrmForm({
          leadWebhookUrl: s.leadWebhookUrl || "",
          appointmentWebhookUrl: s.appointmentWebhookUrl || "",
          orgId: s.orgId || "",
          apiKey: "",
        });
      })
      .catch(() => setCrm(null));
  }, [isAdmin, companyId]);

  async function saveCrm(nextEnabled?: boolean) {
    if (!companyId) return;
    setCrmSaving(true);
    setCrmMsg("");
    try {
      await httpsCallable(functions, "setCrmIntegration")({
        companyId,
        ...(typeof nextEnabled === "boolean" ? { enabled: nextEnabled } : {}),
        leadWebhookUrl: crmForm.leadWebhookUrl,
        appointmentWebhookUrl: crmForm.appointmentWebhookUrl,
        orgId: crmForm.orgId,
        // Only send the key when the admin typed a new one (blank = keep).
        ...(crmForm.apiKey.trim() ? { apiKey: crmForm.apiKey.trim() } : {}),
      });
      const r = await httpsCallable(functions, "getCrmIntegration")({ companyId });
      const s = r.data as CrmStatus;
      setCrm(s);
      setCrmForm((f) => ({ ...f, apiKey: "" }));
      setCrmMsg("Saved ✓");
    } catch (e) {
      setCrmMsg((e as Error).message || "Save failed.");
    } finally {
      setCrmSaving(false);
    }
  }

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

      {isAdmin && (
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>YoutilityCRM integration</h3>
          <p className="muted small" style={{ marginBottom: 12 }}>
            Push interested leads (Appointment / Pipeline / Sold) and booked
            appointments straight into your YoutilityCRM. In the CRM, open
            <strong> Settings → Connect YoutilityKnock</strong> to generate the
            key + webhook URLs, then paste them here.
          </p>

          <label className="muted small">Lead webhook URL</label>
          <input
            className="input"
            style={{ width: "100%", marginBottom: 10 }}
            placeholder="https://www.youtilitycrm.us/api/youtility-knock/webhook/lead"
            value={crmForm.leadWebhookUrl}
            onChange={(e) => setCrmForm((f) => ({ ...f, leadWebhookUrl: e.target.value }))}
          />

          <label className="muted small">Appointment webhook URL</label>
          <input
            className="input"
            style={{ width: "100%", marginBottom: 10 }}
            placeholder="https://www.youtilitycrm.us/api/youtility-knock/webhook/appointment"
            value={crmForm.appointmentWebhookUrl}
            onChange={(e) => setCrmForm((f) => ({ ...f, appointmentWebhookUrl: e.target.value }))}
          />

          <label className="muted small">CRM org ID (optional)</label>
          <input
            className="input"
            style={{ width: "100%", marginBottom: 10 }}
            placeholder="From the CRM's provision response"
            value={crmForm.orgId}
            onChange={(e) => setCrmForm((f) => ({ ...f, orgId: e.target.value }))}
          />

          <label className="muted small">
            Shared key {crm?.configured ? `(saved: ${crm.keyMask} — leave blank to keep)` : ""}
          </label>
          <input
            className="input"
            type="password"
            style={{ width: "100%", marginBottom: 12 }}
            placeholder={crm?.configured ? "••••••••" : "Paste the key from YoutilityCRM"}
            value={crmForm.apiKey}
            onChange={(e) => setCrmForm((f) => ({ ...f, apiKey: e.target.value }))}
          />

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn" disabled={crmSaving} onClick={() => saveCrm()}>
              {crmSaving ? "Saving…" : "Save"}
            </button>
            {crm?.configured && (
              <button
                className="btn"
                disabled={crmSaving}
                onClick={() => saveCrm(!crm.enabled)}
                style={{ background: crm.enabled ? "#F87171" : "#34D399" }}
              >
                {crm.enabled ? "Disable sync" : "Enable sync"}
              </button>
            )}
            <span className="muted small">
              {crm?.enabled ? "🟢 Syncing" : crm?.configured ? "⚪ Configured (off)" : "Not connected"}
            </span>
          </div>
          {crmMsg && <div className="muted small" style={{ marginTop: 10 }}>{crmMsg}</div>}
        </div>
      )}

      <p className="muted small">Need a role change? Ask an admin from the Admin · Users screen.</p>
    </div>
  );
}
