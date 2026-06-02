import { onRequest, onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHmac } from "crypto";

initializeApp();
const db = getFirestore();

const ATTOM = {
  baseUrl: process.env.ATTOM_API_URL || "https://api.gateway.attomdata.com/propertyapi/v1.0.0",
  key: process.env.ATTOM_API_KEY || "",
};

async function attomGet(path: string, params: Record<string, string | number | undefined>) {
  const url = new URL(ATTOM.baseUrl + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  const res = await fetch(url.toString(), { headers: { apikey: ATTOM.key, Accept: "application/json" } });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// BatchData skip-tracing — owner phones/emails (ATTOM doesn't provide contact).
const BATCH = {
  baseUrl: process.env.BATCHDATA_API_URL || "https://api.batchdata.com",
  key: process.env.BATCHDATA_API_KEY || "",
  enabled: process.env.BATCHDATA_SKIPTRACE !== "0",
};

async function batchSkipTrace(attomJson: any, address1: string, address2: string) {
  const p = attomJson?.property?.[0] || {};
  const o1 = p?.assessment?.owner?.owner1 || p?.owner?.owner1 || {};
  const addr = p?.address || {};
  const m = address2.match(/^(.*?),?\s*([A-Za-z]{2})\s*(\d{5})?/) || [];
  const first = String(o1.firstNameAndMi || o1.firstName || o1.firstname || "").trim().split(/\s+/)[0] || "";
  const last = o1.lastName || o1.lastname || "";
  const request: any = {
    propertyAddress: {
      street: addr.line1 || address1,
      city: addr.locality || (m[1] || "").trim(),
      state: addr.countrySubd || m[2] || "",
      zip: addr.postal1 || m[3] || "",
    },
  };
  if (first && last) request.name = { first, last };

  let httpStatus = 0;
  let bd: any = null;
  try {
    const res = await fetch(`${BATCH.baseUrl}/api/v1/property/skip-trace`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BATCH.key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ requests: [request] }),
    });
    httpStatus = res.status;
    bd = await res.json().catch(() => null);
  } catch (e: any) {
    return { phones: [], emails: [], debug: { error: e?.message || String(e), request } };
  }

  const persons =
    bd?.results?.persons || bd?.persons || bd?.results?.[0]?.persons || bd?.data?.persons || [];
  const p0 = persons[0] || {};
  const phones = (p0.phoneNumbers || p0.phones || [])
    .map((x: any) => (typeof x === "string" ? x : x.number || x.phone || x.phoneNumber))
    .filter(Boolean);
  const emails = (p0.emails || p0.email || [])
    .map((x: any) => (typeof x === "string" ? x : x.email))
    .filter(Boolean);
  // `debug` lets us inspect BatchData's real response shape via the Raw panel.
  return { phones, emails, debug: { httpStatus, response: bd, request } };
}

type Tier = "admin" | "manager" | "user";
const TIERS: Tier[] = ["admin", "manager", "user"];

interface Caller {
  uid: string;
  isSuper: boolean;
  role: string | null;
  companyId: string | null;
}

async function getCaller(request: CallableRequest): Promise<Caller> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const isSuper = request.auth.token.superAdmin === true;
  const snap = await db.doc(`users/${uid}`).get();
  const data = snap.data();
  return {
    uid,
    isSuper,
    role: (data?.role as string) ?? null,
    companyId: (data?.companyId as string) ?? null,
  };
}

// Super-admin (any company) or company admin (own company only).
function authorizeForCompany(caller: Caller, companyId: string | undefined): string {
  if (!companyId) throw new HttpsError("invalid-argument", "companyId is required.");
  if (caller.isSuper) return companyId;
  if (caller.role === "admin" && caller.companyId === companyId) return companyId;
  throw new HttpsError("permission-denied", "Not allowed to manage this company.");
}

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

// Compute a user's managerPath (ancestor uids, nearest first) from a managerId.
async function computeManagerPath(managerId: string | null | undefined): Promise<string[]> {
  if (!managerId) return [];
  const snap = await db.doc(`users/${managerId}`).get();
  if (!snap.exists) return [];
  const m = snap.data()!;
  return [managerId, ...((m.managerPath as string[]) || [])];
}

// Recompute managerPath for every user in a company and visibilityPath for
// every lead, from the current managerId links. Run after any reorg.
async function rebuildCompanyHierarchy(companyId: string) {
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const managerOf: Record<string, string | null> = {};
  usersSnap.forEach((d) => (managerOf[d.id] = (d.data().managerId as string) ?? null));

  // Walk up the chain for each user (cycle-guarded).
  const pathCache: Record<string, string[]> = {};
  function pathFor(uid: string, seen: Set<string> = new Set()): string[] {
    if (pathCache[uid]) return pathCache[uid];
    const mgr = managerOf[uid];
    if (!mgr || seen.has(mgr)) return (pathCache[uid] = []);
    seen.add(mgr);
    const p = [mgr, ...pathFor(mgr, seen)];
    return (pathCache[uid] = p);
  }

  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const d of usersSnap.docs) {
    batch.update(d.ref, { managerPath: pathFor(d.id) });
    if (++ops >= 450) await flush();
  }
  await flush();

  const leadsSnap = await db.collection("leads").where("companyId", "==", companyId).get();
  for (const d of leadsSnap.docs) {
    const owner = (d.data().assignedTo as string) || d.data().createdBy;
    batch.update(d.ref, { visibilityPath: [owner, ...pathFor(owner)] });
    if (++ops >= 450) await flush();
  }
  await flush();

  // Keep per-user stats roll-up reachable by the right managers.
  const statsSnap = await db.collection("userStats").where("companyId", "==", companyId).get();
  for (const d of statsSnap.docs) {
    batch.update(d.ref, { managerPath: pathFor(d.id) });
    if (++ops >= 450) await flush();
  }
  await flush();
}

// ───────────────────────────────────────────────────────────────────────────
// /api/property?address=  — single-home detail (owner + property + sale).
// /api/area?lat=&lng=&radius=  — every home in a radius (for map pins).
// Authenticated proxy to ATTOM Data (key stays server-side).
// ───────────────────────────────────────────────────────────────────────────
export const api = onRequest({ cors: true }, async (req, res) => {
  const isProperty = req.path.endsWith("/property") || req.path.endsWith("/knockstat");
  const isArea = req.path.endsWith("/area");
  if (!isProperty && !isArea) { res.status(404).json({ error: "Not found" }); return; }

  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!match) { res.status(401).json({ error: "Missing bearer token" }); return; }
  try { await getAuth().verifyIdToken(match[1]); }
  catch { res.status(401).json({ error: "Invalid token" }); return; }

  if (!ATTOM.key) {
    logger.error("ATTOM_API_KEY not set");
    res.status(503).json({ error: "Property data not configured — set ATTOM_API_KEY" });
    return;
  }

  try {
    if (isArea) {
      const lat = req.query.lat as string | undefined;
      const lng = req.query.lng as string | undefined;
      const radius = (req.query.radius as string | undefined) || "0.5"; // miles
      if (!lat || !lng) { res.status(400).json({ error: "lat & lng required" }); return; }
      const { ok, status, json } = await attomGet("/property/snapshot", {
        latitude: lat,
        longitude: lng,
        radius,
        pagesize: 200,
      });
      res.status(ok ? 200 : status).json(json);
      return;
    }

    // Single-property detail (owner + property + sale).
    const address = (req.query.address as string | undefined)?.trim();
    if (!address) { res.status(400).json({ error: "address query param required" }); return; }
    const ci = address.indexOf(",");
    const address1 = ci > -1 ? address.slice(0, ci).trim() : address;
    const address2 = ci > -1 ? address.slice(ci + 1).trim() : "";
    const { ok, status, json } = await attomGet("/property/expandedprofile", { address1, address2 });
    if (!ok) { res.status(status).json(json); return; }
    // Merge BatchData skip-trace (owner phones/emails) when configured.
    if (BATCH.enabled && BATCH.key) {
      try {
        const skip = await batchSkipTrace(json, address1, address2);
        (json as any)._skiptrace = { phones: skip.phones, emails: skip.emails };
        (json as any)._skiptrace_debug = skip.debug; // remove once mapping confirmed
      } catch (e) {
        logger.warn("BatchData skip-trace failed (continuing)", e);
      }
    }
    res.status(200).json(json);
  } catch (err) {
    logger.error("ATTOM request failed", err);
    res.status(502).json({ error: "Upstream request failed" });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// createCompany — super-admin only. Seeds default Manager + User roles and a
// top-level team so every company starts with the standard hierarchy.
// ───────────────────────────────────────────────────────────────────────────
export const createCompany = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { name, plan } = request.data as { name?: string; plan?: string };
  if (!name?.trim()) throw new HttpsError("invalid-argument", "Company name required.");

  const ref = await db.collection("companies").add({
    name: name.trim(), plan: plan || "standard", status: "active",
    createdAt: Date.now(), createdBy: caller.uid,
  });
  // Standard seed roles.
  const roles = ref.collection("roles");
  await roles.add({ companyId: ref.id, title: "Manager", baseTier: "manager", rank: 100, isDefault: true, createdAt: Date.now() });
  await roles.add({ companyId: ref.id, title: "User", baseTier: "user", rank: 10, isDefault: true, createdAt: Date.now() });
  await ref.collection("teams").add({ companyId: ref.id, name: "Company", parentTeamId: null, createdAt: Date.now() });

  logger.info(`Company ${ref.id} created by ${caller.uid}`);
  return { ok: true, companyId: ref.id };
});

