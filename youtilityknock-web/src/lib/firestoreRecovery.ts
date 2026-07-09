import { terminate, clearIndexedDbPersistence } from "firebase/firestore";
import { db } from "../firebase";

// Firestore's on-device IndexedDB cache (persistentLocalCache, see firebase.ts)
// can wedge into a corrupt "INTERNAL ASSERTION FAILED: Unexpected state" — a
// long-standing firebase-js-sdk bug, most common in the iOS WKWebView the native
// app runs in. Once wedged, EVERY read/write on that device throws until the
// cache is cleared, which otherwise strands a rep at a door (their only fix was
// to delete + reinstall the app). We detect it and self-heal: wipe the cache and
// reload once, so the app recovers on its own.

const FATAL_RE = /INTERNAL ASSERTION FAILED|Unexpected state/i;
const GUARD_KEY = "yk-fs-heal-at";
const COOLDOWN_MS = 60_000; // heal at most once a minute → a crash-on-reload can't loop
let healing = false;

// True for the fatal Firestore SDK assertion (not an ordinary "permission
// denied" / "unavailable" error — those are normal and shouldn't wipe anything).
export function isFatalFirestoreError(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e ?? "");
  return FATAL_RE.test(msg);
}

async function wipeFirestoreCache(): Promise<void> {
  // Preferred path: let the SDK tear down and clear its own store.
  try { await terminate(db); } catch { /* already wedged — keep going */ }
  try { await clearIndexedDbPersistence(db); return; } catch { /* fall back to a raw delete */ }
  // Fallback: delete the underlying IndexedDB databases directly. clearIndexedDb…
  // can refuse when the client is in a bad state, so we don't rely on it alone.
  const idb = typeof indexedDB !== "undefined" ? indexedDB : null;
  if (!idb) return;
  const del = (name: string) =>
    new Promise<void>((res) => {
      try {
        const req = idb.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => res();
      } catch { res(); }
    });
  // Known name for this project, plus anything the browser reports that looks
  // like a Firestore store (databases() isn't available in every WebView).
  const names = new Set<string>(["firestore/[DEFAULT]/youtilityknock/main"]);
  try {
    const list = (idb as { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (typeof list === "function") {
      for (const d of await list.call(idb)) if (d.name && d.name.startsWith("firestore")) names.add(d.name);
    }
  } catch { /* enumeration unsupported — the known name above still gets deleted */ }
  await Promise.all([...names].map(del));
}

// Wipe the corrupt cache and reload — but at most once per COOLDOWN_MS, so a
// crash that reappears immediately after the reload can't spin the app forever.
// Returns true if a heal is underway (caller should show a "repairing" note),
// false if we're inside the cooldown and the raw error should surface instead.
export function recoverFirestore(): boolean {
  if (healing) return true;
  let last = 0;
  try { last = Number(localStorage.getItem(GUARD_KEY)) || 0; } catch { /* private mode */ }
  if (last && Date.now() - last < COOLDOWN_MS) return false;
  healing = true;
  try { localStorage.setItem(GUARD_KEY, String(Date.now())); } catch { /* ignore */ }
  void wipeFirestoreCache().finally(() => window.location.reload());
  return true;
}

// Backstop for uncaught cases — live snapshot listeners and anything that doesn't
// route through an explicit try/catch. Caught write paths call recoverFirestore()
// directly (so the user sees a friendly note); these listeners catch the rest.
export function installFirestoreCrashRecovery(): void {
  if (typeof window === "undefined") return;
  const onErr = (raw: unknown) => { if (isFatalFirestoreError(raw)) recoverFirestore(); };
  window.addEventListener("error", (e) => onErr((e as ErrorEvent).error ?? (e as ErrorEvent).message));
  window.addEventListener("unhandledrejection", (e) => onErr((e as PromiseRejectionEvent).reason));
}
