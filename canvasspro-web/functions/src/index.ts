import { onRequest, onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

const KNOCKSTAT = {
  baseUrl: process.env.KNOCKSTAT_BASE_URL || "https://api.knockstat.com/v1",
  endpoint: process.env.KNOCKSTAT_ENDPOINT || "/property",
  addressParam: "address",
};

type Role = "rep" | "manager" | "admin";
const ROLES: Role[] = ["rep", "manager", "admin"];

interface Caller {
  uid: string;
  isSuper: boolean;
  role: Role | null;
  companyId: string | null;
}

// Resolve the calling user's privileges from their token claim + profile.
async function getCaller(request: CallableRequest): Promise<Caller> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const isSuper = request.auth.token.superAdmin === true;
  const snap = await db.doc(`users/${uid}`).get();
  const data = snap.data();
  return {
    uid,
    isSuper,
    role: (data?.role as Role) ?? null,
    companyId: (data?.companyId as string) ?? null,
  };
}

// Returns the company an action may target, or throws. Super-admins may act on
// any company; company admins only on their own.
function authorizeForCompany(caller: Caller, companyId: string | undefined): string {
  if (!companyId) throw new HttpsError("invalid-argument", "companyId is required.");
  if (caller.isSuper) return companyId;
  if (caller.role === "admin" && caller.companyId === companyId) return companyId;
  throw new HttpsError("permission-denied", "Not allowed to manage this company.");
}

// Guard: a company admin may not touch a user outside their company or a
// super-admin account.
async function authorizeForTargetUser(caller: Caller, targetUid: string) {
  if (caller.uid === targetUid && !caller.isSuper) {
    throw new HttpsError("permission-denied", "You can't change your own access.");
  }
  const snap = await db.doc(`users/${targetUid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const target = snap.data()!;
  if (caller.isSuper) return target;
  if (caller.role === "admin" && target.companyId === caller.companyId) {
    const claims = (await getAuth().getUser(targetUid)).customClaims || {};
    if (claims.superAdmin === true) {
      throw new HttpsError("permission-denied", "Cannot modify a super-admin.");
    }
    return target;
  }
  throw new HttpsError("permission-denied", "Not allowed to manage this user.");
}

// ───────────────────────────────────────────────────────────────────────────
// /api/knockstat — authenticated proxy. The API key stays server-side; the
// client only sends a Firebase ID token. Mounted via Hosting rewrite.
// ───────────────────────────────────────────────────────────────────────────
export const api = onRequest({ cors: true }, async (req, res) => {
  if (!req.path.endsWith("/knockstat")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);
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
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
    const body = await upstream.text();
    res.status(upstream.status).set("Content-Type", "application/json").send(body);
  } catch (err) {
    logger.error("Knockstat request failed", err);
    res.status(502).json({ error: "Upstream request failed" });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// createCompany — super-admin only. Creates a tenant.
// ───────────────────────────────────────────────────────────────────────────
export const createCompany = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");

  const { name, plan } = request.data as { name?: string; plan?: string };
  if (!name?.trim()) throw new HttpsError("invalid-argument", "Company name required.");

  const ref = await db.collection("companies").add({
    name: name.trim(),
    plan: plan || "standard",
    status: "active",
    createdAt: Date.now(),
    createdBy: caller.uid,
  });
  logger.info(`Company ${ref.id} created by ${caller.uid}`);
  return { ok: true, companyId: ref.id };
});

// ───────────────────────────────────────────────────────────────────────────
// createUser — provisions an account inside a company (auth user + claims +
// profile). Super-admin (any company) or company admin (own company).
// ───────────────────────────────────────────────────────────────────────────
export const createUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, email, password, role } = request.data as {
    companyId?: string;
    name?: string;
    email?: string;
    password?: string;
    role?: Role;
  };
  const targetCompany = authorizeForCompany(caller, companyId);

  if (!email?.trim() || !password || password.length < 6) {
    throw new HttpsError("invalid-argument", "Valid email and 6+ char password required.");
  }
  const finalRole: Role = ROLES.includes(role as Role) ? (role as Role) : "rep";

  let userRecord;
  try {
    userRecord = await getAuth().createUser({
      email: email.trim(),
      password,
      displayName: name?.trim() || email.split("@")[0],
    });
  } catch (err: any) {
    if (err?.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "That email is already in use.");
    }
    throw new HttpsError("internal", err?.message || "Could not create user.");
  }

  await getAuth().setCustomUserClaims(userRecord.uid, {
    role: finalRole,
    companyId: targetCompany,
  });
  await db.doc(`users/${userRecord.uid}`).set({
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: finalRole,
    companyId: targetCompany,
    disabled: false,
    createdAt: Date.now(),
    createdBy: caller.uid,
  });
  logger.info(`User ${userRecord.uid} created in ${targetCompany} by ${caller.uid}`);
  return { ok: true, uid: userRecord.uid };
});

// ───────────────────────────────────────────────────────────────────────────
// setUserRole — change a user's role (within company rules above).
// ───────────────────────────────────────────────────────────────────────────
export const setUserRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, role } = request.data as { uid?: string; role?: Role };
  if (!uid || !ROLES.includes(role as Role)) {
    throw new HttpsError("invalid-argument", "uid and a valid role are required.");
  }
  const target = await authorizeForTargetUser(caller, uid);

  // Preserve existing claims (companyId, superAdmin) while changing role.
  const existing = (await getAuth().getUser(uid)).customClaims || {};
  await getAuth().setCustomUserClaims(uid, { ...existing, role });
  await db.doc(`users/${uid}`).set({ role }, { merge: true });
  logger.info(`Role for ${uid} (company ${target.companyId}) set to ${role} by ${caller.uid}`);
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// setUserDisabled — disable/enable an account (revokes app + login access).
// ───────────────────────────────────────────────────────────────────────────
export const setUserDisabled = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, disabled } = request.data as { uid?: string; disabled?: boolean };
  if (!uid || typeof disabled !== "boolean") {
    throw new HttpsError("invalid-argument", "uid and disabled flag are required.");
  }
  await authorizeForTargetUser(caller, uid);

  await getAuth().updateUser(uid, { disabled });
  if (disabled) await getAuth().revokeRefreshTokens(uid);
  await db.doc(`users/${uid}`).set(
    { disabled, disabledAt: disabled ? Date.now() : FieldValue.delete() },
    { merge: true }
  );
  logger.info(`User ${uid} ${disabled ? "disabled" : "enabled"} by ${caller.uid}`);
  return { ok: true };
});
