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
import { auth, db, googleProvider } from "../firebase";
import type { Company, Role, UserProfile } from "../types";

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  company: Company | null;
  /** True once the company doc has resolved at least once (exists or not). */
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
async function loadProfile(user: User): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) return null;
  const data = snap.data() as Omit<UserProfile, "uid">;
  if (!data.companyId) return null;
  return { uid: user.uid, ...data };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
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
      // A cold offline cache (e.g. a fresh native install) raises an initial
      // "doesn't exist" event with fromCache=true before the server responds.
      // Treating that as "company removed" would wrongly flag the account as
      // inactive and sign the user out, so ignore a not-exists answer that is
      // only from cache and wait for the server-backed snapshot.
      if (!snap.exists() && snap.metadata.fromCache) return;
      setCompany(snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<Company, "id">) }) : null);
      setCompanyLoaded(true);
    });
  }, [profile?.companyId]);

  // Refuse access to deactivated or removed accounts: sign them out and stash a
  // message the login screen shows. Disabled *users* are already blocked by
  // Firebase Auth; this additionally covers a suspended/inactive/removed
  // *company* (whose users would otherwise still authenticate).
  useEffect(() => {
    if (!user || !profile) return;
    let reason: string | null = null;
    if (profile.disabled) {
      reason = "Your account has been deactivated. Please contact your system administrator.";
    } else if (companyLoaded) {
      const status = String(company?.status || "active").toLowerCase();
      if (!company) {
        reason = "Your company account is no longer active. Please contact your system administrator.";
      } else if (status === "suspended" || status === "inactive") {
        reason = "Your company account is inactive. Please contact your system administrator.";
      }
    }
    if (reason) {
      setBlockedReason(reason);
      void signOut(auth);
    }
  }, [user, profile, company, companyLoaded]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          const p = await loadProfile(u);
          setProfile(p);
          setNoAccess(p === null);
        } catch (err) {
          console.error("Failed to load profile", err);
          setProfile(null);
          setNoAccess(true);
        }
      } else {
        setProfile(null);
        setNoAccess(false);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const login = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };
  const loginWithGoogle = async () => {
    await signInWithPopup(auth, googleProvider);
  };
  const logout = async () => {
    await signOut(auth);
  };

  const value: AuthState = {
    user,
    profile,
    company,
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