// ───────────────────────────────────────────────────────────────────────────
// createUser — provisions an account with optional hierarchy placement.
// ───────────────────────────────────────────────────────────────────────────
export const createUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, email, password, tier, roleId, title, teamId, managerId } =
    request.data as {
      companyId?: string; name?: string; email?: string; password?: string;
      tier?: Tier; roleId?: string; title?: string; teamId?: string; managerId?: string;
    };
  const targetCompany = authorizeForCompany(caller, companyId);
  if (!email?.trim() || !password || password.length < 6) {
    throw new HttpsError("invalid-argument", "Valid email and 6+ char password required.");
  }

  // Resolve base tier + title from a custom role when provided.
  let baseTier: Tier = TIERS.includes(tier as Tier) ? (tier as Tier) : "user";
  let roleTitle = title || null;
  if (roleId) {
    const roleSnap = await db.doc(`companies/${targetCompany}/roles/${roleId}`).get();
    if (!roleSnap.exists) throw new HttpsError("invalid-argument", "Unknown role.");
    const r = roleSnap.data()!;
    baseTier = (r.baseTier as Tier) || "user";
    roleTitle = r.title;
  }
  // Only a super-admin may mint another company admin's peer? Company admins
  // can create up to 'admin' within their own company.
  if (baseTier === "admin" && !(caller.isSuper || caller.role === "admin")) {
    throw new HttpsError("permission-denied", "Not allowed to create an admin.");
  }

  let userRecord;
  try {
    userRecord = await getAuth().createUser({
      email: email.trim(), password, displayName: name?.trim() || email.split("@")[0],
    });
  } catch (err: any) {
    if (err?.code === "auth/email-already-exists") throw new HttpsError("already-exists", "That email is already in use.");
    throw new HttpsError("internal", err?.message || "Could not create user.");
  }

  const managerPath = await computeManagerPath(managerId);
  await getAuth().setCustomUserClaims(userRecord.uid, { role: baseTier, companyId: targetCompany });
  await db.doc(`users/${userRecord.uid}`).set({
    uid: userRecord.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: baseTier,
    companyId: targetCompany,
    roleId: roleId || null,
    title: roleTitle,
    teamId: teamId || null,
    managerId: managerId || null,
    managerPath,
    disabled: false,
    createdAt: Date.now(),
    createdBy: caller.uid,
  });
  logger.info(`User ${userRecord.uid} created in ${targetCompany} by ${caller.uid}`);
  return { ok: true, uid: userRecord.uid };
});

// ───────────────────────────────────────────────────────────────────────────
// inviteUser — provisions an account and emails a magic sign-in link. The
// invitee clicks it, is signed in, and is prompted to set their own password.
// No temp password to share.
// ───────────────────────────────────────────────────────────────────────────
const APP_URL = process.env.APP_URL || "https://youtilityknock.web.app";

export const inviteUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, email, tier, roleId, title, teamId, managerId } =
    request.data as {
      companyId?: string; name?: string; email?: string;
      tier?: Tier; roleId?: string; title?: string; teamId?: string; managerId?: string;
    };
  const targetCompany = authorizeForCompany(caller, companyId);
  if (!email?.trim()) throw new HttpsError("invalid-argument", "A valid email is required.");

  let baseTier: Tier = TIERS.includes(tier as Tier) ? (tier as Tier) : "user";
  let roleTitle = title || null;
  if (roleId) {
    const roleSnap = await db.doc(`companies/${targetCompany}/roles/${roleId}`).get();
    if (!roleSnap.exists) throw new HttpsError("invalid-argument", "Unknown role.");
    const r = roleSnap.data()!;
    baseTier = (r.baseTier as Tier) || "user";
    roleTitle = r.title;
  }
  if (baseTier === "admin" && !(caller.isSuper || caller.role === "admin")) {
    throw new HttpsError("permission-denied", "Not allowed to create an admin.");
  }

  // Random throwaway password — the invitee sets their own on first sign-in.
  const tempPw = "Yk-" + Math.random().toString(36).slice(2, 10) + "A9!";
  let userRecord;
  try {
    userRecord = await getAuth().createUser({
      email: email.trim(), password: tempPw, displayName: name?.trim() || email.split("@")[0],
    });
  } catch (err: any) {
    if (err?.code === "auth/email-already-exists") throw new HttpsError("already-exists", "That email is already in use.");
    throw new HttpsError("internal", err?.message || "Could not create user.");
  }

  const managerPath = await computeManagerPath(managerId);
  await getAuth().setCustomUserClaims(userRecord.uid, { role: baseTier, companyId: targetCompany });
  await db.doc(`users/${userRecord.uid}`).set({
    uid: userRecord.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: baseTier,
    companyId: targetCompany,
    roleId: roleId || null,
    title: roleTitle,
    teamId: teamId || null,
    managerId: managerId || null,
    managerPath,
    disabled: false,
    invitePending: true,
    createdAt: Date.now(),
    createdBy: caller.uid,
  });

  // Magic sign-in link → app login (which forces a set-password step).
  let link = "";
  try {
    link = await getAuth().generateSignInWithEmailLink(email.trim(), {
      url: `${APP_URL}/app/login?invite=1`,
      handleCodeInApp: true,
    });
  } catch (err: any) {
    throw new HttpsError("internal", err?.message || "Could not generate invite link.");
  }

  // Email it (best-effort — needs SendGrid configured).
  let emailed = false;
  try {
    const cfg = await getNotifyConfig();
    const companyName = (await db.doc(`companies/${targetCompany}`).get()).data()?.name || "your team";
    emailed = await sendEmail(
      cfg,
      email.trim(),
      "You're invited to YoutilityKnock",
      `Hi ${name || "there"},\n\nYou've been added to ${companyName} on YoutilityKnock.\n\n` +
        `Tap to sign in and set your password:\n${link}\n\n` +
        `This link signs you in directly, then asks you to create a password. ` +
        `If you didn't expect this, you can ignore it.`
    );
  } catch (e) {
    logger.warn("invite email send failed", e);
  }

  logger.info(`User ${userRecord.uid} invited to ${targetCompany} by ${caller.uid} (emailed=${emailed})`);
  return { ok: true, uid: userRecord.uid, inviteLink: link, emailed };
});

