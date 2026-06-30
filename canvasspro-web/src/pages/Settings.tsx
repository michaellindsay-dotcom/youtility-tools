import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "firebase/auth";
import { auth, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { useCalendarConnect } from "../lib/calendar";

export default function Settings() {
  const { profile, role } = useAuth();
  const [phone, setPhone] = useState(profile?.phone || "");
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState("");
  // Calendar connect logic lives in a shared hook (also used by the one-tap
  // connect banner on the dashboard/schedule).
  const { cfg, cal, busy, msg: calMsg, connect, disconnect } = useCalendarConnect();
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
  }, [profile]);

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

  const row = (provider: "google" | "microsoft", label: string, icon: string) => {
    const link = cal[provider];
    const connected = !!link?.connected;
    const needsReauth = connected && !!link?.needsReauth;
    return (
      <div className="cal-row">
        <span className="cal-ico">{icon}</span>
        <div className="cal-info">
          <div className="cal-name">{label}</div>
          <div className="muted small">
            {connected ? `Connected${link?.email ? ` · ${link.email}` : ""}` : "Not connected"}
          </div>
          {needsReauth && (
            <div className="small" style={{ color: "#f59e0b", marginTop: 2 }}>
              ⚠ Sync paused — {link?.lastSyncError || "reconnect to resume syncing."}
            </div>
          )}
        </div>
        {needsReauth ? (
          <button className="btn primary sm" disabled={busy === provider} onClick={() => connect(provider)}>
            {busy === provider ? "Connecting…" : "Reconnect"}
          </button>
        ) : connected ? (
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
