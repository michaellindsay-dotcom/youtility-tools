import { initializeApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

// Public client identifiers for the canvasspro-7edd6 Firebase project. These
// are safe to ship in the bundle — security is enforced by Firebase Auth +
// Firestore rules, not by keeping these secret. Env vars override the literals
// (e.g. to point at a different project) but default to the live config so a
// build works without a .env file.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDngv3feWeWn0kpjs_bqKwth2MDHCgGRAA",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "canvasspro-7edd6.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "canvasspro-7edd6",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "canvasspro-7edd6.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "19980259659",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:19980259659:web:d4ace641083db2b99c98ce",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);
export const googleProvider = new GoogleAuthProvider();

// Wire up local emulators when developing against `npm run emulators`.
if (import.meta.env.VITE_USE_EMULATORS === "1") {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
  connectFunctionsEmulator(functions, "localhost", 5001);
}