// ───────────────────────────────────────────────────────────────────────────
// Company role catalog (titles on a base tier). Company admin / super-admin.
// ───────────────────────────────────────────────────────────────────────────
export const createRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, title, baseTier, rank } = request.data as
    { companyId?: string; title?: string; baseTier?: "manager" | "user"; rank?: number };
  const company = authorizeForCompany(caller, companyId);
  if (!title?.trim()) throw new HttpsError("invalid-argument", "Title required.");
  const tier = baseTier === "manager" ? "manager" : "user";
  const ref = await db.collection(`companies/${company}/roles`).add({
    companyId: company, title: title.trim(), baseTier: tier,
    rank: typeof rank === "number" ? rank : 50, isDefault: false, createdAt: Date.now(),
  });
  return { ok: true, roleId: ref.id };
});

export const updateRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, roleId, title, baseTier, rank } = request.data as
    { companyId?: string; roleId?: string; title?: string; baseTier?: "manager" | "user"; rank?: number };
  const company = authorizeForCompany(caller, companyId);
  if (!roleId) throw new HttpsError("invalid-argument", "roleId required.");
  const patch: Record<string, unknown> = {};
  if (title?.trim()) patch.title = title.trim();
  if (baseTier === "manager" || baseTier === "user") patch.baseTier = baseTier;
  if (typeof rank === "number") patch.rank = rank;
  await db.doc(`companies/${company}/roles/${roleId}`).set(patch, { merge: true });
  return { ok: true };
});

export const deleteRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, roleId } = request.data as { companyId?: string; roleId?: string };
  const company = authorizeForCompany(caller, companyId);
  if (!roleId) throw new HttpsError("invalid-argument", "roleId required.");
  const snap = await db.doc(`companies/${company}/roles/${roleId}`).get();
  if (snap.data()?.isDefault) throw new HttpsError("failed-precondition", "Cannot delete a default role.");
  await snap.ref.delete();
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// Teams.
// ───────────────────────────────────────────────────────────────────────────
export const createTeam = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, parentTeamId, leadUserId } = request.data as
    { companyId?: string; name?: string; parentTeamId?: string | null; leadUserId?: string };
  const company = authorizeForCompany(caller, companyId);
  if (!name?.trim()) throw new HttpsError("invalid-argument", "Team name required.");
  const ref = await db.collection(`companies/${company}/teams`).add({
    companyId: company, name: name.trim(),
    parentTeamId: parentTeamId || null, leadUserId: leadUserId || null, createdAt: Date.now(),
  });
  return { ok: true, teamId: ref.id };
});

export const updateTeam = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, teamId, name, parentTeamId, leadUserId } = request.data as
    { companyId?: string; teamId?: string; name?: string; parentTeamId?: string | null; leadUserId?: string };
  const company = authorizeForCompany(caller, companyId);
  if (!teamId) throw new HttpsError("invalid-argument", "teamId required.");
  const patch: Record<string, unknown> = {};
  if (name?.trim()) patch.name = name.trim();
  if (parentTeamId !== undefined) patch.parentTeamId = parentTeamId || null;
  if (leadUserId !== undefined) patch.leadUserId = leadUserId || null;
  await db.doc(`companies/${company}/teams/${teamId}`).set(patch, { merge: true });
  return { ok: true };
});

export const deleteTeam = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, teamId } = request.data as { companyId?: string; teamId?: string };
  const company = authorizeForCompany(caller, companyId);
  if (!teamId) throw new HttpsError("invalid-argument", "teamId required.");
  await db.doc(`companies/${company}/teams/${teamId}`).delete();
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// assignUserHierarchy — set a user's role/title/team/manager, then rebuild the
// company's managerPath + lead visibilityPath so downstream visibility is exact.
// ───────────────────────────────────────────────────────────────────────────
export const assignUserHierarchy = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, roleId, teamId, managerId } = request.data as
    { uid?: string; roleId?: string; teamId?: string | null; managerId?: string | null };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const target = await authorizeForTargetUser(caller, uid);
  const company = target.companyId as string;

  if (managerId === uid) throw new HttpsError("invalid-argument", "A user can't report to themselves.");

  const patch: Record<string, unknown> = {};
  if (roleId !== undefined) {
    if (roleId) {
      const roleSnap = await db.doc(`companies/${company}/roles/${roleId}`).get();
      if (!roleSnap.exists) throw new HttpsError("invalid-argument", "Unknown role.");
      const r = roleSnap.data()!;
      patch.roleId = roleId;
      patch.title = r.title;
      patch.role = r.baseTier; // base tier follows the assigned role
      await getAuth().setCustomUserClaims(uid, {
        ...(await getAuth().getUser(uid)).customClaims,
        role: r.baseTier,
      });
    } else {
      patch.roleId = null;
    }
  }
  if (teamId !== undefined) patch.teamId = teamId || null;
  if (managerId !== undefined) patch.managerId = managerId || null;

  await db.doc(`users/${uid}`).set(patch, { merge: true });
  await rebuildCompanyHierarchy(company);
  logger.info(`Hierarchy updated for ${uid} in ${company} by ${caller.uid}`);
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// setUserRole / setUserDisabled (base-tier changes + enable/disable).
// ───────────────────────────────────────────────────────────────────────────
export const setUserRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, role } = request.data as { uid?: string; role?: Tier };
  if (!uid || !TIERS.includes(role as Tier)) throw new HttpsError("invalid-argument", "uid and a valid tier are required.");
  await authorizeForTargetUser(caller, uid);
  const existing = (await getAuth().getUser(uid)).customClaims || {};
  await getAuth().setCustomUserClaims(uid, { ...existing, role });
  await db.doc(`users/${uid}`).set({ role }, { merge: true });
  return { ok: true };
});

export const setUserDisabled = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, disabled } = request.data as { uid?: string; disabled?: boolean };
  if (!uid || typeof disabled !== "boolean") throw new HttpsError("invalid-argument", "uid and disabled flag required.");
  await authorizeForTargetUser(caller, uid);
  await getAuth().updateUser(uid, { disabled });
  if (disabled) await getAuth().revokeRefreshTokens(uid);
  await db.doc(`users/${uid}`).set(
    { disabled, disabledAt: disabled ? Date.now() : FieldValue.delete() }, { merge: true });
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// impersonate — SUPER-ADMIN mirror. Returns a custom token that signs the
// caller in AS the target user (full act-as) and writes an audit log.
// ───────────────────────────────────────────────────────────────────────────
export const impersonate = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { targetUid } = request.data as { targetUid?: string };
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid required.");

  const targetSnap = await db.doc(`users/${targetUid}`).get();
  if (!targetSnap.exists) throw new HttpsError("not-found", "Target user not found.");
  const target = targetSnap.data()!;

  const log = await db.collection("impersonationLogs").add({
    superUid: caller.uid,
    targetUid,
    targetEmail: target.email || null,
    targetCompanyId: target.companyId || null,
    startedAt: Date.now(),
  });

  // developerClaims are non-reserved; flags the session as an impersonation.
  const token = await getAuth().createCustomToken(targetUid, {
    impersonatedBy: caller.uid,
    impersonationLogId: log.id,
  });
  logger.warn(`IMPERSONATION: ${caller.uid} -> ${targetUid} (log ${log.id})`);
  return { ok: true, token, logId: log.id, targetEmail: target.email || null };
});

