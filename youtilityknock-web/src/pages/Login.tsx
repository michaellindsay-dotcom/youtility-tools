import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import {
  isSignInWithEmailLink,
  signInWithEmailLink,
  sendPasswordResetEmail,
  updatePassword,
} from "firebase/auth";
import { auth } from "../firebase";
import { useAuth } from "../auth/AuthContext";

type Mode = "login" | "invite" | "setpw";

export default function Login() {
  const { user, login, loginWithGoogle, loading, blockedReason, clearBlocked } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname || "/";

  // Did we arrive via a magic invite link?
  const emailLink = typeof window !== "undefined" && isSignInWithEmailLink(auth, window.location.href);

  const [mode, setMode] = useState<Mode>(emailLink ? "invite" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Last forced sign-out breadcrumb (persisted by AuthContext) — a fallback when
  // the live banner is missed on a redirect/reload.
  const lastKick = typeof window !== "undefined" ? window.localStorage.getItem("ykKickDiag") : null;

  // If the link sign-in email was stored on this device, finish automatically.
  useEffect(() => {
    if (!emailLink) return;
    const saved = window.localStorage.getItem("ykInviteEmail");
    if (saved) void completeLink(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only auto-redirect a normal returning sign-in — never mid-invite, and never
  // a deactivated account (which AuthContext signs out with a blockedReason).
  if (!loading && user && mode === "login" && !blockedReason) return <Navigate to={from} replace />;

  async function completeLink(addr: string) {
    setError("");
    setBusy(true);
    try {
      await signInWithEmailLink(auth, addr, window.location.href);
      window.localStorage.removeItem("ykInviteEmail");
      // Drop the long oob params from the URL.
      window.history.replaceState(null, "", "/app/login");
      setMode("setpw");
    } catch (err: any) {
      setError(
        err?.code === "auth/invalid-action-code"
          ? "This invite link has expired or was already used. Ask your admin to resend it."
          : err?.message || "Couldn't verify the invite link."
      );
      setMode("invite");
    } finally {
      setBusy(false);
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    clearBlocked();
    setBusy(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err: any) {
      setError(prettyError(err?.code) || err?.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setError("");
    clearBlocked();
    setBusy(true);
    try {
      await loginWithGoogle();
      navigate(from, { replace: true });
    } catch (err: any) {
      setError(err?.message || "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const forgotPassword = async () => {
    setError("");
    setNotice("");
    if (!email.trim()) {
      setError("Enter your email above first, then tap “Forgot password”.");
      return;
    }
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setNotice(`Reset link sent to ${email.trim()} — check your inbox to set a new password.`);
    } catch (err: any) {
      setError(prettyError(err?.code) || err?.message || "Couldn't send the reset email.");
    } finally {
      setBusy(false);
    }
  };

  const confirmInviteEmail = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) void completeLink(email.trim());
  };

  const setPasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPw.length < 6) return setError("Use at least 6 characters.");
    if (newPw !== newPw2) return setError("Passwords don't match.");
    setBusy(true);
    try {
      if (auth.currentUser) await updatePassword(auth.currentUser, newPw);
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(err?.message || "Couldn't set your password. Try signing in again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand center">
          <div className="brand-mark lg">YK</div>
          <div className="brand-name lg">YoutilityKnock</div>
          <div className="brand-sub">Homeowner intel for the field</div>
        </div>

        {/* Magic-link: confirm email to finish sign-in */}
        {mode === "invite" && (
          <form onSubmit={confirmInviteEmail} className="auth-form" style={{ marginTop: 22 }}>
            <p className="muted small" style={{ marginBottom: 12 }}>
              Confirm your email to finish signing in.
            </p>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </label>
            {error && <div className="banner error show">{error}</div>}
            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Continue"}
            </button>
          </form>
        )}

        {/* Magic-link: set a password */}
        {mode === "setpw" && (
          <form onSubmit={setPasswordSubmit} className="auth-form" style={{ marginTop: 22 }}>
            <p className="muted small" style={{ marginBottom: 12 }}>
              Welcome! Set a password for your account.
            </p>
            <label className="field">
              <span>New password</span>
              <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" required />
            </label>
            <label className="field">
              <span>Confirm password</span>
              <input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" required />
            </label>
            {error && <div className="banner error show">{error}</div>}
            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Set password & continue"}
            </button>
          </form>
        )}

        {/* Normal sign-in */}
        {mode === "login" && (
          <>
            <form onSubmit={submit} className="auth-form" style={{ marginTop: 22 }}>
              <label className="field">
                <span>Email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </label>

              {(error || blockedReason) && <div className="banner error show" style={{ whiteSpace: "pre-wrap" }}>{error || blockedReason}</div>}
              {/* Persisted breadcrumb from the last forced sign-out — readable even
                  if the live banner above was missed on a redirect/reload. */}
              {!error && !blockedReason && lastKick && (
                <div className="banner error show" style={{ whiteSpace: "pre-wrap" }}>
                  Last sign-out reason:{"\n"}{lastKick}
                </div>
              )}
              {notice && <div className="banner good show">{notice}</div>}

              <button className="btn primary block" type="submit" disabled={busy}>
                {busy ? "Please wait…" : "Sign in"}
              </button>
              <button type="button" className="link-btn" onClick={forgotPassword} disabled={busy}>
                Forgot password?
              </button>
            </form>

            {/* Google popup sign-in doesn't work inside the native WebView — web only. */}
            {import.meta.env.VITE_NATIVE !== "1" && (
              <>
                <div className="or">or</div>
                <button className="btn block" type="button" onClick={google} disabled={busy}>
                  Continue with Google
                </button>
              </>
            )}

            <p className="muted small" style={{ marginTop: 16, textAlign: "center" }}>
              Accounts are created by your administrator. No login yet? Contact your admin.
            </p>
          </>
        )}

        {/* Store-required legal links. Absolute URLs opened externally so they
            resolve against Firebase Hosting even inside the native WebView,
            where the app itself runs from the bundle root. */}
        <p className="muted small" style={{ marginTop: 14, textAlign: "center" }}>
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

function prettyError(code?: string): string | null {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact your admin.";
    case "auth/invalid-email":
      return "That doesn't look like a valid email.";
    default:
      return null;
  }
}
