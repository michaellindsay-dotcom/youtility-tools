import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions, googleProvider } from "../firebase";
import { isBillingLocked, PAYMENT_LOCK_MSG } from "../lib/billing";
import { teardownPush } from "../lib/push";
import type { Company, Role, UserProfile, Team } from "../types";

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  company: Company | null;
  /** The user's team (for team-level service permissions); null if none. */
  team: Team | null;
  /** True once the company doc has resolved from the SERVER (not just cache). */
  companyLoaded: boolean;
  role: Role | null;
  companyId: string | null;
  /** Signed in but has no provisioned company/profile (no access). */
  noAccess: boolean;
  /** Why a deactivated/removed account was refused; shown on the login screen. */
  blockedReason: string | null;
  clearBlocked: () => void;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

// Profiles are created by the admin console (createUser Cloud Function), never
// in the app. If a signed-in user has no profile/company, they have no access.
function toProfile(uid: string, data: Record<string, unknown> | undefined): UserProfile | null {
  if (!data || !data.companyId) return null;
  return { uid, ...(data as Omit<UserProfile, "uid">) };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [companyLoaded, setCompanyLoaded] = useState(false);
  const [noAccess, setNoAccess] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep the company doc (incl. scheduling settings) live for the current user.
  useEffect(() => {
    const cid = profile?.companyId;
    if (!cid) {
      setCompany(null);
      setCompanyLoaded(false);
      return;
    }
    setCompanyLoaded(false);
    return onSnapshot(doc(db, "companies", cid), (snap) => {
      // Render with whatever we have (cache included) for a snappy UI…
      setCompany(snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<Company, "id">) }) : null);
      // …but only make the inactive/removed sign-out decision once the answer
      // is SERVER-confirmed. A stale or cold local cache briefly reports the
      // company as missing, or with an old "suspended" status, before the
      // server replies — that must never lock an active company out (it was
      // signing valid users out of the web app on a laptop with stale cache).
      if (!snap.metadata.fromCache) setCompanyLoaded(true);
    });
  }, [profile?.companyId]);

  // Keep the user's team doc live (for team-level service permissions).
  useEffect(() => {
    const cid = profile?.companyId;
    const tid = profile?.teamId;
    if (!cid || !tid) { setTeam(null); return; }
    return onSnapshot(doc(db, "companies", cid, "teams", tid), (snap) => {
      setTeam(snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<Team, "id">) }) : null);
    }, () => setTeam(null));
  }, [profile?.companyId, profile?.teamId]);

  // Refuse access to deactivated or removed accounts: sign them out and stash a
  // message the login screen shows. Disabled *users* are already blocked by
  // Firebase Auth; this additionally covers a suspended/inactive/removed
  // *company* (whose users would otherwise still authenticate).
  useEffect(() => {
    if (!user || !profile) return;
    let reason: string | null = null;
    let code = "";
    const status = String(company?.status || "active").toLowerCase();
    if (profile.disabled) {
      reason = "Your account has been deactivated. Please contact your system administrator.";
      code = "user-disabled";
    } else if (companyLoaded) {
      if (!company) {
        reason = "Your company account is no longer active. Please contact your system administrator.";
        code = "company-missing";
      } else if (status === "suspended" || status === "inactive") {
        reason = isBillingLocked(company)
          ? PAYMENT_LOCK_MSG
          : "Your company account is inactive. Please contact your system administrator.";
        code = isBillingLocked(company) ? "company-billing-locked" : `company-${status}`;
      }
    }
    if (reason) {
      // Diagnostic breadcrumb: persisted (survives the sign-out redirect/reload)
      // and logged, so the precise cause + which company is at fault is readable
      // even when the on-screen banner is missed. Appended to the message too.
      const diag = `code=${code} · company=${profile.companyId || "—"} (${company?.name || "?"}) · status=${status} · billingHold=${!!company?.billingHold} · pastDueSince=${company?.pastDueSince || 0}`;
      console.error("[auth] signing out:", diag);
      try { window.localStorage.setItem("ykKickDiag", `${new Date().toISOString()} — ${reason} [${diag}]`); } catch { /* ignore */ }
      setBlockedReason(`${reason}\n\n(${diag})`);
      void signOut(auth);
    }
  }, [user, profile, company, companyLoaded]);

  useEffect(() => {
    let unsubProfile: (() => void) | null = null;
    // Track the UID we've already tried to self-heal so a permanently
    // profile-less account doesn't loop calling relinkMyProfile.
    let relinkTried: string | null = null;
    const stopProfile = () => {
      if (unsubProfile) {
        unsubProfile();
        unsubProfile = null;
      }
    };
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      stopProfile();
      if (!u) {
        setProfile(null);
        setNoAccess(false);
        setLoading(false);
        return;
      }
      // Keep the profile LIVE (not a one-time read): if an admin disables this
      // account mid-session, the `disabled` flag flips here and the effect
      // below signs them out immediately, instead of the account lingering with
      // access until the next full app reload (the bug that let disabled
      // accounts keep working on a phone that already had a session open).
      unsubProfile = onSnapshot(
        doc(db, "users", u.uid),
        (snap) => {
          const p = toProfile(u.uid, snap.exists() ? snap.data() : undefined);
          // No profile at this UID? Before declaring "no access", try once to
          // self-heal an account whose profile lives under a different doc id
          // (imported, or an Auth user that was recreated). On success the
          // server writes users/<uid>, which re-fires THIS listener with the
          // real profile — so we just wait rather than flashing the gate.
          if (p === null && !snap.metadata.fromCache && relinkTried !== u.uid) {
            relinkTried = u.uid;
            httpsCallable(functions, "relinkMyProfile")()
              .catch((err) => console.error("relinkMyProfile failed", err))
              .finally(() => {
                // If nothing got linked, the listener won't re-fire — settle the
                // no-access state here so we don't hang on the loader forever.
                if (auth.currentUser?.uid === u.uid) {
                  void getDoc(doc(db, "users", u.uid)).then((s) => {
                    if (!s.exists()) { setNoAccess(true); setLoading(false); }
                  });
                }
              });
            return;
          }
          setProfile(p);
          setNoAccess(p === null);
          setLoading(false);
        },
        (err) => {
          console.error("Failed to load profile", err);
          setProfile(null);
          setNoAccess(true);
          setLoading(false);
        }
      );
    });
    return () => {
      stopProfile();
      unsub();
    };
  }, []);

  const login = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };
  const loginWithGoogle = async () => {
    await signInWithPopup(auth, googleProvider);
  };
  const logout = async () => {
    await teardownPush(); // drop this device's push token before signing out
    await signOut(auth);
  };

  const value: AuthState = {
    user,
    profile,
    company,
    team,
    companyLoaded,
    role: profile?.role ?? null,
    companyId: profile?.companyId ?? null,
    noAccess,
    blockedReason,
    clearBlocked: () => setBlockedReason(null),
    loading,
    login,
    loginWithGoogle,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