// ════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS — in-app + email + SMS fallback for chat / DMs / scheduler.
//
// Delivery policy (per the product spec):
//   • An in-app notification doc is ALWAYS written (drives the bell + badge and
//     becomes a native push once the mobile apps ship).
//   • If the recipient is currently OFFLINE (no presence heartbeat in the last
//     ONLINE_WINDOW_MS), we ALSO send email (SendGrid) and SMS (Twilio) so they
//     hear about it before the apps are live.
// Provider keys come from the super-admin console (Firestore config/notifications),
// falling back to env vars. Absent keys → email/SMS skipped, no error, so the
// core app works without them configured.
// ════════════════════════════════════════════════════════════════════════════

interface NotifyConfig {
  sendgridKey: string;
  sendgridFrom: string;
  sendgridFromName: string;
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
}

// Read provider config: Firestore (set via super-admin console) overrides env.
async function getNotifyConfig(): Promise<NotifyConfig> {
  let c: Record<string, string> = {};
  try {
    const snap = await db.doc("config/notifications").get();
    if (snap.exists) c = (snap.data() as Record<string, string>) || {};
  } catch (e) {
    logger.warn("getNotifyConfig read failed", e);
  }
  return {
    sendgridKey: c.sendgridKey || process.env.SENDGRID_API_KEY || "",
    sendgridFrom: c.sendgridFrom || process.env.SENDGRID_FROM || "",
    sendgridFromName: c.sendgridFromName || process.env.SENDGRID_FROM_NAME || "YoutilityKnock",
    twilioSid: c.twilioSid || process.env.TWILIO_ACCOUNT_SID || "",
    twilioToken: c.twilioToken || process.env.TWILIO_AUTH_TOKEN || "",
    twilioFrom: c.twilioFrom || process.env.TWILIO_FROM || "",
  };
}

// A user is considered "online" if their presence doc was touched this recently.
const ONLINE_WINDOW_MS = 90 * 1000;

async function sendEmail(cfg: NotifyConfig, to: string, subject: string, text: string): Promise<boolean> {
  if (!cfg.sendgridKey || !cfg.sendgridFrom || !to) return false;
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.sendgridKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: cfg.sendgridFrom, name: cfg.sendgridFromName },
        subject,
        content: [{ type: "text/plain", value: text }],
      }),
    });
    if (!res.ok) logger.warn(`SendGrid ${res.status}: ${await res.text().catch(() => "")}`);
    return res.ok;
  } catch (e) {
    logger.error("sendEmail failed", e);
    return false;
  }
}

async function sendSms(cfg: NotifyConfig, to: string, body: string): Promise<boolean> {
  if (!cfg.twilioSid || !cfg.twilioToken || !cfg.twilioFrom || !to) return false;
  try {
    const form = new URLSearchParams({ To: to, From: cfg.twilioFrom, Body: body });
    const auth = Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) logger.warn(`Twilio ${res.status}: ${await res.text().catch(() => "")}`);
    return res.ok;
  } catch (e) {
    logger.error("sendSms failed", e);
    return false;
  }
}

async function isOnline(uid: string): Promise<boolean> {
  try {
    const snap = await db.doc(`presence/${uid}`).get();
    const last = snap.exists ? Number(snap.data()?.lastSeen || 0) : 0;
    return Date.now() - last < ONLINE_WINDOW_MS;
  } catch {
    return false;
  }
}

interface NotifyOpts {
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}

// Write the in-app notification, then email + SMS the user iff they're offline.
async function notifyUser(opts: NotifyOpts): Promise<void> {
  const { userId, type, title, body = "", link = "" } = opts;
  await db.collection("notifications").add({
    userId,
    type,
    title,
    body,
    link,
    read: false,
    createdAt: Date.now(),
  });

  if (await isOnline(userId)) return; // in-app/push is enough when they're active

  const userSnap = await db.doc(`users/${userId}`).get();
  if (!userSnap.exists) return;
  const u = userSnap.data()!;
  const cfg = await getNotifyConfig();
  const line = body ? `${title}\n\n${body}` : title;
  await Promise.all([
    u.email ? sendEmail(cfg, u.email, `YoutilityKnock — ${title}`, line) : Promise.resolve(false),
    u.phone ? sendSms(cfg, u.phone, line) : Promise.resolve(false),
  ]);
}

// ── trigger: new company-channel chat message → notify the rest of the company
export const onChatMessage = onDocumentCreated("chat/{messageId}", async (event) => {
  const msg = event.data?.data();
  if (!msg?.companyId) return;
  const preview = msg.text ? String(msg.text).slice(0, 140) : msg.imageUrl ? "📷 Photo" : "";
  const members = await db.collection("users").where("companyId", "==", msg.companyId).get();
  await Promise.all(
    members.docs
      .filter((d) => d.id !== msg.userId && d.data()?.disabled !== true)
      .map((d) =>
        notifyUser({
          userId: d.id,
          type: "chat",
          title: `${msg.userName || "Teammate"} in Team Chat`,
          body: preview,
          link: "/app/chat",
        })
      )
  );
});

// ── trigger: new DM → notify the other member(s) of that channel
export const onDmMessage = onDocumentCreated("dms/{channelId}/messages/{messageId}", async (event) => {
  const msg = event.data?.data();
  const channelId = event.params.channelId;
  if (!msg) return;
  const chanSnap = await db.doc(`dms/${channelId}`).get();
  const members: string[] = chanSnap.exists ? chanSnap.data()?.members || [] : [];
  const preview = msg.text ? String(msg.text).slice(0, 140) : msg.imageUrl ? "📷 Photo" : "";
  await Promise.all(
    members
      .filter((m) => m !== msg.userId)
      .map((m) =>
        notifyUser({
          userId: m,
          type: "dm",
          title: `New message from ${msg.userName || "a teammate"}`,
          body: preview,
          link: "/app/chat",
        })
      )
  );
});

// ── scheduled: remind owners of upcoming events (appointments/go-backs/follow-ups)
// Runs every 15 min; fires once per event when it falls inside the next 30-min
// window. `reminded` flag guards against double-sends.
export const eventReminders = onSchedule("every 15 minutes", async () => {
  const now = Date.now();
  const windowEnd = now + 30 * 60 * 1000;
  const due = await db
    .collection("events")
    .where("startAt", ">=", now)
    .where("startAt", "<=", windowEnd)
    .get();
  await Promise.all(
    due.docs
      .filter((d) => d.data()?.reminded !== true)
      .map(async (d) => {
        const ev = d.data();
        const when = new Date(ev.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const label =
          ev.type === "appointment" ? "Appointment" : ev.type === "go_back" ? "Go-back" : "Follow-up";
        await notifyUser({
          userId: ev.userId,
          type: "event",
          title: `${label} at ${when}`,
          body: [ev.title, ev.address].filter(Boolean).join(" — "),
          link: "/app/schedule",
        });
        await d.ref.update({ reminded: true });
      })
  );
});

// ── super-admin: notification provider config (SendGrid / Twilio) ────────────
// Secrets live in Firestore config/notifications, readable ONLY by Cloud
// Functions (rules deny client access). getNotificationConfig returns a MASKED
// view (configured flags + non-secret fields) so the console can show status
// without ever shipping the keys back to the browser.
function mask(v?: string): string {
  if (!v) return "";
  return v.length <= 4 ? "••••" : "••••" + v.slice(-4);
}

export const getNotificationConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const snap = await db.doc("config/notifications").get();
  const c = (snap.exists ? (snap.data() as Record<string, string>) : {}) || {};
  return {
    sendgrid: {
      configured: !!c.sendgridKey,
      keyMask: mask(c.sendgridKey),
      from: c.sendgridFrom || "",
      fromName: c.sendgridFromName || "",
    },
    twilio: {
      configured: !!c.twilioSid && !!c.twilioToken,
      sidMask: mask(c.twilioSid),
      tokenMask: mask(c.twilioToken),
      from: c.twilioFrom || "",
    },
  };
});

