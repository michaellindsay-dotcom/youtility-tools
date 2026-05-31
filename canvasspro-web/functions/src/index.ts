import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

const KNOCKSTAT = {
  baseUrl: process.env.KNOCKSTAT_BASE_URL || "https://api.knockstat.com/v1",
  endpoint: process.env.KNOCKSTAT_ENDPOINT || "/property",
  addressParam: "address",
};

// ---------------------------------------------------------------------------
// /api/knockstat — authenticated proxy to the Knockstat property API.
// The API key stays server-side; the browser only sends a Firebase ID token.
// Mounted via the Hosting rewrite "/api/**" → function "api".
// ---------------------------------------------------------------------------
export const api = onRequest({ cors: true }, async (req, res) => {
  // Only the knockstat lookup route is implemented here.
  if (!req.path.endsWith("/knockstat")) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // Verify the caller is a signed-in Canvass Pro user.
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  try {
    await getAuth().verifyIdToken(match[1]);
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  const address = (req.query.address as string | undefined)?.trim();
  if (!address) {
    res.status(400).json({ error: "address query param required" });
    return;
  }

  const apiKey = process.env.KNOCKSTAT_API_KEY;
  if (!apiKey) {
    logger.error("KNOCKSTAT_API_KEY is not configured");
    res.status(503).json({ error: "Lookup service not configured" });
    return;
  }

  try {
    const url = new URL(KNOCKSTAT.baseUrl + KNOCKSTAT.endpoint);
    url.searchParams.set(KNOCKSTAT.addressParam, address);
    const upstream = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const body = await upstream.text();
    res
      .status(upstream.status)
      .set("Content-Type", "application/json")
      .send(body);
  } catch (err) {
    logger.error("Knockstat request failed", err);
    res.status(502).json({ error: "Upstream request failed" });
  }
});

// ---------------------------------------------------------------------------
// setUserRole — callable, admin-only. Sets a custom claim + the Firestore
// users/{uid}.role field. Client-side role edits are blocked by rules.
// ---------------------------------------------------------------------------
export const setUserRole = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
  if (callerSnap.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Admins only.");
  }

  const { uid, role } = request.data as { uid?: string; role?: string };
  if (!uid || !["rep", "manager", "admin"].includes(role || "")) {
    throw new HttpsError("invalid-argument", "uid and a valid role are required.");
  }

  await getAuth().setCustomUserClaims(uid, { role });
  await db.doc(`users/${uid}`).set({ role }, { merge: true });
  logger.info(`Role for ${uid} set to ${role} by ${request.auth.uid}`);
  return { ok: true };
});
