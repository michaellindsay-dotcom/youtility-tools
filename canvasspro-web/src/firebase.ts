import { initializeApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  setPersistence,
  inMemoryPersistence,
  signInWithCustomToken,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

// Public client identifiers for the youtilityknock Firebase project. These
// are safe to ship in the bundle — security is enforced by Firebase Auth +
// Firestore rules, not by keeping these secret. Env vars override the literals
// (e.g. to point at a different project) but default to the live config so a
// build works without a .env file.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyAArLWkY_WS7yabCgW_WZJu973J5iGcBI",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "youtilityknock.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "youtilityknock",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "youtilityknock.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "426528140931",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:426528140931:web:91366949118c237fe1f5b6",
};

// ── Super-admin "mirror" (impersonation) ────────────────────────────────────
// admin.html opens /app/#imp=<customToken> to act AS another user. When that
// token is present we run the app on a SEPARATE Firebase app instance with
// in-memory (tab-local) persistence, so the operator's own session — stored on
// the default instance — is never overwritten.
const impToken =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.hash.replace(/^#/, "")).get("imp")
    : null;
export const isImpersonating = !!impToken;

export const app = initializeApp(firebaseConfig, isImpersonating ? "impersonation" : undefined);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);
export const googleProvider = new GoogleAuthProvider();

if (isImpersonating && impToken) {
  // Strip the token from the URL immediately so it isn't bookmarked/leaked.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  setPersistence(auth, inMemoryPersistence)
    .then(() => signInWithCustomToken(auth, impToken))
    .catch((err) => console.error("Impersonation sign-in failed:", err));
}

// Wire up local emulators when developing against `npm run emulators`.
if (import.meta.env.VITE_USE_EMULATORS === "1") {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
  connectFunctionsEmulator(functions, "localhost", 5001);
}