export const setNotificationConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  // Secrets: only overwrite when a non-empty value is supplied (blank = keep
  // existing). Non-secret fields are always set from the payload.
  if (typeof d.sendgridKey === "string" && d.sendgridKey.trim()) update.sendgridKey = d.sendgridKey.trim();
  if (typeof d.sendgridFrom === "string") update.sendgridFrom = d.sendgridFrom.trim();
  if (typeof d.sendgridFromName === "string") update.sendgridFromName = d.sendgridFromName.trim();
  if (typeof d.twilioSid === "string" && d.twilioSid.trim()) update.twilioSid = d.twilioSid.trim();
  if (typeof d.twilioToken === "string" && d.twilioToken.trim()) update.twilioToken = d.twilioToken.trim();
  if (typeof d.twilioFrom === "string") update.twilioFrom = d.twilioFrom.trim();
  await db.doc("config/notifications").set(update, { merge: true });
  logger.info(`notification config updated by ${caller.uid}`);
  return { ok: true };
});

// Clear a single provider's stored secrets (super-admin only).
export const clearNotificationProvider = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { provider } = (request.data || {}) as { provider?: string };
  const ref = db.doc("config/notifications");
  if (provider === "sendgrid") {
    await ref.set({ sendgridKey: "", sendgridFrom: "", sendgridFromName: "" }, { merge: true });
  } else if (provider === "twilio") {
    await ref.set({ twilioSid: "", twilioToken: "", twilioFrom: "" }, { merge: true });
  } else {
    throw new HttpsError("invalid-argument", "provider must be 'sendgrid' or 'twilio'.");
  }
  return { ok: true };
});

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULING — company settings, self-service profile, calendar sync, and
// availability-aware assignment.
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_SCHEDULING = {
  apptMinLeadHours: 1,
  apptMaxDaysOut: 30,
  apptDurationMin: 60,
  bufferMin: 0,
  assignment: "self_gen" as const,
  timezone: "America/Denver",
  dayStartMin: 9 * 60,
  dayEndMin: 20 * 60,
  workDays: [1, 2, 3, 4, 5, 6],
  slotMin: 30,
};

// Weekday (0=Sun) + minutes-from-midnight of a timestamp in a given IANA tz.
function localParts(ms: number, tz: string): { dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "America/Denver",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let dow = 0, hh = 0, mm = 0;
  for (const p of parts) {
    if (p.type === "weekday") dow = wd[p.value] ?? 0;
    else if (p.type === "hour") hh = parseInt(p.value, 10) % 24;
    else if (p.type === "minute") mm = parseInt(p.value, 10);
  }
  return { dow, minutes: hh * 60 + mm };
}

function withinBusinessHours(ms: number, sched: any): boolean {
  const { dow, minutes } = localParts(ms, sched.timezone);
  if (Array.isArray(sched.workDays) && sched.workDays.length && !sched.workDays.includes(dow)) return false;
  return minutes >= (sched.dayStartMin ?? 0) && minutes <= (sched.dayEndMin ?? 1440);
}

// ── company admin: scheduling settings (min/max window, duration, routing) ───
export const setCompanySettings = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, scheduling } = (request.data || {}) as {
    companyId?: string;
    scheduling?: Record<string, unknown>;
  };
  authorizeForCompany(caller, companyId);
  if (!scheduling) throw new HttpsError("invalid-argument", "scheduling is required.");
  const days = Array.isArray(scheduling.workDays)
    ? (scheduling.workDays as unknown[]).map((n) => Number(n)).filter((n) => n >= 0 && n <= 6)
    : DEFAULT_SCHEDULING.workDays;
  const s = {
    apptMinLeadHours: Math.max(0, Number(scheduling.apptMinLeadHours) || DEFAULT_SCHEDULING.apptMinLeadHours),
    apptMaxDaysOut: Math.max(1, Number(scheduling.apptMaxDaysOut) || DEFAULT_SCHEDULING.apptMaxDaysOut),
    apptDurationMin: Math.max(5, Number(scheduling.apptDurationMin) || DEFAULT_SCHEDULING.apptDurationMin),
    bufferMin: Math.max(0, Number(scheduling.bufferMin) || 0),
    assignment: ["self_gen", "round_robin", "highest_production", "manual"].includes(String(scheduling.assignment))
      ? String(scheduling.assignment)
      : "self_gen",
    timezone: String(scheduling.timezone || DEFAULT_SCHEDULING.timezone),
    dayStartMin: Math.min(1439, Math.max(0, Number(scheduling.dayStartMin) ?? DEFAULT_SCHEDULING.dayStartMin)),
    dayEndMin: Math.min(1440, Math.max(0, Number(scheduling.dayEndMin) ?? DEFAULT_SCHEDULING.dayEndMin)),
    workDays: days.length ? days : DEFAULT_SCHEDULING.workDays,
    slotMin: Math.max(5, Number(scheduling.slotMin) || DEFAULT_SCHEDULING.slotMin),
  };
  await db.doc(`companies/${companyId}`).set({ scheduling: s }, { merge: true });
  return { ok: true, scheduling: s };
});

// ── self-service: a user sets their own phone (calendar handled via OAuth) ───
export const setMyProfile = onCall(async (request) => {
  const caller = await getCaller(request);
  const { phone } = (request.data || {}) as { phone?: string };
  const update: Record<string, unknown> = {};
  if (typeof phone === "string") {
    const trimmed = phone.trim();
    // Light E.164-ish normalization for the SMS fallback.
    update.phone = trimmed ? (trimmed.startsWith("+") ? trimmed : trimmed.replace(/[^\d]/g, "").replace(/^/, "+1").slice(0, 12)) : "";
  }
  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  await db.doc(`users/${caller.uid}`).set(update, { merge: true });
  return { ok: true, phone: update.phone };
});

// ── integration credentials (OAuth client id/secret) — super-admin only ──────
interface IntegrationConfig {
  googleClientId: string;
  googleClientSecret: string;
  microsoftClientId: string;
  microsoftClientSecret: string;
  microsoftTenant: string;
}
async function getIntegrationConfig(): Promise<IntegrationConfig> {
  let c: Record<string, string> = {};
  try {
    const snap = await db.doc("config/integrations").get();
    if (snap.exists) c = (snap.data() as Record<string, string>) || {};
  } catch (e) {
    logger.warn("getIntegrationConfig failed", e);
  }
  return {
    googleClientId: c.googleClientId || process.env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: c.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "",
    microsoftClientId: c.microsoftClientId || process.env.MS_CLIENT_ID || "",
    microsoftClientSecret: c.microsoftClientSecret || process.env.MS_CLIENT_SECRET || "",
    microsoftTenant: c.microsoftTenant || process.env.MS_TENANT || "common",
  };
}

// Public (non-secret) integration config — any signed-in user, so the client
// can launch the OAuth flow with the right client IDs.
export const getIntegrationPublicConfig = onCall(async (request) => {
  await getCaller(request);
  const c = await getIntegrationConfig();
  return {
    google: { clientId: c.googleClientId, configured: !!c.googleClientId && !!c.googleClientSecret },
    microsoft: {
      clientId: c.microsoftClientId,
      tenant: c.microsoftTenant,
      configured: !!c.microsoftClientId && !!c.microsoftClientSecret,
    },
  };
});

export const setIntegrationConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.googleClientId === "string") update.googleClientId = d.googleClientId.trim();
  if (typeof d.googleClientSecret === "string" && d.googleClientSecret.trim()) update.googleClientSecret = d.googleClientSecret.trim();
  if (typeof d.microsoftClientId === "string") update.microsoftClientId = d.microsoftClientId.trim();
  if (typeof d.microsoftClientSecret === "string" && d.microsoftClientSecret.trim()) update.microsoftClientSecret = d.microsoftClientSecret.trim();
  if (typeof d.microsoftTenant === "string") update.microsoftTenant = d.microsoftTenant.trim() || "common";
  await db.doc("config/integrations").set(update, { merge: true });
  return { ok: true };
});

