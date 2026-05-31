import { useState, type FormEvent } from "react";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function Login() {
  const { user, login, register, loginWithGoogle, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname || "/";

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, name);
      navigate(from, { replace: true });
    } catch (err: any) {
      setError(prettyError(err?.code) || err?.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setError("");
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

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand center">
          <div className="brand-mark lg">CP</div>
          <div className="brand-name lg">Canvass Pro</div>
          <div className="brand-sub">Homeowner intel for the field</div>
        </div>

        <div className="seg">
          <button
            className={"seg-btn" + (mode === "login" ? " active" : "")}
            onClick={() => setMode("login")}
            type="button"
          >
            Sign in
          </button>
          <button
            className={"seg-btn" + (mode === "register" ? " active" : "")}
            onClick={() => setMode("register")}
            type="button"
          >
            Create account
          </button>
        </div>

        <form onSubmit={submit} className="auth-form">
          {mode === "register" && (
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={6}
            />
          </label>

          {error && <div className="banner error show">{error}</div>}

          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="or">or</div>
        <button className="btn block" type="button" onClick={google} disabled={busy}>
          Continue with Google
        </button>
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
    case "auth/email-already-in-use":
      return "An account with that email already exists.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/invalid-email":
      return "That doesn't look like a valid email.";
    default:
      return null;
  }
}
