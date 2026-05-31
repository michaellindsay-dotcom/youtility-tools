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
import { doc, getDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "../firebase";
import type { Role, UserProfile } from "../types";

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  role: Role | null;
  companyId: string | null;
  /** Signed in but has no provisioned company/profile (no access). */
  noAccess: boolean;
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
  const [noAccess, setNoAccess] = useState(false);
  const [loading, setLoading] = useState(true);

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
    role: profile?.role ?? null,
    companyId: profile?.companyId ?? null,
    noAccess,
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