// ── calendar OAuth: exchange an auth code for an offline refresh token ───────
// Tokens are stored in calendarTokens/{uid} (server-only); only a connection
// summary lands on the user doc.
export const connectGoogleCalendar = onCall(async (request) => {
  const caller = await getCaller(request);
  const { code, redirectUri } = (request.data || {}) as { code?: string; redirectUri?: string };
  if (!code || !redirectUri) throw new HttpsError("invalid-argument", "code & redirectUri required.");
  const cfg = await getIntegrationConfig();
  if (!cfg.googleClientId || !cfg.googleClientSecret) {
    throw new HttpsError("failed-precondition", "Google integration not configured by the platform admin.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const tok = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !tok.refresh_token) {
    logger.error("Google token exchange failed", tok);
    throw new HttpsError("internal", "Google sign-in failed. Make sure offline access is granted.");
  }
  let email = "";
  try {
    const u = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    email = ((await u.json()) as { email?: string }).email || "";
  } catch { /* non-fatal */ }
  await db.doc(`calendarTokens/${caller.uid}`).set({ google: { refreshToken: tok.refresh_token } }, { merge: true });
  await db.doc(`users/${caller.uid}`).set(
    { calendar: { google: { connected: true, email, connectedAt: Date.now() } } },
    { merge: true }
  );
  return { ok: true, email };
});

export const connectMicrosoftCalendar = onCall(async (request) => {
  const caller = await getCaller(request);
  const { code, redirectUri } = (request.data || {}) as { code?: string; redirectUri?: string };
  if (!code || !redirectUri) throw new HttpsError("invalid-argument", "code & redirectUri required.");
  const cfg = await getIntegrationConfig();
  if (!cfg.microsoftClientId || !cfg.microsoftClientSecret) {
    throw new HttpsError("failed-precondition", "Microsoft integration not configured by the platform admin.");
  }
  const res = await fetch(`https://login.microsoftonline.com/${cfg.microsoftTenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.microsoftClientId,
      client_secret: cfg.microsoftClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: "offline_access Calendars.ReadWrite User.Read",
    }).toString(),
  });
  const tok = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !tok.refresh_token) {
    logger.error("Microsoft token exchange failed", tok);
    throw new HttpsError("internal", "Microsoft sign-in failed.");
  }
  let email = "";
  try {
    const u = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const me = (await u.json()) as { mail?: string; userPrincipalName?: string };
    email = me.mail || me.userPrincipalName || "";
  } catch { /* non-fatal */ }
  await db.doc(`calendarTokens/${caller.uid}`).set({ microsoft: { refreshToken: tok.refresh_token } }, { merge: true });
  await db.doc(`users/${caller.uid}`).set(
    { calendar: { microsoft: { connected: true, email, connectedAt: Date.now() } } },
    { merge: true }
  );
  return { ok: true, email };
});

export const disconnectCalendar = onCall(async (request) => {
  const caller = await getCaller(request);
  const { provider } = (request.data || {}) as { provider?: string };
  if (provider !== "google" && provider !== "microsoft") {
    throw new HttpsError("invalid-argument", "provider must be 'google' or 'microsoft'.");
  }
  await db.doc(`calendarTokens/${caller.uid}`).set({ [provider]: FieldValue.delete() }, { merge: true });
  await db.doc(`users/${caller.uid}`).set(
    { calendar: { [provider]: { connected: false } } },
    { merge: true }
  );
  return { ok: true };
});

// ── external free/busy ───────────────────────────────────────────────────────
type Interval = { start: number; end: number };

async function googleAccessToken(refreshToken: string, cfg: IntegrationConfig): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, string>;
  return j.access_token || "";
}

async function microsoftAccessToken(refreshToken: string, cfg: IntegrationConfig): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${cfg.microsoftTenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.microsoftClientId,
      client_secret: cfg.microsoftClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: "offline_access Calendars.ReadWrite User.Read",
    }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, string>;
  return j.access_token || "";
}

// Busy intervals from a rep's connected external calendars over [startMs,endMs].
async function externalBusy(uid: string, startMs: number, endMs: number): Promise<Interval[]> {
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get();
  if (!tokSnap.exists) return [];
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  const cfg = await getIntegrationConfig();
  const out: Interval[] = [];
  const timeMin = new Date(startMs).toISOString();
  const timeMax = new Date(endMs).toISOString();

  if (t.google?.refreshToken && cfg.googleClientId) {
    try {
      const at = await googleAccessToken(t.google.refreshToken, cfg);
      if (at) {
        const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
          method: "POST",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }),
        });
        const j = (await r.json().catch(() => ({}))) as any;
        for (const b of j?.calendars?.primary?.busy || []) {
          out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
        }
      }
    } catch (e) { logger.warn("google freebusy failed", e); }
  }

  if (t.microsoft?.refreshToken && cfg.microsoftClientId) {
    try {
      const at = await microsoftAccessToken(t.microsoft.refreshToken, cfg);
      if (at) {
        const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(timeMin)}&endDateTime=${encodeURIComponent(timeMax)}&$select=start,end,showAs&$top=100`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${at}`, Prefer: 'outlook.timezone="UTC"' } });
        const j = (await r.json().catch(() => ({}))) as any;
        for (const ev of j?.value || []) {
          if (ev.showAs === "free") continue;
          out.push({ start: Date.parse(ev.start?.dateTime + "Z"), end: Date.parse(ev.end?.dateTime + "Z") });
        }
      }
    } catch (e) { logger.warn("microsoft calendarView failed", e); }
  }
  return out.filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end));
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

// Is a rep free for [startMs,endMs] (± buffer): no app appointment and no
// external busy block overlaps.
async function isUserFree(uid: string, startMs: number, endMs: number, bufferMin: number): Promise<boolean> {
  const buf = bufferMin * 60 * 1000;
  const win: Interval = { start: startMs - buf, end: endMs + buf };

  // Internal appointments (events) for this user.
  const evSnap = await db.collection("events").where("userId", "==", uid).where("startAt", "<=", win.end).get();
  for (const d of evSnap.docs) {
    const ev = d.data();
    const s = Number(ev.startAt);
    const e = Number(ev.endAt) || s + (Number(ev.durationMin) || 60) * 60 * 1000;
    if (overlaps(win, { start: s, end: e })) return false;
  }

  // External calendars.
  const busy = await externalBusy(uid, win.start, win.end);
  return !busy.some((b) => overlaps(win, b));
}

// Push an appointment to a rep's connected external calendars (best-effort).
async function pushExternalEvent(uid: string, ev: { title: string; address?: string; notes?: string; startMs: number; endMs: number }): Promise<void> {
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get();
  if (!tokSnap.exists) return;
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  const cfg = await getIntegrationConfig();
  const startISO = new Date(ev.startMs).toISOString();
  const endISO = new Date(ev.endMs).toISOString();

  if (t.google?.refreshToken && cfg.googleClientId) {
    try {
      const at = await googleAccessToken(t.google.refreshToken, cfg);
      if (at) {
        await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: ev.title,
            location: ev.address || "",
            description: ev.notes || "Booked via YoutilityKnock",
            start: { dateTime: startISO },
            end: { dateTime: endISO },
          }),
        });
      }
    } catch (e) { logger.warn("google event push failed", e); }
  }
  if (t.microsoft?.refreshToken && cfg.microsoftClientId) {
    try {
      const at = await microsoftAccessToken(t.microsoft.refreshToken, cfg);
      if (at) {
        await fetch("https://graph.microsoft.com/v1.0/me/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: ev.title,
            location: { displayName: ev.address || "" },
            body: { contentType: "text", content: ev.notes || "Booked via YoutilityKnock" },
            start: { dateTime: startISO, timeZone: "UTC" },
            end: { dateTime: endISO, timeZone: "UTC" },
          }),
        });
      }
    } catch (e) { logger.warn("microsoft event push failed", e); }
  }
}

// ── availability + assignment ────────────────────────────────────────────────
async function companyScheduling(companyId: string) {
  const snap = await db.doc(`companies/${companyId}`).get();
  const s = (snap.exists ? snap.data()?.scheduling : null) || {};
  return { ...DEFAULT_SCHEDULING, ...s };
}

// Check whether a given rep (or the caller) is free for a slot.
export const checkAvailability = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, startAt, durationMin } = (request.data || {}) as { uid?: string; startAt?: number; durationMin?: number };
  const targetUid = uid || caller.uid;
  if (!startAt) throw new HttpsError("invalid-argument", "startAt required.");
  const sched = caller.companyId ? await companyScheduling(caller.companyId) : DEFAULT_SCHEDULING;
  const dur = (durationMin || sched.apptDurationMin) * 60 * 1000;
  const free = await isUserFree(targetUid, startAt, startAt + dur, sched.bufferMin);
  return { free };
});

// Route a (non-self-gen) appointment to an available rep per company policy.
export const assignAppointment = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    companyId?: string;
    startAt?: number;
    durationMin?: number;
    title?: string;
    address?: string;
    name?: string;
    notes?: string;
    leadId?: string;
    candidateUid?: string; // for manual
    pushExternal?: boolean;
  };
  const companyId = d.companyId || caller.companyId || "";
  if (!companyId || caller.companyId !== companyId) {
    if (!caller.isSuper) throw new HttpsError("permission-denied", "Wrong company.");
  }
  if (!d.startAt) throw new HttpsError("invalid-argument", "startAt required.");

  const sched = await companyScheduling(companyId);
  const now = Date.now();
  const minAt = now + sched.apptMinLeadHours * 3600 * 1000;
  const maxAt = now + sched.apptMaxDaysOut * 86400 * 1000;
  if (d.startAt < minAt) throw new HttpsError("failed-precondition", `Too soon — needs ${sched.apptMinLeadHours}h lead time.`);
  if (d.startAt > maxAt) throw new HttpsError("failed-precondition", `Too far out — max ${sched.apptMaxDaysOut} days.`);
  if (!withinBusinessHours(d.startAt, sched)) throw new HttpsError("failed-precondition", "Outside the company's booking hours/days.");

  const dur = (d.durationMin || sched.apptDurationMin) * 60 * 1000;
  const endAt = d.startAt + dur;

  // Candidate reps: enabled company members (managers + users).
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const candidates: Array<{ uid: string; [k: string]: any }> = usersSnap.docs
    .map((u): { uid: string; [k: string]: any } => ({ uid: u.id, ...(u.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true && (u.role === "user" || u.role === "manager"));

  // Keep only those actually free at the slot.
  const freeFlags = await Promise.all(candidates.map((c) => isUserFree(c.uid, d.startAt!, endAt, sched.bufferMin)));
  let pool = candidates.filter((_, i) => freeFlags[i]);
  if (pool.length === 0) throw new HttpsError("failed-precondition", "No rep is available at that time.");

  let chosen = pool[0];
  if (sched.assignment === "manual") {
    if (!d.candidateUid) throw new HttpsError("invalid-argument", "Manual assignment needs candidateUid.");
    const found = pool.find((p) => p.uid === d.candidateUid);
    if (!found) throw new HttpsError("failed-precondition", "Chosen rep isn't available then.");
    chosen = found;
  } else if (sched.assignment === "highest_production") {
    const statsSnap = await db.collection("userStats").where("companyId", "==", companyId).get();
    const sales: Record<string, number> = {};
    statsSnap.forEach((s) => (sales[s.id] = Number(s.data().sales) || 0));
    pool = pool.sort((a, b) => (sales[b.uid] || 0) - (sales[a.uid] || 0));
    chosen = pool[0];
  } else if (sched.assignment === "round_robin") {
    pool = pool.sort((a, b) => a.uid.localeCompare(b.uid));
    const cur = Number((await db.doc(`companies/${companyId}`).get()).data()?.rrCursor) || 0;
    chosen = pool[cur % pool.length];
    await db.doc(`companies/${companyId}`).set({ rrCursor: cur + 1 }, { merge: true });
  } else {
    // self_gen: assign to the caller if they're in the pool, else first free.
    chosen = pool.find((p) => p.uid === caller.uid) || pool[0];
  }

  const managerPath = (chosen.managerPath as string[]) || [];
  const ev = {
    companyId,
    userId: chosen.uid,
    userName: chosen.displayName || "",
    type: "appointment",
    title: d.title || `Appointment${d.name ? ` — ${d.name}` : ""}`,
    address: d.address || "",
    leadId: d.leadId || null,
    startAt: d.startAt,
    endAt,
    durationMin: d.durationMin || sched.apptDurationMin,
    assignedBy: caller.uid,
    source: "assigned",
    notes: d.notes || "",
    visibilityPath: [chosen.uid, ...managerPath],
    reminded: false,
    createdAt: now,
  };
  const ref = await db.collection("events").add(ev);

  if (d.pushExternal !== false) {
    await pushExternalEvent(chosen.uid, { title: ev.title, address: ev.address, notes: ev.notes, startMs: d.startAt, endMs: endAt });
  }
  await notifyUser({
    userId: chosen.uid,
    type: "event",
    title: `New appointment assigned`,
    body: [ev.title, new Date(d.startAt).toLocaleString()].filter(Boolean).join(" — "),
    link: "/app/schedule",
  });

  return { ok: true, eventId: ref.id, assignedTo: chosen.uid, assignedName: chosen.displayName || "" };
});

// ════════════════════════════════════════════════════════════════════════════
// YOUTILITYCRM INTEGRATION (outbound)
// ────────────────────────────────────────────────────────────────────────────
// The other half of the YoutilityKnock ⇆ YoutilityCRM link. When a rep
// dispositions a door as interested (status appointment/pipeline/sold) or
// books an on-the-spot appointment, we push that lead / appointment into the
// company's YoutilityCRM via the receiver shipped in
// FMSNate/youtility-crm (routes/youtilityKnock.js):
//
//   POST <leadWebhookUrl>         /api/youtility-knock/webhook/lead
//   POST <appointmentWebhookUrl>  /api/youtility-knock/webhook/appointment
//
// Per-company credentials live in crmConfig/{companyId} — a SERVER-ONLY
// collection (no Firestore rule grants client access, so it defaults to
// deny). The admin pastes the key + webhook URLs the CRM hands back from its
// /provision endpoint via setCrmIntegration. Every push is signed with
// X-Knock-Signature (HMAC-SHA256 of the raw body, keyed by the shared key)
// and also carries X-API-Key so the CRM can resolve the org either way.
// ════════════════════════════════════════════════════════════════════════════

interface CrmConfig {
  enabled: boolean;
  leadWebhookUrl: string;
  appointmentWebhookUrl: string;
  apiKey: string;
  orgId: string;
}

// Lead dispositions worth a CRM push — interested homeowners only. "Not home",
// "not interested", "dnc", and bare "new" stay in the field app.
const CRM_PUSHABLE_STATUSES = new Set(["appointment", "pipeline", "sold"]);

const CRM_STATUS_LABEL: Record<string, string> = {
  appointment: "Appointment",
  pipeline: "Pipeline",
  sold: "Sold",
  go_back: "Go Back",
};

async function loadCrmConfig(companyId: string | undefined): Promise<CrmConfig | null> {
  if (!companyId) return null;
  try {
    const snap = await db.doc(`crmConfig/${companyId}`).get();
    if (!snap.exists) return null;
    const c = snap.data() as Partial<CrmConfig>;
    if (!c.enabled || !c.apiKey) return null;
    return {
      enabled: true,
      leadWebhookUrl: c.leadWebhookUrl || "",
      appointmentWebhookUrl: c.appointmentWebhookUrl || "",
      apiKey: c.apiKey,
      orgId: c.orgId || "",
    };
  } catch (e) {
    logger.warn("loadCrmConfig failed", e);
    return null;
  }
}

// Sign + POST a JSON payload to a CRM webhook. Returns { ok, status }.
async function crmPush(
  cfg: CrmConfig,
  url: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status: number }> {
  if (!url) return { ok: false, status: 0 };
  const raw = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", cfg.apiKey).update(raw).digest("hex");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": cfg.apiKey,
        "X-Knock-Signature": signature,
        ...(cfg.orgId ? { "X-Org-Id": cfg.orgId } : {}),
      },
      body: raw,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    logger.warn("crmPush request failed", e);
    return { ok: false, status: 0 };
  }
}

// Split a stored "First Last" owner name into parts for the CRM contact.
function splitName(full?: string): { firstName: string; lastName: string } {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Best-effort display name for the rep who owns a record (for "Knocked by").
async function repDisplayName(uid?: string): Promise<string> {
  if (!uid) return "";
  try {
    const snap = await db.doc(`users/${uid}`).get();
    return (snap.data()?.displayName as string) || "";
  } catch {
    return "";
  }
}

// Build the CRM contact block from a lead document.
function crmContactFromLead(lead: Record<string, any>): Record<string, unknown> {
  const { firstName, lastName } = splitName(lead.ownerName);
  // Fall back to skip-traced owner contact when the rep didn't capture one.
  const owner = Array.isArray(lead?.enrichment?.owners) ? lead.enrichment.owners[0] : null;
  return {
    firstName,
    lastName,
    email: lead.email || owner?.emails?.[0] || "",
    phone: lead.phone || owner?.phones?.[0] || "",
    address: {
      street: lead.address || "",
      city: lead.city || "",
      state: lead.state || "",
      zip: lead.zip || "",
    },
  };
}

// ── trigger: lead reaches an interested disposition → push to the CRM ────────
// Fires on create AND update so a re-disposition (e.g. "not home" → "appointment")
// still syncs. Idempotent: a `crmSync` stamp on the lead records the last
// status we successfully pushed, so the write-back doesn't loop and an
// unchanged status isn't pushed twice.
export const onLeadWriteSyncCrm = onDocumentWritten("leads/{leadId}", async (event) => {
  const after = event.data?.after;
  if (!after?.exists) return; // deletion — nothing to push
  const lead = after.data() as Record<string, any>;
  const status = String(lead.status || "");
  if (!CRM_PUSHABLE_STATUSES.has(status)) return;

  // Already pushed this exact status successfully? Skip (also breaks the
  // write-back re-trigger loop).
  if (lead.crmSync?.pushedStatus === status && lead.crmSync?.result === "ok") return;

  const cfg = await loadCrmConfig(lead.companyId);
  if (!cfg || !cfg.leadWebhookUrl) return;

  const contact = crmContactFromLead(lead);
  const repName = await repDisplayName(lead.assignedTo || lead.createdBy);
  const payload = {
    ...contact,
    disposition: CRM_STATUS_LABEL[status] || status,
    repName,
    knockId: event.params.leadId,
    source: "YoutilityKnock",
    notes: lead.notes || "",
  };

  const { ok, status: httpStatus } = await crmPush(cfg, cfg.leadWebhookUrl, payload);
  await after.ref.update({
    crmSync: {
      pushedStatus: status,
      result: ok ? "ok" : "error",
      httpStatus,
      at: Date.now(),
    },
  });
  logger.info(`CRM lead push ${ok ? "ok" : "FAILED"} lead=${event.params.leadId} status=${status} http=${httpStatus}`);
});

// ── trigger: appointment booked → push to the CRM ────────────────────────────
// Only "appointment" events sync (go-backs / follow-ups stay internal).
// Idempotent via a `crmSynced` flag; onDocumentCreated never re-fires on the
// flag write, so no loop guard beyond that is needed.
export const onEventCreateSyncCrm = onDocumentCreated("events/{eventId}", async (event) => {
  const ev = event.data?.data() as Record<string, any> | undefined;
  if (!ev || ev.type !== "appointment") return;
  if (ev.crmSynced === true) return;

  const cfg = await loadCrmConfig(ev.companyId);
  if (!cfg || !cfg.appointmentWebhookUrl) return;

  // Enrich the contact from the linked lead when present; otherwise fall back
  // to whatever the event itself carries.
  let contact: Record<string, unknown> = { address: { street: ev.address || "" } };
  if (ev.leadId) {
    try {
      const leadSnap = await db.doc(`leads/${ev.leadId}`).get();
      if (leadSnap.exists) contact = crmContactFromLead(leadSnap.data() as Record<string, any>);
    } catch (e) {
      logger.warn("CRM appointment: lead lookup failed", e);
    }
  }

  const startMs = Number(ev.startAt) || Date.now();
  const endMs = Number(ev.endAt) || startMs + (Number(ev.durationMin) || 60) * 60000;
  const payload = {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    title: ev.title || "Solar Consultation",
    location: ev.address || "",
    repName: ev.userName || (await repDisplayName(ev.userId)),
    notes: ev.notes || "",
    contact,
  };

  const { ok, status: httpStatus } = await crmPush(cfg, cfg.appointmentWebhookUrl, payload);
  await event.data!.ref.update({ crmSynced: ok, crmSyncHttp: httpStatus, crmSyncAt: Date.now() });
  logger.info(`CRM appointment push ${ok ? "ok" : "FAILED"} event=${event.params.eventId} http=${httpStatus}`);
});

// ── super-admin: read the CRM integration status (masked) ────────────────────
// YoutilityCRM provisioning is a super-admin-only operation on both sides, so
// only super-admins can read or write a company's CRM credentials.
export const getCrmIntegration = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { companyId } = (request.data || {}) as { companyId?: string };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId is required.");
  const snap = await db.doc(`crmConfig/${companyId}`).get();
  const c = (snap.exists ? (snap.data() as Record<string, string>) : {}) || {};
  return {
    enabled: !!c.enabled,
    leadWebhookUrl: c.leadWebhookUrl || "",
    appointmentWebhookUrl: c.appointmentWebhookUrl || "",
    orgId: c.orgId || "",
    configured: !!c.apiKey,
    keyMask: mask(c.apiKey),
  };
});

// ── super-admin: set the CRM integration (enable + URLs + shared key) ─────────
// The super-admin pastes the values YoutilityCRM issues from its SuperAdmin →
// YoutilityKnock panel. The key is a secret: only overwritten when a non-blank
// value is supplied.
export const setCrmIntegration = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as {
    companyId?: string;
    enabled?: boolean;
    leadWebhookUrl?: string;
    appointmentWebhookUrl?: string;
    apiKey?: string;
    orgId?: string;
  };
  if (!d.companyId) throw new HttpsError("invalid-argument", "companyId is required.");

  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.enabled === "boolean") update.enabled = d.enabled;
  if (typeof d.leadWebhookUrl === "string") update.leadWebhookUrl = d.leadWebhookUrl.trim();
  if (typeof d.appointmentWebhookUrl === "string") update.appointmentWebhookUrl = d.appointmentWebhookUrl.trim();
  if (typeof d.orgId === "string") update.orgId = d.orgId.trim();
  if (typeof d.apiKey === "string" && d.apiKey.trim()) update.apiKey = d.apiKey.trim();

  await db.doc(`crmConfig/${d.companyId}`).set(update, { merge: true });
  logger.info(`CRM integration updated company=${d.companyId} by ${caller.uid}`);
  return { ok: true };
});
