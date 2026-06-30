// Native push notifications (iOS/Android via @capacitor-firebase/messaging).
//
// Everything here is a no-op on the web build: the dynamic import only runs
// inside `Capacitor.isNativePlatform()`, so a normal browser session never
// touches Firebase Messaging and the bundle stays unaffected. Any failure
// (permission denied, plugin missing, network) is swallowed — push is purely
// additive and must never block login or crash the app.
//
// Tokens are stored on the user's own `users/{uid}` doc via the
// `registerPushToken` Cloud Function (the doc is server-write-only by rule,
// so the device can't write it directly). The matching backend sends a push
// through this token whenever `notifyUser` fires for an offline user.
import { Capacitor } from "@capacitor/core";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

let started = false;
let currentToken: string | null = null;

async function saveToken(token: string): Promise<void> {
  try {
    await httpsCallable(functions, "registerPushToken")({ token, platform: Capacitor.getPlatform() });
  } catch (e) {
    console.warn("registerPushToken failed", e);
  }
}

/**
 * Request permission, fetch the device's FCM token, persist it, and wire up
 * tap-to-navigate. Safe to call repeatedly — it only runs once per session.
 * @param navigate optional router navigate, used when the user taps a push.
 */
export async function initPush(navigate?: (path: string) => void): Promise<void> {
  if (!Capacitor.isNativePlatform() || started) return;
  started = true;
  try {
    const { FirebaseMessaging } = await import("@capacitor-firebase/messaging");

    const perm = await FirebaseMessaging.requestPermissions();
    if (perm.receive !== "granted") {
      started = false; // let a later attempt re-prompt if the user enables it in Settings
      return;
    }

    const { token } = await FirebaseMessaging.getToken();
    if (token) {
      currentToken = token;
      await saveToken(token);
    }

    // The token can rotate; keep the stored copy current.
    await FirebaseMessaging.addListener("tokenReceived", (event: { token: string }) => {
      if (event?.token && event.token !== currentToken) {
        currentToken = event.token;
        void saveToken(event.token);
      }
    });

    // Tapping a delivered notification deep-links into the relevant screen.
    await FirebaseMessaging.addListener("notificationActionPerformed", (event: any) => {
      const link = event?.notification?.data?.link;
      if (link && navigate) navigate(String(link));
    });
  } catch (e) {
    started = false;
    console.warn("push init failed", e);
  }
}

/** Drop this device's token on sign-out so a shared phone stops getting pushes. */
export async function teardownPush(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !currentToken) return;
  try {
    await httpsCallable(functions, "unregisterPushToken")({ token: currentToken });
  } catch {
    /* best-effort */
  }
  currentToken = null;
  started = false;
}
