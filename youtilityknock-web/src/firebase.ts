import { initializeApp } from "firebase/app";
import {
  getAuth,
  initializeAuth,
  browserLocalPersistence,
  connectAuthEmulator,
  GoogleAuthProvider,
  setPersistence,
  inMemoryPersistence,
  signInWithCustomToken,
} from "firebase/auth";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  memoryLocalCache,
} from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
import { getStorage } from "firebase/storage";
import { Capacitor } from "@capacitor/core";

// Native (Capacitor) WebView vs. a regular browser. The capacitor:// origin
// changes how Firebase's storage-based features behave, so we adjust below.
const isNative = Capacitor.isNativePlatform();

// Public client identifiers for the youtilityknock Firebase project. These
// are safe to ship in the bundle — security is enforced by Firebase Auth +
// Firestore rules, not by keeping these secret. Env vars override the literals
// (e.g. to point at a different project) but default to the live config so a
// build works without a .env file.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyAAfrLWkY_WS7yabCgW_WZJu973J5iGcBI",
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
// In the native WebView, Firebase Auth's default persistence probing (indexedDB)
// can hang under the capacitor:// origin — onAuthStateChanged never fires and
// the app is stuck on "Loading…". Pin auth to localStorage there, which is
// reliable in WKWebView. The web build keeps the default behavior.
export const auth =
  isNative && !isImpersonating
    ? initializeAuth(app, { persistence: browserLocalPersistence })
    : getAuth(app);
// Persist Firestore to IndexedDB so writes made on a flaky/no connection (the
// norm when knocking doors) survive an app refresh or reload and sync once
// signal returns. Without this, a queued write lives only in memory and is lost
// on reload — the lead "saves" in the UI but never reaches the server.
// The impersonation instance stays tab-local (memory only) so an operator's
// device never caches another user's data to disk.
export const db = initializeFirestore(app, {
  localCache: isImpersonating
    ? memoryLocalCache()
    : persistentLocalCache({
        // Native is a single WebView; the multi-tab manager relies on Web Locks /
        // BroadcastChannel, which can hang in WKWebView. Use the single-tab
        // manager there. Web keeps multi-tab so multiple browser tabs stay synced.
        tabManager: isNative
          ? persistentSingleTabManager(undefined)
          : persistentMultipleTabManager(),
      }),
});
export const functions = getFunctions(app);
export const storage = getStorage(app);
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
