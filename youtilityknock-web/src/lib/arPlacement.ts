// In-app AR battery placement + capture (iOS, native ARKit).
//
// Bridges to the custom ARPlacement Capacitor plugin (youtilityknock-web/
// ios-src/*). On web — or any platform without the plugin / ARKit — every
// entry point degrades to a safe no-op so the existing photo flow is the
// fallback. Nothing here can break the web build.
import { Capacitor, registerPlugin } from "@capacitor/core";

interface ARPlacementPlugin {
  isSupported(): Promise<{ supported: boolean }>;
  capture(options: { modelName?: string }): Promise<{ photoBase64?: string; cancelled?: boolean }>;
}

const ARPlacement = registerPlugin<ARPlacementPlugin>("ARPlacement");

/** True only on a native device whose hardware supports ARKit world tracking. */
export async function isARSupported(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { supported } = await ARPlacement.isSupported();
    return !!supported;
  } catch {
    return false;
  }
}

/**
 * Open the full-screen AR placer. The user drops the battery on a real surface
 * and taps Capture; we get back a JPEG of the live AR scene as a File ready to
 * drop straight into the placement-photos list. Returns null if cancelled or
 * unavailable.
 */
export async function captureARPlacement(modelName = "battery"): Promise<File | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const res = await ARPlacement.capture({ modelName });
    if (res.cancelled || !res.photoBase64) return null;
    const binary = atob(res.photoBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], `ar-placement-${Date.now()}.jpg`, { type: "image/jpeg" });
  } catch (e) {
    console.warn("AR capture failed", e);
    return null;
  }
}
