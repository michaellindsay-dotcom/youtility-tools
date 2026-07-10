import { Capacitor } from "@capacitor/core";
import { FirebaseMessaging } from "@capacitor-firebase/messaging";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

// Native push (FCM/APNs) wiring. Everything here is a no-op on the web build —
// push only runs inside the iOS/Android app. Server side, notifyUser() sends to
// the tokens we register here.

let initialized = false;
let currentToken: string | null = null;

async function saveToken(token?: string | null) {
  if (!token || token === currentToken) return;
  currentToken = token;
  try { await httpsCallable(functions, "registerPushToken")({ token, platform: Capacitor.getPlatform() }); }
  catch (e) { console.warn("registerPushToken failed", e); }
}

// Wire push once, after sign-in. `onOpenLink` is called with an in-app route
// when the user taps a notification.
export async function initPush(onOpenLink: (link: string) => void): Promise<void> {
  if (initialized || !Capacitor.isNativePlatform()) return;
  initialized = true;
  try {
    const perm = await FirebaseMessaging.requestPermissions();
    if (perm.receive !== "granted") { initialized = false; return; }

    const { token } = await FirebaseMessaging.getToken();
    await saveToken(token);

    // Firebase can rotate the token; keep the server copy current.
    await FirebaseMessaging.addListener("tokenReceived", (e) => { void saveToken(e.token); });

    // Tapping a push opens the app to the notification's link. Links are stored
    // as hosting paths ("/app/..."); strip the origin + /app base so the in-app
    // router can navigate to the route.
    await FirebaseMessaging.addListener("notificationActionPerformed", (e) => {
      const link = (e.notification?.data as Record<string, unknown> | undefined)?.link;
      if (typeof link === "string" && link) {
        onOpenLink(link.replace(/^https?:\/\/[^/]+/, "").replace(/^\/app/, "") || "/");
      }
    });
  } catch (e) {
    console.warn("push init failed", e);
    initialized = false;
  }
}

// Drop this device's token — called on sign-out so a shared phone stops getting
// the previous user's pushes.
export async function teardownPush(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (currentToken) await httpsCallable(functions, "unregisterPushToken")({ token: currentToken });
    await FirebaseMessaging.removeAllListeners();
    await FirebaseMessaging.deleteToken().catch(() => {});
  } catch (e) {
    console.warn("push teardown failed", e);
  } finally {
    currentToken = null;
    initialized = false;
  }
}
