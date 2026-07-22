import { onRequest, onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentDeleted, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getMessaging } from "firebase-admin/messaging";
import Stripe from "stripe";
import * as crypto from "crypto";
import PDFDocument from "pdfkit";
import * as nodemailer from "nodemailer";
import { spawn } from "child_process";
import nacl from "tweetnacl";
import ffmpegPath from "ffmpeg-static";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";

initializeApp();
const db = getFirestore();

// A "trial" plan grants full access for a short window, then the account is
// paused (status → suspended) until they subscribe. No data is ever deleted, so
// a paying conversion picks up exactly where the trial left off.
const TRIAL_DAYS = 3;
const TRIAL_MS = TRIAL_DAYS * 86400000;
const isTrialPlan = (plan?: string) => (plan || "").trim().toLowerCase() === "trial";

const ATTOM = {
  baseUrl: process.env.ATTOM_API_URL || "https://api.gateway.attomdata.com/propertyapi/v1.0.0",
  key: process.env.ATTOM_API_KEY || "",
};

// NREL (api.data.gov) — identifies the electric utility serving a lat/lng. Free
// key; DEMO_KEY works for light testing but is rate-limited.
const NREL = { key: process.env.NREL_API_KEY || "DEMO_KEY" };

// Google Maps — Street View + satellite imagery of the customer's actual home
// for the proposal hero (Static Maps, Street View, Geocoding APIs). Defaults to
// the platform's existing youtilityknock project key (the same public web key
// shipped in the app) so home imagery works for everyone out of the box; a
// super-admin can still override it with a dedicated key in config/api. NOTE:
// the Maps Static, Street View Static, and Geocoding APIs must be enabled on the
// project for this key, and the key must not be API-restricted to exclude them.
const GMAPS = { key: process.env.GOOGLE_MAPS_KEY || "AIzaSyAAfrLWkY_WS7yabCgW_WZJu973J5iGcBI" };

async function attomGet(path: string, params: Record<string, string | number | undefined>) {
  const url = new URL(ATTOM.baseUrl + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  const res = await fetch(url.toString(), { headers: { apikey: ATTOM.key, Accept: "application/json" } });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// ATTOM auth failures (expired / revoked / unentitled key) must NOT leak the
// raw provider JSON to the rep's screen. Translate 401/403 into a clean, typed
// error the client can render as a friendly banner and degrade around (keep
// cached + lead + mover pins). Other upstream errors pass through unchanged.
function sendAttomError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  status: number,
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
): void {
  if (status === 401 || status === 403) {
    logger.error("ATTOM auth rejected", {
      status,
      msg: json?.status?.msg ?? json?.Response?.status?.msg ?? "unknown",
    });
    res.status(502).json({ error: "Property data is temporarily unavailable.", code: "PROVIDER_AUTH" });
    return;
  }
  res.status(status).json(json);
}

// BatchData skip-tracing — owner phones/emails (ATTOM doesn't provide contact).
const BATCH = {
  baseUrl: process.env.BATCHDATA_API_URL || "https://api.batchdata.com",
  key: process.env.BATCHDATA_API_KEY || "",
  enabled: process.env.BATCHDATA_SKIPTRACE !== "0",
};

// Provider keys can be overridden from the super-admin screen (config/api),
// falling back to the env defaults. Refreshed at the top of each /api request.
async function refreshApiConfig(): Promise<void> {
  try {
    const snap = await db.doc("config/api").get();
    if (!snap.exists) return;
    const c = snap.data() as Record<string, unknown>;
    if (typeof c.attomKey === "string" && c.attomKey) ATTOM.key = c.attomKey;
    if (typeof c.attomUrl === "string" && c.attomUrl) ATTOM.baseUrl = c.attomUrl;
    if (typeof c.nrelKey === "string" && c.nrelKey) NREL.key = c.nrelKey;
    if (typeof c.googleMapsKey === "string" && c.googleMapsKey) GMAPS.key = c.googleMapsKey;
    if (typeof c.batchKey === "string" && c.batchKey) BATCH.key = c.batchKey;
    if (typeof c.batchUrl === "string" && c.batchUrl) BATCH.baseUrl = c.batchUrl;
    if (typeof c.batchEnabled === "boolean") BATCH.enabled = c.batchEnabled;
  } catch { /* keep env defaults */ }
}

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

// ── Positions ────────────────────────────────────────────────────────────────
// A single structural Position per user drives the access tier, the setter /
// closer org-chart participation, and downline visibility. Managers derive the
// "manager" tier; setter/closer derive "user". Custom role titles still ride on
// top for display; this is the structural source of truth.
type Position = "admin" | "team_manager" | "closer_manager" | "setter_manager" | "closer" | "setter" | "scheduler";
const POSITIONS: Position[] = ["admin", "team_manager", "closer_manager", "setter_manager", "closer", "setter", "scheduler"];
function isPosition(p: unknown): p is Position { return typeof p === "string" && (POSITIONS as string[]).includes(p); }
function tierForPosition(p: Position): Tier {
  if (p === "admin") return "admin";
  if (p === "team_manager" || p === "closer_manager" || p === "setter_manager") return "manager";
  return "user";
}
// Which org chart(s) the position participates in (gates assignability + chains).
function fnForPosition(p: Position): { isSetter: boolean; isCloser: boolean } {
  switch (p) {
    case "setter": return { isSetter: true, isCloser: false };
    case "closer": return { isSetter: false, isCloser: true };
    case "setter_manager": return { isSetter: true, isCloser: false };
    case "closer_manager": return { isSetter: false, isCloser: true };
    case "team_manager": return { isSetter: true, isCloser: true };
    case "admin": return { isSetter: false, isCloser: false };
    case "scheduler": return { isSetter: false, isCloser: false }; // a dispatcher, not a door rep
  }
}

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

// An enterprise/org admin is the admin of any company that belongs to the org.
// Used for org-level self-service billing (view invoices/contract, change card).
async function authorizeForOrg(caller: Caller, orgId: string | undefined): Promise<string> {
  if (!orgId) throw new HttpsError("invalid-argument", "orgId is required.");
  if (caller.isSuper) return orgId;
  if (caller.role === "admin" && caller.companyId) {
    const company = (await db.doc(`companies/${caller.companyId}`).get()).data();
    if (company && company.organizationId === orgId) return orgId;
  }
  throw new HttpsError("permission-denied", "Not allowed to manage this organization.");
}

async function authorizeForTargetUser(caller: Caller, targetUid: string) {
  // Editing your own account is allowed; callers add narrow guards to stop the
  // two moves that would lock you out (removing your own admin, disabling
  // yourself). Deleting yourself is blocked in deleteUser.
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

// The closer org chart is a SEPARATE chain from the setter one — walk it via
// closerManagerId / closerManagerPath so closer managers see closer production.
async function computeCloserManagerPath(closerManagerId: string | null | undefined): Promise<string[]> {
  if (!closerManagerId) return [];
  const snap = await db.doc(`users/${closerManagerId}`).get();
  if (!snap.exists) return [];
  const m = snap.data()!;
  return [closerManagerId, ...((m.closerManagerPath as string[]) || [])];
}

// Recompute managerPath for every user in a company and visibilityPath for
// every lead, from the current managerId links. Run after any reorg.
async function rebuildCompanyHierarchy(companyId: string) {
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const managerOf: Record<string, string | null> = {};
  const closerManagerOf: Record<string, string | null> = {};
  usersSnap.forEach((d) => {
    managerOf[d.id] = (d.data().managerId as string) ?? null;
    closerManagerOf[d.id] = (d.data().closerManagerId as string) ?? null;
  });

  // Walk up a chain for each user (cycle-guarded). One walker per org chart.
  const makeWalker = (parentOf: Record<string, string | null>) => {
    const cache: Record<string, string[]> = {};
    const walk = (uid: string, seen: Set<string> = new Set()): string[] => {
      if (cache[uid]) return cache[uid];
      const mgr = parentOf[uid];
      if (!mgr || seen.has(mgr)) return (cache[uid] = []);
      seen.add(mgr);
      return (cache[uid] = [mgr, ...walk(mgr, seen)]);
    };
    return walk;
  };
  const pathFor = makeWalker(managerOf); // setter chain
  const closerPathFor = makeWalker(closerManagerOf); // closer chain

  // Team managers see EVERYONE on the teams they manage (across both chains).
  // Map team → its managers, and each user → their team, then fold the team's
  // managers (and the managers' own up-chains) into every member's paths so the
  // existing visibilityPath rules automatically include team managers.
  const teamMgrsByTeam: Record<string, string[]> = {};
  const teamIdOf: Record<string, string | null> = {};
  usersSnap.forEach((d) => {
    teamIdOf[d.id] = (d.data().teamId as string) ?? null;
    const mt = d.data().managedTeamIds;
    if (Array.isArray(mt)) mt.forEach((t: string) => { (teamMgrsByTeam[t] ||= []).push(d.id); });
  });
  const teamMgrChain = (uid: string): string[] => {
    const t = teamIdOf[uid];
    if (!t || !teamMgrsByTeam[t]) return [];
    const out: string[] = [];
    for (const m of teamMgrsByTeam[t]) if (m !== uid) out.push(m, ...pathFor(m), ...closerPathFor(m));
    return out;
  };

  // Region managers see EVERYONE on every team in their region. A region is a
  // team with kind === "region"; a team belongs to it via parentTeamId. Fold the
  // region's manager (and their up-chains) into each region member's paths, just
  // like team managers above — so the regional manager's downline/reports/leads
  // roll up the whole region automatically.
  const teamsSnap = await db.collection(`companies/${companyId}/teams`).get();
  const regionMgr: Record<string, string | null> = {}; // regionTeamId → manager uid
  teamsSnap.forEach((t) => {
    if (t.data().kind === "region") regionMgr[t.id] = (t.data().regionalManagerUid as string) || null;
  });
  const regionMgrOfTeam: Record<string, string | null> = {}; // memberTeamId → region manager uid
  teamsSnap.forEach((t) => {
    if (t.data().kind === "region") return;
    const parent = (t.data().parentTeamId as string) || null;
    if (parent && regionMgr[parent]) regionMgrOfTeam[t.id] = regionMgr[parent];
  });
  const regionMgrChain = (uid: string): string[] => {
    const t = teamIdOf[uid];
    const mgr = t ? regionMgrOfTeam[t] : null;
    if (!mgr || mgr === uid) return [];
    return [mgr, ...pathFor(mgr), ...closerPathFor(mgr)];
  };

  const fullPathFor = (uid: string) => Array.from(new Set([...pathFor(uid), ...teamMgrChain(uid), ...regionMgrChain(uid)]));
  const fullCloserPathFor = (uid: string) => Array.from(new Set([...closerPathFor(uid), ...teamMgrChain(uid), ...regionMgrChain(uid)]));

  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const d of usersSnap.docs) {
    batch.update(d.ref, { managerPath: fullPathFor(d.id), closerManagerPath: fullCloserPathFor(d.id) });
    if (++ops >= 450) await flush();
  }
  await flush();

  // Read appointments up front so a lead's assigned CLOSER (and their closer-
  // managers) can also see that lead — a closer needs the customer's phone +
  // history for their appointment, but the lead's owner-chain is the setter's.
  const apptSnap = await db.collection("events").where("companyId", "==", companyId).where("closerUid", "!=", null).get().catch(() => null);
  const leadCloserVis: Record<string, string[]> = {};
  if (apptSnap) {
    for (const d of apptSnap.docs) {
      const e = d.data();
      const leadId = e.leadId as string | undefined;
      const closerUid = e.closerUid as string | undefined;
      if (!leadId || !closerUid) continue;
      leadCloserVis[leadId] = Array.from(new Set([
        ...(leadCloserVis[leadId] || []), closerUid, ...fullCloserPathFor(closerUid),
      ]));
    }
  }

  const leadsSnap = await db.collection("leads").where("companyId", "==", companyId).get();
  for (const d of leadsSnap.docs) {
    const owner = (d.data().assignedTo as string) || d.data().createdBy;
    const vis = Array.from(new Set([owner, ...fullPathFor(owner), ...(leadCloserVis[d.id] || [])]));
    batch.update(d.ref, { visibilityPath: vis });
    if (++ops >= 450) await flush();
  }
  await flush();

  // Appointments are visible up BOTH chains: the closer's closer-managers and
  // the setter's setter-managers.
  if (apptSnap) {
    for (const d of apptSnap.docs) {
      const e = d.data();
      const closerUid = e.closerUid as string;
      const setterUid = (e.setterUid as string) || "";
      const vis = Array.from(new Set([
        closerUid, ...fullCloserPathFor(closerUid),
        ...(setterUid ? [setterUid, ...fullPathFor(setterUid)] : []),
      ]));
      batch.update(d.ref, { visibilityPath: vis });
      if (++ops >= 450) await flush();
    }
    await flush();
  }

  // Keep per-user stats roll-up reachable by the right managers.
  const statsSnap = await db.collection("userStats").where("companyId", "==", companyId).get();
  for (const d of statsSnap.docs) {
    batch.update(d.ref, { managerPath: fullPathFor(d.id), closerManagerPath: fullCloserPathFor(d.id) });
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
  const isMovers = req.path.endsWith("/movers");
  if (!isProperty && !isArea && !isMovers) { res.status(404).json({ error: "Not found" }); return; }

  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!match) { res.status(401).json({ error: "Missing bearer token" }); return; }
  try { await getAuth().verifyIdToken(match[1]); }
  catch { res.status(401).json({ error: "Invalid token" }); return; }

  await refreshApiConfig(); // pick up super-admin key overrides

  if (!ATTOM.key) {
    logger.error("ATTOM_API_KEY not set");
    res.status(503).json({ error: "Property data not configured — set ATTOM_API_KEY" });
    return;
  }

  try {
    if (isMovers) {
      // Recent move-ins = homes that sold inside the lookback window. ATTOM's
      // sale snapshot returns every sale in a radius between two dates, which we
      // surface as "movers" pins on the map (newest = freshest door to knock).
      const lat = req.query.lat as string | undefined;
      const lng = req.query.lng as string | undefined;
      const radius = (req.query.radius as string | undefined) || "1"; // miles
      const days = Math.min(Math.max(parseInt((req.query.days as string) || "90", 10) || 90, 1), 366);
      if (!lat || !lng) { res.status(400).json({ error: "lat & lng required" }); return; }
      const fmt = (d: Date) =>
        `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400000);
      const { ok, status, json } = await attomGet("/sale/snapshot", {
        latitude: lat,
        longitude: lng,
        radius,
        startsalesearchdate: fmt(start),
        endsalesearchdate: fmt(end),
        pagesize: 200,
      });
      if (!ok) { sendAttomError(res, status, json); return; }
      res.status(200).json(json);
      return;
    }

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
      if (!ok) { sendAttomError(res, status, json); return; }
      res.status(200).json(json);
      return;
    }

    // Single-property detail (owner + property + sale).
    const address = (req.query.address as string | undefined)?.trim();
    if (!address) { res.status(400).json({ error: "address query param required" }); return; }
    const ci = address.indexOf(",");
    const address1 = ci > -1 ? address.slice(0, ci).trim() : address;
    const address2 = ci > -1 ? address.slice(ci + 1).trim() : "";
    const { ok, status, json } = await attomGet("/property/expandedprofile", { address1, address2 });
    if (!ok) { sendAttomError(res, status, json); return; }
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

  // A trial company starts in "trial" status with a 3-day countdown; a scheduled
  // job (trialExpiry) pauses it when the window elapses, keeping all its data.
  const trial = isTrialPlan(plan);
  const ref = await db.collection("companies").add({
    name: name.trim(), plan: plan || "standard",
    status: trial ? "trial" : "active",
    ...(trial ? { trialEndsAt: Date.now() + TRIAL_MS, trialExpired: false } : {}),
    createdAt: Date.now(), createdBy: caller.uid,
  });
  // Standard seed roles.
  const roles = ref.collection("roles");
  await roles.add({ companyId: ref.id, title: "Manager", baseTier: "manager", rank: 100, isDefault: true, createdAt: Date.now() });
  await roles.add({ companyId: ref.id, title: "User", baseTier: "user", rank: 10, isDefault: true, createdAt: Date.now() });
  await ref.collection("teams").add({ companyId: ref.id, name: "Company", parentTeamId: null, kind: "company", createdAt: Date.now() });

  logger.info(`Company ${ref.id} created by ${caller.uid}`);
  return { ok: true, companyId: ref.id };
});

// ───────────────────────────────────────────────────────────────────────────
// createUser — provisions an account with optional hierarchy placement.
// ───────────────────────────────────────────────────────────────────────────
export const createUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, email, password, tier, roleId, title, teamId, managerId, isSetter, isCloser, closerManagerId,
    position, managedTeamIds, canReassignAppointments } =
    request.data as {
      companyId?: string; name?: string; email?: string; password?: string;
      tier?: Tier; roleId?: string; title?: string; teamId?: string; managerId?: string;
      isSetter?: boolean; isCloser?: boolean; closerManagerId?: string | null;
      position?: Position; managedTeamIds?: string[]; canReassignAppointments?: boolean;
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
  // Position (structural) takes precedence: it drives the tier + setter/closer fn.
  let effSetter = isSetter === undefined ? true : !!isSetter;
  let effCloser = !!isCloser;
  const pos: Position | null = isPosition(position) ? position : null;
  if (pos) {
    baseTier = tierForPosition(pos);
    const fn = fnForPosition(pos);
    effSetter = fn.isSetter; effCloser = fn.isCloser;
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
  const closerManagerPath = await computeCloserManagerPath(closerManagerId);
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
    // Structural position + function flags + the closer org chart.
    position: pos || null,
    isSetter: effSetter,
    isCloser: effCloser,
    closerManagerId: closerManagerId || null,
    closerManagerPath,
    // A team manager can manage several teams (sees everyone in all of them).
    managedTeamIds: Array.isArray(managedTeamIds) ? managedTeamIds : [],
    canReassignAppointments: !!canReassignAppointments,
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

// ── Provider / legal identity (used on contracts + invoices) ─────────────────
// YoutilityKnock is the product; Sun Service is the legal entity behind it.
const PROVIDER_LEGAL_NAME = "Sun Service";
const PRODUCT_NAME = "YoutilityKnock";
const PRIVACY_URL = "https://youtilityknock.web.app/privacy";
const GOVERNING_LAW_STATE = "Utah";

export const inviteUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, email, tier, roleId, title, teamId, managerId, isSetter, isCloser, closerManagerId,
    position, managedTeamIds, canReassignAppointments } =
    request.data as {
      companyId?: string; name?: string; email?: string;
      tier?: Tier; roleId?: string; title?: string; teamId?: string; managerId?: string;
      isSetter?: boolean; isCloser?: boolean; closerManagerId?: string | null;
      position?: Position; managedTeamIds?: string[]; canReassignAppointments?: boolean;
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
  let effSetter = isSetter === undefined ? true : !!isSetter;
  let effCloser = !!isCloser;
  const pos: Position | null = isPosition(position) ? position : null;
  if (pos) {
    baseTier = tierForPosition(pos);
    const fn = fnForPosition(pos);
    effSetter = fn.isSetter; effCloser = fn.isCloser;
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
  const closerManagerPath = await computeCloserManagerPath(closerManagerId);
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
    position: pos || null,
    isSetter: effSetter,
    isCloser: effCloser,
    closerManagerId: closerManagerId || null,
    closerManagerPath,
    managedTeamIds: Array.isArray(managedTeamIds) ? managedTeamIds : [],
    canReassignAppointments: !!canReassignAppointments,
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

// resendInvite — regenerate and re-email a magic sign-in link for an EXISTING
// account (e.g. the invite was missed or expired). Company admin / super-admin.
export const resendInvite = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid } = (request.data || {}) as { uid?: string };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const u = snap.data() as any;
  authorizeForCompany(caller, u.companyId);
  const email = String(u.email || "").trim();
  if (!email) throw new HttpsError("failed-precondition", "This account has no email to send to.");

  let link = "";
  try {
    link = await getAuth().generateSignInWithEmailLink(email, { url: `${APP_URL}/app/login?invite=1`, handleCodeInApp: true });
  } catch (err: any) {
    throw new HttpsError("internal", err?.message || "Could not generate the sign-in link.");
  }
  await db.doc(`users/${uid}`).set({ invitePending: true, inviteResentAt: Date.now() }, { merge: true });

  let emailed = false;
  try {
    const cfg = await getNotifyConfig();
    const companyName = (await db.doc(`companies/${u.companyId}`).get()).data()?.name || "your team";
    emailed = await sendEmail(
      cfg, email, "Your YoutilityKnock sign-in link",
      `Hi ${u.displayName || "there"},\n\nHere's a fresh link to sign in to ${companyName} on YoutilityKnock:\n${link}\n\n` +
        `Tap it to sign in, then set your password. If you didn't request this, you can ignore it.`,
    );
  } catch (err) {
    logger.warn("resendInvite email send failed", err);
  }
  return { ok: true, emailed, link };
});

// getUserLoginMeta — the account's last sign-in / creation time from Firebase
// Auth (not stored in the profile doc). Company admin / super-admin.
export const getUserLoginMeta = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid } = (request.data || {}) as { uid?: string };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  authorizeForCompany(caller, (snap.data() as any).companyId);
  const rec = await getAuth().getUser(uid).catch(() => null);
  const m = rec?.metadata as any;
  return {
    lastSignInTime: m?.lastSignInTime || null, // RFC-1123 string, or null if never signed in
    creationTime: m?.creationTime || null,
    emailVerified: rec?.emailVerified ?? null,
  };
});

// Last-active for every account in a company, in one call (for the Accounts
// list). Combines Firebase Auth last sign-in with presence "last seen" and
// returns the most recent as an epoch-ms map { uid: ms }.
export const getCompanyActivity = onCall(async (request) => {
  const caller = await getCaller(request);
  const reqCompany = ((request.data || {}) as { companyId?: string }).companyId;
  const companyId = caller.isSuper && reqCompany ? reqCompany : caller.companyId;
  if (!companyId) throw new HttpsError("permission-denied", "No company.");
  if (!(caller.isSuper || caller.role === "admin")) throw new HttpsError("permission-denied", "Admins only.");
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const uids = usersSnap.docs.map((d) => d.id);
  const activity: Record<string, number> = {};
  // Auth last sign-in, in batches of 100 (getUsers cap).
  for (let i = 0; i < uids.length; i += 100) {
    const batch = uids.slice(i, i + 100).map((uid) => ({ uid }));
    const res = await getAuth().getUsers(batch).catch(() => null);
    if (res) for (const u of res.users) {
      const t = u.metadata?.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) : NaN;
      if (Number.isFinite(t)) activity[u.uid] = t;
    }
  }
  // Fold in presence "last seen" (map/app activity), keeping the most recent.
  const presSnap = await db.collection("presence").where("companyId", "==", companyId).get().catch(() => null);
  if (presSnap) presSnap.forEach((d) => { const ls = Number((d.data() as any).lastSeen) || 0; if (ls) activity[d.id] = Math.max(activity[d.id] || 0, ls); });
  return { activity };
});

// ───────────────────────────────────────────────────────────────────────────
// relinkMyProfile — self-heal a login whose profile lives under a DIFFERENT
// document ID than this Auth UID. The app loads a profile at users/<uid>, but
// an imported account (or one whose Auth user was deleted and recreated) has a
// profile keyed by some other id while still carrying the right email +
// companyId. Such a user authenticates fine but lands on "Account not set up"
// because users/<uid> doesn't exist. Here we find their orphaned profile BY
// THEIR OWN VERIFIED EMAIL and re-key it onto this UID, then rebuild the org
// chart so their managers/reports stay connected. Runs as the signed-in user;
// only ever touches a profile that matches their own Auth email.
// ───────────────────────────────────────────────────────────────────────────
export const relinkMyProfile = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  // Already linked — nothing to do (idempotent; safe to call on every login).
  const mine = await db.doc(`users/${uid}`).get();
  if (mine.exists && mine.data()?.companyId) return { ok: true, alreadyLinked: true };

  // Authoritative email from the Auth record (not a spoofable client claim).
  const authUser = await getAuth().getUser(uid).catch(() => null);
  const email = (authUser?.email || "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "no_email" };

  // Orphaned profile(s) carrying this email under a different doc id.
  const byEmail = await db.collection("users").where("email", "==", authUser!.email).get();
  const orphans = byEmail.docs.filter((d) => d.id !== uid && d.data()?.companyId && !d.data()?.relinkedTo);
  if (!orphans.length) return { ok: false, reason: "no_existing_profile" };
  // More than one distinct profile → ambiguous; don't guess, let an admin sort it.
  if (orphans.length > 1) return { ok: false, reason: "ambiguous", count: orphans.length };

  const orphan = orphans[0];
  const data = orphan.data();
  const companyId = data.companyId as string;
  const oldId = orphan.id;

  // Re-key the profile onto this UID (preserve provisioning + history fields).
  await db.doc(`users/${uid}`).set(
    { ...data, uid, disabled: false, relinkedFrom: oldId, relinkedAt: Date.now() },
    { merge: true }
  );
  // Retire the orphan so it stops showing as a duplicate active account.
  await orphan.ref.set({ relinkedTo: uid, disabled: true, updatedAt: Date.now() }, { merge: true });

  // Re-point anyone whose manager chain referenced the old id, so this user's
  // reports still ladder up to them after the re-key.
  const company = await db.collection("users").where("companyId", "==", companyId).get();
  let batch = db.batch();
  let ops = 0;
  for (const d of company.docs) {
    const u = d.data();
    const patch: Record<string, unknown> = {};
    if (u.managerId === oldId) patch.managerId = uid;
    if (u.closerManagerId === oldId) patch.closerManagerId = uid;
    if (Object.keys(patch).length) { batch.update(d.ref, patch); if (++ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; } }
  }
  if (ops) await batch.commit();

  // Mirror access claims and recompute every path/visibility from the links.
  await getAuth().setCustomUserClaims(uid, { role: (data.role as string) || "user", companyId });
  await rebuildCompanyHierarchy(companyId);

  logger.info(`Relinked profile ${oldId} → ${uid} (${email}) in ${companyId}`);
  return { ok: true, companyId, relinkedFrom: oldId };
});

// linkProfileToUid — admin manually links an existing company profile to a
// specific Firebase Auth UID (the "Account ID" shown on the ACCOUNT NOT SET UP
// gate). This is the fallback for when auto-relink can't resolve it on its own —
// e.g. a duplicate profile for the same email makes it ambiguous, so it refuses
// to guess. The admin opens the person's profile and pastes the Account ID.
// Company admin / super-admin.
export const linkProfileToUid = onCall(async (request) => {
  const caller = await getCaller(request);
  const { profileUid, targetUid } = (request.data || {}) as { profileUid?: string; targetUid?: string };
  if (!profileUid || !targetUid) throw new HttpsError("invalid-argument", "profileUid and targetUid required.");
  const target = String(targetUid).trim();
  if (!/^[A-Za-z0-9_-]{6,}$/.test(target)) throw new HttpsError("invalid-argument", "That doesn't look like a valid Account ID.");

  const snap = await db.doc(`users/${profileUid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Profile not found.");
  const data = snap.data() as any;
  const companyId = data.companyId as string;
  if (!companyId) throw new HttpsError("failed-precondition", "That profile isn't attached to a company.");
  authorizeForCompany(caller, companyId);

  // The target Auth account must exist, and its email should match the profile
  // so we never hand a company profile to an unrelated login.
  const authUser = await getAuth().getUser(target).catch(() => null);
  if (!authUser) throw new HttpsError("not-found", "No sign-in account with that Account ID. Have them sign in once first.");
  const profileEmail = String(data.email || "").trim().toLowerCase();
  const authEmail = String(authUser.email || "").trim().toLowerCase();
  if (profileEmail && authEmail && profileEmail !== authEmail) {
    throw new HttpsError("failed-precondition",
      `That Account ID signs in as ${authUser.email}, but this profile is ${data.email}. Double-check the ID.`);
  }
  if (target === profileUid) return { ok: true, alreadyLinked: true };

  // Re-key the profile onto the target UID (same as auto-relink, but explicit).
  await db.doc(`users/${target}`).set(
    { ...data, uid: target, email: authUser.email || data.email, disabled: false, invitePending: false,
      relinkedFrom: profileUid, relinkedAt: Date.now() },
    { merge: true },
  );
  await snap.ref.set({ relinkedTo: target, disabled: true, updatedAt: Date.now() }, { merge: true });

  // Retire any OTHER same-email profiles so the next login isn't ambiguous.
  if (authUser.email) {
    const dupes = await db.collection("users").where("email", "==", authUser.email).get();
    for (const d of dupes.docs) {
      if (d.id === target || d.id === profileUid) continue;
      if (d.data()?.relinkedTo) continue;
      await d.ref.set({ relinkedTo: target, disabled: true, updatedAt: Date.now() }, { merge: true });
    }
  }

  // Re-point manager chains that referenced the old id so reports still ladder up.
  const company = await db.collection("users").where("companyId", "==", companyId).get();
  let batch = db.batch();
  let ops = 0;
  for (const d of company.docs) {
    const u = d.data();
    const patch: Record<string, unknown> = {};
    if (u.managerId === profileUid) patch.managerId = target;
    if (u.closerManagerId === profileUid) patch.closerManagerId = target;
    if (Object.keys(patch).length) { batch.update(d.ref, patch); if (++ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; } }
  }
  if (ops) await batch.commit();

  await getAuth().setCustomUserClaims(target, { role: (data.role as string) || "user", companyId });
  await rebuildCompanyHierarchy(companyId);
  logger.info(`Admin ${caller.uid} linked profile ${profileUid} → ${target} (${authUser.email}) in ${companyId}`);
  return { ok: true, companyId, linkedFrom: profileUid };
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
  const { companyId, name, parentTeamId, leadUserId, servicePermissions, logoUrl, kind, regionalManagerUid } = request.data as
    { companyId?: string; name?: string; parentTeamId?: string | null; leadUserId?: string; servicePermissions?: string[]; logoUrl?: string | null; kind?: string; regionalManagerUid?: string | null };
  const company = authorizeForCompany(caller, companyId);
  if (!name?.trim()) throw new HttpsError("invalid-argument", "Team name required.");
  // kind: "company" (umbrella baseline) | "region" | "team" (default).
  const teamKind = kind === "region" || kind === "company" ? kind : "team";
  const ref = await db.collection(`companies/${company}/teams`).add({
    companyId: company, name: name.trim(),
    parentTeamId: parentTeamId || null, leadUserId: leadUserId || null,
    logoUrl: logoUrl || null,
    kind: teamKind,
    // Only meaningful on regions: the manager the whole region rolls up to.
    regionalManagerUid: teamKind === "region" ? (regionalManagerUid || null) : null,
    // Locked-baseline services granted to everyone on the team.
    servicePermissions: Array.isArray(servicePermissions) ? servicePermissions : [],
    createdAt: Date.now(),
  });
  // A new region with a manager already set needs the org chart recomputed.
  if (teamKind === "region" && regionalManagerUid) await rebuildCompanyHierarchy(company);
  return { ok: true, teamId: ref.id };
});

export const updateTeam = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, teamId, name, parentTeamId, leadUserId, servicePermissions, logoUrl, kind, regionalManagerUid } = request.data as
    { companyId?: string; teamId?: string; name?: string; parentTeamId?: string | null; leadUserId?: string; servicePermissions?: string[]; logoUrl?: string | null; kind?: string; regionalManagerUid?: string | null };
  const company = authorizeForCompany(caller, companyId);
  if (!teamId) throw new HttpsError("invalid-argument", "teamId required.");
  const patch: Record<string, unknown> = {};
  if (name?.trim()) patch.name = name.trim();
  if (parentTeamId !== undefined) patch.parentTeamId = parentTeamId || null;
  if (leadUserId !== undefined) patch.leadUserId = leadUserId || null;
  if (servicePermissions !== undefined) patch.servicePermissions = Array.isArray(servicePermissions) ? servicePermissions : [];
  if (logoUrl !== undefined) patch.logoUrl = logoUrl || null;
  if (kind !== undefined && (kind === "region" || kind === "company" || kind === "team")) patch.kind = kind;
  if (regionalManagerUid !== undefined) patch.regionalManagerUid = regionalManagerUid || null;
  await db.doc(`companies/${company}/teams/${teamId}`).set(patch, { merge: true });
  // Region wiring (which region a team is in, or who manages a region) changes
  // who rolls up to whom — recompute the org chart's paths + visibility.
  if (parentTeamId !== undefined || regionalManagerUid !== undefined || kind !== undefined) {
    await rebuildCompanyHierarchy(company);
  }
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
  const { uid, roleId, teamId, managerId, closerManagerId, isSetter, isCloser,
    position, managedTeamIds, canReassignAppointments } = request.data as
    { uid?: string; roleId?: string; teamId?: string | null; managerId?: string | null;
      closerManagerId?: string | null; isSetter?: boolean; isCloser?: boolean;
      position?: Position; managedTeamIds?: string[]; canReassignAppointments?: boolean };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const target = await authorizeForTargetUser(caller, uid);
  const company = target.companyId as string;

  // You can edit your own team/managers/etc., but not strip your own admin.
  if (uid === caller.uid && !caller.isSuper) {
    if (isPosition(position) && tierForPosition(position) !== "admin") {
      throw new HttpsError("permission-denied", "You can't change your own role away from admin — ask another admin.");
    }
    if (roleId) {
      const rs = await db.doc(`companies/${company}/roles/${roleId}`).get();
      if (rs.exists && (rs.data()!.baseTier as string) !== "admin") {
        throw new HttpsError("permission-denied", "You can't change your own role away from admin — ask another admin.");
      }
    }
  }

  if (managerId === uid) throw new HttpsError("invalid-argument", "A user can't report to themselves.");
  if (closerManagerId === uid) throw new HttpsError("invalid-argument", "A user can't report to themselves.");

  const patch: Record<string, unknown> = {};
  let claimsChanged = false;
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
      claimsChanged = true;
    } else {
      patch.roleId = null;
    }
  }
  // Position drives the tier + setter/closer function (overrides any role tier).
  if (isPosition(position)) {
    const t = tierForPosition(position);
    const fn = fnForPosition(position);
    patch.position = position;
    patch.role = t;
    patch.isSetter = fn.isSetter;
    patch.isCloser = fn.isCloser;
    // A "scheduler" position is a dedicated dispatcher — grant the dispatch tool
    // and lock them to the Scheduler on login. Moving OFF the scheduler position
    // clears that lock; other position changes leave the scheduler flags alone
    // (so a closer's add-on dispatch capability isn't wiped by a re-title).
    if (position === "scheduler") { patch.isScheduler = true; patch.schedulerOnly = true; }
    else if ((target as any).position === "scheduler") { patch.isScheduler = false; patch.schedulerOnly = false; }
    await getAuth().setCustomUserClaims(uid, {
      ...(await getAuth().getUser(uid)).customClaims,
      role: t,
    });
    claimsChanged = true;
  }
  // Bump a marker the app watches so it force-refreshes the ID token (picking up
  // the new claims) without waiting ~1h or making the rep log in again.
  if (claimsChanged) patch.claimsUpdatedAt = Date.now();
  if (teamId !== undefined) patch.teamId = teamId || null;
  if (managerId !== undefined) patch.managerId = managerId || null;
  if (closerManagerId !== undefined) patch.closerManagerId = closerManagerId || null;
  // Explicit isSetter/isCloser only honored when no position was supplied.
  if (!isPosition(position) && isSetter !== undefined) patch.isSetter = !!isSetter;
  if (!isPosition(position) && isCloser !== undefined) patch.isCloser = !!isCloser;
  if (managedTeamIds !== undefined) patch.managedTeamIds = Array.isArray(managedTeamIds) ? managedTeamIds : [];
  if (canReassignAppointments !== undefined) patch.canReassignAppointments = !!canReassignAppointments;

  await db.doc(`users/${uid}`).set(patch, { merge: true });
  await rebuildCompanyHierarchy(company);
  logger.info(`Hierarchy updated for ${uid} in ${company} by ${caller.uid}`);
  return { ok: true };
});

// Set the per-position service permissions for a company ("services by role").
// Stored as companies/{id}.positionServices = { setter: [...], closer: [...], ... }.
export const setPositionServices = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, positionServices } = (request.data || {}) as
    { companyId?: string; positionServices?: Record<string, string[]> };
  const company = authorizeForCompany(caller, companyId);
  if (!positionServices || typeof positionServices !== "object") {
    throw new HttpsError("invalid-argument", "positionServices required.");
  }
  const clean: Record<string, string[]> = {};
  for (const p of POSITIONS) {
    const v = (positionServices as Record<string, unknown>)[p];
    if (Array.isArray(v)) clean[p] = v.filter((x) => typeof x === "string") as string[];
  }
  await db.doc(`companies/${company}`).set({ positionServices: clean, updatedAt: Date.now() }, { merge: true });
  return { ok: true };
});

// Reassign an appointment to a different closer. Allowed for a super-admin, a
// company admin, or a closer-manager who has the reassign permission AND already
// sees the appointment (it's in their downline). Refreshes the company's
// visibility paths so the new closer + their chain can see it.
export const reassignAppointment = onCall(async (request) => {
  const caller = await getCaller(request);
  const { eventId, closerUid } = (request.data || {}) as { eventId?: string; closerUid?: string };
  if (!eventId || !closerUid) throw new HttpsError("invalid-argument", "eventId and closerUid required.");
  const evRef = db.doc(`events/${eventId}`);
  const ev = (await evRef.get()).data();
  if (!ev) throw new HttpsError("not-found", "Appointment not found.");
  const company = ev.companyId as string;

  const inDownline = Array.isArray(ev.visibilityPath) && (ev.visibilityPath as string[]).includes(caller.uid);
  // The original setter, a company admin, or a manager for the team may reassign
  // (plus the existing closer-manager reassign permission).
  let allowed = caller.isSuper
    || (caller.companyId === company && caller.role === "admin")
    || ev.setterUid === caller.uid
    || (caller.companyId === company && caller.role === "manager" && inDownline);
  if (!allowed) {
    const me = (await db.doc(`users/${caller.uid}`).get()).data() || {};
    // A Scheduler dispatches for the whole team, so they can reassign any
    // company appointment; the canReassign permission stays downline-scoped.
    allowed = me.companyId === company && (!!me.isScheduler || (!!me.canReassignAppointments && inDownline));
  }
  if (!allowed) throw new HttpsError("permission-denied", "Not allowed to reassign this appointment.");

  const newCloser = (await db.doc(`users/${closerUid}`).get()).data();
  if (!newCloser || newCloser.companyId !== company || !newCloser.isCloser) {
    throw new HttpsError("invalid-argument", "Pick a closer in this company.");
  }
  const closerName = newCloser.displayName || newCloser.email || "Closer";
  // Who owned the appointment before this reassign (the "Assigned to" rep + the
  // calendar it sits on). Capture it before we overwrite so we can pull the
  // event off their external calendar.
  const prevOwnerUid = (ev.userId as string) || "";
  const ownerChanged = prevOwnerUid !== closerUid;

  // Hand the appointment fully to the new closer: they become the OWNER
  // ("Assigned to"), not just the named closer. Dropping userId off the old rep
  // — plus the visibilityPath rebuild below — removes their access entirely, so
  // a reassigned appointment no longer lingers with the person who lost it.
  const wasUnassigned = !ev.closerUid; // a dispatch-queue appt getting its first closer
  await evRef.set({
    userId: closerUid,
    userName: closerName,
    closerUid,
    closerName,
    dispatchPending: false, // it now has a closer — clear the dispatch flag
    // The old owner's external-calendar ids point at THEIR calendar; clear them
    // so a later reschedule doesn't patch an event on the wrong person's calendar.
    googleEventId: null,
    microsoftEventId: null,
    updatedAt: Date.now(),
  }, { merge: true });
  await rebuildCompanyHierarchy(company); // recompute appointment visibilityPath (drops the old owner)
  // First assignment of a dispatch appt puts it into this closer's queue count.
  if (wasUnassigned) await serverBumpStats({ uid: closerUid, ...(newCloser as any) }, { closerAppts: 1 }).catch(() => {});

  // Move it off the previous owner's Google/Outlook and onto the new closer's,
  // so it disappears from the old rep's calendar too — not just the app.
  if (ownerChanged) {
    if (prevOwnerUid && (ev.googleEventId || ev.microsoftEventId)) {
      await deleteExternalEvent(prevOwnerUid, {
        googleEventId: ev.googleEventId as string | undefined,
        microsoftEventId: ev.microsoftEventId as string | undefined,
      }).catch((e) => logger.warn("reassign: old calendar delete failed", e));
    }
    const startMs = Number(ev.startAt);
    if (Number.isFinite(startMs)) {
      try {
        const ids = await pushExternalEvent(closerUid, {
          title: (ev.title as string) || "Appointment",
          address: ev.address as string | undefined,
          notes: (ev.notes as string) || (ev.apptNotes as string) || undefined,
          startMs,
          endMs: Number(ev.endAt) || startMs + (Number(ev.durationMin) || 60) * 60 * 1000,
        });
        if (ids.googleEventId || ids.microsoftEventId) await evRef.set(ids, { merge: true });
      } catch (e) { logger.warn("reassign: new calendar push failed", e); }
    }
    await notifyUser({
      userId: closerUid, type: "event",
      title: "New appointment to close",
      body: [ev.title, ev.startAt ? fmtApptTime(Number(ev.startAt), ev.address as string | undefined) : ""].filter(Boolean).join(" — "),
      link: "/app/closer",
    }).catch(() => {});
    if (prevOwnerUid) await notifyUser({
      userId: prevOwnerUid, type: "event",
      title: "Appointment reassigned",
      body: [ev.title, `reassigned to ${closerName}`].filter(Boolean).join(" — "),
      link: "/app/schedule",
    }).catch(() => {});
  }

  logger.info(`Appointment ${eventId} reassigned to ${closerUid} (owner ${prevOwnerUid || "—"}→${closerUid}) by ${caller.uid}`);
  return { ok: true };
});

// Reschedule an appointment to a new time. Allowed for the original setter, a
// company admin, or a manager for the team. Moves the matching event on the
// owner's external calendar in place (no duplicate).
export const rescheduleAppointment = onCall(async (request) => {
  const caller = await getCaller(request);
  const { eventId, startAt } = (request.data || {}) as { eventId?: string; startAt?: number };
  const start = Number(startAt);
  if (!eventId || !Number.isFinite(start)) throw new HttpsError("invalid-argument", "eventId and startAt required.");
  const evRef = db.doc(`events/${eventId}`);
  const ev = (await evRef.get()).data();
  if (!ev) throw new HttpsError("not-found", "Appointment not found.");
  const company = ev.companyId as string;
  const inTeam = Array.isArray(ev.visibilityPath) && (ev.visibilityPath as string[]).includes(caller.uid);
  const allowed = caller.isSuper
    || (caller.companyId === company && caller.role === "admin")
    || ev.setterUid === caller.uid
    || (caller.companyId === company && caller.role === "manager" && inTeam);
  if (!allowed) throw new HttpsError("permission-denied", "Not allowed to reschedule this appointment.");

  const dur = (Number(ev.durationMin) || 60) * 60 * 1000;
  const endAt = start + dur;
  await evRef.set({ startAt: start, endAt, updatedAt: Date.now() }, { merge: true });

  // Move it on the owner's external calendar too (patch in place).
  if (ev.userId) {
    try {
      const ids = await patchExternalEvent(
        ev.userId as string,
        { googleEventId: ev.googleEventId, microsoftEventId: ev.microsoftEventId },
        { title: ev.title || "Appointment", address: ev.address, notes: ev.notes || ev.apptNotes, startMs: start, endMs: endAt },
      );
      if (ids.googleEventId !== ev.googleEventId || ids.microsoftEventId !== ev.microsoftEventId) {
        await evRef.set(ids, { merge: true }).catch(() => {});
      }
    } catch (e) { logger.warn("reschedule external sync failed", e); }
    if (ev.userId !== caller.uid) {
      await notifyUser({ userId: ev.userId as string, type: "event", title: "Appointment moved", body: [ev.title, fmtApptTime(Number(start), ev.address as string | undefined)].filter(Boolean).join(" — "), link: "/app/schedule" });
    }
  }
  return { ok: true, startAt: start, endAt };
});

// Cancel / delete an appointment and unwind everything it touched — so a
// cancelled appointment never lingers in anyone's numbers. Permission mirrors
// reschedule (the setter, a team manager, or a company admin). We:
//   • fully reverse the stat credits, EACH in the period it was earned (the
//     "set" credit at createdAt, any sit/close credit at dispositionedAt), so
//     both the leaderboard counters and the season boards drop it;
//   • revert the lead out of "appointment" so the lead-based funnel (Reports &
//     Rep Rankings) stops counting it;
//   • remove the event from the owner's external calendar and delete it.
// A won deal can't be cancelled here — undo the sale first.
export const cancelAppointment = onCall(async (request) => {
  const caller = await getCaller(request);
  const { eventId } = (request.data || {}) as { eventId?: string };
  if (!eventId) throw new HttpsError("invalid-argument", "eventId required.");
  const evRef = db.doc(`events/${eventId}`);
  const ev = (await evRef.get()).data() as any;
  if (!ev) throw new HttpsError("not-found", "Appointment not found.");
  if (ev.type !== "appointment") throw new HttpsError("failed-precondition", "Only appointments can be cancelled here.");

  const company = ev.companyId as string;
  const inTeam = Array.isArray(ev.visibilityPath) && (ev.visibilityPath as string[]).includes(caller.uid);
  // Only the setter who SET it, a team manager, or a company admin — never the
  // closer. For a routed appointment the setter is setterUid (userId is the
  // closer); for a self-gen appointment (no closer) the setter is userId.
  const isSetter = ev.setterUid
    ? ev.setterUid === caller.uid
    : (!ev.closerUid && ev.userId === caller.uid);
  const allowed = caller.isSuper
    || (caller.companyId === company && caller.role === "admin")
    || isSetter
    || (caller.companyId === company && caller.role === "manager" && inTeam);
  if (!allowed) throw new HttpsError("permission-denied", "Not allowed to cancel this appointment.");

  const apptStatus = (ev.apptStatus as string) || "scheduled";
  if (apptStatus === "closed_won") {
    throw new HttpsError("failed-precondition", "This appointment already closed as a won deal — reverse the sale before cancelling.");
  }

  // The setter is whoever set it (self-gen events store only userId; routed
  // appointments store setterUid + the closer as userId).
  const setterUid = (ev.setterUid as string) || (ev.userId as string) || null;
  const closerUid = (ev.closerUid as string) || null;
  const [setterSnap, closerSnap] = await Promise.all([
    setterUid ? db.doc(`users/${setterUid}`).get() : Promise.resolve(null as any),
    closerUid ? db.doc(`users/${closerUid}`).get() : Promise.resolve(null as any),
  ]);
  const setter = setterSnap && setterSnap.exists ? { uid: setterSnap.id, ...(setterSnap.data() as any) } : null;
  const closer = closerSnap && closerSnap.exists ? { uid: closerSnap.id, ...(closerSnap.data() as any) } : null;

  const setAt = Number(ev.createdAt) || Number(ev.startAt) || Date.now();
  const dispoAt = Number(ev.dispositionedAt) || setAt;
  const isSit = CLOSER_SIT_STATUSES.has(apptStatus);

  // Reverse the "appointment set" credit in the period it was set.
  if (setter) await serverBumpStatsAt(setter, { appointments: -1 }, setAt);
  if (closer) await serverBumpStatsAt(closer, { closerAppts: -1 }, setAt);
  // Reverse any disposition credit in the period it was dispositioned.
  if (isSit) {
    if (closer) await serverBumpStatsAt(closer, { closerSits: -1 }, dispoAt);
    if (setter) await serverBumpStatsAt(setter, { sits: -1, pitchedAppts: -1 }, dispoAt);
  } else if (apptStatus === "no_show") {
    if (setter) await serverBumpStatsAt(setter, { pitchedAppts: -1 }, dispoAt);
  }
  if (apptStatus === "turned_away" && closer) await serverBumpStatsAt(closer, { closerTurnedAways: -1 }, dispoAt);
  if (apptStatus === "closer_no_show" && closer) await serverBumpStatsAt(closer, { closerNoShows: -1 }, dispoAt);

  // Drop the lead out of "appointment" so the lead-based funnel stops counting
  // it — keep it as a warm "pipeline" lead (it was still a real conversation).
  if (ev.leadId) {
    try {
      const leadRef = db.doc(`leads/${ev.leadId}`);
      const lead = (await leadRef.get()).data() as any;
      if (lead && lead.status === "appointment") {
        await leadRef.set({ status: "pipeline", updatedAt: Date.now() }, { merge: true });
      }
    } catch (e) { logger.warn("cancel: lead revert failed", e); }
  }

  // Remove it from the owner's external calendar, then delete the event.
  if (ev.userId) {
    await deleteExternalEvent(ev.userId as string, { googleEventId: ev.googleEventId, microsoftEventId: ev.microsoftEventId }).catch(() => {});
  }
  await evRef.delete();

  // Let the closer know their queued appointment is gone (if someone else cancelled).
  if (closerUid && closerUid !== caller.uid) {
    await notifyUser({
      userId: closerUid, type: "event", title: "Appointment cancelled",
      body: [ev.title || "Appointment", ev.address].filter(Boolean).join(" — "), link: "/app/schedule",
    }).catch(() => {});
  }
  return { ok: true };
});

// Set a user's function (setter / closer / both). Keeps isSetter + isCloser in
// sync; rebuilds the org charts so both chains stay consistent.
export const setUserFunction = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, isSetter, isCloser, kind } = (request.data || {}) as { uid?: string; isSetter?: boolean; isCloser?: boolean; kind?: string };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  authorizeForCompany(caller, (snap.data() as any).companyId);
  if (kind === "scheduler") {
    // A dedicated dispatcher: locked to the Scheduler on login, no door lane.
    await db.doc(`users/${uid}`).set(
      { isSetter: false, isCloser: false, isScheduler: true, schedulerOnly: true, position: "scheduler" }, { merge: true });
  } else {
    const patch: Record<string, unknown> = { isSetter: !!isSetter, isCloser: !!isCloser, schedulerOnly: false };
    // Switching a dedicated scheduler to a door lane drops the scheduler role.
    if ((snap.data() as any).position === "scheduler") { patch.position = null; patch.isScheduler = false; }
    await db.doc(`users/${uid}`).set(patch, { merge: true });
  }
  // company.schedulerActive is kept in sync by the onUserSchedulerSync trigger.
  return { ok: true };
});

// Update a user's profile / personal info (company admin or super-admin). Covers
// the human details the Accounts editor collects — name plus contact + sizing —
// separate from the org-chart wiring in assignUserHierarchy.
export const updateUserProfile = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, displayName, phone, mailingAddress, birthday, shirtSize, hatSize } = (request.data || {}) as {
    uid?: string; displayName?: string; phone?: string; mailingAddress?: string; birthday?: string; shirtSize?: string; hatSize?: string;
  };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  authorizeForCompany(caller, (snap.data() as any).companyId);
  const patch: Record<string, unknown> = {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (displayName !== undefined) {
    const dn = str(displayName);
    if (!dn) throw new HttpsError("invalid-argument", "Name can't be empty.");
    patch.displayName = dn;
  }
  if (phone !== undefined) patch.phone = str(phone);
  if (mailingAddress !== undefined) patch.mailingAddress = str(mailingAddress);
  if (birthday !== undefined) patch.birthday = str(birthday); // "YYYY-MM-DD" or ""
  if (shirtSize !== undefined) patch.shirtSize = str(shirtSize);
  if (hatSize !== undefined) patch.hatSize = str(hatSize);
  if (Object.keys(patch).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  await db.doc(`users/${uid}`).set(patch, { merge: true });
  // Keep the Auth displayName in sync so it shows the same everywhere.
  if (patch.displayName) await getAuth().updateUser(uid, { displayName: patch.displayName as string }).catch(() => {});
  return { ok: true, ...patch };
});

// Change a user's sign-in email (company admin / super-admin). Sensitive: the
// caller re-authenticates with their own password client-side first, and a
// reason is required and logged to the user's audit trail.
export const changeUserEmail = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, newEmail, reason } = (request.data || {}) as { uid?: string; newEmail?: string; reason?: string };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const email = String(newEmail || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError("invalid-argument", "Enter a valid email.");
  const note = String(reason || "").trim();
  if (!note) throw new HttpsError("invalid-argument", "A reason is required.");
  const ref = db.doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const data = snap.data() as any;
  authorizeForCompany(caller, data.companyId);
  const oldEmail = (data.email as string) || "";
  if (oldEmail.toLowerCase() === email) throw new HttpsError("invalid-argument", "That's already their email.");
  try {
    await getAuth().updateUser(uid, { email, emailVerified: false });
  } catch (e: any) {
    if (e?.code === "auth/email-already-exists") throw new HttpsError("already-exists", "That email is already in use by another account.");
    if (e?.code === "auth/invalid-email") throw new HttpsError("invalid-argument", "That email is invalid.");
    throw new HttpsError("internal", e?.message || "Couldn't update the email.");
  }
  await ref.set({ email }, { merge: true });
  await ref.collection("auditLog").add({
    type: "email_change", oldEmail, newEmail: email, reason: note,
    changedBy: caller.uid, changedByEmail: (request.auth?.token?.email as string) || "", at: Date.now(),
  });
  logger.info(`Email for ${uid} changed ${oldEmail} → ${email} by ${caller.uid}: ${note}`);
  return { ok: true, email };
});

// Assigns a rep's ported number (Telnyx) + where their calls forward to. Set
// once a number's porting has actually completed — company admin or super-admin.
export const setUserPhoneRouting = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, smsNumber, smsForwardTo } = (request.data || {}) as { uid?: string; smsNumber?: string; smsForwardTo?: string };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  // A rep may manage their own texting/forwarding; otherwise a company admin.
  if (caller.uid !== uid) authorizeForCompany(caller, (snap.data() as any).companyId);
  const update: Record<string, unknown> = {};
  if (typeof smsNumber === "string") update.smsNumber = smsNumber.trim();
  if (typeof smsForwardTo === "string") update.smsForwardTo = smsForwardTo.trim();
  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  await db.doc(`users/${uid}`).set(update, { merge: true });
  return { ok: true, ...update };
});

// ───────────────────────────────────────────────────────────────────────────
// setUserRole / setUserDisabled (base-tier changes + enable/disable).
// ───────────────────────────────────────────────────────────────────────────
export const setUserRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, role } = request.data as { uid?: string; role?: Tier };
  if (!uid || !TIERS.includes(role as Tier)) throw new HttpsError("invalid-argument", "uid and a valid tier are required.");
  await authorizeForTargetUser(caller, uid);
  if (uid === caller.uid && !caller.isSuper && role !== "admin") {
    throw new HttpsError("permission-denied", "You can't change your own role away from admin.");
  }
  const existing = (await getAuth().getUser(uid)).customClaims || {};
  await getAuth().setCustomUserClaims(uid, { ...existing, role });
  await db.doc(`users/${uid}`).set({ role, claimsUpdatedAt: Date.now() }, { merge: true });
  return { ok: true };
});

export const setUserDisabled = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, disabled } = request.data as { uid?: string; disabled?: boolean };
  if (!uid || typeof disabled !== "boolean") throw new HttpsError("invalid-argument", "uid and disabled flag required.");
  await authorizeForTargetUser(caller, uid);
  if (uid === caller.uid && !caller.isSuper && disabled) {
    throw new HttpsError("permission-denied", "You can't disable your own account.");
  }
  await getAuth().updateUser(uid, { disabled });
  if (disabled) await getAuth().revokeRefreshTokens(uid);
  await db.doc(`users/${uid}`).set(
    { disabled, disabledAt: disabled ? Date.now() : FieldValue.delete() }, { merge: true });
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// deleteUser — permanently remove an account and (optionally) hand off their
// book of business to another rep. Reassigns the deleted user's leads and
// appointments (as assignee / closer / setter), re-points anyone who reported
// to them, then deletes the Auth user + Firestore profile and rebuilds the org
// chart. Company admin (own company) or super-admin. Irreversible.
// ───────────────────────────────────────────────────────────────────────────
export const deleteUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, uid, reassignToUid } = request.data as
    { companyId?: string; uid?: string; reassignToUid?: string | null };
  const company = authorizeForCompany(caller, companyId);
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  if (uid === caller.uid) throw new HttpsError("permission-denied", "You can't delete your own account.");

  const targetSnap = await db.doc(`users/${uid}`).get();
  if (!targetSnap.exists) throw new HttpsError("not-found", "User not found.");
  const target = targetSnap.data()!;
  if ((target.companyId as string) !== company) throw new HttpsError("permission-denied", "User is not in this company.");
  if (target.role === "admin" && !caller.isSuper) {
    throw new HttpsError("permission-denied", "Only a super-admin can delete a company admin.");
  }

  // Resolve the reassignment target (optional — must be in the same company).
  let toUid = ""; let toName = "";
  if (reassignToUid) {
    if (reassignToUid === uid) throw new HttpsError("invalid-argument", "Reassign target can't be the deleted user.");
    const toSnap = await db.doc(`users/${reassignToUid}`).get();
    if (!toSnap.exists || (toSnap.data()!.companyId as string) !== company) {
      throw new HttpsError("invalid-argument", "Reassign target must be in this company.");
    }
    toUid = reassignToUid; toName = (toSnap.data()!.displayName as string) || "";
  }

  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

  if (toUid) {
    // Leads owned by the deleted user → the new rep.
    const leads = await db.collection("leads").where("companyId", "==", company).where("assignedTo", "==", uid).get();
    for (const d of leads.docs) { batch.update(d.ref, { assignedTo: toUid }); if (++ops >= 400) await flush(); }
    await flush();
    // Appointments / events where the deleted user is the assignee, closer or setter.
    const eventFields: ReadonlyArray<readonly [string, string]> =
      [["userId", "userName"], ["closerUid", "closerName"], ["setterUid", "setterName"]];
    for (const [idField, nameField] of eventFields) {
      const snap = await db.collection("events").where("companyId", "==", company).where(idField, "==", uid).get();
      for (const d of snap.docs) { batch.update(d.ref, { [idField]: toUid, [nameField]: toName }); if (++ops >= 400) await flush(); }
      await flush();
    }
  }

  // Re-point anyone who reported to the deleted user so they aren't orphaned
  // (to the new rep if one was given, otherwise detached).
  const members = await db.collection("users").where("companyId", "==", company).get();
  for (const d of members.docs) {
    if (d.id === uid) continue;
    const u = d.data();
    const patch: Record<string, unknown> = {};
    if (u.managerId === uid) patch.managerId = toUid || null;
    if (u.closerManagerId === uid) patch.closerManagerId = toUid || null;
    if (Object.keys(patch).length) { batch.update(d.ref, patch); if (++ops >= 400) await flush(); }
  }
  await flush();

  // Remove the profile + stats, then the Auth user (best-effort — the doc id may
  // not be a live Auth uid for an imported account).
  await db.doc(`users/${uid}`).delete();
  await db.doc(`userStats/${uid}`).delete().catch(() => undefined);
  try { await getAuth().deleteUser(uid); }
  catch (e: any) { logger.warn(`deleteUser: auth delete failed for ${uid}: ${e?.message}`); }

  await rebuildCompanyHierarchy(company);
  logger.info(`User ${uid} deleted by ${caller.uid}; book reassigned to ${toUid || "(none)"}`);
  return { ok: true, reassignedTo: toUid || null };
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
//     ONLINE_WINDOW_MS), we ALSO send email (SendGrid) and SMS (Telnyx) so they
//     hear about it before the apps are live.
// Provider keys come from the super-admin console (Firestore config/notifications),
// falling back to env vars. Absent keys → email/SMS skipped, no error, so the
// core app works without them configured.
// ════════════════════════════════════════════════════════════════════════════

interface NotifyConfig {
  // SMTP (the platform's own-mailbox email — preferred over SendGrid).
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpFromName: string;
  sendgridKey: string;
  sendgridFrom: string;
  sendgridFromName: string;
  // Telnyx (SMS + voice for ported rep numbers, and the platform SMS fallback).
  telnyxApiKey: string;
  telnyxFrom: string; // platform default From when a rep has no ported number yet
  telnyxMessagingProfileId: string;
  telnyxPublicKey: string; // webhook Ed25519 signature verification
}

// Read provider config: Firestore (set via super-admin console) overrides env.
async function getNotifyConfig(): Promise<NotifyConfig> {
  let c: Record<string, any> = {};
  try {
    const snap = await db.doc("config/notifications").get();
    if (snap.exists) c = (snap.data() as Record<string, any>) || {};
  } catch (e) {
    logger.warn("getNotifyConfig read failed", e);
  }
  return {
    smtpHost: c.smtpHost || process.env.SMTP_HOST || "",
    smtpPort: Number(c.smtpPort) || 587,
    smtpSecure: c.smtpSecure === true,
    smtpUser: c.smtpUser || process.env.SMTP_USER || "",
    smtpPass: c.smtpPass || process.env.SMTP_PASS || "",
    smtpFrom: c.smtpFrom || "",
    smtpFromName: c.smtpFromName || "YoutilityKnock",
    sendgridKey: c.sendgridKey || process.env.SENDGRID_API_KEY || "",
    sendgridFrom: c.sendgridFrom || process.env.SENDGRID_FROM || "",
    sendgridFromName: c.sendgridFromName || process.env.SENDGRID_FROM_NAME || "YoutilityKnock",
    telnyxApiKey: c.telnyxApiKey || process.env.TELNYX_API_KEY || "",
    telnyxFrom: c.telnyxFrom || process.env.TELNYX_FROM || "",
    telnyxMessagingProfileId: c.telnyxMessagingProfileId || process.env.TELNYX_MESSAGING_PROFILE_ID || "",
    telnyxPublicKey: c.telnyxPublicKey || process.env.TELNYX_PUBLIC_KEY || "",
  };
}

// A phone number that has texted STOP (or been manually suppressed) — checked
// before every homeowner-facing send, platform-wide, regardless of which lead
// record it's attached to. E.164 keys.
async function isSuppressed(phoneE164: string): Promise<boolean> {
  if (!phoneE164) return true;
  try {
    const snap = await db.doc(`smsSuppressions/${phoneE164}`).get();
    return snap.exists;
  } catch {
    return false;
  }
}

// A user is considered "online" if their presence doc was touched this recently.
const ONLINE_WINDOW_MS = 90 * 1000;

interface EmailAttachment { filename: string; content: string; type: string } // content = base64
// Send an email and return why it failed (so the console can show the real
// SendGrid error instead of a generic "couldn't send").
async function sendEmailDetailed(
  cfg: NotifyConfig, to: string, subject: string, text: string, attachments?: EmailAttachment[], html?: string
): Promise<{ ok: boolean; detail: string }> {
  if (!to) return { ok: false, detail: "No recipient email." };

  // Preferred: send through the platform's own mailbox over SMTP (no SendGrid).
  if (cfg.smtpHost && cfg.smtpUser && cfg.smtpPass && cfg.smtpFrom) {
    try {
      const transporter = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort || 587,
        secure: cfg.smtpSecure, // true = 465 (implicit TLS); false = 587 (STARTTLS)
        auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
      });
      await transporter.sendMail({
        from: cfg.smtpFromName ? `"${cfg.smtpFromName}" <${cfg.smtpFrom}>` : cfg.smtpFrom,
        to, subject, text, ...(html ? { html } : {}),
        attachments: attachments?.map((a) => ({
          filename: a.filename, content: Buffer.from(a.content, "base64"), contentType: a.type,
        })),
      });
      return { ok: true, detail: "" };
    } catch (e: any) {
      logger.warn("SMTP send failed", e);
      return { ok: false, detail: (e?.message || "SMTP send failed.") + " — check the SMTP host/port, username, and app password under Notifications." };
    }
  }

  if (!cfg.sendgridKey || !cfg.sendgridFrom) {
    return { ok: false, detail: "Email isn't configured — add your SMTP mailbox (or SendGrid) under Notifications." };
  }
  try {
    const body: Record<string, unknown> = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: cfg.sendgridFrom, name: cfg.sendgridFromName },
      subject,
      // SendGrid requires text/plain before text/html when both are present.
      content: html
        ? [{ type: "text/plain", value: text }, { type: "text/html", value: html }]
        : [{ type: "text/plain", value: text }],
    };
    if (attachments && attachments.length) {
      body.attachments = attachments.map((a) => ({
        content: a.content, filename: a.filename, type: a.type, disposition: "attachment",
      }));
    }
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.sendgridKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, detail: "" };
    const txt = await res.text().catch(() => "");
    logger.warn(`SendGrid ${res.status}: ${txt}`);
    let detail = `SendGrid error ${res.status}`;
    try { const j = JSON.parse(txt); if (j?.errors?.[0]?.message) detail = j.errors[0].message; } catch { /* keep generic */ }
    if (res.status === 401 || res.status === 403) {
      detail += " — check the API key, and that the From address is a verified sender in SendGrid.";
    }
    return { ok: false, detail };
  } catch (e: any) {
    logger.error("sendEmail failed", e);
    return { ok: false, detail: e?.message || "Email send failed." };
  }
}
async function sendEmail(
  cfg: NotifyConfig, to: string, subject: string, text: string, attachments?: EmailAttachment[]
): Promise<boolean> {
  return (await sendEmailDetailed(cfg, to, subject, text, attachments)).ok;
}

// `from` lets a homeowner-facing send go out as a specific rep's ported number
// instead of the platform default (cfg.telnyxFrom) — falls back to the
// platform number when the rep hasn't been ported yet, so sends never hard-fail.
async function sendSms(cfg: NotifyConfig, to: string, body: string, from?: string): Promise<boolean> {
  const sender = from || cfg.telnyxFrom;
  if (!cfg.telnyxApiKey || !sender || !to) return false;
  try {
    const payload: Record<string, unknown> = { from: sender, to, text: body };
    if (cfg.telnyxMessagingProfileId) payload.messaging_profile_id = cfg.telnyxMessagingProfileId;
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.telnyxApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) logger.warn(`Telnyx ${res.status}: ${await res.text().catch(() => "")}`);
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

// Send a native push (FCM) to every device the user has registered. Invalid /
// unregistered tokens are pruned so the list stays clean. Best-effort: never
// throws into the caller. No-op when the user has no tokens (e.g. web-only).
async function sendPush(userId: string, title: string, body: string, link: string, type: string): Promise<void> {
  try {
    const snap = await db.doc(`users/${userId}`).get();
    const tokens: string[] = Array.isArray(snap.data()?.pushTokens) ? snap.data()!.pushTokens : [];
    if (!tokens.length) return;
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title, body: body || undefined },
      data: { link: link || "", type: type || "" },
      apns: { payload: { aps: { sound: "default" } } },
      android: { priority: "high", notification: { sound: "default" } },
    });
    // Drop tokens the device/registration no longer accepts.
    const dead: string[] = [];
    res.responses.forEach((r, i) => {
      const code = (r.error as { code?: string } | undefined)?.code || "";
      if (!r.success && (code.includes("registration-token-not-registered") || code.includes("invalid-argument") || code.includes("invalid-registration-token"))) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) await snap.ref.set({ pushTokens: FieldValue.arrayRemove(...dead) }, { merge: true });
  } catch (e) {
    logger.warn("sendPush failed", e);
  }
}

// Write the in-app notification, push to the user's devices, then email + SMS
// iff they're offline.
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

  await sendPush(userId, title, body, link, type); // native push to their phone(s)

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

// registerPushToken — the native app saves its FCM device token here so the
// user's phone(s) receive push. Tokens are kept as a set on the user doc.
export const registerPushToken = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const { token, platform } = (request.data || {}) as { token?: string; platform?: string };
  if (!token || typeof token !== "string") throw new HttpsError("invalid-argument", "token required.");
  await db.doc(`users/${request.auth.uid}`).set(
    { pushTokens: FieldValue.arrayUnion(token), pushPlatform: platform || null, pushUpdatedAt: Date.now() },
    { merge: true },
  );
  return { ok: true };
});

// unregisterPushToken — drop a device token (sign-out / notifications off).
export const unregisterPushToken = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const { token } = (request.data || {}) as { token?: string };
  if (!token) throw new HttpsError("invalid-argument", "token required.");
  await db.doc(`users/${request.auth.uid}`).set(
    { pushTokens: FieldValue.arrayRemove(token) }, { merge: true },
  );
  return { ok: true };
});

// ════════════════════════════════════════════════════════════════════════════
// LEAD OUTREACH AUTOMATION — ported rep numbers via Telnyx.
// ----------------------------------------------------------------------------
// Each rep can be assigned a ported personal number (UserProfile.smsNumber);
// automated + manual texts to their leads go out as that number so it reads as
// a real conversation with that rep, not a shared company line. Two Telnyx
// webhooks (SMS + Call Control voice) route inbound traffic; a Firestore
// trigger + scheduled function drive the actual drip sequences.
//
// Compliance (TCPA): a lead must have `smsOptIn` set (captured at the door)
// before ANY automated text goes out, `smsOptOutAt`/`smsSuppressions` are
// checked before every send, and sends are held to 8am-9pm in the company's
// configured timezone as a stand-in for the recipient's local time.
// ════════════════════════════════════════════════════════════════════════════

// Telnyx signs webhooks with Ed25519: signature over `${timestamp}|${rawBody}`,
// verified against the public key shown in the Telnyx portal for your app.
function verifyTelnyxSignature(rawBody: string, signatureB64: string, timestamp: string, publicKeyB64: string): boolean {
  if (!signatureB64 || !timestamp || !publicKeyB64) return false;
  try {
    const signed = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
    const sig = Buffer.from(signatureB64, "base64");
    const key = Buffer.from(publicKeyB64, "base64");
    return nacl.sign.detached.verify(signed, sig, key);
  } catch {
    return false;
  }
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
const HELP_WORDS = new Set(["help", "info"]);

// Inbound SMS from a homeowner — handles STOP/START/HELP per TCPA, otherwise
// logs the reply so the owning rep sees it in their text inbox.
export const telnyxSmsWebhook = onRequest({ cors: false }, async (req, res) => {
  const cfg = await getNotifyConfig();
  const raw = (req as unknown as { rawBody: Buffer }).rawBody?.toString("utf8") || "";
  const sig = String(req.headers["telnyx-signature-ed25519"] || "");
  const ts = String(req.headers["telnyx-timestamp"] || "");
  if (cfg.telnyxPublicKey && !verifyTelnyxSignature(raw, sig, ts, cfg.telnyxPublicKey)) {
    res.status(400).send("bad signature");
    return;
  }
  res.status(200).json({ received: true }); // ack immediately; Telnyx retries on non-2xx

  try {
    const event = JSON.parse(raw || "{}");
    const payload = event?.data?.payload;
    if (event?.data?.event_type !== "message.received" || !payload) return;
    const from = String(payload.from?.phone_number || "");
    const to = String(payload.to?.[0]?.phone_number || "");
    const text = String(payload.text || "").trim();
    const word = text.toLowerCase();
    if (!from) return;

    if (STOP_WORDS.has(word)) {
      await db.doc(`smsSuppressions/${from}`).set({ phone: from, reason: "stop_keyword", createdAt: Date.now() });
      const leads = await db.collection("leads").where("phone", "==", from).get();
      await Promise.all(leads.docs.map((d) => d.ref.set({ smsOptOutAt: Date.now() }, { merge: true })));
      await sendSms(cfg, from, "You've been unsubscribed and won't receive further texts. Reply START to opt back in.", to || undefined);
      return;
    }
    if (START_WORDS.has(word)) {
      await db.doc(`smsSuppressions/${from}`).delete().catch(() => {});
      await sendSms(cfg, from, "You're re-subscribed to texts. Reply STOP anytime to opt out again.", to || undefined);
      return;
    }
    if (HELP_WORDS.has(word)) {
      await sendSms(cfg, from, "This number is used by your solar rep to follow up about your appointment. Reply STOP to opt out.", to || undefined);
      return;
    }

    // A normal reply — file it against the owning rep's text inbox.
    const repSnap = to ? await db.collection("users").where("smsNumber", "==", to).limit(1).get() : null;
    if (repSnap && !repSnap.empty) {
      const rep = repSnap.docs[0];
      const leadSnap = await db.collection("leads")
        .where("companyId", "==", (rep.data() as any).companyId)
        .where("phone", "==", from).limit(1).get();
      await db.collection("smsMessages").add({
        companyId: (rep.data() as any).companyId,
        repUid: rep.id,
        leadId: leadSnap.empty ? null : leadSnap.docs[0].id,
        phone: from,
        direction: "in",
        body: text,
        at: Date.now(),
      });
    }
  } catch (e) {
    logger.error("telnyxSmsWebhook handler error", e);
  }
});

// Inbound calls to a ported number — forward to the rep's real personal line.
export const telnyxVoiceWebhook = onRequest({ cors: false }, async (req, res) => {
  res.status(200).send(""); // ack immediately; Call Control commands are async
  try {
    const cfg = await getNotifyConfig();
    const event = req.body?.data;
    const payload = event?.payload;
    if (event?.event_type !== "call.initiated" || payload?.direction !== "incoming" || !payload?.call_control_id) return;
    const to = String(payload.to || "");
    const callControlId = String(payload.call_control_id);
    const repSnap = await db.collection("users").where("smsNumber", "==", to).limit(1).get();
    const forwardTo = repSnap.empty ? "" : String((repSnap.docs[0].data() as any).smsForwardTo || "");
    const action = forwardTo ? "transfer" : "hangup";
    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.telnyxApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(forwardTo ? { to: forwardTo } : {}),
    });
  } catch (e) {
    logger.error("telnyxVoiceWebhook handler error", e);
  }
});

// A rep manually texting one of their own leads from their ported number.
export const sendLeadSms = onCall(async (request) => {
  const caller = await getCaller(request);
  const { leadId, body } = (request.data || {}) as { leadId?: string; body?: string };
  const text = String(body || "").trim();
  if (!leadId || !text) throw new HttpsError("invalid-argument", "leadId and body are required.");
  const leadSnap = await db.doc(`leads/${leadId}`).get();
  if (!leadSnap.exists) throw new HttpsError("not-found", "Lead not found.");
  const lead = leadSnap.data() as any;
  if (lead.companyId !== caller.companyId && !caller.isSuper) throw new HttpsError("permission-denied", "Not your lead.");
  const phone = String(lead.phone || "");
  if (!phone) throw new HttpsError("failed-precondition", "This lead has no phone number.");
  if (await isSuppressed(phone)) throw new HttpsError("failed-precondition", "This homeowner has opted out of texts.");

  const me = (await db.doc(`users/${caller.uid}`).get()).data() as any;
  const cfg = await getNotifyConfig();
  const ok = await sendSms(cfg, phone, text, me?.smsNumber || undefined);
  if (!ok) throw new HttpsError("internal", "Text failed to send — check your texting number is set up.");
  await db.collection("smsMessages").add({
    companyId: lead.companyId, repUid: caller.uid, leadId, phone, direction: "out", body: text, at: Date.now(),
  });
  return { ok: true };
});

// ── Outreach rules: enqueue a message when a lead's status flips to a rule's
// trigger status, then a scheduled job sends whatever's due. ─────────────────
function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

export const onLeadStatusChange = onDocumentWritten("leads/{leadId}", async (event) => {
  const before = event.data?.before?.data() as any;
  const after = event.data?.after?.data() as any;
  if (!after || !after.status || before?.status === after.status) return; // create-with-no-prior-status still fires once, that's fine
  if (after.status === "dnc") return;

  const rulesSnap = await db.collection("companies").doc(after.companyId).collection("outreachRules")
    .where("trigger", "==", after.status).where("active", "==", true).get();
  if (rulesSnap.empty) return;

  const leadId = event.params.leadId;
  const now = Date.now();
  await Promise.all(rulesSnap.docs.map((r) => {
    const rule = r.data();
    return db.collection("outreachQueue").add({
      companyId: after.companyId,
      leadId,
      ruleId: r.id,
      repUid: after.assignedTo || null,
      channel: rule.channel,
      sendAt: now + Math.max(0, Number(rule.delayMinutes) || 0) * 60000,
      status: "pending",
      createdAt: now,
    });
  }));
});

// Sends between 8am-9pm in the company's configured timezone (a stand-in for
// the recipient's actual local time — good enough for a regional business,
// avoids waking someone up with an automated text).
function withinQuietHours(timezone: string): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone || "America/Denver" }).format(new Date()));
    return hour >= 8 && hour < 21;
  } catch {
    return true;
  }
}

export const processOutreachQueue = onSchedule("every 15 minutes", async () => {
  const now = Date.now();
  const due = await db.collection("outreachQueue").where("status", "==", "pending").where("sendAt", "<=", now).limit(200).get();
  if (due.empty) return;
  const cfg = await getNotifyConfig();

  for (const doc of due.docs) {
    const q = doc.data();
    try {
      const [leadSnap, companySnap, ruleSnap] = await Promise.all([
        db.doc(`leads/${q.leadId}`).get(),
        db.doc(`companies/${q.companyId}`).get(),
        db.doc(`companies/${q.companyId}/outreachRules/${q.ruleId}`).get(),
      ]);
      const lead = leadSnap.data() as any;
      const rule = ruleSnap.data() as any;
      const company = companySnap.data() as any;
      if (!lead || !rule || !rule.active) { await doc.ref.set({ status: "skipped", skippedReason: "rule or lead gone" }, { merge: true }); continue; }
      if (lead.status === "dnc" || lead.status !== rule.trigger) { await doc.ref.set({ status: "skipped", skippedReason: "lead status changed" }, { merge: true }); continue; }

      const rep = q.repUid ? (await db.doc(`users/${q.repUid}`).get()).data() as any : null;
      const vars = {
        firstName: String(lead.ownerName || "").split(" ")[0] || "there",
        repName: rep?.displayName || "your rep",
        repPhone: rep?.smsNumber || rep?.phone || "",
        companyName: company?.name || "",
      };
      const text = fillTemplate(rule.template || "", vars);

      if (rule.channel === "sms") {
        if (!lead.phone || !lead.smsOptIn || lead.smsOptOutAt || await isSuppressed(lead.phone)) {
          await doc.ref.set({ status: "skipped", skippedReason: "no consent or opted out" }, { merge: true });
          continue;
        }
        if (!withinQuietHours(company?.scheduling?.timezone)) {
          await doc.ref.set({ sendAt: now + 30 * 60000 }, { merge: true }); // try again in 30 min
          continue;
        }
        const ok = await sendSms(cfg, lead.phone, text, rep?.smsNumber || undefined);
        await doc.ref.set({ status: ok ? "sent" : "failed", sentAt: ok ? Date.now() : null }, { merge: true });
        if (ok) await db.collection("smsMessages").add({
          companyId: q.companyId, repUid: q.repUid || null, leadId: q.leadId, phone: lead.phone, direction: "out", body: text, at: Date.now(),
        });
      } else {
        if (!lead.email) { await doc.ref.set({ status: "skipped", skippedReason: "no email" }, { merge: true }); continue; }
        const ok = await sendEmail(cfg, lead.email, `${company?.name || "Your rep"} — following up`, text);
        await doc.ref.set({ status: ok ? "sent" : "failed", sentAt: ok ? Date.now() : null }, { merge: true });
      }
    } catch (e) {
      logger.error(`processOutreachQueue failed for ${doc.id}`, e);
      await doc.ref.set({ status: "failed", skippedReason: "internal error" }, { merge: true }).catch(() => {});
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// requestDemo — public (unauthenticated) demo request from the marketing site.
// ----------------------------------------------------------------------------
// Anyone on the landing page can submit the "Request a Demo" form. We:
//   • Store the request in `demoRequests` so it shows up in the super-admin
//     portal (admin.html → Demo Requests tab).
//   • Email EVERY super-admin (users with superAdmin:true) so they hear about
//     it immediately, regardless of whether they're online.
// Exposed at /demo-request via a Hosting rewrite (same-origin, no CORS needed),
// but cors:true is set so it also works if called cross-origin.
// ════════════════════════════════════════════════════════════════════════════
const DEMO_FIELDS = ["fname", "lname", "company", "title", "email", "phone", "teamsize", "industry", "message"] as const;

export const requestDemo = onRequest({ cors: true }, async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  // Accept either parsed JSON or a raw/form body.
  const raw = (typeof req.body === "string" ? safeJson(req.body) : req.body) || {};
  const data: Record<string, string> = {};
  for (const k of DEMO_FIELDS) {
    const v = raw[k];
    data[k] = typeof v === "string" ? v.trim().slice(0, 2000) : "";
  }

  // Minimal validation — mirror the required fields on the form.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email);
  if (!data.fname || !data.lname || !data.company || !emailOk || !data.teamsize) {
    res.status(400).json({ error: "Missing or invalid required fields." });
    return;
  }

  const fullName = `${data.fname} ${data.lname}`.trim();
  const record = {
    ...data,
    name: fullName,
    status: "new",
    createdAt: Date.now(),
    source: "landing-page",
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
  };

  try {
    const ref = await db.collection("demoRequests").add(record);

    // Email every super-admin. Don't fail the request if email isn't configured —
    // the record is already saved and visible in the portal.
    try {
      const supers = await db.collection("users").where("superAdmin", "==", true).get();
      const recipients = supers.docs
        .map((d) => String(d.data()?.email || "").trim())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (recipients.length) {
        const cfg = await getNotifyConfig();
        const subject = `New demo request — ${data.company}`;
        const body = [
          `A new demo request just came in from the YoutilityKnock landing page.`,
          ``,
          `Name:       ${fullName}`,
          `Company:    ${data.company}`,
          data.title ? `Role:       ${data.title}` : "",
          `Email:      ${data.email}`,
          data.phone ? `Phone:      ${data.phone}` : "",
          `Team size:  ${data.teamsize}`,
          data.industry ? `Industry:   ${data.industry}` : "",
          data.message ? `\nChallenge:\n${data.message}` : "",
          ``,
          `Open the Super Admin portal → Demo Requests to follow up.`,
        ].filter((l) => l !== "").join("\n");
        await Promise.all(recipients.map((to) => sendEmail(cfg, to, subject, body)));
      } else {
        logger.warn("requestDemo: no super-admin recipients found to email");
      }
    } catch (e) {
      logger.error("requestDemo: notifying super-admins failed (request was saved)", e);
    }

    res.status(200).json({ ok: true, id: ref.id });
  } catch (err) {
    logger.error("requestDemo failed", err);
    res.status(500).json({ error: "Could not submit request. Please try again." });
  }
});

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
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
        const when = fmtApptTime(Number(ev.startAt), ev.address as string | undefined, undefined, { hour: "numeric", minute: "2-digit" });
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

// ── super-admin: notification provider config (SendGrid / Telnyx) ────────────
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
  const c = (snap.exists ? (snap.data() as Record<string, any>) : {}) || {};
  return {
    smtp: {
      configured: !!c.smtpHost && !!c.smtpUser && !!c.smtpPass && !!c.smtpFrom,
      host: c.smtpHost || "",
      port: Number(c.smtpPort) || 587,
      secure: c.smtpSecure === true,
      user: c.smtpUser || "",
      passMask: mask(c.smtpPass),
      from: c.smtpFrom || "",
      fromName: c.smtpFromName || "",
    },
    sendgrid: {
      configured: !!c.sendgridKey,
      keyMask: mask(c.sendgridKey),
      from: c.sendgridFrom || "",
      fromName: c.sendgridFromName || "",
    },
    telnyx: {
      configured: !!c.telnyxApiKey,
      keyMask: mask(c.telnyxApiKey),
      from: c.telnyxFrom || "",
      messagingProfileId: c.telnyxMessagingProfileId || "",
      publicKeyMask: mask(c.telnyxPublicKey),
    },
  };
});

export const setNotificationConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, any>;
  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  // SMTP (own-mailbox email). The password is a secret (blank = keep existing);
  // don't trim it — passwords/app-passwords can contain spaces.
  if (typeof d.smtpHost === "string") update.smtpHost = d.smtpHost.trim();
  if (d.smtpPort !== undefined && d.smtpPort !== "") update.smtpPort = Number(d.smtpPort) || 587;
  if (typeof d.smtpSecure === "boolean") update.smtpSecure = d.smtpSecure;
  if (typeof d.smtpUser === "string") update.smtpUser = d.smtpUser.trim();
  if (typeof d.smtpPass === "string" && d.smtpPass) update.smtpPass = d.smtpPass;
  if (typeof d.smtpFrom === "string") update.smtpFrom = d.smtpFrom.trim();
  if (typeof d.smtpFromName === "string") update.smtpFromName = d.smtpFromName.trim();
  // Secrets: only overwrite when a non-empty value is supplied (blank = keep
  // existing). Non-secret fields are always set from the payload.
  if (typeof d.sendgridKey === "string" && d.sendgridKey.trim()) update.sendgridKey = d.sendgridKey.trim();
  if (typeof d.sendgridFrom === "string") update.sendgridFrom = d.sendgridFrom.trim();
  if (typeof d.sendgridFromName === "string") update.sendgridFromName = d.sendgridFromName.trim();
  if (typeof d.telnyxApiKey === "string" && d.telnyxApiKey.trim()) update.telnyxApiKey = d.telnyxApiKey.trim();
  if (typeof d.telnyxFrom === "string") update.telnyxFrom = d.telnyxFrom.trim();
  if (typeof d.telnyxMessagingProfileId === "string") update.telnyxMessagingProfileId = d.telnyxMessagingProfileId.trim();
  if (typeof d.telnyxPublicKey === "string" && d.telnyxPublicKey.trim()) update.telnyxPublicKey = d.telnyxPublicKey.trim();
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
  if (provider === "smtp") {
    await ref.set({ smtpHost: "", smtpPort: "", smtpSecure: false, smtpUser: "", smtpPass: "", smtpFrom: "", smtpFromName: "" }, { merge: true });
  } else if (provider === "sendgrid") {
    await ref.set({ sendgridKey: "", sendgridFrom: "", sendgridFromName: "" }, { merge: true });
  } else if (provider === "telnyx") {
    await ref.set({ telnyxApiKey: "", telnyxFrom: "", telnyxMessagingProfileId: "", telnyxPublicKey: "" }, { merge: true });
  } else {
    throw new HttpsError("invalid-argument", "provider must be 'smtp', 'sendgrid' or 'telnyx'.");
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
  closersEnabled: false,
  closerAssignment: "round_robin" as const,
  // When true, setters never pick the closer: the booking flow shows only open
  // times (across every closer's calendar) and the closer is auto-assigned by
  // the closerAssignment method. Used by the Scheduler / dispatch flow.
  hideCloserFromSetters: false,
};

// ── address → IANA timezone ──────────────────────────────────────────────
// Appointment times in emails/notifications must show in the LOCAL time of the
// appointment's ADDRESS — a rep in one zone routinely books a customer in
// another, and the Cloud Functions runtime is UTC. We only store the address
// string (e.g. "…, Summerville, SC 29483, USA"), so we derive the zone from the
// US state, refining the handful of timezone-split states by ZIP prefix. Falls
// back to the company/default tz when the address can't be parsed.
const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};
// ZIP-3 ranges (inclusive) inside a state that fall in a DIFFERENT zone than the
// state's base entry above — the timezone-split states.
const SPLIT_STATE_TZ: Record<string, Array<[number, number, string]>> = {
  FL: [[324, 325, "America/Chicago"]],                                          // western panhandle → Central
  MI: [[498, 499, "America/Menominee"]],                                        // western UP → Central
  IN: [[463, 464, "America/Chicago"], [476, 477, "America/Chicago"]],           // NW + SW corners → Central
  KY: [[420, 427, "America/Chicago"]],                                          // western KY → Central
  TN: [[373, 374, "America/New_York"], [377, 379, "America/New_York"]],         // east TN → Eastern
  TX: [[798, 799, "America/Denver"], [885, 885, "America/Denver"]],             // El Paso corner → Mountain
  KS: [[677, 677, "America/Denver"], [679, 679, "America/Denver"]],             // far-west KS → Mountain
  NE: [[693, 693, "America/Denver"]],                                           // panhandle → Mountain
  ND: [[586, 586, "America/Denver"]],                                           // SW ND → Mountain
  SD: [[577, 577, "America/Denver"]],                                           // Black Hills → Mountain
  OR: [[979, 979, "America/Denver"]],                                           // Malheur County → Mountain
  ID: [[835, 835, "America/Los_Angeles"], [838, 838, "America/Los_Angeles"]],   // north ID → Pacific
};

function tzForAddress(address?: string | null, fallbackTz?: string): string {
  const fb = fallbackTz || DEFAULT_SCHEDULING.timezone;
  if (!address) return fb;
  const up = String(address).toUpperCase();
  // "ST 12345" / "ST 12345-6789" — the canonical US state+ZIP tail.
  const m = up.match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
  let state = m?.[1] || "";
  const zip3 = m ? parseInt(m[2].slice(0, 3), 10) : NaN;
  if (!(state in STATE_TZ)) {
    // No clean state+ZIP tail — fall back to the last bare 2-letter state token.
    const toks = up.split(/[^A-Z]+/).filter((t) => t.length === 2 && t in STATE_TZ);
    state = toks.length ? toks[toks.length - 1] : "";
  }
  if (!(state in STATE_TZ)) return fb;
  if (Number.isFinite(zip3)) {
    for (const [lo, hi, tz] of SPLIT_STATE_TZ[state] || []) {
      if (zip3 >= lo && zip3 <= hi) return tz;
    }
  }
  return STATE_TZ[state];
}

// Appointment time rendered in the address's local zone, with the zone label so
// the reader never has to guess whose clock it is ("Fri, Aug 1, 9:00 PM EDT").
// `opts` overrides the default date+time format (e.g. time-only for a reminder).
function fmtApptTime(
  ms: number, address?: string | null, fallbackTz?: string, opts?: Intl.DateTimeFormatOptions,
): string {
  const tz = tzForAddress(address, fallbackTz);
  return new Date(ms).toLocaleString("en-US", {
    timeZone: tz,
    ...(opts || { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    timeZoneName: "short",
  });
}

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
    closersEnabled: !!scheduling.closersEnabled,
    closerAssignment: ["round_robin", "close_rate", "setter_select"].includes(String(scheduling.closerAssignment))
      ? String(scheduling.closerAssignment)
      : "round_robin",
    hideCloserFromSetters: !!scheduling.hideCloserFromSetters,
  };
  await db.doc(`companies/${companyId}`).set({ scheduling: s }, { merge: true });
  return { ok: true, scheduling: s };
});

// Per-territory rollup: homes (total addressable homes inside the polygon, via
// ATTOM), completion (% worked) and success (% sold). Computed server-side so it
// isn't blocked by the per-lead read rules a blanket company query would trip
// for non-admins.
// ── Territory completion model ───────────────────────────────────────────────
// A home only counts toward completion by how thoroughly it was worked:
//   • appointment / sold / dnc → fully complete (1.0)
//   • not interested → half a door (0.5)
//   • not home → needs 3 knocks to be complete (knockCount/3, capped at 1.0)
//   • go back / pipeline / new → not complete until it becomes an appointment (0)
// Then the credit is scaled by whether the rep is PITCH-CERTIFIED: an
// uncertified rep's doors only count as a partial knock until they pass the AI
// pitch certification — so training is what unlocks full-credit canvassing.
const NOT_HOME_KNOCKS_FOR_COMPLETE = 3;
const UNCERTIFIED_DOOR_FACTOR = 0.5; // knocks by a not-yet-certified rep count half
const TERRITORY_COMPLETE_PCT = 80; // an area is "complete" at ≥80% credited
function leadDoorCredit(status: string, knockCount: number): number {
  switch (status) {
    case "appointment": case "sold": case "dnc": return 1;
    case "not_interested": return 0.5;
    case "not_home": case "not_home_2":
      return Math.min(Math.max(knockCount, 1), NOT_HOME_KNOCKS_FOR_COMPLETE) / NOT_HOME_KNOCKS_FOR_COMPLETE;
    default: return 0; // go_back, pipeline, new — incomplete until worked further
  }
}

type LatLng = { lat: number; lng: number };

// Coordinates can arrive as numbers OR numeric strings (Firestore round-trips,
// imported territories), so normalize every polygon to real numbers once —
// matching the Map's defensive Number() coercion — and drop any bad vertex.
// This guards arithmetic (string + number = concatenation) and `.toFixed`.
function normalizePoly(raw: unknown): LatLng[] {
  if (!Array.isArray(raw)) return [];
  const out: LatLng[] = [];
  for (const p of raw as Array<{ lat?: unknown; lng?: unknown }>) {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (isFinite(lat) && isFinite(lng)) out.push({ lat, lng });
  }
  return out;
}

// Centroid + a covering radius (miles) that encloses every polygon vertex, so a
// single ATTOM radius query around the centroid sweeps the whole territory.
function polyCentroidRadiusMi(poly: LatLng[]): { lat: number; lng: number; radiusMi: number } {
  const lat = poly.reduce((s, p) => s + p.lat, 0) / poly.length;
  const lng = poly.reduce((s, p) => s + p.lng, 0) / poly.length;
  const milesPerDegLat = 69.0;
  const milesPerDegLng = 69.0 * Math.cos((lat * Math.PI) / 180);
  let maxMi = 0;
  for (const p of poly) {
    const dy = (p.lat - lat) * milesPerDegLat;
    const dx = (p.lng - lng) * milesPerDegLng;
    maxMi = Math.max(maxMi, Math.hypot(dx, dy));
  }
  // Small buffer for rooftop-vs-parcel jitter; ATTOM caps radius, so clamp.
  return { lat, lng, radiusMi: Math.min(Math.max(maxMi + 0.05, 0.1), 5) };
}

// Total homes whose rooftop falls inside the polygon. Queries ATTOM's property
// snapshot around the covering circle, then filters to the exact polygon. Bounded
// by a shared page budget so one call can't run away on dense urban territories.
async function countHomesInPolygon(poly: LatLng[], budget: { pages: number }): Promise<number | null> {
  if (!ATTOM.key) return null;
  const { lat, lng, radiusMi } = polyCentroidRadiusMi(poly);
  const PAGE_SIZE = 200;
  const PER_TERR_MAX_PAGES = 12;
  let count = 0;
  let total = Infinity;
  for (let page = 1; page <= PER_TERR_MAX_PAGES && (page - 1) * PAGE_SIZE < total; page++) {
    if (budget.pages <= 0) return null; // out of budget → treat as unknown, retry next call
    budget.pages--;
    let json: any;
    try {
      const r = await attomGet("/property/snapshot", { latitude: lat, longitude: lng, radius: radiusMi, pagesize: PAGE_SIZE, page });
      if (!r.ok) return page === 1 ? null : count; // first-page failure = unknown
      json = r.json;
    } catch { return page === 1 ? null : count; }
    const list: any[] = Array.isArray(json?.property) ? json.property : [];
    total = Number(json?.status?.total ?? list.length);
    for (const p of list) {
      const loc = p.location || {};
      const a = p.address || {};
      const plat = Number(loc.latitude ?? a.latitude);
      const plng = Number(loc.longitude ?? a.longitude);
      if (!isFinite(plat) || !isFinite(plng)) continue;
      if (pinInPolygon({ lat: plat, lng: plng }, poly)) count++;
    }
    if (list.length < PAGE_SIZE) break;
  }
  return count;
}

// Cheap stable hash of a polygon so we only re-bill ATTOM when the shape changes.
function polyHash(poly: LatLng[]): string {
  return poly.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
}

export const getTerritoryStats = onCall({ timeoutSeconds: 180 }, async (request) => {
  const caller = await getCaller(request);
  const cid = (request.data || {}).companyId || caller.companyId;
  if (!cid) throw new HttpsError("invalid-argument", "companyId required.");
  if (!caller.isSuper && cid !== caller.companyId) throw new HttpsError("permission-denied", "Wrong company.");
  await refreshApiConfig(); // pick up super-admin ATTOM key override
  // Leads are never stamped with a territoryId, so bucket each lead into a
  // territory geometrically: test its lat/lng against every territory polygon.
  const [leadSnap, terrSnap, userSnap] = await Promise.all([
    db.collection("leads").where("companyId", "==", cid).get(),
    db.collection("territories").where("companyId", "==", cid).get(),
    db.collection("users").where("companyId", "==", cid).get(),
  ]);
  // Which reps have passed AI pitch certification → their doors count full credit.
  const certified: Record<string, boolean> = {};
  userSnap.forEach((d) => { certified[d.id] = (d.data() as any).pitchCertified === true; });
  const terrs = terrSnap.docs
    .map((d) => ({ id: d.id, ref: d.ref, data: d.data() as any, polygon: normalizePoly((d.data() as any).polygon) }))
    .filter((t) => t.polygon.length >= 3);
  // Bucket dispositioned leads by polygon and accumulate weighted door credit.
  // Coerce lead coords with Number() (they may be strings) so none are skipped.
  const agg: Record<string, { credit: number; sold: number; doors: number }> = {};
  leadSnap.forEach((d) => {
    const l = d.data() as any;
    const lat = Number(l.lat);
    const lng = Number(l.lng);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const t = terrs.find((tt) => pinInPolygon({ lat, lng }, tt.polygon));
    if (!t) return;
    const a = (agg[t.id] ??= { credit: 0, sold: 0, doors: 0 });
    a.doors++;
    let credit = leadDoorCredit(l.status, Number(l.knockCount) || 1);
    // Until the rep is certified, their knocks only count as a partial door.
    if (credit > 0 && l.assignedTo && certified[l.assignedTo] !== true) credit *= UNCERTIFIED_DOOR_FACTOR;
    a.credit += credit;
    if (l.status === "sold") a.sold++;
  });
  // homes = total addressable homes in the polygon (ATTOM), cached on the
  // territory doc and only recomputed when the polygon shape changes. Each
  // territory is isolated so an ATTOM hiccup can never zero out the whole map.
  const budget = { pages: 40 }; // shared ATTOM page budget for this whole call
  const stats: Record<string, { homes: number; completion: number; success: number; complete: boolean; doors: number }> = {};
  for (const t of terrs) {
    const a = agg[t.id] || { credit: 0, sold: 0, doors: 0 };
    let homes: number | null = null;
    try {
      const hash = polyHash(t.polygon);
      if (typeof t.data.homesTotal === "number" && t.data.homesPolyHash === hash) {
        homes = t.data.homesTotal; // fresh cache for this exact shape
      } else {
        homes = await countHomesInPolygon(t.polygon, budget);
        if (homes != null) {
          try { await t.ref.set({ homesTotal: homes, homesPolyHash: hash, homesTotalAt: Date.now() }, { merge: true }); } catch { /* non-fatal */ }
        }
      }
    } catch (e) {
      logger.warn("territory homes count failed", { territory: t.id, err: String(e) });
    }
    // Completion = weighted door credit ÷ total homes. Fall back to the count of
    // dispositioned doors when ATTOM is unavailable/over budget.
    const denom = homes != null && homes > 0 ? homes : a.doors;
    const completion = denom ? Math.min(100, Math.round((a.credit / denom) * 100)) : 0;
    stats[t.id] = {
      homes: homes != null ? homes : a.doors,
      completion,
      success: denom ? Math.round((a.sold / denom) * 100) : 0,
      complete: completion >= TERRITORY_COMPLETE_PCT,
      doors: a.doors,
    };
  }
  return { stats };
});

// Company-level options (currently: how many territories one rep may hold).
export const setCompanyOptions = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, maxTerritoriesPerUser } = (request.data || {}) as { companyId?: string; maxTerritoriesPerUser?: number };
  authorizeForCompany(caller, companyId);
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (maxTerritoriesPerUser !== undefined) {
    patch.maxTerritoriesPerUser = Math.max(0, Math.floor(Number(maxTerritoriesPerUser) || 0));
  }
  await db.doc(`companies/${companyId}`).set(patch, { merge: true });
  return { ok: true };
});

// ── self-service: a user sets their own phone (calendar handled via OAuth) ───
export const setMyProfile = onCall(async (request) => {
  const caller = await getCaller(request);
  const { phone, displayName, email } = (request.data || {}) as { phone?: string; displayName?: string; email?: string };
  const update: Record<string, unknown> = {};
  if (typeof phone === "string") {
    const trimmed = phone.trim();
    // Light E.164-ish normalization for the SMS fallback.
    update.phone = trimmed ? (trimmed.startsWith("+") ? trimmed : trimmed.replace(/[^\d]/g, "").replace(/^/, "+1").slice(0, 12)) : "";
  }
  if (typeof displayName === "string" && displayName.trim()) update.displayName = displayName.trim();
  if (typeof email === "string" && email.trim()) update.email = email.trim(); // keep users doc in sync with auth email
  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  await db.doc(`users/${caller.uid}`).set(update, { merge: true });
  if (typeof update.displayName === "string") {
    try { await getAuth().updateUser(caller.uid, { displayName: update.displayName as string }); } catch { /* non-fatal */ }
  }
  return { ok: true, ...update };
});

// ── Digital business card ─────────────────────────────────────────────────────
// A rep's public, shareable profile page for lead capture (photo, bio, service
// area, reviews, click-to-contact) — reachable at /app?card=<slug> with no
// login, in the same "public onCall, no firestore.rules changes" style as
// getSharedProposal/AgreementSignView above: the Admin SDK does the read/write,
// so `users`/`leads` stay fully locked down to signed-in members.
const CARD_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const CARD_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CARD_THEME_KEYS = new Set(["default", "midnight", "forest", "sunset", "royal", "slate"]);

function normalizeCardSlug(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

// Reps don't pick their own card link — it's assigned from their name so it's
// predictable and there are never collisions across the (globally shared) URL
// space. Start with first-initial + last name ("mlindsay"), fall back to the
// full first name ("mikelindsay") if that's taken, then a numeric suffix so a
// unique link is always produced. `selfUid` is treated as free (re-runs are
// idempotent).
async function generateUniqueCardSlug(displayName: string, selfUid: string): Promise<string> {
  const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";

  const candidates: string[] = [];
  if (first && last) {
    candidates.push(normalizeCardSlug(first.slice(0, 1) + last)); // mlindsay
    candidates.push(normalizeCardSlug(first + last));             // mikelindsay
  } else if (first) {
    candidates.push(normalizeCardSlug(first));
  }

  const isFree = async (slug: string): Promise<boolean> => {
    if (!CARD_SLUG_RE.test(slug)) return false;
    const snap = await db.collection("users").where("cardSlug", "==", slug).limit(1).get();
    return snap.empty || snap.docs[0].id === selfUid;
  };

  for (const c of candidates) {
    if (await isFree(c)) return c;
  }

  // Everything above was taken (or the name was unusable) — append a number to
  // the fullest name-based stem we have so the result is still unique.
  const stem = (normalizeCardSlug(candidates[candidates.length - 1] || "") || "member").slice(0, 28);
  for (let n = 2; n < 1000; n++) {
    const c = `${stem}-${n}`;
    if (await isFree(c)) return c;
  }
  // Astronomically unlikely fallback.
  return normalizeCardSlug(`${stem}-${100000 + crypto.randomInt(900000)}`);
}

// A website saved without "http(s)://" (e.g. "youtility.us") renders as a
// broken relative link (`https://youtilityknock.web.app/youtility.us`)
// instead of opening the real site — assume https when no scheme is given.
function withUrlProtocol(input: string): string {
  const url = String(input || "").trim();
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function sanitizeCardReviews(input: unknown): { name: string; text: string; rating: number }[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 20)
    .map((r) => ({
      name: String((r as any)?.name || "").trim().slice(0, 80),
      text: String((r as any)?.text || "").trim().slice(0, 500),
      rating: Math.min(5, Math.max(1, Math.round(Number((r as any)?.rating) || 5))),
    }))
    .filter((r) => r.text);
}

// A rep edits their own card. Reps may only change their photo, title and bio —
// the link, colors, logo override, service area and reviews are admin-managed
// (company branding / defaults), so those inputs are ignored unless the caller
// is an admin editing their own card. The card link is assigned automatically
// from the rep's name (see generateUniqueCardSlug); slugs are unique across the
// whole platform (every company shares one hosting domain, so the URL space is
// global).
export const setMyCard = onCall(async (request) => {
  const caller = await getCaller(request);
  const isAdmin = caller.isSuper || caller.role === "admin";
  const d = (request.data || {}) as {
    slug?: string; enabled?: boolean; title?: string; bio?: string; serviceArea?: string;
    photoUrl?: string; logoUrl?: string; reviews?: unknown; accentColor?: string; theme?: string;
  };
  const update: Record<string, unknown> = {};

  const me = await db.doc(`users/${caller.uid}`).get();
  const meData = (me.data() || {}) as any;

  // Fields every rep controls.
  if (typeof d.title === "string") update.cardTitle = d.title.trim().slice(0, 80);
  if (typeof d.bio === "string") update.cardBio = d.bio.trim().slice(0, 1000);
  if (typeof d.photoUrl === "string") update.cardPhotoUrl = d.photoUrl.trim().slice(0, 1000);

  if (isAdmin) {
    // Admin-only fields (an admin still has full control of their own card).
    if (typeof d.slug === "string") {
      const slug = normalizeCardSlug(d.slug);
      if (!CARD_SLUG_RE.test(slug)) {
        throw new HttpsError("invalid-argument", "Link must be 3-32 lowercase letters, numbers, or hyphens.");
      }
      const existing = await db.collection("users").where("cardSlug", "==", slug).limit(1).get();
      if (!existing.empty && existing.docs[0].id !== caller.uid) {
        throw new HttpsError("already-exists", "That link is already taken — try another.");
      }
      update.cardSlug = slug;
    }
    if (typeof d.enabled === "boolean") update.cardEnabled = d.enabled;
    if (typeof d.serviceArea === "string") update.cardServiceArea = d.serviceArea.trim().slice(0, 200);
    if (typeof d.logoUrl === "string") update.cardLogoUrl = d.logoUrl.trim().slice(0, 1000);
    if (d.reviews !== undefined) update.cardReviews = sanitizeCardReviews(d.reviews);
    if (typeof d.accentColor === "string") {
      const c = d.accentColor.trim();
      if (c && !CARD_HEX_COLOR_RE.test(c)) throw new HttpsError("invalid-argument", "Accent color must be a hex value like #2563eb.");
      update.cardAccentColor = c;
    }
    if (typeof d.theme === "string") {
      const t = d.theme.trim();
      if (t && !CARD_THEME_KEYS.has(t)) throw new HttpsError("invalid-argument", "Unknown card theme.");
      update.cardTheme = t;
    }
  } else {
    // Reps never pick their own link — auto-assign one from their name on first
    // save, and take the card live automatically (they have no live toggle).
    if (!meData.cardSlug) {
      update.cardSlug = await generateUniqueCardSlug(meData.displayName || "", caller.uid);
    }
    if (!meData.cardEnabled) update.cardEnabled = true;
  }

  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");

  if (update.cardEnabled === true && !update.cardSlug && !meData.cardSlug) {
    throw new HttpsError("failed-precondition", "Choose a card link before turning your card on.");
  }
  // A stable, randomly-assigned display number ("No. 348219") — cosmetic only,
  // assigned once on a rep's first save so their card doesn't read like id #1.
  if (!meData.cardMemberId) update.cardMemberId = 100000 + crypto.randomInt(900000);

  await db.doc(`users/${caller.uid}`).set(update, { merge: true });
  return { ok: true, ...update };
});

// Public (no auth): fetch a rep's digital business card by its slug.
export const getRepCard = onCall(async (request) => {
  const slug = normalizeCardSlug(String((request.data as any)?.slug || ""));
  if (!slug) throw new HttpsError("invalid-argument", "Missing card link.");
  const q = await db.collection("users").where("cardSlug", "==", slug).limit(1).get();
  if (q.empty) throw new HttpsError("not-found", "This card isn't available.");
  const r = q.docs[0].data() as any;
  if (!r.cardEnabled || r.disabled) throw new HttpsError("not-found", "This card isn't available.");
  const company = await db.doc(`companies/${r.companyId}`).get();
  const c = company.data() as any;
  if (!c || c.status === "suspended") throw new HttpsError("not-found", "This card isn't available.");
  return {
    slug,
    displayName: r.displayName || "",
    title: r.cardTitle || r.title || "",
    photoUrl: r.cardPhotoUrl || "",
    logoUrl: r.cardLogoUrl || c.logoUrl || "",
    bgImageUrl: c.bgImageUrl || "",
    bio: r.cardBio || "",
    serviceArea: r.cardServiceArea || "",
    reviews: Array.isArray(r.cardReviews) ? r.cardReviews : [],
    phone: r.phone || "",
    email: r.email || "",
    companyName: c.name || "",
    companyWebsite: withUrlProtocol(c.website),
    companyPhone: c.phone || "",
    companyAddress: c.address || "",
    companyIdPrefix: c.idPrefix || "",
    accentColor: r.cardAccentColor || "",
    theme: r.cardTheme || "default",
    memberId: typeof r.cardMemberId === "number" ? r.cardMemberId : null,
  };
});

// Public (no auth): server-rendered share link for a rep's card. The SPA at
// /app?card=<slug> can't carry per-rep Open Graph tags (it's one static
// index.html), so link unfurlers (iMessage, SMS, Slack, etc.) only ever saw
// the generic site preview. This route returns a tiny HTML shell with the
// rep's real name/title/photo as og:title/og:description/og:image, then
// immediately sends real visitors on to the interactive card.
export const cardShare = onRequest({ cors: true }, async (req, res) => {
  // Path may arrive with or without the "/c" rewrite prefix.
  const parts = req.path.split("/").filter(Boolean).filter((p) => p !== "c");
  const slug = normalizeCardSlug(parts[0] || "");
  const appUrl = `${APP_URL}/app${slug ? `?card=${encodeURIComponent(slug)}` : ""}`;

  let displayName = "", cardTitle = "", bio = "", photoUrl = "", companyName = "", logoUrl = "";
  let found = false;
  if (slug) {
    try {
      const q = await db.collection("users").where("cardSlug", "==", slug).limit(1).get();
      if (!q.empty) {
        const r = q.docs[0].data() as any;
        if (r.cardEnabled && !r.disabled) {
          found = true;
          displayName = r.displayName || "";
          cardTitle = r.cardTitle || r.title || "";
          bio = r.cardBio || "";
          photoUrl = r.cardPhotoUrl || "";
          if (r.companyId) {
            const c = (await db.doc(`companies/${r.companyId}`).get()).data() as any;
            if (c) { companyName = c.name || ""; logoUrl = r.cardLogoUrl || c.logoUrl || ""; }
          }
        }
      }
    } catch {
      // fall through to the generic redirect below
    }
  }

  const image = photoUrl || logoUrl || "";
  const title = found
    ? `${displayName}${cardTitle ? ` — ${cardTitle}` : ""}`
    : "Digital Business Card";
  const desc = found
    ? (bio ? bio.slice(0, 200) : `${companyName ? `${companyName} — ` : ""}Tap to view my digital business card.`)
    : "Tap to view this digital business card.";

  res.set("Cache-Control", "public, max-age=300");
  res.status(200).send(`<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<meta property="og:type" content="profile">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
${image ? `<meta property="og:image" content="${escHtml(image)}">\n<meta name="twitter:card" content="summary_large_image">` : ""}
<meta property="og:url" content="${escHtml(`${APP_URL}/c/${slug}`)}">
<meta http-equiv="refresh" content="0; url=${escHtml(appUrl)}">
<script>location.replace(${JSON.stringify(appUrl)});</script>
</head><body>
<p>Redirecting to <a href="${escHtml(appUrl)}">the card</a>…</p>
</body></html>`);
});

function escVcf(s: unknown): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// Public (no auth): a rep's card as a downloadable .vcf — so opening the
// share link (or scanning the printed QR) can save the contact directly,
// with no app or login. Same lookup as getRepCard/cardShare.
export const cardVcf = onRequest({ cors: true }, async (req, res) => {
  const parts = req.path.split("/").filter(Boolean).filter((p) => p !== "vcf");
  const slug = normalizeCardSlug(parts[0] || "");
  if (!slug) { res.status(404).send("Not found"); return; }

  const q = await db.collection("users").where("cardSlug", "==", slug).limit(1).get();
  if (q.empty) { res.status(404).send("This card isn't available."); return; }
  const r = q.docs[0].data() as any;
  if (!r.cardEnabled || r.disabled) { res.status(404).send("This card isn't available."); return; }
  const c = (await db.doc(`companies/${r.companyId}`).get()).data() as any;
  if (!c || c.status === "suspended") { res.status(404).send("This card isn't available."); return; }

  const displayName: string = r.displayName || "Contact";
  const [first, ...restName] = displayName.trim().split(/\s+/);
  const last = restName.join(" ");
  const title: string = r.cardTitle || r.title || "";
  const companyName: string = c.name || "";
  const phone: string = r.phone || "";
  const email: string = r.email || "";
  const website = withUrlProtocol(c.website);
  const address: string = c.address || "";

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escVcf(last)};${escVcf(first || displayName)};;;`,
    `FN:${escVcf(displayName)}`,
  ];
  if (companyName) lines.push(`ORG:${escVcf(companyName)}`);
  if (title) lines.push(`TITLE:${escVcf(title)}`);
  if (phone) lines.push(`TEL;TYPE=CELL,VOICE:${escVcf(phone)}`);
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${escVcf(email)}`);
  if (website) lines.push(`URL:${escVcf(website)}`);
  if (address) lines.push(`ADR;TYPE=WORK:;;${escVcf(address)};;;;`);
  lines.push("END:VCARD");

  const safeName = displayName.replace(/[^\w.-]+/g, "_") || "contact";
  res.set("Content-Type", "text/vcard; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${safeName}.vcf"`);
  res.set("Cache-Control", "public, max-age=300");
  res.status(200).send(lines.join("\r\n"));
});

// Company branding shown on every rep's card (logo, website, phone, address) unless a
// rep overrides the logo with their own. Company admin (own company) or
// super-admin (any company).
export const setCompanyBranding = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, logoUrl, bgImageUrl, website, phone, address, idPrefix } = (request.data || {}) as {
    companyId?: string; logoUrl?: string; bgImageUrl?: string; website?: string; phone?: string; address?: string; idPrefix?: string;
  };
  authorizeForCompany(caller, companyId);
  const update: Record<string, unknown> = {};
  if (typeof logoUrl === "string") update.logoUrl = logoUrl.trim().slice(0, 1000);
  if (typeof bgImageUrl === "string") update.bgImageUrl = bgImageUrl.trim().slice(0, 1000);
  if (typeof website === "string") update.website = withUrlProtocol(website.slice(0, 200));
  if (typeof phone === "string") update.phone = phone.trim().slice(0, 30);
  if (typeof address === "string") update.address = address.trim().slice(0, 200);
  if (typeof idPrefix === "string") update.idPrefix = idPrefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  await db.doc(`companies/${companyId}`).set(update, { merge: true });
  return { ok: true, ...update };
});

// The company's core profile: legal/display name + general contact info. Company
// admin (own company) or super-admin (any company). Separate from the RallyCard
// branding fields above (which control what's shown on a rep's card) and from
// setCompanyBilling (which controls who invoices go to).
export const setCompanyProfile = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, phone, address, email } = (request.data || {}) as {
    companyId?: string; name?: string; phone?: string; address?: string; email?: string;
  };
  authorizeForCompany(caller, companyId);
  const update: Record<string, unknown> = {};
  if (typeof name === "string") {
    const trimmed = name.trim().slice(0, 200);
    if (!trimmed) throw new HttpsError("invalid-argument", "Company name can't be empty.");
    update.name = trimmed;
  }
  if (typeof phone === "string") update.phone = phone.trim().slice(0, 30);
  if (typeof address === "string") update.address = address.trim().slice(0, 200);
  if (typeof email === "string") {
    const trimmedEmail = email.trim().slice(0, 200);
    if (trimmedEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)) {
      throw new HttpsError("invalid-argument", "Enter a valid email address.");
    }
    update.email = trimmedEmail;
  }
  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  update.updatedAt = Date.now();
  await db.doc(`companies/${companyId}`).set(update, { merge: true });
  return { ok: true, ...update };
});

// Public (no auth): a visitor submits the lead-capture form on a rep's card.
// Mirrors the crmApi lead-upsert shape above, but the rep IS the assignee.
export const submitCardLead = onCall(async (request) => {
  const d = (request.data || {}) as {
    slug?: string; name?: string; phone?: string; email?: string; address?: string; notes?: string; hp?: string;
  };
  if (d.hp) return { ok: true }; // honeypot field tripped — silently drop, pretend success

  const slug = normalizeCardSlug(String(d.slug || ""));
  if (!slug) throw new HttpsError("invalid-argument", "Missing card link.");
  const name = String(d.name || "").trim().slice(0, 120);
  const phone = String(d.phone || "").trim().slice(0, 30);
  const email = String(d.email || "").trim().slice(0, 120);
  if (!name || (!phone && !email)) {
    throw new HttpsError("invalid-argument", "Name and a phone or email are required.");
  }

  const q = await db.collection("users").where("cardSlug", "==", slug).limit(1).get();
  if (q.empty) throw new HttpsError("not-found", "This card isn't available.");
  const repUid = q.docs[0].id;
  const rep = q.docs[0].data() as any;
  if (!rep.cardEnabled || rep.disabled) throw new HttpsError("not-found", "This card isn't available.");
  const company = await db.doc(`companies/${rep.companyId}`).get();
  if (!company.exists || (company.data() as any)?.status === "suspended") {
    throw new HttpsError("not-found", "This card isn't available.");
  }

  const now = Date.now();
  const ref = await db.collection("leads").add({
    companyId: rep.companyId,
    address: String(d.address || "").trim().slice(0, 200) || "(no address provided)",
    ownerName: name,
    phone: phone || null,
    email: email || null,
    notes: String(d.notes || "").trim().slice(0, 1000) || null,
    status: "new",
    assignedTo: repUid,
    visibilityPath: [repUid, ...(Array.isArray(rep.managerPath) ? rep.managerPath : [])],
    createdBy: repUid,
    source: "digitalCard",
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, leadId: ref.id };
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
    { calendar: { google: { connected: true, email, connectedAt: Date.now(), needsReauth: false, lastSyncError: "" } } },
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
    { calendar: { microsoft: { connected: true, email, connectedAt: Date.now(), needsReauth: false, lastSyncError: "" } } },
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
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get().catch(() => null);
  if (!tokSnap || !tokSnap.exists) return [];
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  // A failure loading integration config must NOT bubble up and make the rep
  // look busy — degrade to "no external calendars" so the internal appointment
  // check stays authoritative and availability is never zeroed out wholesale.
  const cfg = await getIntegrationConfig().catch(() => null);
  if (!cfg) return [];
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

// Two-way calendar sync (inbound): the caller's external-calendar busy blocks
// over a window, so anything they block outside the app (Google/Outlook) shows
// as "busy" on their in-app calendar. Range is clamped to 62 days.
export const myExternalBusy = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as { startMs?: number; endMs?: number };
  const start = Number(d.startMs) || Date.now();
  const end = Math.min(Number(d.endMs) || (start + 31 * 86400000), start + 62 * 86400000);
  if (!(end > start)) return { busy: [] };
  const busy = await externalBusy(caller.uid, start, end);
  return { busy };
});

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

// Record the outcome of a calendar push on the user's connection summary, so a
// dead token or a rejected event surfaces in the app instead of failing
// silently. needsReauth=true means the stored refresh token is no longer valid
// (the #1 cause: a Google OAuth app left in "Testing" status, whose refresh
// tokens expire after 7 days) and the rep must reconnect.
async function recordCalendarSync(
  uid: string, provider: "google" | "microsoft",
  patch: { needsReauth?: boolean; lastSyncError?: string },
): Promise<void> {
  await db.doc(`users/${uid}`).set(
    { calendar: { [provider]: { ...patch, lastSyncAt: Date.now() } } },
    { merge: true },
  );
}

// Push an appointment to a rep's connected external calendars. Best-effort for
// the booking itself (a calendar hiccup never blocks an appointment), but the
// outcome is recorded so failures are visible and re-auth can be prompted.
async function pushExternalEvent(uid: string, ev: { title: string; address?: string; notes?: string; startMs: number; endMs: number }): Promise<{ googleEventId?: string; microsoftEventId?: string }> {
  const ids: { googleEventId?: string; microsoftEventId?: string } = {};
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get();
  if (!tokSnap.exists) return ids;
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  const cfg = await getIntegrationConfig();
  const startISO = new Date(ev.startMs).toISOString();
  const endISO = new Date(ev.endMs).toISOString();
  // Stamp the company's timezone so the event shows at the right local time.
  let tz = "UTC";
  try {
    const companyId = (await db.doc(`users/${uid}`).get()).data()?.companyId as string | undefined;
    if (companyId) tz = (await companyScheduling(companyId)).timezone || "UTC";
  } catch { /* default UTC */ }

  if (t.google?.refreshToken && cfg.googleClientId) {
    try {
      const at = await googleAccessToken(t.google.refreshToken, cfg);
      if (!at) {
        // Refresh failed → the connection is dead; prompt the rep to reconnect.
        await recordCalendarSync(uid, "google", { needsReauth: true, lastSyncError: "Google sign-in expired — reconnect your calendar." });
      } else {
        const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: ev.title,
            location: ev.address || "",
            description: ev.notes || "Booked via YoutilityKnock",
            start: { dateTime: startISO, timeZone: tz },
            end: { dateTime: endISO, timeZone: tz },
          }),
        });
        if (r.ok) {
          const gj = (await r.json().catch(() => ({}))) as { id?: string };
          if (gj.id) ids.googleEventId = gj.id;
          await recordCalendarSync(uid, "google", { needsReauth: false, lastSyncError: "" });
        } else {
          const body = await r.text().catch(() => "");
          logger.warn(`google event push failed (${r.status})`, body);
          await recordCalendarSync(uid, "google", { needsReauth: r.status === 401, lastSyncError: `Google Calendar rejected the event (${r.status}).` });
        }
      }
    } catch (e) {
      logger.warn("google event push failed", e);
      await recordCalendarSync(uid, "google", { lastSyncError: "Couldn't reach Google Calendar." });
    }
  }
  if (t.microsoft?.refreshToken && cfg.microsoftClientId) {
    try {
      const at = await microsoftAccessToken(t.microsoft.refreshToken, cfg);
      if (!at) {
        await recordCalendarSync(uid, "microsoft", { needsReauth: true, lastSyncError: "Outlook sign-in expired — reconnect your calendar." });
      } else {
        const r = await fetch("https://graph.microsoft.com/v1.0/me/events", {
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
        if (r.ok) {
          const mj = (await r.json().catch(() => ({}))) as { id?: string };
          if (mj.id) ids.microsoftEventId = mj.id;
          await recordCalendarSync(uid, "microsoft", { needsReauth: false, lastSyncError: "" });
        } else {
          const body = await r.text().catch(() => "");
          logger.warn(`microsoft event push failed (${r.status})`, body);
          await recordCalendarSync(uid, "microsoft", { needsReauth: r.status === 401, lastSyncError: `Outlook rejected the event (${r.status}).` });
        }
      }
    } catch (e) {
      logger.warn("microsoft event push failed", e);
      await recordCalendarSync(uid, "microsoft", { lastSyncError: "Couldn't reach Outlook." });
    }
  }
  return ids;
}

// Move an already-pushed event (reschedule) on the owner's external calendars.
// Falls back to creating a fresh one if we don't have a stored external id.
async function patchExternalEvent(
  uid: string,
  ids: { googleEventId?: string; microsoftEventId?: string },
  ev: { title: string; address?: string; notes?: string; startMs: number; endMs: number },
): Promise<{ googleEventId?: string; microsoftEventId?: string }> {
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get();
  if (!tokSnap.exists) return ids;
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  const cfg = await getIntegrationConfig();
  const startISO = new Date(ev.startMs).toISOString();
  const endISO = new Date(ev.endMs).toISOString();
  let tz = "UTC";
  try {
    const companyId = (await db.doc(`users/${uid}`).get()).data()?.companyId as string | undefined;
    if (companyId) tz = (await companyScheduling(companyId)).timezone || "UTC";
  } catch { /* default UTC */ }
  const out = { ...ids };

  if (t.google?.refreshToken && cfg.googleClientId && ids.googleEventId) {
    try {
      const at = await googleAccessToken(t.google.refreshToken, cfg);
      if (at) {
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${ids.googleEventId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({ start: { dateTime: startISO, timeZone: tz }, end: { dateTime: endISO, timeZone: tz } }),
        });
      }
    } catch (e) { logger.warn("google event patch failed", e); }
  }
  if (t.microsoft?.refreshToken && cfg.microsoftClientId && ids.microsoftEventId) {
    try {
      const at = await microsoftAccessToken(t.microsoft.refreshToken, cfg);
      if (at) {
        await fetch(`https://graph.microsoft.com/v1.0/me/events/${ids.microsoftEventId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({ start: { dateTime: startISO, timeZone: "UTC" }, end: { dateTime: endISO, timeZone: "UTC" } }),
        });
      }
    } catch (e) { logger.warn("microsoft event patch failed", e); }
  }
  // No stored id for a connected provider → create it fresh so it still lands.
  const needGoogle = t.google?.refreshToken && cfg.googleClientId && !ids.googleEventId;
  const needMicrosoft = t.microsoft?.refreshToken && cfg.microsoftClientId && !ids.microsoftEventId;
  if (needGoogle || needMicrosoft) {
    const fresh = await pushExternalEvent(uid, ev);
    if (needGoogle && fresh.googleEventId) out.googleEventId = fresh.googleEventId;
    if (needMicrosoft && fresh.microsoftEventId) out.microsoftEventId = fresh.microsoftEventId;
  }
  return out;
}

// Remove an event from the owner's external calendar (used when an appointment
// is cancelled). Best-effort — a provider failure never blocks the cancel.
async function deleteExternalEvent(uid: string, ids: { googleEventId?: string; microsoftEventId?: string }): Promise<void> {
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get();
  if (!tokSnap.exists) return;
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  const cfg = await getIntegrationConfig();
  if (t.google?.refreshToken && cfg.googleClientId && ids.googleEventId) {
    try {
      const at = await googleAccessToken(t.google.refreshToken, cfg);
      if (at) await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${ids.googleEventId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${at}` },
      });
    } catch (e) { logger.warn("google event delete failed", e); }
  }
  if (t.microsoft?.refreshToken && cfg.microsoftClientId && ids.microsoftEventId) {
    try {
      const at = await microsoftAccessToken(t.microsoft.refreshToken, cfg);
      if (at) await fetch(`https://graph.microsoft.com/v1.0/me/events/${ids.microsoftEventId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${at}` },
      });
    } catch (e) { logger.warn("microsoft event delete failed", e); }
  }
}

// Push EVERY newly-created calendar event to its owner's external calendar.
// Centralizing here means every path that books an appointment / go-back /
// follow-up reaches Google/Outlook — the door DispositionModal (client-side),
// closer close-out follow-ups, and the assigned/closer appointment callables —
// not just the two server callables that pushed inline before. Opt out per
// event with `pushExternal: false` (e.g. a silent reassign).
const CALENDAR_EVENT_TYPES = new Set(["appointment", "go_back", "follow_up"]);
export const onEventCreatedPushCalendar = onDocumentCreated("events/{eventId}", async (event) => {
  const ev = event.data?.data() as any;
  if (!ev || !CALENDAR_EVENT_TYPES.has(ev.type) || ev.pushExternal === false) return;
  const uid = ev.userId as string | undefined;
  const startMs = Number(ev.startAt);
  if (!uid || !Number.isFinite(startMs)) return;
  const endMs = Number(ev.endAt) || startMs + (Number(ev.durationMin) || 60) * 60 * 1000;
  // Put the customer's phone at the top of the calendar description so the
  // closer can tap-to-call straight from Google/Outlook.
  const baseNotes = ev.notes || ev.apptNotes || "";
  const notes = ev.phone ? `📞 ${ev.phone}${baseNotes ? `\n\n${baseNotes}` : ""}` : baseNotes;
  try {
    const ids = await pushExternalEvent(uid, {
      title: ev.title || "Appointment",
      address: ev.address,
      notes,
      startMs,
      endMs,
    });
    // Stash the external ids so a later reschedule MOVES the same event instead
    // of creating a duplicate.
    if (ids.googleEventId || ids.microsoftEventId) {
      await event.data?.ref.set(ids, { merge: true }).catch(() => {});
    }
  } catch (e) {
    logger.warn("event→calendar push failed", e);
  }
});

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

// Given a list of candidate start times, return only the ones the rep is free
// for. The client generates the day's candidate slots (it knows business hours
// from company.scheduling); the server is needed only because the free/busy
// check also reads external-calendar busy from server-only tokens.
export const getFreeSlots = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, durationMin, candidates } = (request.data || {}) as
    { uid?: string; durationMin?: number; candidates?: number[] };
  if (!Array.isArray(candidates) || !candidates.length) return { free: [] };
  const list = candidates.filter((n) => typeof n === "number" && isFinite(n)).slice(0, 64);
  const targetUid = uid || caller.uid;
  const sched = caller.companyId ? await companyScheduling(caller.companyId) : DEFAULT_SCHEDULING;
  const dur = (durationMin || sched.apptDurationMin) * 60 * 1000;
  // Fail OPEN: if an availability check errors (a calendar API hiccup, a
  // building index, a timeout), offer the slot rather than hiding it. A stray
  // error must never make a rep look fully booked and block every booking — the
  // definitive double-book guard runs again at commit time in pickCloser.
  const flags = await Promise.all(list.map((s) =>
    isUserFree(targetUid, s, s + dur, sched.bufferMin).catch(() => true)));
  return { free: list.filter((_, i) => flags[i]) };
});

// Team-wide open slots: a candidate time is offered if AT LEAST ONE active closer
// is free then (union of every closer's calendar — internal events + external
// free/busy). Powers the "available times only" setter flow and the Scheduler
// dispatch view, so nobody is ever double-booked.
export const getTeamFreeSlots = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = caller.companyId;
  if (!companyId) return { free: [] };
  const { durationMin, candidates } = (request.data || {}) as { durationMin?: number; candidates?: number[] };
  if (!Array.isArray(candidates) || !candidates.length) return { free: [] };
  const list = candidates.filter((n) => typeof n === "number" && isFinite(n)).slice(0, 64);
  const sched = await companyScheduling(companyId);
  const dur = (durationMin || sched.apptDurationMin) * 60 * 1000;
  const buf = Number(sched.bufferMin) || 0;
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const closerUids = usersSnap.docs.filter((u) => { const d = u.data() as any; return d.disabled !== true && d.isCloser === true; }).map((u) => u.id);
  if (!closerUids.length) return { free: [] };
  // A slot is free if any closer is free; short-circuit per slot. Fail OPEN: an
  // errored availability check (calendar API hiccup, building index, timeout)
  // counts the closer as FREE so the slot is still offered — a stray error must
  // never zero out the whole team's availability and block every booking. The
  // real double-book guard runs again at commit time in pickCloser.
  const flags = await Promise.all(list.map(async (s) => {
    for (const cu of closerUids) { if (await isUserFree(cu, s, s + dur, buf).catch(() => true)) return true; }
    return false;
  }));
  return { free: list.filter((_, i) => flags[i]) };
});

// Toggle the Scheduler (team dispatch) capability on a user. Admin/super only.
export const setUserScheduler = onCall(async (request) => {
  const caller = await getCaller(request);
  const data = (request.data || {}) as { uid?: string; isScheduler?: boolean; schedulerOnly?: boolean };
  const uid = data.uid;
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const companyId = (snap.data() as any).companyId as string;
  authorizeForCompany(caller, companyId);
  // Two dials: `isScheduler` (dispatch capability, can be added to any rep) and
  // `schedulerOnly` (a dedicated dispatcher locked to the Scheduler on login).
  // Locked-only implies scheduler; turning scheduler off clears locked-only.
  const patch: Record<string, unknown> = {};
  if (typeof data.schedulerOnly === "boolean") {
    patch.schedulerOnly = data.schedulerOnly;
    if (data.schedulerOnly) patch.isScheduler = true;
  }
  if (typeof data.isScheduler === "boolean") {
    patch.isScheduler = data.isScheduler;
    if (!data.isScheduler) patch.schedulerOnly = false;
  }
  await db.doc(`users/${uid}`).set(patch, { merge: true });
  // Maintain a company flag so the door booking flow can hide closer-selection
  // whenever ANY Scheduler is active — without every client scanning the roster.
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const schedulerActive = usersSnap.docs.some((d) => { const u = d.data() as any; return u.disabled !== true && u.isScheduler === true; });
  await db.doc(`companies/${companyId}`).set({ schedulerActive }, { merge: true });
  return { ok: true, schedulerActive };
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
    phone?: string;
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
  // Carry the customer's phone onto the appointment so it shows on the rep's
  // calendar (in-app + pushed to Google/Outlook).
  let apptPhone: string | null = d.phone || null;
  if (d.leadId && !apptPhone) {
    try {
      const ld = (await db.doc(`leads/${d.leadId}`).get()).data() as any;
      if (ld) apptPhone = ld.phone || ld.phoneNumber || null;
    } catch { /* non-fatal */ }
  }
  const ev = {
    companyId,
    userId: chosen.uid,
    userName: chosen.displayName || "",
    type: "appointment",
    title: d.title || `Appointment${d.name ? ` — ${d.name}` : ""}`,
    address: d.address || "",
    phone: apptPhone,
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
  // The events→calendar trigger pushes this to the owner's external calendar;
  // persist the opt-out so a silent reassign can suppress that push.
  const ref = await db.collection("events").add(d.pushExternal === false ? { ...ev, pushExternal: false } : ev);

  await notifyUser({
    userId: chosen.uid,
    type: "event",
    title: `New appointment assigned`,
    body: [ev.title, fmtApptTime(Number(d.startAt), ev.address as string | undefined)].filter(Boolean).join(" — "),
    link: "/app/schedule",
  });

  return { ok: true, eventId: ref.id, assignedTo: chosen.uid, assignedName: chosen.displayName || "" };
});

// ════════════════════════════════════════════════════════════════════════════
// CLOSER WORKFLOW — setters book appointments that route to a closer; the
// closer dispositions them on-site. Sit % (setter) and close % (closer) roll up
// from the outcomes. Mirrors lib/closerDispositions.ts on the client.
// ════════════════════════════════════════════════════════════════════════════
const CLOSER_SIT_STATUSES = new Set([
  "pitched_pending", "pitched_not_interested", "pitched_failed_credit", "closed_won",
]);
const APPT_STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  pitched_pending: "Pitched — Pending",
  pitched_not_interested: "Pitched — Not Interested",
  pitched_failed_credit: "Pitched — Failed Credit",
  closed_won: "Closed / Won",
  no_show: "No Show",
  turned_away: "Turned Away",
  reschedule: "Reschedule",
  closer_no_show: "Closer No Show",
  auto_cleared: "Auto-cleared (stale)",
};
// Setter sit-rate denominator ("pitched appointments"): every real sit plus a
// homeowner no-show. Deliberately EXCLUDES turned_away (homeowner refused the
// pitch — not the setter's miss) and closer_no_show, so those never drag down a
// setter's sit %. reschedule is deferred — its follow-up is counted when sat.
const SETTER_PITCHED_STATUSES = new Set([
  "pitched_pending", "pitched_not_interested", "pitched_failed_credit", "closed_won", "no_show",
]);

// Choose the closer for a new appointment per company policy. When a slot
// (startMs/endMs) is given, the closer's availability is enforced: an explicitly
// picked closer must be free, and auto-assignment only considers free closers —
// so a booking never lands on a closer whose calendar is already blocked.
async function pickCloser(companyId: string, sched: any, candidateUid?: string, startMs?: number, endMs?: number, callerIsDispatcher = false) {
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  let closers = usersSnap.docs
    .map((u): { uid: string; [k: string]: any } => ({ uid: u.id, ...(u.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true && u.isCloser === true);
  if (closers.length === 0) {
    throw new HttpsError("failed-precondition", "No closers are set up for this company yet — turn a rep into a closer in Team settings.");
  }
  // Setters don't pick the closer when the company hides it OR whenever a
  // Scheduler is active (dispatch / "available times only" mode). An explicit
  // pick (below) is still honored — that's the Scheduler choosing on purpose.
  const hasScheduler = usersSnap.docs.some((u) => { const d = u.data() as any; return d.disabled !== true && d.isScheduler === true; });
  const effectiveHide = !!sched.hideCloserFromSetters || hasScheduler;
  // In hide mode a setter can't force a closer — only a dispatcher (Scheduler /
  // manager / admin) may pass an explicit pick. This is enforced here so a stale
  // client that still shows the picker can't override the auto-assignment.
  if (effectiveHide && !callerIsDispatcher) candidateUid = undefined;
  let method = sched.closerAssignment || "round_robin";
  if (effectiveHide && method === "setter_select") method = "round_robin";
  const buf = Number(sched.bufferMin) || 0;
  const checkSlot = Number.isFinite(startMs) && Number.isFinite(endMs);

  // An explicit pick (setter_select, or a Scheduler/dispatcher choosing a closer)
  // is honored in any mode — as long as that closer is free at the slot.
  if (candidateUid) {
    const found = closers.find((c) => c.uid === candidateUid);
    if (!found) throw new HttpsError("failed-precondition", "That closer isn't available.");
    if (checkSlot && !(await isUserFree(found.uid, startMs!, endMs!, buf).catch(() => true))) {
      throw new HttpsError("failed-precondition", "That closer is already booked at that time — pick another time or closer.");
    }
    return found;
  }
  if (method === "setter_select") throw new HttpsError("invalid-argument", "Pick a closer for this appointment.");

  // Auto-assignment: narrow to closers who are actually free at the slot, so a
  // busy closer is never chosen. If nobody's free, the booking is refused.
  if (checkSlot) {
    const flags = await Promise.all(closers.map((c) => isUserFree(c.uid, startMs!, endMs!, buf).catch(() => true)));
    closers = closers.filter((_, i) => flags[i]);
    if (closers.length === 0) {
      throw new HttpsError("failed-precondition", "No closer is available at that time — pick another time.");
    }
  }

  if (method === "close_rate") {
    const statsSnap = await db.collection("userStats").where("companyId", "==", companyId).get();
    const rate: Record<string, number> = {};
    statsSnap.forEach((s) => {
      const d = s.data() as any;
      const sits = Number(d.closerSits) || 0;
      rate[s.id] = sits > 0 ? (Number(d.closerCloses) || 0) / sits : 0;
    });
    closers = closers.sort((a, b) => (rate[b.uid] || 0) - (rate[a.uid] || 0) || a.uid.localeCompare(b.uid));
    return closers[0];
  }
  // round_robin among closers (stable order + a per-company cursor)
  closers = closers.sort((a, b) => a.uid.localeCompare(b.uid));
  const cur = Number((await db.doc(`companies/${companyId}`).get()).data()?.closerRrCursor) || 0;
  const chosen = closers[cur % closers.length];
  await db.doc(`companies/${companyId}`).set({ closerRrCursor: cur + 1 }, { merge: true });
  return chosen;
}

// Active schedulers for a company — the people who dispatch appointments to
// closers. Used to route unassigned appointments and to gate dispatch mode.
async function activeSchedulers(companyId: string): Promise<Array<{ uid: string; name: string; email: string }>> {
  const snap = await db.collection("users").where("companyId", "==", companyId).get();
  return snap.docs
    .map((d): { uid: string; [k: string]: any } => ({ uid: d.id, ...(d.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true && u.isScheduler === true)
    .map((u) => ({ uid: u.uid, name: u.displayName || u.email || "Scheduler", email: (u.email as string) || "" }));
}

// When an appointment lands in the dispatch queue, email every scheduler and
// drop a message into their chat from the company's Dispatch — so it hits them
// no matter which surface they're on. The chat write also fires onDmMessage,
// which pushes + in-app-notifies them.
async function notifySchedulersOfDispatch(
  companyId: string, schedulers: Array<{ uid: string; name: string; email: string }>, ev: any, eventId: string,
): Promise<void> {
  if (!schedulers.length) return;
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  const companyName = (company.name as string) || "Your company";
  const when = ev.startAt ? fmtApptTime(Number(ev.startAt), ev.address as string | undefined) : "";
  const line = [ev.title || "Appointment", ev.address, when].filter(Boolean).join(" · ");
  const link = `${APP_URL}/app/scheduler`;
  const cfg = await getNotifyConfig();
  const emailReady = !!cfg.sendgridKey || !!(cfg.smtpHost && cfg.smtpUser);
  const now = Date.now();
  const sysUid = `dispatch_${companyId}`;
  const senderName = `${companyName} Dispatch`;
  for (const s of schedulers) {
    // Guaranteed email (regardless of online status).
    if (s.email && emailReady) {
      const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">`+
        `<div style="font-size:22px;font-weight:800;color:#0EA5E9">${escEmail(companyName)}</div>`+
        `<h2 style="margin:14px 0 6px">New appointment to assign 📅</h2>`+
        `<p>${escEmail(s.name)}, a new appointment needs a closer assigned:</p>`+
        `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin:10px 0">`+
        `<div style="font-weight:700">${escEmail(ev.title || "Appointment")}</div>`+
        (ev.address ? `<div style="color:#555">${escEmail(String(ev.address))}</div>` : "")+
        (when ? `<div style="color:#555">${escEmail(when)}</div>` : "")+
        (ev.setterName ? `<div style="color:#888;font-size:13px;margin-top:4px">Set by ${escEmail(String(ev.setterName))}</div>` : "")+
        `</div>`+
        `<p style="margin:20px 0"><a href="${escEmail(link)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700;display:inline-block">Open the Scheduler →</a></p>`+
        `<p style="color:#555;font-size:13px">The Scheduler suggests the available closer with the highest close rate — assign in one click or drag it onto a closer.</p></div>`;
      await sendEmailDetailed(cfg, s.email, `New appointment to assign — ${companyName}`, `New appointment to assign: ${line}\n\nAssign a closer: ${link}`, undefined, html).catch(() => {});
    }
    // Chat message straight from the company's Dispatch into the scheduler's inbox.
    const chanId = [sysUid, s.uid].sort().join("__");
    const body = `📅 New appointment to assign: ${line}. Open the Scheduler to assign a closer.`;
    await db.doc(`dms/${chanId}`).set(
      { members: [sysUid, s.uid], memberNames: { [sysUid]: senderName, [s.uid]: s.name }, companyId, system: true, lastMessage: body, lastAt: now },
      { merge: true },
    ).catch(() => {});
    await db.collection(`dms/${chanId}/messages`).add(
      { channelId: chanId, userId: sysUid, userName: senderName, text: body, createdAt: now, eventId },
    ).catch(() => {});
  }
}

// A setter books an appointment that routes to a closer. Called from the
// disposition modal when the company has the closer workflow enabled.
export const createCloserAppointment = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    companyId?: string; startAt?: number; durationMin?: number;
    title?: string; address?: string; name?: string; notes?: string; phone?: string;
    leadId?: string; candidateCloserUid?: string;
  };
  const companyId = d.companyId || caller.companyId || "";
  if (!companyId || (caller.companyId !== companyId && !caller.isSuper)) {
    throw new HttpsError("permission-denied", "Wrong company.");
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

  const setterSnap = await db.doc(`users/${caller.uid}`).get();
  const setter: { uid: string; [k: string]: any } = setterSnap.exists
    ? { uid: setterSnap.id, ...(setterSnap.data() as Record<string, any>) }
    : { uid: caller.uid, companyId };
  // A dispatcher (Scheduler / manager / admin) may choose a specific closer;
  // a plain setter's pick is ignored when hide mode is active.
  const callerIsDispatcher = caller.isSuper || caller.role === "admin" || caller.role === "manager" || setter.isScheduler === true;
  // When a Scheduler is active, appointments are NOT auto-assigned — they route
  // to the dispatch queue for a scheduler to assign a closer by hand. A
  // dispatcher (Scheduler/manager/admin) who explicitly picked a closer is honored.
  const schedulers = await activeSchedulers(companyId);
  const dispatchMode = schedulers.length > 0 && !(callerIsDispatcher && d.candidateCloserUid);
  const closer: { uid: string; [k: string]: any } | null = dispatchMode
    ? null
    : await pickCloser(companyId, sched, d.candidateCloserUid, d.startAt, endAt, callerIsDispatcher);

  // Appointments roll up BOTH org charts: the closer's closer-managers and the
  // setter's setter-managers. An unassigned dispatch appt is visible to the
  // setter's chain plus every scheduler until a closer is assigned.
  const setterPath = (setter.managerPath as string[]) || [];
  const closerPath = (closer?.closerManagerPath as string[]) || [];
  const visibility = closer
    ? Array.from(new Set([closer.uid, ...closerPath, setter.uid, ...setterPath]))
    : Array.from(new Set([setter.uid, ...setterPath, ...schedulers.map((s) => s.uid)]));

  // Carry the area incentives the setter captured onto the appointment so the
  // closer has them in hand at the door.
  let incentives: any[] = [];
  let incentivesUtility: any = null;
  // Also carry the customer's phone onto the appointment so it lands on the
  // closer's calendar (in-app and pushed to Google/Outlook) — they can call
  // ahead without digging into the lead.
  let leadPhone: string | null = d.phone || null;
  if (d.leadId) {
    try {
      const ld = (await db.doc(`leads/${d.leadId}`).get()).data() as any;
      if (ld && Array.isArray(ld.incentives)) { incentives = ld.incentives; incentivesUtility = ld.incentivesUtility || null; }
      if (ld && !leadPhone) leadPhone = ld.phone || ld.phoneNumber || null;
    } catch { /* non-fatal */ }
  }

  const ev = {
    companyId,
    userId: closer ? closer.uid : setter.uid, // closer owns it; unassigned sits with the setter until dispatched
    userName: closer ? (closer.displayName || "") : (setter.displayName || ""),
    type: "appointment",
    title: d.title || `Appointment${d.name ? ` — ${d.name}` : ""}`,
    address: d.address || "",
    phone: leadPhone,
    leadId: d.leadId || null,
    incentives,
    incentivesUtility,
    startAt: d.startAt,
    endAt,
    durationMin: d.durationMin || sched.apptDurationMin,
    assignedBy: caller.uid,
    source: "assigned",
    notes: d.notes || "",
    setterUid: setter.uid,
    setterName: setter.displayName || "",
    closerUid: closer ? closer.uid : null,
    closerName: closer ? (closer.displayName || "") : "",
    dispatchPending: !closer,
    apptStatus: "scheduled",
    visibilityPath: visibility,
    reminded: false,
    createdAt: now,
  };
  // Re-booking a lead that already has an OPEN (undispositioned) appointment must
  // REPLACE it, not stack a second one — otherwise the same customer shows up
  // twice, often under two different closers. Remove any prior scheduled
  // appointment for this lead first, reversing that closer's queue count and
  // pulling it off their external calendar. (Dispositioned appointments are kept
  // as history.)
  if (d.leadId) {
    const prior = await db.collection("events").where("leadId", "==", d.leadId).get().catch(() => null);
    for (const p of (prior?.docs || [])) {
      const e = p.data() as any;
      if (e.type !== "appointment" || e.companyId !== companyId) continue;
      if ((e.apptStatus || "scheduled") !== "scheduled") continue;
      if (e.closerUid) {
        const cs = await db.doc(`users/${e.closerUid}`).get();
        if (cs.exists) await serverBumpStatsAt({ uid: cs.id, ...(cs.data() as any) }, { closerAppts: -1 }, Number(e.createdAt) || now).catch(() => {});
      }
      if (e.userId && (e.googleEventId || e.microsoftEventId)) {
        await deleteExternalEvent(e.userId as string, { googleEventId: e.googleEventId, microsoftEventId: e.microsoftEventId }).catch(() => {});
      }
      await p.ref.delete().catch(() => {});
    }
  }

  const ref = await db.collection("events").add(ev);

  // Let the closer (and their closer-managers) read the lead — its phone, email,
  // and knock history — once one is assigned (skipped while unassigned).
  if (closer && d.leadId) {
    await db.doc(`leads/${d.leadId}`).set(
      { visibilityPath: FieldValue.arrayUnion(closer.uid, ...closerPath) },
      { merge: true },
    ).catch((e) => logger.warn("lead closer-visibility failed", e));
  }

  if (closer) {
    // Tally the closer's incoming queue + notify them. (External-calendar push is
    // handled by the events→calendar trigger.)
    await serverBumpStats(closer, { closerAppts: 1 });
    await notifyUser({
      userId: closer.uid, type: "event",
      title: "New appointment to close",
      body: [ev.title, fmtApptTime(Number(d.startAt), ev.address as string | undefined)].filter(Boolean).join(" — "),
      link: "/app/closer",
    });
  } else {
    // Dispatch mode: email + chat every scheduler to assign a closer by hand.
    await notifySchedulersOfDispatch(companyId, schedulers, ev, ref.id).catch((e) => logger.warn("dispatch notify failed", e));
  }

  return { ok: true, eventId: ref.id, closerUid: closer ? closer.uid : "", closerName: closer ? (closer.displayName || "") : "", pending: !closer };
});

// ensureCloserLeadAccess — a closer opening their appointment needs to read the
// customer's lead (phone, email, knock history), but the lead's owner-chain is
// the setter's, so the closer isn't on its visibilityPath. If they hold an
// appointment for the lead, add them (and their closer-managers) so they can
// read it. Self-heals appointments booked before this was granted at create
// time; new bookings already grant it in createCloserAppointment.
export const ensureCloserLeadAccess = onCall(async (request) => {
  const caller = await getCaller(request);
  const { leadId } = (request.data || {}) as { leadId?: string };
  if (!leadId) throw new HttpsError("invalid-argument", "leadId required.");
  const leadRef = db.doc(`leads/${leadId}`);
  const lead = (await leadRef.get()).data() as any;
  if (!lead) throw new HttpsError("not-found", "Lead not found.");
  if (!caller.isSuper && caller.companyId && lead.companyId !== caller.companyId) {
    throw new HttpsError("permission-denied", "Wrong company.");
  }
  const vis: string[] = Array.isArray(lead.visibilityPath) ? lead.visibilityPath : [];
  if (vis.includes(caller.uid) || lead.assignedTo === caller.uid) return { ok: true, already: true };
  // Must actually hold an appointment for this customer.
  const appts = await db.collection("events").where("leadId", "==", leadId).get();
  const holds = appts.docs.some((d) => {
    const e = d.data() as any;
    return e.type === "appointment" && (
      e.closerUid === caller.uid || e.userId === caller.uid ||
      (Array.isArray(e.visibilityPath) && e.visibilityPath.includes(caller.uid))
    );
  });
  if (!holds) throw new HttpsError("permission-denied", "No appointment for this customer.");
  const me = (await db.doc(`users/${caller.uid}`).get()).data() as any;
  const path = Array.isArray(me?.closerManagerPath) ? me.closerManagerPath : [];
  await leadRef.set({ visibilityPath: FieldValue.arrayUnion(caller.uid, ...path) }, { merge: true });
  return { ok: true, granted: true };
});

// A closer records the outcome of an assigned appointment.
export const closerDisposition = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    eventId?: string; status?: string; notes?: string;
    distanceFt?: number | null; verified?: boolean; followUpAt?: number;
    afterTheFact?: boolean;
  };
  if (!d.eventId) throw new HttpsError("invalid-argument", "eventId required.");
  if (!d.status || !APPT_STATUS_LABEL[d.status] || d.status === "scheduled" || d.status === "closer_no_show") {
    throw new HttpsError("invalid-argument", "Pick a valid disposition.");
  }
  if (!d.notes || !d.notes.trim()) {
    throw new HttpsError("invalid-argument", "Notes are required on every disposition.");
  }

  const evRef = db.doc(`events/${d.eventId}`);
  const evSnap = await evRef.get();
  if (!evSnap.exists) throw new HttpsError("not-found", "Appointment not found.");
  const ev = evSnap.data() as any;

  const isAssignedCloser = ev.closerUid === caller.uid;
  const isMgr = caller.isSuper || (caller.companyId === ev.companyId && (caller.role === "admin" || caller.role === "manager"));
  if (!isAssignedCloser && !isMgr) throw new HttpsError("permission-denied", "Not your appointment to disposition.");

  // After-the-fact: the closer is closing out a past appointment from their
  // calendar, not standing at the door — so we skip the geofence penalty and
  // record the real outcome, but flag it as NOT dispositioned on the spot.
  const afterTheFact = d.afterTheFact === true;
  // Geofence (on-the-spot flow only): a disposition only counts at the home.
  // Off-site there → closer no show.
  const onSite = d.verified !== false;
  // "On the spot" = at the door, on-site, right then.
  const onSpot = !afterTheFact && onSite;
  const finalStatus = (!afterTheFact && !onSite) ? "closer_no_show" : (d.status as string);
  if (finalStatus === "pitched_pending" && !d.followUpAt) {
    throw new HttpsError("invalid-argument", "Pick a follow-up date to schedule the next appointment.");
  }
  const now = Date.now();

  await evRef.set({
    apptStatus: finalStatus,
    apptNotes: d.notes.trim(),
    dispositionedAt: now,
    dispositionDistanceFt: afterTheFact ? null : (d.distanceFt ?? null),
    dispositionVerified: afterTheFact ? false : onSite,
    dispositionedOnSpot: onSpot,
    updatedAt: now,
  }, { merge: true });

  // Credit stats: a sit lifts both the setter's sit% and the closer's close%
  // denominator; a closed_won also lifts the closer's closes (+ sales).
  const closerUid = ev.closerUid || caller.uid;
  const setterUid = ev.setterUid || null;
  const [closerSnap, setterSnap] = await Promise.all([
    db.doc(`users/${closerUid}`).get(),
    setterUid ? db.doc(`users/${setterUid}`).get() : Promise.resolve(null as any),
  ]);
  const closer = closerSnap.exists ? { uid: closerSnap.id, ...(closerSnap.data() as any) } : { uid: closerUid, companyId: ev.companyId };
  const setter = setterSnap && setterSnap.exists ? { uid: setterSnap.id, ...(setterSnap.data() as any) } : null;

  const isSit = CLOSER_SIT_STATUSES.has(finalStatus);
  if (isSit) await serverBumpStats(closer, { closerSits: 1 });
  // Setter side: a sit lifts both sits and the pitched-appointment denominator;
  // a no-show lifts only the denominator (a real appointment that didn't sit).
  if (setter && SETTER_PITCHED_STATUSES.has(finalStatus)) {
    await serverBumpStats(setter, isSit ? { sits: 1, pitchedAppts: 1 } : { pitchedAppts: 1 });
  }
  // Turned away is tracked for the closer but never touches the setter's sit %.
  if (finalStatus === "turned_away") await serverBumpStats(closer, { closerTurnedAways: 1 });
  if (finalStatus === "closed_won") {
    await serverBumpStats(closer, { closerCloses: 1, sales: 1 });
    if (ev.leadId) {
      await db.doc(`leads/${ev.leadId}`).set({ status: "sold", soldAt: now, updatedAt: now }, { merge: true }).catch(() => {});
    }
  }

  // pitched_pending / reschedule → schedule a follow-up appointment (same closer).
  let followUpId: string | null = null;
  if ((onSite || afterTheFact) && (finalStatus === "pitched_pending" || finalStatus === "reschedule") && d.followUpAt) {
    const dur = (ev.durationMin || 60) * 60 * 1000;
    const fu = { ...ev };
    delete fu.id;
    delete fu.dispositionedOnSpot;
    delete fu.pushExternal; // a fresh follow-up should always reach the calendar
    Object.assign(fu, {
      startAt: d.followUpAt,
      endAt: d.followUpAt + dur,
      apptStatus: "scheduled",
      apptNotes: "",
      dispositionedAt: null,
      dispositionDistanceFt: null,
      dispositionVerified: null,
      followUpForEventId: d.eventId,
      reminded: false,
      createdAt: now,
    });
    // The events→calendar trigger picks this up and pushes it to Google/Outlook.
    const fuRef = await db.collection("events").add(fu);
    followUpId = fuRef.id;
    await notifyUser({ userId: closerUid, type: "event", title: "Follow-up scheduled", body: fmtApptTime(Number(d.followUpAt), ev.address as string | undefined), link: "/app/closer" });
  }

  // Alert the setter with the closer's notes — the communication loop.
  if (setterUid) {
    await notifyUser({
      userId: setterUid, type: "closer_update",
      title: `Your appt: ${APPT_STATUS_LABEL[finalStatus]}`,
      body: [ev.address, d.notes.trim()].filter(Boolean).join(" — "),
      link: "/app/schedule",
    });
  }

  // No-show → open a direct chat back to the setter so they can help follow up.
  // Covers both a "No Show" disposition and an off-site closer no-show.
  if (setterUid && (finalStatus === "no_show" || finalStatus === "closer_no_show")) {
    try {
      const closerName = (closer as any).displayName || ev.closerName || "The closer";
      const cid = [closerUid, setterUid].sort().join("__");
      const body = `🚪 No-show on ${ev.address || "your appointment"}${ev.title ? ` (${ev.title})` : ""}. `
        + `Can you help follow up / re-book?${d.notes.trim() ? ` Notes: ${d.notes.trim()}` : ""}`;
      await db.doc(`dms/${cid}`).set({
        members: [closerUid, setterUid],
        memberNames: { [closerUid]: closerName, [setterUid]: (setter as any)?.displayName || "" },
        companyId: ev.companyId,
        lastMessage: body,
        lastAt: now,
      }, { merge: true });
      await db.collection(`dms/${cid}/messages`).add({
        channelId: cid, userId: closerUid, userName: closerName, text: body, createdAt: now,
      });
      await notifyUser({ userId: setterUid, type: "closer_update", title: `No-show — please follow up`, body: ev.address || "", link: "/app/chat" });
    } catch (err) {
      logger.warn("no-show setter DM failed", err);
    }
  }

  // A closer no-show (dispositioned off-site) flags up to the closer's manager.
  if (finalStatus === "closer_no_show") {
    await serverBumpStats(closer, { closerNoShows: 1 });
    const mgr = Array.isArray((closer as any).closerManagerPath) ? (closer as any).closerManagerPath[0] : null;
    if (mgr) {
      await notifyUser({
        userId: mgr, type: "closer_no_show",
        title: "Closer no-show",
        body: `${(closer as any).displayName || "A closer"} dispositioned ${ev.address || "an appointment"} off-site (${d.distanceFt ?? "?"} ft away).`,
        link: "/app/closer",
      });
    }
  }

  return { ok: true, status: finalStatus, onSite, followUpId };
});

// Toggle whether a user can be assigned appointments as a closer.
export const setUserCloser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, isCloser } = (request.data || {}) as { uid?: string; isCloser?: boolean };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  authorizeForCompany(caller, (snap.data() as any).companyId);
  await db.doc(`users/${uid}`).set({ isCloser: !!isCloser }, { merge: true });
  return { ok: true };
});

// List a company's closers (for the setter-select booking dropdown).
export const listClosers = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.companyId) throw new HttpsError("permission-denied", "No company.");
  const snap = await db.collection("users").where("companyId", "==", caller.companyId).get();
  const closers = snap.docs
    .map((dd): { uid: string; [k: string]: any } => ({ uid: dd.id, ...(dd.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true && u.isCloser === true)
    .map((u) => ({ uid: u.uid, name: u.displayName || u.email || "Closer" }));
  return { closers };
});

// Emergency unblock: clear the backlog of stale, never-dispositioned closer
// appointments so the app's hard disposition gate releases closers immediately
// (used when a pile of old / test appointments locks them out). Marks each as
// "auto_cleared" — counts as dispositioned so the gate lets go, but NOT as a
// sit / close / no-show, so it doesn't pollute anyone's rates. Admin/super only.
export const clearStaleAppointments = onCall(async (request) => {
  const caller = await getCaller(request);
  const req = (request.data || {}) as { companyId?: string; olderThanHours?: number };
  const companyId = caller.isSuper && req.companyId ? req.companyId : caller.companyId;
  if (!companyId) throw new HttpsError("permission-denied", "No company.");
  if (!(caller.isSuper || caller.role === "admin")) throw new HttpsError("permission-denied", "Admins only.");
  const graceMs = 2 * 60 * 60 * 1000; // matches the gate's grace buffer
  const olderMs = Math.max(0, Number(req.olderThanHours) || 0) * 60 * 60 * 1000;
  const cutoff = Date.now() - graceMs - olderMs;
  const now = Date.now();
  const snap = await db.collection("events").where("companyId", "==", companyId).where("type", "==", "appointment").get();
  const ops: Promise<unknown>[] = [];
  let cleared = 0;
  for (const d of snap.docs) {
    const ev = d.data() as any;
    if (!ev.closerUid) continue;
    if (ev.apptStatus && ev.apptStatus !== "scheduled") continue; // already dispositioned
    const endAt = (typeof ev.endAt === "number" && ev.endAt > 0) ? ev.endAt : (Number(ev.startAt) || 0) + ((Number(ev.durationMin) || 60) * 60000);
    if (!(endAt > 0 && endAt < cutoff)) continue; // not past-due beyond the window
    ops.push(d.ref.set({ apptStatus: "auto_cleared", apptNotes: "Auto-cleared (stale — never dispositioned)", dispositionedAt: now, dispositionedOnSpot: false, dispositionVerified: false, updatedAt: now }, { merge: true }));
    cleared++;
  }
  await Promise.all(ops);
  return { cleared };
});

// Team appointment calendar for the Scheduler / dispatch board. Runs server-side
// so a Scheduler (or manager/admin) sees the whole team's appointments in a
// window — plus the closer roster for columns + reassignment — without needing
// company-wide Firestore read access.
export const listTeamAppointments = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = caller.companyId;
  if (!companyId) return { appts: [], closers: [] };
  const me = (await db.doc(`users/${caller.uid}`).get()).data() || {};
  const allowed = caller.isSuper || caller.role === "admin" || caller.role === "manager" || me.isScheduler === true;
  if (!allowed) throw new HttpsError("permission-denied", "Schedulers, managers or admins only.");
  const { fromMs, toMs } = (request.data || {}) as { fromMs?: number; toMs?: number };
  const start = Number(fromMs) || Date.now() - 24 * 3600 * 1000;
  const end = Number(toMs) || Date.now() + 30 * 24 * 3600 * 1000;
  const snap = await db.collection("events")
    .where("companyId", "==", companyId)
    .where("startAt", ">=", start)
    .where("startAt", "<=", end)
    .get();
  const appts = snap.docs
    .map((d) => {
      const e = d.data() as any;
      return {
        id: d.id, title: (e.title as string) || "", address: (e.address as string) || "",
        startAt: Number(e.startAt), endAt: e.endAt ? Number(e.endAt) : null, durationMin: e.durationMin ? Number(e.durationMin) : null,
        closerUid: (e.closerUid as string) || null, closerName: (e.closerName as string) || "",
        setterName: (e.setterName as string) || "", apptStatus: (e.apptStatus as string) || null, type: (e.type as string) || "",
        notes: (e.notes as string) || "", apptNotes: (e.apptNotes as string) || "", phone: (e.phone as string) || "",
        dispatchPending: e.dispatchPending === true, leadId: (e.leadId as string) || null,
      };
    })
    .filter((e) => e.type === "appointment" || !!e.closerUid)
    .sort((a, b) => a.startAt - b.startAt);
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  // All-time per-closer close rate (closes ÷ sits) so the board can suggest the
  // available closer with the highest close %.
  const metrics = await computeApptMetrics(companyId, 0);
  const closers = usersSnap.docs
    .map((u): { uid: string; [k: string]: any } => ({ uid: u.id, ...(u.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true && u.isCloser === true)
    .map((u) => {
      const cm = metrics.closers[u.uid];
      const sits = cm?.sits || 0, closes = cm?.closes || 0;
      return { uid: u.uid, name: u.displayName || u.email || "Closer", closes, sits, closeRate: sits > 0 ? Math.round((closes / sits) * 100) : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { appts, closers };
});

// Company-wide rep funnel rankings (doors / convos / appts / closes) for a
// window, computed from leads exactly like the admin Town Hall. Runs server-side
// (admin SDK) so any rep — not just admins — can see the whole company's board;
// a rep can't read every company lead directly under the security rules.
export const companyFunnelRankings = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = caller.companyId;
  if (!companyId) throw new HttpsError("permission-denied", "No company.");
  const startMs = Number((request.data as { startMs?: number } | undefined)?.startMs) || 0;

  const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
  const knockAt = (l: any) => l.knockedAt || l.createdAt || 0;
  // Close DATE = when it actually sold. Never fall back to updatedAt — any later
  // edit (a visibility rebuild, a note) would otherwise make an old sale count as
  // "closed this week" and inflate the week's closes. createdAt is the stable
  // last resort for legacy sold leads with no soldAt.
  const closeAt = (l: any) => l.soldAt || l.createdAt || 0;

  const leadsCol = db.collection("leads");
  // Fetch the whole company lead set and window by knockAt in code — the SAME
  // rule Reports uses (getEmployeeReport → rFunnel). A createdAt pre-filter would
  // drop leads created before the window but re-knocked/set as an appointment
  // inside it, making this board undercount vs. Reports (7 vs 9). Window parity
  // matters more than the extra reads.
  const leadDocs = (await leadsCol.where("companyId", "==", companyId).get()).docs;
  const soldDocs = (await leadsCol.where("companyId", "==", companyId).where("status", "==", "sold").get().catch(() => null))?.docs || [];
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const names: Record<string, string> = {};
  usersSnap.forEach((d) => { const u = d.data(); names[d.id] = (u.displayName as string) || (u.email as string) || "Rep"; });

  type Funnel = { doors: number; conv: number; appt: number; closed: number };
  const perRep: Record<string, Funnel> = {};
  const blank = (): Funnel => ({ doors: 0, conv: 0, appt: 0, closed: 0 });
  for (const d of leadDocs) {
    const l = d.data();
    if (knockAt(l) < startMs) continue;
    const uid = l.assignedTo as string; if (!uid) continue;
    const acc = (perRep[uid] ??= blank());
    if (l.verified !== false) { acc.doors++; if (CONVO.has(l.status)) acc.conv++; } // doors/convos need on-site
    if (l.status === "appointment") acc.appt++;
  }
  for (const d of soldDocs) {
    const l = d.data();
    if (closeAt(l) < startMs) continue;
    const uid = l.assignedTo as string; if (!uid) continue;
    (perRep[uid] ??= blank()).closed++;
  }
  const rankings = Object.entries(perRep)
    .map(([uid, f]) => ({ uid, name: names[uid] || "Rep", ...f }))
    .sort((a, b) => b.closed - a.closed || b.appt - a.appt || b.conv - a.conv || b.doors - a.doors)
    .slice(0, 25);
  return { rankings };
});

// Authoritative appointment metrics, computed straight from the appointment
// EVENTS — not the rolled-up stat counters, which drift (double-bumps on save,
// counters that only started accruing recently, etc.). An appointment counts
// once, when the setter sets it: reschedule follow-ups (followUpForEventId) are
// skipped, and a cancelled appointment's event is deleted so it drops out for
// free. Windowed by when it was SET (createdAt). Sit % denominator = sits +
// no-shows (turn-aways and closer-no-shows excluded). Keyed by uid for the
// setter and, separately, the closer.
// Grace after an appointment's END before a disposition is mandatory — must
// match the client hard gate (DISPO_GRACE_MS in lib/closerDispositions.ts) so
// the reported disposition rate lines up exactly with when reps are forced to
// disposition.
const APPT_DISPO_GRACE_MS = 2 * 60 * 60 * 1000;
async function computeApptMetrics(companyId: string, startMs: number, endMs: number = Number.MAX_SAFE_INTEGER): Promise<{
  setters: Record<string, { appts: number; sits: number; pitched: number; noShow: number; upcoming: number; undispositioned: number; other: number }>;
  closers: Record<string, { appts: number; sits: number; closes: number; turnedAways: number; due: number; dispositioned: number; ended: number; endedDispo: number }>;
}> {
  const snap = await db.collection("events")
    .where("companyId", "==", companyId).where("type", "==", "appointment").get();
  const nowMs = Date.now();
  const setters: Record<string, { appts: number; sits: number; pitched: number; noShow: number; upcoming: number; undispositioned: number; other: number }> = {};
  const closers: Record<string, { appts: number; sits: number; closes: number; turnedAways: number; due: number; dispositioned: number; ended: number; endedDispo: number }> = {};
  for (const d of snap.docs) {
    const ev = d.data() as any;
    if (ev.followUpForEventId) continue; // a reschedule's follow-up isn't a new appointment
    const setAt = Number(ev.createdAt) || Number(ev.startAt) || 0;
    // "Set in this window" gates the volume counters (appts / sits / closes) —
    // those belong to the period the appointment was booked.
    const setInWindow = setAt >= startMs && setAt < endMs;
    const startAt = Number(ev.startAt) || 0;
    const endAt = Number(ev.endAt) || startAt || 0;
    // Disposition accountability uses the SAME rule as the hard gate: an
    // appointment is "owed a disposition" once its end + a 2-hour grace has
    // passed. Credit it to the period it came DUE (not when it was booked), so a
    // disposition done today shows today — and an appointment still inside its
    // grace window isn't held against anyone yet, so a compliant team hits 100%.
    const dueAt = endAt > 0 ? endAt + APPT_DISPO_GRACE_MS : 0;
    const dueInWindow = dueAt > 0 && dueAt < nowMs && dueAt >= startMs && dueAt < endMs;
    const st = (ev.apptStatus as string) || "scheduled";
    const isSit = CLOSER_SIT_STATUSES.has(st);
    // Routed appt: setterUid is the setter, userId the closer. Self-gen appt
    // (no closer routing): the setter is userId.
    const setterUid = (ev.setterUid as string) || (ev.userId as string) || null;
    // Closer of record: the routed closer if there is one, otherwise the setter
    // runs and closes their OWN self-gen appointment — so they are the closer for
    // it. Each appointment is attributed to exactly one closer here, so a close is
    // never counted for both the setter and a separate closer (no double count).
    const closerUid = (ev.closerUid as string) || setterUid;
    if (setterUid && setInWindow) {
      const s = (setters[setterUid] ??= { appts: 0, sits: 0, pitched: 0, noShow: 0, upcoming: 0, undispositioned: 0, other: 0 });
      s.appts++;
      // Full outcome breakdown so every set appointment is accounted for:
      // sat, no-showed, still upcoming, past-due-but-never-dispositioned, or
      // otherwise closed out (rescheduled / turned away / cancelled).
      if (isSit) { s.sits++; s.pitched++; }
      else if (st === "no_show") { s.noShow++; s.pitched++; }
      else if (st === "scheduled") { if (startAt > 0 && startAt < nowMs) s.undispositioned++; else s.upcoming++; }
      else s.other++;
    }
    if (closerUid) {
      const c = (closers[closerUid] ??= { appts: 0, sits: 0, closes: 0, turnedAways: 0, due: 0, dispositioned: 0, ended: 0, endedDispo: 0 });
      if (setInWindow) {
        c.appts++;                             // appointments set FOR or BY this closer
        if (isSit) c.sits++;
        if (st === "closed_won") c.closes++;
        if (st === "turned_away") c.turnedAways++;
      }
      // Owed-a-disposition (and whether it's been dispositioned), by due date.
      // A "reschedule" / "no_show" / any non-"scheduled" outcome counts as done.
      if (dueInWindow) {
        c.due++; c.ended++;
        if (st !== "scheduled") { c.dispositioned++; c.endedDispo++; }
      }
    }
  }
  return { setters, closers };
}

// Start-of-period (ms) for the appointment boards — Monday-based week to match
// the rest of the app; all-time = 0.
function apptPeriodStart(view: string): number {
  if (view === "day") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (view === "month") return rStartOfMonth();
  if (view === "year") return new Date(new Date().getFullYear(), 0, 1).getTime();
  if (view === "alltime") return 0;
  return rStartOfWeek();
}

// Separate leaderboards for setters and closers, so a setter sees where they
// stack up against other setters and a closer against other closers. Appointment
// metrics come from the events (authoritative); doors is a shift metric kept
// from the season bucket. Company-wide: any rep sees the whole company's board
// for their lane. Also returns apptTops — the company appointments-set top 3.
export const roleLeaderboards = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = caller.companyId;
  if (!companyId) throw new HttpsError("permission-denied", "No company.");
  const view = ((request.data as { view?: string } | undefined)?.view || "week") as string;
  const kind = view === "month" || view === "year" ? view : "week";

  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const meta: Record<string, { name: string; isCloser: boolean; disabled: boolean }> = {};
  usersSnap.forEach((d) => {
    const u = d.data() as any;
    meta[d.id] = { name: u.displayName || u.email || "Rep", isCloser: u.isCloser === true, disabled: u.disabled === true };
  });

  const { setters: sm, closers: cm } = await computeApptMetrics(companyId, apptPeriodStart(view));

  // Doors isn't appointment-derived — keep it from the season/all-time buckets
  // for the setter board's secondary column.
  const doorsByUid: Record<string, number> = {};
  if (view === "alltime") {
    (await db.collection("userStats").where("companyId", "==", companyId).get())
      .forEach((d) => { const s = d.data() as any; if (s.uid) doorsByUid[s.uid] = Number(s.doorsKnocked) || 0; });
  } else {
    (await db.collection("seasonStats").where("companyId", "==", companyId).where("period", "==", rPeriodKey(kind)).get())
      .forEach((d) => { const s = d.data() as any; if (s.kind === kind && s.uid) doorsByUid[s.uid] = Number(s.doorsKnocked) || 0; });
  }

  const rate = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : null);
  const setters: any[] = [];
  const closers: any[] = [];
  const apptTops: { uid: string; name: string; value: number }[] = [];
  for (const [uid, m] of Object.entries(meta)) {
    if (m.disabled) continue; // only current, active reps
    const s = sm[uid];
    const c = cm[uid];
    if (s && s.appts > 0) apptTops.push({ uid, name: m.name, value: s.appts });
    if (m.isCloser) {
      const appts = c?.appts || 0, sits = c?.sits || 0, closes = c?.closes || 0;
      if (appts + sits + closes === 0) continue;
      closers.push({ uid, name: m.name, appts, sits, closes, turnedAways: c?.turnedAways || 0, closeRate: rate(closes, sits) });
    } else {
      const appts = s?.appts || 0, sits = s?.sits || 0, pitched = s?.pitched || 0, doors = doorsByUid[uid] || 0;
      if (appts + sits + doors === 0) continue;
      setters.push({ uid, name: m.name, doors, appts, sits, pitchedAppts: pitched, sitRate: rate(sits, pitched) });
    }
  }
  // Setters ranked by real productive output (sits, then appts, then doors);
  // closers by closes, then sits, then close rate.
  setters.sort((a, b) => b.sits - a.sits || b.appts - a.appts || b.doors - a.doors);
  closers.sort((a, b) => b.closes - a.closes || b.sits - a.sits || (b.closeRate ?? -1) - (a.closeRate ?? -1));
  apptTops.sort((a, b) => b.value - a.value);
  return { setters: setters.slice(0, 50), closers: closers.slice(0, 50), apptTops: apptTops.slice(0, 3) };
});

// getCompanyRollup — aggregated setter + closer results for the caller's scope,
// returned as a Company → Regions → Teams → Users tree with sit% and close% at
// every level. Admins/super see the whole company; a manager sees only their
// downline (setter and closer chains). Drives the field Town Hall card and the
// drill-down report. Metrics are event-based (computeApptMetrics), doors come
// from the stats buckets — the same sources as the leaderboards.
// Shared rollup builder — used by the getCompanyRollup callable AND the weekly /
// on-demand report emails, so the emailed numbers match the console exactly.
// scopeUid === null → the whole company; a uid → only that manager's downline.
export async function computeRollup(companyId: string, view: string, scopeUid: string | null, range?: { startMs: number; endMs: number }): Promise<{ period: string; scopedToDownline: boolean; company: any }> {
  const kind = view === "month" || view === "year" ? view : "week";
  // range overrides the view's window (used by on-demand emails: previous day,
  // week-to-date, month-to-date). endMs is exclusive.
  const startMs = range ? range.startMs : apptPeriodStart(view);
  const endMs = range ? range.endMs : Number.MAX_SAFE_INTEGER;
  const isAllTime = view === "alltime" && !range;

  // Active users, scoped to the given manager's downline (or all).
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const seeAll = scopeUid === null;
  type U = { uid: string; name: string; isCloser: boolean; isSetter: boolean; teamId: string | null };
  const users: U[] = [];
  usersSnap.forEach((d) => {
    const u = d.data() as any;
    if (u.disabled === true) return;
    const inDownline = seeAll
      || d.id === scopeUid
      || (Array.isArray(u.managerPath) && u.managerPath.includes(scopeUid as string))
      || (Array.isArray(u.closerManagerPath) && u.closerManagerPath.includes(scopeUid as string));
    if (!inDownline) return;
    // isSetter/isCloser are the explicit lane flags (kept in sync with position);
    // default isSetter true for legacy docs that predate the flag.
    users.push({ uid: d.id, name: u.displayName || u.email || "Rep", isCloser: u.isCloser === true, isSetter: u.isSetter !== false, teamId: (u.teamId as string) || null });
  });

  // Per-user setter/closer metrics (event-based) + doors from the stats buckets.
  const { setters: sm, closers: cm } = await computeApptMetrics(companyId, startMs, endMs);
  // Doors: live count of leads knocked in the window (attributed to the rep who
  // owns the door), so "today" reflects the day's activity — the same
  // leads-based counting the admin Town Hall uses. All-time uses the lifetime
  // door counter instead of scanning every lead ever.
  // A "conversation" = a door that turned into a real interaction (matches the
  // rest of the app). Recorded-pitch coverage is measured against THIS, not
  // against appointment sits.
  const ROLLUP_CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
  const doorsByUid: Record<string, number> = {};
  const convosByUid: Record<string, number> = {};
  if (isAllTime) {
    (await db.collection("userStats").where("companyId", "==", companyId).get())
      .forEach((d) => {
        const s = d.data() as any; if (!s.uid) return;
        doorsByUid[s.uid] = Number(s.doorsKnocked) || 0;
        // leadsCreated is the lifetime "conversations" counter the app already keeps.
        convosByUid[s.uid] = Number(s.leadsCreated) || 0;
      });
  } else {
    try {
      const leadsSnap = await db.collection("leads")
        .where("companyId", "==", companyId).where("knockedAt", ">=", startMs).get();
      leadsSnap.forEach((d) => {
        const l = d.data() as any;
        if (l.deleted) return;
        if ((Number(l.knockedAt) || 0) >= endMs) return; // upper bound for a fixed window
        const uid = (l.assignedTo as string) || (l.createdBy as string);
        if (!uid) return;
        doorsByUid[uid] = (doorsByUid[uid] || 0) + 1;
        if (l.verified !== false && ROLLUP_CONVO.has(l.status)) convosByUid[uid] = (convosByUid[uid] || 0) + 1;
      });
    } catch (e) {
      // Missing composite index → fall back to the season buckets (weekly/monthly
      // only; a daily view just shows appt-derived metrics until the index builds).
      logger.warn("rollup doors: knockedAt query failed, falling back to season stats", e);
      if (view !== "day" && !range) {
        (await db.collection("seasonStats").where("companyId", "==", companyId).where("period", "==", rPeriodKey(kind)).get())
          .forEach((d) => {
            const s = d.data() as any; if (!(s.kind === kind && s.uid)) return;
            doorsByUid[s.uid] = Number(s.doorsKnocked) || 0;
            convosByUid[s.uid] = Number(s.leadsCreated) || 0;
          });
      }
    }
  }

  // Recorded pitches per rep for the window — only real customer pitches recorded
  // AT the home, GPS-confirmed inside the on-site geofence (atLocation). Practice /
  // certification role-plays and off-location recordings are excluded, so
  // "% recorded" reflects actual field conversations captured for coaching.
  const recordedByUid: Record<string, number> = {};
  try {
    const pitchSnap = await db.collection("pitches").where("companyId", "==", companyId).get();
    pitchSnap.forEach((d) => {
      const p = d.data() as any;
      if ((p.kind || "door") !== "door") return;       // no practice pitches
      if (p.atLocation !== true) return;                // must be GPS-verified at the home
      const pc = Number(p.createdAt) || 0;
      if ((startMs > 0 && pc < startMs) || pc >= endMs) return;
      if (p.uid) recordedByUid[p.uid] = (recordedByUid[p.uid] || 0) + 1;
    });
  } catch (e) {
    logger.warn("rollup: pitches query failed", e);
  }

  // Field time (hours on shift) per rep in the window — the honest activity input
  // (doors-per-hour vary by rep, so hours on the doors is what we coach to).
  const shiftMsByUid: Record<string, number> = {};
  try {
    const now = Date.now();
    (await db.collection("shifts").where("companyId", "==", companyId).get()).forEach((d) => {
      const s = d.data() as any;
      const st = Number(s.startAt) || 0;
      if (!st || (startMs > 0 && st < startMs) || st >= endMs) return;
      const uid = (s.userId as string) || (s.uid as string);
      if (!uid) return;
      // Clamp the shift's end to the window so a fixed range (e.g. yesterday)
      // doesn't count hours spilling past it.
      shiftMsByUid[uid] = (shiftMsByUid[uid] || 0) + Math.max(0, Math.min(Number(s.endAt) || now, endMs) - st);
    });
  } catch (e) {
    logger.warn("rollup: shifts query failed", e);
  }

  // Teams + regions (a region is a team with kind==="region"; a team joins a
  // region via parentTeamId).
  const teamsSnap = await db.collection(`companies/${companyId}/teams`).get();
  const regionName: Record<string, string> = {};
  teamsSnap.forEach((t) => { const d = t.data() as any; if (d.kind === "region") regionName[t.id] = d.name || "Region"; });
  const teamMeta: Record<string, { name: string; regionId: string | null; logoUrl: string | null }> = {};
  teamsSnap.forEach((t) => {
    const d = t.data() as any;
    if (d.kind === "region") return;
    const parent = (d.parentTeamId as string) || null;
    teamMeta[t.id] = { name: d.name || "Team", regionId: parent && regionName[parent] ? parent : null, logoUrl: (d.logoUrl as string) || null };
  });

  const blank = () => ({ doors: 0, convos: 0, recorded: 0, shiftMs: 0, setterAppts: 0, setterSits: 0, setterPitched: 0, setterNoShows: 0, setterUpcoming: 0, setterUndispositioned: 0, setterOther: 0, closerAppts: 0, closerSits: 0, closes: 0, turnedAways: 0, closerDue: 0, closerDispositioned: 0, closerEnded: 0, closerEndedDispositioned: 0, reps: 0, closerReps: 0 });
  type M = ReturnType<typeof blank>;
  const add = (a: M, u: U) => {
    const s = sm[u.uid]; const c = cm[u.uid];
    a.doors += doorsByUid[u.uid] || 0;
    a.convos += convosByUid[u.uid] || 0;
    a.recorded += recordedByUid[u.uid] || 0;
    a.shiftMs += shiftMsByUid[u.uid] || 0;
    a.setterAppts += s?.appts || 0; a.setterSits += s?.sits || 0; a.setterPitched += s?.pitched || 0;
    a.setterNoShows += s?.noShow || 0; a.setterUpcoming += s?.upcoming || 0; a.setterUndispositioned += s?.undispositioned || 0; a.setterOther += s?.other || 0;
    a.closerAppts += c?.appts || 0; a.closerSits += c?.sits || 0; a.closes += c?.closes || 0; a.turnedAways += c?.turnedAways || 0;
    a.closerDue += c?.due || 0; a.closerDispositioned += c?.dispositioned || 0;
    a.closerEnded += c?.ended || 0; a.closerEndedDispositioned += c?.endedDispo || 0;
    a.reps += 1; if (u.isCloser) a.closerReps += 1;
  };
  const rate = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : null);
  const node = (m: M, name: string, type: string, id: string | null, extra?: Record<string, unknown>) => ({
    type, id, name, ...m,
    // Sit rate = sits ÷ ALL appointments set (the true, complete conversion). The
    // appointment breakdown (noShows / upcoming / undispositioned / other) accounts
    // for every set appointment, so nothing hides in a small denominator.
    sitRate: rate(m.setterSits, m.setterAppts),
    noShows: m.setterNoShows,
    closeRate: rate(m.closes, m.closerSits),
    dispoRate: rate(m.closerDispositioned, m.closerDue), // % of due appts the closer dispositioned
    endDispoRate: rate(m.closerEndedDispositioned, m.closerEnded), // % of ENDED appts dispositioned
    recRate: rate(m.recorded, m.convos), // % of door conversations that were recorded
    fieldHours: Math.round((m.shiftMs / 3600000) * 10) / 10, // hours in the field this period
    ...extra,
  });
  const sumOf = (arr: U[]) => { const m = blank(); for (const u of arr) add(m, u); return m; };

  // Group users → team → region.
  const usersByTeam: Record<string, U[]> = {};
  const noTeam: U[] = [];
  for (const u of users) {
    if (u.teamId && teamMeta[u.teamId]) (usersByTeam[u.teamId] ??= []).push(u);
    else noTeam.push(u);
  }
  const teamsByRegion: Record<string, string[]> = {};
  const noRegionTeams: string[] = [];
  for (const tid of Object.keys(usersByTeam)) {
    const rid = teamMeta[tid].regionId;
    if (rid) (teamsByRegion[rid] ??= []).push(tid);
    else noRegionTeams.push(tid);
  }
  const buildUser = (u: U) => node(sumOf([u]), u.name, "user", u.uid, { isCloser: u.isCloser, isSetter: u.isSetter });
  const byClose = (a: { closes: number; setterSits: number }, b: { closes: number; setterSits: number }) => b.closes - a.closes || b.setterSits - a.setterSits;
  const buildTeam = (tid: string, name: string, roster: U[]) =>
    node(sumOf(roster), name, "team", tid, { users: roster.map(buildUser).sort(byClose), logoUrl: teamMeta[tid]?.logoUrl || null });

  const regions: unknown[] = [];
  for (const rid of Object.keys(teamsByRegion)) {
    const teamNodes = teamsByRegion[rid].map((tid) => buildTeam(tid, teamMeta[tid].name, usersByTeam[tid])).sort(byClose);
    const roster = teamsByRegion[rid].flatMap((tid) => usersByTeam[tid]);
    regions.push(node(sumOf(roster), regionName[rid] || "Region", "region", rid, { teams: teamNodes }));
  }
  if (noRegionTeams.length) {
    const teamNodes = noRegionTeams.map((tid) => buildTeam(tid, teamMeta[tid].name, usersByTeam[tid])).sort(byClose);
    const roster = noRegionTeams.flatMap((tid) => usersByTeam[tid]);
    regions.push(node(sumOf(roster), "Teams (no region)", "region", "__noregion", { teams: teamNodes }));
  }
  if (noTeam.length) {
    const team = node(sumOf(noTeam), "Unassigned", "team", "__noteam", { users: noTeam.map(buildUser).sort(byClose) });
    regions.push(node(sumOf(noTeam), "Unassigned", "region", "__unassigned", { teams: [team] }));
  }
  (regions as { closes: number; setterSits: number }[]).sort(byClose);

  const companyDoc = (await db.doc(`companies/${companyId}`).get()).data() || {};
  const companyName = companyDoc.name || "Company";
  const company = node(sumOf(users), companyName, "company", companyId, { regions, logoUrl: (companyDoc.logoUrl as string) || null });
  return { period: view, scopedToDownline: !seeAll, company };
}

// getCompanyRollup — the callable wrapper around computeRollup (auth + scoping).
export const getCompanyRollup = onCall(async (request) => {
  const caller = await getCaller(request);
  const reqData = (request.data || {}) as { period?: string; companyId?: string; range?: { startMs?: number; endMs?: number } };
  // Super-admins may target any company (drill-down from the console). Everyone
  // else is locked to their own company.
  const companyId = caller.isSuper && reqData.companyId ? reqData.companyId : caller.companyId;
  if (!companyId) throw new HttpsError("permission-denied", "No company.");
  if (!(caller.isSuper || caller.role === "admin" || caller.role === "manager")) {
    throw new HttpsError("permission-denied", "Managers and admins only.");
  }
  const view = (reqData.period || "week") as string;
  const seeAll = caller.isSuper || caller.role === "admin";
  // Custom date range (from the report's calendar picker): a bounded window that
  // overrides the view's default period. endMs is exclusive.
  let range: { startMs: number; endMs: number } | undefined;
  const rs = Number(reqData.range?.startMs), re = Number(reqData.range?.endMs);
  if (Number.isFinite(rs) && Number.isFinite(re) && re > rs) range = { startMs: rs, endMs: re };
  return computeRollup(companyId, view, seeAll ? null : caller.uid, range);
});

// ════════════════════════════════════════════════════════════════════════════
// SUCCESS REPORT EMAILS — the drill-down report, emailed. On-demand (to the
// company admins) and an automated Saturday-night send to admins (company),
// managers (their team + their reps) and reps (their own). Mirrors the console's
// Production Score + coaching recap exactly (shared computeRollup), with the
// field-time coaching tone.
// ════════════════════════════════════════════════════════════════════════════
const RREP_TARGETS = { doorsWk: 100, setsWk: 8, closesWk: 2 };
const RREP_GOALS = { sit: 50, close: 30, rec: 80, dispo: 90 };
const RREP_MULT: Record<string, number> = { day: 1 / 7, week: 1, month: 4.3, year: 52, alltime: 52 };
const RREP_LEVEL_WORD: Record<string, string> = { company: "company", region: "regional", team: "team", rep: "1:1" };

function rrepPureCloser(m: any): boolean {
  return m.type === "user" && m.isCloser && !((m.doors || 0) > 0 || (m.setterAppts || 0) > 0);
}
function rrepScore(m: any, period: string): number | null {
  const mult = RREP_MULT[period] || 1;
  const parts: [number, number][] = [];
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const add = (v: number | null, w: number) => { if (v != null && isFinite(v)) parts.push([clamp(v), w]); };
  const attain = (actual: number, perRep: number, reps: number) => { const t = reps * perRep * mult; return t > 0 ? (actual / t) * 100 : null; };
  const hasCloseLane = m.type !== "user" || (m.closerAppts || 0) > 0 || (m.closes || 0) > 0 || m.isCloser;
  if (!rrepPureCloser(m)) {
    add(attain(m.doors, RREP_TARGETS.doorsWk, m.reps), 15);
    add(attain(m.setterAppts, RREP_TARGETS.setsWk, m.reps), 15);
  }
  add(m.sitRate != null ? (m.sitRate / RREP_GOALS.sit) * 100 : null, 15);
  add(m.closeRate != null ? (m.closeRate / RREP_GOALS.close) * 100 : null, 25);
  if (hasCloseLane) add(attain(m.closes, RREP_TARGETS.closesWk, m.closerReps || m.reps), 15);
  add(m.dispoRate != null ? (m.dispoRate / RREP_GOALS.dispo) * 100 : null, 10);
  add(m.recRate != null ? (m.recRate / RREP_GOALS.rec) * 100 : null, 10);
  if (!parts.length) return null;
  const wsum = parts.reduce((a, p) => a + p[1], 0);
  return Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / wsum);
}
function rrepGrade(s: number | null): { label: string; word: string; color: string } {
  if (s == null) return { label: "No data", word: "Not enough activity this period to score.", color: "#64748B" };
  if (s >= 85) return { label: "A · Elite", word: "Top-tier production.", color: "#22C55E" };
  if (s >= 70) return { label: "B · Strong", word: "Solid production with a couple of levers to pull.", color: "#84CC78" };
  if (s >= 55) return { label: "C · Building", word: "Producing, but with real gaps to close.", color: "#F59E0B" };
  return { label: "D · Needs a plan", word: "Underproducing — this needs a game plan now.", color: "#F87171" };
}
function rrepIdle(node: any): number {
  if (node.type === "user") return (!(node.doors || 0) && !(node.setterAppts || 0) && !(node.closerAppts || 0) && !(node.closes || 0)) ? 1 : 0;
  const kids = node.regions || node.teams || node.users || [];
  return kids.reduce((a: number, k: any) => a + rrepIdle(k), 0);
}
// The coaching recap — a faithful server port of the console's engine, same
// field-time tone (manage to hours in the field, not a door quota).
function rrepRecap(m: any, level: string, period: string, plabel: string): { strengths: string[]; gaps: string[]; agenda: string[] } {
  const strengths: string[] = [], gaps: string[] = [], agenda: string[] = [];
  const isUser = level === "rep";
  const mult = RREP_MULT[period] || 1;
  if (!rrepPureCloser(m)) {
    const dScore = m.reps ? (m.doors / (m.reps * RREP_TARGETS.doorsWk * mult)) * 100 : null;
    if (dScore != null) {
      if (dScore >= 90) strengths.push(`Field activity is strong — ${Math.round(dScore)}% of target (${(m.doors || 0).toLocaleString()} doors, ${m.fieldHours || 0}h in the field). The hours are being put in, and that's exactly why there's anything in the pipeline.`);
      else if (dScore < 60) { gaps.push(`Not enough time in the field — activity is at ${Math.round(dScore)}% of target (${(m.doors || 0).toLocaleString()} doors, ${m.fieldHours || 0}h). Here's the reality: this isn't a door-quota problem, because everyone's doors-per-hour is different. It's an hours-on-the-doors problem. Nothing downstream can grow while the top of the funnel is starved of time.`); agenda.push("Manage to TIME in the field, not a door count. Set a weekly field-hours expectation per rep and track it live — hours on the doors is the one input that reliably grows everything else."); }
    }
    const sScore = m.reps ? (m.setterAppts / (m.reps * RREP_TARGETS.setsWk * mult)) * 100 : null;
    if (sScore != null && sScore < 60) { gaps.push(`Appointments set are low — ${Math.round(sScore)}% of target (${m.setterAppts} booked). The conversations are happening but the ask at the door isn't landing.`); agenda.push("Sharpen the door pitch and the ask — role-play the transition from conversation to booked appointment until it's automatic."); }
    else if (sScore != null && sScore >= 90) strengths.push(`Setting engine is humming — ${m.setterAppts} appointments booked, ${Math.round(sScore)}% of target.`);
  }
  if (m.sitRate != null) {
    if (m.sitRate >= RREP_GOALS.sit) strengths.push(`Sit rate is ${m.sitRate}% — at or above the ${RREP_GOALS.sit}% goal (${m.setterSits} sat of ${m.setterAppts} set).`);
    else if (m.sitRate < RREP_GOALS.sit * 0.8) { gaps.push(`Sit rate is ${m.sitRate}% — only ${m.setterSits} of ${m.setterAppts} set appointments sat. Heavy fallout between set and sit (no-shows, cancels, reschedules).`); agenda.push("Drill confirm-and-remind cadence and set quality: right person, right time, all decision-makers present, tight time window."); }
  }
  if ((m.setterUndispositioned || 0) > 0 && (m.setterAppts || 0) > 0 && (m.setterUndispositioned / m.setterAppts) >= 0.2) {
    gaps.push(`${m.setterUndispositioned} of ${m.setterAppts} set appointments are past-due with no recorded outcome — the real sit rate can't be trusted until they're dispositioned.`);
    agenda.push("Close out every past-due appointment: the undispositioned pile is hiding the team's true results.");
  }
  if (m.closeRate != null) {
    if (m.closeRate >= RREP_GOALS.close) strengths.push(`Close rate is ${m.closeRate}% — beating the ${RREP_GOALS.close}% goal (${m.closes} of ${m.closerSits} sits).`);
    else if (m.closeRate < RREP_GOALS.close * 0.8) { gaps.push(`Close rate is ${m.closeRate}% vs the ${RREP_GOALS.close}% goal — sits aren't converting. Presentation / objection-handling gap.`); agenda.push("Ride-along or role-play the close; review objection handling on every sat-but-not-closed deal."); }
  }
  if (m.dispoRate != null) {
    const undone = (m.closerDue || 0) - (m.closerDispositioned || 0);
    if (m.dispoRate >= RREP_GOALS.dispo) strengths.push(`Disposition rate is ${m.dispoRate}% — appointments get closed out promptly, so setters see real outcomes.`);
    else { gaps.push(`Disposition rate is ${m.dispoRate}% (goal ${RREP_GOALS.dispo}%+): ${undone} of ${m.closerDue || 0} due appointments were never marked. Below 90% the team's production is understated, and setters get demotivated when they never learn what happened to the appointments they set.`); agenda.push("Require every appointment to be dispositioned same-day — make it a daily accountability."); }
  }
  if (m.closerSits > 4 && m.turnedAways / m.closerSits > 0.25) { gaps.push(`Turn-away rate is high (${Math.round((m.turnedAways / m.closerSits) * 100)}% of sits) — unqualified appointments are being run.`); agenda.push("Tighten qualification at the set so closers spend time on real opportunities."); }
  if (m.recRate != null) {
    if (m.recRate >= RREP_GOALS.rec) strengths.push(`${m.recRate}% of on-site conversations are recorded — great coaching visibility.`);
    else { gaps.push(`Only ${m.recRate}% of on-site conversations are recorded (goal ${RREP_GOALS.rec}%; ${m.recorded || 0} of ${m.convos || 0}). Coaching is blind without the tape.`); agenda.push("Make at-the-door pitch recording non-negotiable and review one recorded pitch per rep each week."); }
  } else if (!rrepPureCloser(m) && (m.convos || 0) > 0) {
    gaps.push(`None of ${m.convos} on-site conversations were recorded ${plabel} — nothing to coach from the tape.`);
    agenda.push("Turn on and enforce at-the-door pitch recording so real conversations can be reviewed.");
  }
  if (!isUser && m.reps > 1 && (m.idleReps || 0) > 0) {
    gaps.push(`${m.idleReps} of ${m.reps} reps produced nothing ${plabel} — zero doors, sets, appointments or closes. They're on the roster but not in the field, dragging the team's numbers down.`);
    agenda.push(`Have the direct conversation with the ${m.idleReps} non-producing rep${m.idleReps > 1 ? "s" : ""}: a real activity plan with a field-hours commitment, a ride-along, or a decision about fit.`);
  }
  return { strengths, gaps, agenda };
}

const rrepEsc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const rrepPct = (v: number | null | undefined) => (v == null ? "—" : v + "%");

// Full HTML email for one node (company / team / rep).
function rrepReportHtml(node: any, level: string, period: string, plabel: string, companyName: string): string {
  node.idleReps = rrepIdle(node);
  const score = rrepScore(node, period);
  const g = rrepGrade(score);
  const r = rrepRecap(node, level, period, plabel);
  const li = (arr: string[], ic: string) => arr.length ? `<ul style="margin:4px 0 0;padding-left:18px;color:#334155;">${arr.map((x) => `<li style="margin:6px 0;">${ic} ${rrepEsc(x)}</li>`).join("")}</ul>` : `<p style="margin:4px 0 0;color:#64748B;">Nothing flagged.</p>`;
  const agenda = r.agenda.length ? r.agenda : ["Recognize the wins publicly and have top performers share exactly what's working so it spreads."];
  const metric = (label: string, val: string, sub?: string) =>
    `<td style="padding:8px 10px;border:1px solid #e2e8f0;vertical-align:top;"><div style="font:700 16px system-ui;color:#0f1727;">${val}</div><div style="font:11px system-ui;color:#64748B;text-transform:uppercase;letter-spacing:.3px;">${label}</div>${sub ? `<div style="font:11px system-ui;color:#94a3b8;">${sub}</div>` : ""}</td>`;
  const setterRow = `<tr>${metric("Field hours", String(node.fieldHours || 0))}${metric("Doors", (node.doors || 0).toLocaleString())}${metric("Appts set", String(node.setterAppts || 0))}${metric("Sat", String(node.setterSits || 0))}${metric("Sit rate", rrepPct(node.sitRate), "goal 50%")}</tr>`;
  const closerRow = `<tr>${metric("Appts (for/by)", String(node.closerAppts || 0))}${metric("Closes", String(node.closes || 0))}${metric("Close rate", rrepPct(node.closeRate), "goal 30%")}${metric("Disposition", rrepPct(node.dispoRate), "goal 90%")}${metric("% recorded", rrepPct(node.recRate), "goal 80%")}</tr>`;
  // Child summary table (teams under a company/region; reps under a team).
  const kids = (node.regions || node.teams || node.users || []) as any[];
  let childTable = "";
  if (kids.length) {
    const rows = kids.map((k) => {
      const ks = rrepScore(k, period);
      const kg = rrepGrade(ks);
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;">${rrepEsc(k.name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:center;"><span style="display:inline-block;min-width:30px;padding:2px 6px;border-radius:6px;background:${kg.color};color:#fff;font:700 12px system-ui;">${ks == null ? "—" : ks}</span></td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:center;">${k.fieldHours || 0}h</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:center;">${(k.doors || 0).toLocaleString()}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:center;">${k.setterAppts || 0}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:center;">${rrepPct(k.sitRate)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:center;">${k.closes || 0}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:center;">${rrepPct(k.closeRate)}</td>
      </tr>`;
    }).join("");
    const kLabel = node.regions ? "Region" : node.teams ? "Team" : "Rep";
    childTable = `<h3 style="font:700 14px system-ui;color:#0f1727;margin:22px 0 6px;">${kLabel} breakdown</h3>
      <table style="border-collapse:collapse;width:100%;font:13px system-ui;">
        <thead><tr style="color:#64748B;text-transform:uppercase;font-size:11px;">
          <th style="text-align:left;padding:6px 10px;">${kLabel}</th><th style="padding:6px 10px;">Score</th><th style="padding:6px 10px;">Hours</th><th style="padding:6px 10px;">Doors</th><th style="padding:6px 10px;">Appts</th><th style="padding:6px 10px;">Sit%</th><th style="padding:6px 10px;">Closes</th><th style="padding:6px 10px;">Close%</th>
        </tr></thead><tbody>${rows}</tbody></table>`;
  }
  const title = level === "company" ? rrepEsc(companyName)
    : level === "rep" ? rrepEsc(node.name)
    : rrepEsc(node.name);
  const sub = level === "company" ? "Company report" : level === "rep" ? "Your report" : "Team report";
  return `<div style="max-width:680px;margin:0 auto;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f1727;">
    <div style="padding:18px 20px;background:#0f1727;border-radius:14px 14px 0 0;color:#fff;">
      <div style="font:12px system-ui;color:#93c5fd;text-transform:uppercase;letter-spacing:.6px;">${sub} · ${rrepEsc(plabel)}</div>
      <div style="font:800 22px system-ui;margin-top:2px;">${title}</div>
      <div style="margin-top:8px;display:inline-block;padding:4px 12px;border-radius:999px;background:${g.color};color:#06121f;font:800 14px system-ui;">Production Score ${score == null ? "—" : score} · ${g.label}</div>
      <div style="font:13px system-ui;color:#cbd5e1;margin-top:8px;">${g.word} · ${node.reps || 0} active rep${(node.reps || 0) === 1 ? "" : "s"}${node.idleReps ? ` · ${node.idleReps} not producing` : ""}</div>
    </div>
    <div style="padding:18px 20px;background:#fff;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;">
      <h3 style="font:700 13px system-ui;color:#16a34a;margin:0 0 2px;text-transform:uppercase;">✅ What's working</h3>${li(r.strengths, "✅")}
      <h3 style="font:700 13px system-ui;color:#b45309;margin:18px 0 2px;text-transform:uppercase;">⚠️ What's missing</h3>${li(r.gaps, "⚠️")}
      <h3 style="font:700 13px system-ui;color:#334155;margin:18px 0 2px;text-transform:uppercase;">📋 Turn this into a ${RREP_LEVEL_WORD[level]} meeting</h3>${li(agenda, "→")}
      <h3 style="font:700 14px system-ui;color:#0f1727;margin:22px 0 6px;">The numbers</h3>
      <table style="border-collapse:collapse;width:100%;"><tbody>${setterRow}${closerRow}</tbody></table>
      ${childTable}
      <p style="font:12px system-ui;color:#94a3b8;margin:22px 0 0;">Open the full drill-down in the admin console → Success Reports.</p>
    </div>
  </div>`;
}
function rrepReportText(node: any, level: string, period: string, plabel: string, companyName: string): string {
  const score = rrepScore(node, period);
  const r = rrepRecap(node, level, period, plabel);
  const name = level === "company" ? companyName : node.name;
  const lines = [`${name} — ${plabel} — Production Score ${score == null ? "—" : score}`, ""];
  if (r.strengths.length) { lines.push("WORKING:"); r.strengths.forEach((s) => lines.push(" - " + s)); lines.push(""); }
  lines.push("MISSING:"); r.gaps.forEach((s) => lines.push(" - " + s)); lines.push("");
  lines.push("MEETING:"); (r.agenda.length ? r.agenda : ["Recognize the wins and have top performers share what's working."]).forEach((s) => lines.push(" - " + s));
  return lines.join("\n");
}

// Walk a computed rollup tree, collecting the company node + team nodes (by id) +
// user nodes (by uid) so we can route each to the right recipients.
function rrepIndex(company: any): { company: any; teams: Record<string, any>; users: Record<string, any> } {
  const teams: Record<string, any> = {};
  const users: Record<string, any> = {};
  (company.regions || []).forEach((region: any) => {
    (region.teams || []).forEach((team: any) => {
      if (team.id) teams[team.id] = team;
      (team.users || []).forEach((u: any) => { if (u.id) users[u.id] = u; });
    });
  });
  return { company, teams, users };
}

// Send one company's full Saturday report set: admins → company; managers →
// their team(s) + their reps; reps → their own. Returns how many emails went out.
async function sendCompanyReports(cfg: NotifyConfig, companyId: string, view: string, plabel: string, audience: string = "all", range?: { startMs: number; endMs: number }): Promise<number> {
  const rollup = await computeRollup(companyId, view, null, range);
  const companyName = rollup.company.name || "Company";
  const idx = rrepIndex(rollup.company);

  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  type U = { uid: string; email: string; role: string; position: string; teamId: string | null; managedTeamIds: string[]; disabled: boolean };
  const roster: U[] = usersSnap.docs.map((d) => {
    const u = d.data() as any;
    return { uid: d.id, email: (u.email as string) || "", role: (u.role as string) || "user", position: (u.position as string) || "", teamId: (u.teamId as string) || null, managedTeamIds: Array.isArray(u.managedTeamIds) ? u.managedTeamIds : [], disabled: u.disabled === true };
  }).filter((u) => !u.disabled && u.email);

  let sent = 0;
  const send = async (to: string, subject: string, node: any, level: string) => {
    const html = rrepReportHtml(node, level, view, plabel, companyName);
    const text = rrepReportText(node, level, view, plabel, companyName);
    const res = await sendEmailDetailed(cfg, to, subject, text, undefined, html).catch(() => ({ ok: false, detail: "" }));
    if (res.ok) sent++;
  };
  const per = plabel;

  for (const u of roster) {
    const isAdmin = u.role === "admin" || u.role === "superadmin";
    const isManager = u.role === "manager" || u.managedTeamIds.length > 0 || u.position.includes("manager");
    if (isAdmin) {
      if (audience === "all" || audience === "admins")
        await send(u.email, `📊 ${companyName} — company report (${per})`, idx.company, "company");
    } else if (isManager) {
      if (audience === "all" || audience === "managers") {
        const teamIds = u.managedTeamIds.length ? u.managedTeamIds : (u.teamId ? [u.teamId] : []);
        for (const tid of teamIds) { const t = idx.teams[tid]; if (t) await send(u.email, `📊 ${t.name} — team report (${per})`, t, "team"); }
      }
    } else {
      if (audience === "all" || audience === "reps") {
        const un = idx.users[u.uid];
        if (un) await send(u.email, `📊 Your report (${per})`, un, "rep");
      }
    }
  }
  return sent;
}

// Send a single team's report: to the caller (test), the team's manager(s),
// and/or each rep on the team (their own). Returns how many emails went out.
async function sendTeamReport(cfg: NotifyConfig, companyId: string, view: string, plabel: string, teamId: string, audience: string, range: { startMs: number; endMs: number } | undefined, callerUid: string): Promise<number> {
  const rollup = await computeRollup(companyId, view, null, range);
  const companyName = rollup.company.name || "Company";
  const idx = rrepIndex(rollup.company);
  const team = idx.teams[teamId];
  if (!team) throw new HttpsError("not-found", "That team wasn't found in the current rollup.");

  let sent = 0;
  const send = async (to: string, subject: string, node: any, level: string) => {
    const html = rrepReportHtml(node, level, view, plabel, companyName);
    const text = rrepReportText(node, level, view, plabel, companyName);
    const res = await sendEmailDetailed(cfg, to, subject, text, undefined, html).catch(() => ({ ok: false, detail: "" }));
    if (res.ok) sent++;
  };

  if (audience === "me") {
    const email = ((await db.doc(`users/${callerUid}`).get()).data()?.email as string) || "";
    if (!email) throw new HttpsError("failed-precondition", "Your account has no email address.");
    await send(email, `📊 ${team.name} — team report (${plabel})`, team, "team");
    return sent;
  }

  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const roster = usersSnap.docs.map((d) => {
    const u = d.data() as any;
    return { uid: d.id, email: (u.email as string) || "", role: (u.role as string) || "user", position: (u.position as string) || "", teamId: (u.teamId as string) || null, managedTeamIds: Array.isArray(u.managedTeamIds) ? u.managedTeamIds : [], disabled: u.disabled === true };
  }).filter((u) => !u.disabled && u.email);

  for (const u of roster) {
    const isAdmin = u.role === "admin" || u.role === "superadmin";
    const managesTeam = u.managedTeamIds.includes(teamId) || (u.teamId === teamId && (u.role === "manager" || u.position.includes("manager")));
    if (audience === "admins" && isAdmin) {
      await send(u.email, `📊 ${team.name} — team report (${plabel})`, team, "team");
    } else if (managesTeam) {
      if (audience === "all" || audience === "managers") await send(u.email, `📊 ${team.name} — team report (${plabel})`, team, "team");
    } else if (u.teamId === teamId) {
      if (audience === "all" || audience === "reps") { const un = idx.users[u.uid]; if (un) await send(u.email, `📊 Your report (${plabel})`, un, "rep"); }
    }
  }
  return sent;
}

// Maps a chooseable period to a rollup window: previous day (bounded), or an
// open-ended today / week-to-date / month-to-date / year / all-time.
function reportWindow(period: string): { view: string; plabel: string; range?: { startMs: number; endMs: number } } {
  const d = new Date(); d.setHours(0, 0, 0, 0); const startToday = d.getTime();
  switch (period) {
    case "today": return { view: "day", plabel: "today" };
    case "yesterday": return { view: "day", plabel: "yesterday", range: { startMs: startToday - 86400000, endMs: startToday } };
    case "week": return { view: "week", plabel: "week to date" };
    case "month": return { view: "month", plabel: "month to date" };
    case "year": return { view: "year", plabel: "year to date" };
    case "alltime": return { view: "alltime", plabel: "all-time" };
    default: return { view: "week", plabel: "week to date" };
  }
}

// emailSuccessReport — on-demand: an admin picks a window (today / yesterday /
// week-to-date / month-to-date / year / all-time) and an audience, and sends the
// report out anytime — to themselves (test), all admins, managers (their team +
// reps, for shout-outs / coaching to relay), reps (their own), or everyone.
export const emailSuccessReport = onCall(async (request) => {
  const caller = await getCaller(request);
  const reqData = (request.data || {}) as { period?: string; companyId?: string; audience?: string; teamId?: string; repUid?: string; range?: { startMs?: number; endMs?: number }; plabel?: string };
  const companyId = caller.isSuper && reqData.companyId ? reqData.companyId : caller.companyId;
  if (!companyId) throw new HttpsError("permission-denied", "No company.");
  if (!(caller.isSuper || caller.role === "admin")) throw new HttpsError("permission-denied", "Admins only.");
  // A custom range (from the report's calendar filter) overrides the named window.
  const rs = Number(reqData.range?.startMs), re = Number(reqData.range?.endMs);
  const custom = reqData.period === "custom" && Number.isFinite(rs) && Number.isFinite(re) && re > rs;
  const { view, plabel, range } = custom
    ? { view: "week", plabel: (reqData.plabel || "custom range"), range: { startMs: rs, endMs: re } }
    : reportWindow(reqData.period || "week");
  const audience = reqData.audience || "me";
  const cfg = await getNotifyConfig();
  if (!cfg.sendgridKey && !(cfg.smtpHost && cfg.smtpUser)) {
    throw new HttpsError("failed-precondition", "Email isn't configured — set up SendGrid or SMTP under Notifications first.");
  }

  // Single-team send: report scoped to one team (test to caller, its manager(s), or its reps).
  if (reqData.teamId) {
    const sent = await sendTeamReport(cfg, companyId, view, plabel, reqData.teamId, audience, range, caller.uid);
    if (!sent) throw new HttpsError("failed-precondition", "Nothing was sent — check that recipients have email addresses and email is configured.");
    return { sent };
  }

  // Single-rep send: one rep's individual report — delivered to the rep, or a
  // test copy to the caller (audience "me").
  if (reqData.repUid) {
    const repDoc = (await db.doc(`users/${reqData.repUid}`).get()).data() as any;
    if (!repDoc || (repDoc.companyId !== companyId && !caller.isSuper)) throw new HttpsError("not-found", "Rep not found.");
    const toEmail = audience === "me"
      ? (((await db.doc(`users/${caller.uid}`).get()).data()?.email as string) || "")
      : ((repDoc.email as string) || "");
    if (!toEmail) throw new HttpsError("failed-precondition", "No email address on file for that recipient.");
    const rollup = await computeRollup(companyId, view, null, range);
    const companyName = rollup.company.name || "Company";
    const idx = rrepIndex(rollup.company);
    const node = idx.users[reqData.repUid];
    if (!node) throw new HttpsError("failed-precondition", "That rep has no activity in this window.");
    const subject = audience === "me" ? `📊 ${node.name || "Rep"} — report (${plabel})` : `📊 Your report (${plabel})`;
    const res = await sendEmailDetailed(cfg, toEmail, subject,
      rrepReportText(node, "rep", view, plabel, companyName), undefined,
      rrepReportHtml(node, "rep", view, plabel, companyName));
    if (!res.ok) throw new HttpsError("failed-precondition", res.detail || "Send failed.");
    return { sent: 1 };
  }

  if (audience === "me") {
    const callerEmail = ((await db.doc(`users/${caller.uid}`).get()).data()?.email as string) || "";
    if (!callerEmail) throw new HttpsError("failed-precondition", "Your account has no email address.");
    const rollup = await computeRollup(companyId, view, null, range);
    const companyName = rollup.company.name || "Company";
    const res = await sendEmailDetailed(
      cfg, callerEmail, `📊 ${companyName} — company report (${plabel})`,
      rrepReportText(rollup.company, "company", view, plabel, companyName), undefined,
      rrepReportHtml(rollup.company, "company", view, plabel, companyName)
    );
    if (!res.ok) throw new HttpsError("failed-precondition", res.detail || "Send failed.");
    return { sent: 1, recipients: 1 };
  }

  const sent = await sendCompanyReports(cfg, companyId, view, plabel, audience, range);
  if (!sent) throw new HttpsError("failed-precondition", "Nothing was sent — check that recipients have email addresses and email is configured.");
  return { sent };
});

// Start of the month (00:00) in a named timezone, from any instant in it.
function tzStartOfMonth(ms: number, tz: string): number {
  const dom = Number(new Date(ms).toLocaleString("en-US", { timeZone: tz, day: "numeric" })) || 1;
  return tzStartOfDay(tzStartOfDay(ms, tz) - (dom - 1) * 86400000, tz);
}

// weeklySuccessReports — every Sunday 2:00 AM Mountain, send each company the
// PREVIOUS (completed) week's report set: admins → company, managers → their
// teams, setters & closers → their own individual report.
export const weeklySuccessReports = onSchedule({ schedule: "0 2 * * 0", timeZone: "America/Denver" }, async () => {
  const cfg = await getNotifyConfig();
  if (!cfg.sendgridKey && !(cfg.smtpHost && cfg.smtpUser)) {
    logger.warn("weeklySuccessReports: no email provider configured — skipping.");
    return;
  }
  const tz = "America/Denver";
  const weekEnd = tzStartOfDay(Date.now(), tz);                       // this Sunday 00:00 (send day)
  const range = { startMs: weekEnd - 7 * 86400000, endMs: weekEnd };  // the completed Sun–Sat week
  const companies = await db.collection("companies").get();
  for (const co of companies.docs) {
    try {
      const n = await sendCompanyReports(cfg, co.id, "week", "last week", "all", range);
      logger.info(`weeklySuccessReports: ${co.id} → ${n} emails`);
    } catch (e) {
      logger.warn(`weeklySuccessReports failed for ${co.id}`, e);
    }
  }
});

// monthlySuccessReports — the 1st of each month at 2:00 AM Mountain, send each
// company the PREVIOUS month's report set (same audience fan-out).
export const monthlySuccessReports = onSchedule({ schedule: "0 2 1 * *", timeZone: "America/Denver" }, async () => {
  const cfg = await getNotifyConfig();
  if (!cfg.sendgridKey && !(cfg.smtpHost && cfg.smtpUser)) {
    logger.warn("monthlySuccessReports: no email provider configured — skipping.");
    return;
  }
  const tz = "America/Denver";
  const monthEnd = tzStartOfMonth(Date.now(), tz);                          // 1st of this month 00:00
  const range = { startMs: tzStartOfMonth(monthEnd - 86400000, tz), endMs: monthEnd }; // the previous month
  const companies = await db.collection("companies").get();
  for (const co of companies.docs) {
    try {
      const n = await sendCompanyReports(cfg, co.id, "month", "last month", "all", range);
      logger.info(`monthlySuccessReports: ${co.id} → ${n} emails`);
    } catch (e) {
      logger.warn(`monthlySuccessReports failed for ${co.id}`, e);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// THROW DOWNS — rep-vs-rep challenges. Stakes are between the two reps (capped
// at $100). The winner is settled automatically from stats when the window ends.
// ════════════════════════════════════════════════════════════════════════════
// Every active teammate in the caller's company (uid + name), so any rep can
// pick an opponent even if the other rep isn't in their downline.
export const listTeammates = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.companyId) throw new HttpsError("permission-denied", "No company.");
  const snap = await db.collection("users").where("companyId", "==", caller.companyId).get();
  const teammates = snap.docs
    .filter((d) => d.id !== caller.uid)
    .map((d): { uid: string; [k: string]: any } => ({ uid: d.id, ...(d.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true)
    .map((u) => ({ uid: u.uid, name: u.displayName || u.email || "Rep", isCloser: !!u.isCloser }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { teammates };
});

// Top 3 company pitches this week (by AI score) — visible to EVERY rep for
// training. Runs server-side because a rep can't read teammates' pitch docs
// under the rules; the audio itself is readable by any signed-in user, so the
// client fetches the download URL from the returned audioPath.
export const topCompanyPitches = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.companyId) throw new HttpsError("permission-denied", "No company.");
  const weekStart = rStartOfWeek();
  const snap = await db.collection("pitches").where("companyId", "==", caller.companyId).get();
  const top = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as any) }))
    .filter((p) => p.status === "analyzed" && typeof p.score === "number" && (Number(p.createdAt) || 0) >= weekStart)
    .sort((a, b) => (b.score as number) - (a.score as number))
    .slice(0, 3)
    .map((p) => ({
      id: p.id, userName: p.userName || "Rep", score: p.score, address: p.address || "",
      feedback: p.feedback || "", highlight: p.highlight || "", lowlight: p.lowlight || "",
      audioPath: p.audioPath || "", createdAt: Number(p.createdAt) || 0,
    }));
  return { pitches: top };
});

const CHALLENGE_METRICS = new Set(["doors", "appointments", "sales", "points"]);
type ChScore = { doors: number; conv: number; appt: number; sale: number };
// Per-rep funnel for a window (leads owned by each uid), same rules as the Town
// Hall / leaderboard. Returns a map uid → counts for the requested uids only.
async function challengeFunnel(companyId: string, startMs: number, endMs: number, uids: string[]): Promise<Record<string, ChScore>> {
  const want = new Set(uids);
  const out: Record<string, ChScore> = {};
  uids.forEach((u) => { out[u] = { doors: 0, conv: 0, appt: 0, sale: 0 }; });
  const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
  const knockAt = (l: any) => l.knockedAt || l.createdAt || 0;
  // Close DATE = when it actually sold. Never fall back to updatedAt — any later
  // edit (a visibility rebuild, a note) would otherwise make an old sale count as
  // "closed this week" and inflate the week's closes. createdAt is the stable
  // last resort for legacy sold leads with no soldAt.
  const closeAt = (l: any) => l.soldAt || l.createdAt || 0;
  const leadsCol = db.collection("leads");
  let leadDocs;
  try {
    leadDocs = (await leadsCol.where("companyId", "==", companyId).where("createdAt", ">=", startMs).get()).docs;
  } catch {
    leadDocs = (await leadsCol.where("companyId", "==", companyId).get()).docs;
  }
  for (const d of leadDocs) {
    const l = d.data();
    const uid = l.assignedTo as string;
    if (!want.has(uid)) continue;
    const t = knockAt(l);
    if (t < startMs || t >= endMs) continue;
    const acc = out[uid];
    if (l.verified !== false) { acc.doors++; if (CONVO.has(l.status)) acc.conv++; }
    if (l.status === "appointment") acc.appt++;
  }
  const soldDocs = (await leadsCol.where("companyId", "==", companyId).where("status", "==", "sold").get().catch(() => null))?.docs || [];
  for (const d of soldDocs) {
    const l = d.data();
    const uid = l.assignedTo as string;
    if (!want.has(uid)) continue;
    const c = closeAt(l);
    if (c < startMs || c >= endMs) continue;
    out[uid].sale++;
  }
  return out;
}
function scoreForMetric(f: ChScore, metric: string): number {
  if (metric === "doors") return f.doors;
  if (metric === "appointments") return f.appt;
  if (metric === "sales") return f.sale;
  return f.doors * 1 + f.conv * 3 + f.appt * 20 + f.sale * 100; // points
}
const METRIC_WORD: Record<string, string> = { doors: "doors", appointments: "appointments", sales: "sales", points: "points" };
// Post a system message to a company's Team Chat (same channel as the weekly
// recap). Used for Throw Down battles and reward shout-outs.
async function postTeamChat(companyId: string, userName: string, text: string): Promise<void> {
  await db.collection("chat").add({ companyId, userId: "system", userName, text, createdAt: Date.now() }).catch(() => {});
}

export const createChallenge = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = caller.companyId;
  if (!companyId) throw new HttpsError("permission-denied", "No company.");
  const { opponentUid, metric, period, startAt, endAt, stakes, stakeValue } = (request.data || {}) as {
    opponentUid?: string; metric?: string; period?: string; startAt?: number; endAt?: number; stakes?: string; stakeValue?: number | null;
  };
  if (!opponentUid || opponentUid === caller.uid) throw new HttpsError("invalid-argument", "Pick another rep to challenge.");
  if (!metric || !CHALLENGE_METRICS.has(metric)) throw new HttpsError("invalid-argument", "Pick a valid metric.");
  if (period !== "day" && period !== "week") throw new HttpsError("invalid-argument", "Pick day or week.");
  const s = Number(startAt), e = Number(endAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e - s > 8 * 86400000) throw new HttpsError("invalid-argument", "Bad window.");
  const note = String(stakes || "").trim();
  if (!note) throw new HttpsError("invalid-argument", "Add what's on the line.");
  let value: number | null = null;
  if (stakeValue != null && stakeValue !== undefined) {
    value = Number(stakeValue);
    if (!Number.isFinite(value) || value < 0) throw new HttpsError("invalid-argument", "Bad stake value.");
    if (value > 100) throw new HttpsError("invalid-argument", "Stakes are capped at $100.");
  }
  const [meDoc, oppDoc] = await Promise.all([db.doc(`users/${caller.uid}`).get(), db.doc(`users/${opponentUid}`).get()]);
  const opp = oppDoc.data();
  if (!oppDoc.exists || !opp || opp.companyId !== companyId || opp.disabled === true) throw new HttpsError("invalid-argument", "Pick a rep in your company.");
  const challengerName = (meDoc.data()?.displayName as string) || (meDoc.data()?.email as string) || "A teammate";
  const opponentName = (opp.displayName as string) || (opp.email as string) || "Rep";
  const now = Date.now();
  const ref = await db.collection("challenges").add({
    companyId, metric, period, startAt: s, endAt: e, stakes: note, stakeValue: value,
    challengerUid: caller.uid, challengerName, opponentUid, opponentName,
    participants: [caller.uid, opponentUid], status: "pending",
    challengerScore: 0, opponentScore: 0, createdAt: now, updatedAt: now,
  });
  await notifyUser({ userId: opponentUid, type: "challenge", title: `⚔️ Throw Down from ${challengerName}`, body: `${metric} · ${period === "day" ? "today" : "this week"} — on the line: ${note}`, link: "/app/throwdowns" });
  return { ok: true, id: ref.id };
});

export const respondChallenge = onCall(async (request) => {
  const caller = await getCaller(request);
  const { challengeId, action } = (request.data || {}) as { challengeId?: string; action?: string };
  if (!challengeId || !["accept", "decline", "cancel"].includes(String(action))) throw new HttpsError("invalid-argument", "challengeId and action required.");
  const ref = db.doc(`challenges/${challengeId}`);
  const snap = await ref.get();
  const c = snap.data();
  if (!snap.exists || !c) throw new HttpsError("not-found", "Challenge not found.");
  const isOpponent = c.opponentUid === caller.uid;
  const isChallenger = c.challengerUid === caller.uid;
  if (!isOpponent && !isChallenger && !caller.isSuper) throw new HttpsError("permission-denied", "Not your challenge.");
  const now = Date.now();
  if (action === "accept") {
    if (!isOpponent || c.status !== "pending") throw new HttpsError("failed-precondition", "Can't accept this challenge.");
    await ref.set({ status: "active", updatedAt: now }, { merge: true });
    await notifyUser({ userId: c.challengerUid, type: "challenge", title: `✅ ${c.opponentName} accepted your Throw Down`, body: `${c.metric} · game on!`, link: "/app/throwdowns" });
    // Announce the battle in Team Chat to build competition + culture.
    const when = c.period === "day" ? "TODAY" : "THIS WEEK";
    await postTeamChat(c.companyId, "⚔️ Throw Down",
      `⚔️ BATTLE ON! ${c.challengerName} 🆚 ${c.opponentName} — most ${METRIC_WORD[c.metric] || c.metric} ${when} wins. On the line: ${c.stakes}. Let's go! 🔥`);
  } else if (action === "decline") {
    if (!isOpponent || c.status !== "pending") throw new HttpsError("failed-precondition", "Can't decline this challenge.");
    await ref.set({ status: "declined", updatedAt: now }, { merge: true });
    await notifyUser({ userId: c.challengerUid, type: "challenge", title: `❌ ${c.opponentName} declined your Throw Down`, link: "/app/throwdowns" });
  } else { // cancel
    if (!isChallenger || (c.status !== "pending" && c.status !== "active")) throw new HttpsError("failed-precondition", "Can't cancel this challenge.");
    await ref.set({ status: "cancelled", updatedAt: now }, { merge: true });
    if (c.opponentUid) await notifyUser({ userId: c.opponentUid, type: "challenge", title: `🚫 ${c.challengerName} called off the Throw Down`, link: "/app/throwdowns" });
  }
  return { ok: true };
});

// Every 15 min: refresh live scores on active challenges and settle any whose
// window has ended (winner = higher score; tie = no winner).
export const tickChallenges = onSchedule("every 15 minutes", async () => {
  const now = Date.now();
  const snap = await db.collection("challenges").where("status", "==", "active").get();
  for (const d of snap.docs) {
    const c = d.data();
    const startAt = Number(c.startAt) || 0;
    const endAt = Number(c.endAt) || 0;
    const windowEnd = Math.min(now, endAt);
    try {
      const funnel = await challengeFunnel(c.companyId as string, startAt, windowEnd, [c.challengerUid, c.opponentUid]);
      const cs = scoreForMetric(funnel[c.challengerUid], c.metric as string);
      const os = scoreForMetric(funnel[c.opponentUid], c.metric as string);
      const word = METRIC_WORD[c.metric as string] || c.metric;
      if (now >= endAt) {
        const winnerUid = cs === os ? null : (cs > os ? c.challengerUid : c.opponentUid);
        await d.ref.set({ status: "settled", challengerScore: cs, opponentScore: os, winnerUid, scoresUpdatedAt: now, updatedAt: now }, { merge: true });
        const loserUid = winnerUid ? (winnerUid === c.challengerUid ? c.opponentUid : c.challengerUid) : null;
        const winnerName = winnerUid === c.challengerUid ? c.challengerName : c.opponentName;
        const loserName = winnerUid === c.challengerUid ? c.opponentName : c.challengerName;
        if (winnerUid) {
          await notifyUser({ userId: winnerUid, type: "challenge", title: "🏆 You won the Throw Down!", body: `Final: ${cs} vs ${os}. Collect: ${c.stakes}`, link: "/app/throwdowns" });
          if (loserUid) await notifyUser({ userId: loserUid, type: "challenge", title: `😤 ${winnerName} won the Throw Down`, body: `You owe: ${c.stakes}`, link: "/app/throwdowns" });
          await postTeamChat(c.companyId, "⚔️ Throw Down", `🏆 FINAL — ${winnerName} beat ${loserName} ${Math.max(cs, os)}–${Math.min(cs, os)} (${word})! ${loserName} owes: ${c.stakes}. 👏`);
        } else {
          for (const u of [c.challengerUid, c.opponentUid]) await notifyUser({ userId: u, type: "challenge", title: "🤝 Throw Down tied", body: `Dead heat at ${cs}. Call it a draw?`, link: "/app/throwdowns" });
          await postTeamChat(c.companyId, "⚔️ Throw Down", `🤝 FINAL — ${c.challengerName} and ${c.opponentName} tied at ${cs} (${word}). Run it back? 😤`);
        }
      } else {
        await d.ref.set({ challengerScore: cs, opponentScore: os, scoresUpdatedAt: now }, { merge: true });
        // Periodic Team Chat score update, throttled so the chat isn't spammed:
        // a daily challenge posts every 90 min; a multi-day/weekly one only at
        // roughly the start & end of each day (~every 11h).
        const interval = c.period === "day" ? 90 * 60 * 1000 : 11 * 60 * 60 * 1000;
        const lastChatAt = Number(c.lastChatAt) || 0;
        if (now - lastChatAt >= interval) {
          const lead = cs === os ? `🔥 dead even at ${cs}` : `${cs > os ? c.challengerName : c.opponentName} leads ${Math.max(cs, os)}–${Math.min(cs, os)}`;
          const leftMs = endAt - now;
          const leftTxt = leftMs > 24 * 3600 * 1000 ? `${Math.round(leftMs / (24 * 3600 * 1000))}d left` : leftMs > 3600 * 1000 ? `${Math.round(leftMs / (3600 * 1000))}h left` : `${Math.max(1, Math.round(leftMs / 60000))}m left`;
          await postTeamChat(c.companyId, "⚔️ Throw Down", `⚔️ ${c.challengerName} 🆚 ${c.opponentName} (${word}): ${lead} · ${leftTxt}. Who's got it?`);
          await d.ref.set({ lastChatAt: now }, { merge: true });
        }
      }
    } catch (e) { logger.warn("tickChallenges failed for", d.id, e); }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// REWARD SHOUT-OUTS — once a day, motivate reps toward active rewards. Team
// rewards post the team's progress to Team Chat; individual rewards send each
// rep who hasn't hit it yet a private nudge with their own progress.
// ════════════════════════════════════════════════════════════════════════════
const REWARD_WORD: Record<string, string> = { doors: "doors", appointments: "appointments", sales: "sales", conversations: "conversations", points: "points" };
export const rewardMotivation = onSchedule({ schedule: "0 9 * * *", timeZone: "America/Denver" }, async () => {
  const now = Date.now();
  const rewardsSnap = await db.collectionGroup("rewards").get().catch(() => null);
  if (!rewardsSnap) return;
  const byCompany: Record<string, any[]> = {};
  for (const d of rewardsSnap.docs) {
    const r = d.data();
    if (r.active === false) continue;
    if (r.kind === "store") continue; // store rewards are redeemed, not chased
    if (r.startsAt && now < Number(r.startsAt)) continue;
    if (r.expiresAt && now > Number(r.expiresAt)) continue;
    const companyId = d.ref.parent.parent?.id;
    if (!companyId || !(Number(r.target) > 0)) continue;
    (byCompany[companyId] ||= []).push({ id: d.id, ...r });
  }

  const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
  const fromFunnel = (f: ChScore, m: string) =>
    m === "doors" ? f.doors : m === "appointments" ? f.appt : m === "sales" ? f.sale : m === "conversations" ? f.conv : f.doors * STAT_PTS.door + f.conv * STAT_PTS.lead + f.appt * STAT_PTS.appointment + f.sale * STAT_PTS.sale;
  const fromStats = (s: any, m: string) =>
    !s ? 0 : m === "doors" ? (Number(s.doorsKnocked) || 0) : m === "appointments" ? (Number(s.appointments) || 0) : m === "sales" ? (Number(s.sales) || 0) : m === "conversations" ? (Number(s.leadsCreated) || 0) : pointsOf(s);

  for (const [companyId, rewards] of Object.entries(byCompany)) {
    try {
      const [usersSnap, statsSnap] = await Promise.all([
        db.collection("users").where("companyId", "==", companyId).get(),
        db.collection("userStats").where("companyId", "==", companyId).get(),
      ]);
      const reps = usersSnap.docs.map((d) => ({ uid: d.id, ...(d.data() as any) })).filter((u) => u.disabled !== true);
      const statsByUid: Record<string, any> = {};
      statsSnap.forEach((d) => { statsByUid[d.id] = d.data(); });

      // Windowed (week/month) per-rep funnel from leads.
      const monthStart = rStartOfMonth(); const weekStart = rStartOfWeek();
      const fw: Record<string, ChScore> = {}; const fm: Record<string, ChScore> = {};
      reps.forEach((u) => { fw[u.uid] = { doors: 0, conv: 0, appt: 0, sale: 0 }; fm[u.uid] = { doors: 0, conv: 0, appt: 0, sale: 0 }; });
      let leadDocs;
      try { leadDocs = (await db.collection("leads").where("companyId", "==", companyId).where("createdAt", ">=", monthStart).get()).docs; }
      catch { leadDocs = (await db.collection("leads").where("companyId", "==", companyId).get()).docs; }
      for (const d of leadDocs) {
        const l = d.data(); const uid = l.assignedTo as string;
        if (!fm[uid]) continue;
        const t = (l.knockedAt as number) || (l.createdAt as number) || 0;
        if (t < monthStart) continue;
        const bump = (f: ChScore) => { if (l.verified !== false) { f.doors++; if (CONVO.has(l.status)) f.conv++; } if (l.status === "appointment") f.appt++; if (l.status === "sold") f.sale++; };
        bump(fm[uid]); if (t >= weekStart) bump(fw[uid]);
      }
      // Team all-time totals (team rewards are all-time in the app).
      const teamAll: any = { doorsKnocked: 0, appointments: 0, sales: 0, leadsCreated: 0, shifts: 0 };
      Object.values(statsByUid).forEach((s: any) => { teamAll.doorsKnocked += Number(s.doorsKnocked) || 0; teamAll.appointments += Number(s.appointments) || 0; teamAll.sales += Number(s.sales) || 0; teamAll.leadsCreated += Number(s.leadsCreated) || 0; teamAll.shifts += Number(s.shifts) || 0; });

      for (const r of rewards) {
        const target = Number(r.target) || 0;
        const word = REWARD_WORD[r.metric] || r.metric;
        if (r.audience === "team") {
          const val = fromStats(teamAll, r.metric);
          if (val >= target) continue; // already earned — no nagging
          const pct = Math.round((val / target) * 100);
          await postTeamChat(companyId, "🎁 Team Reward", `🎁 TEAM GOAL — "${r.name}": ${val}/${target} ${word} (${pct}%). ${target - val} to go — everybody push! 💪🔥`);
        } else {
          for (const u of reps) {
            const val = r.period === "weekly" ? fromFunnel(fw[u.uid], r.metric) : r.period === "monthly" ? fromFunnel(fm[u.uid], r.metric) : fromStats(statsByUid[u.uid], r.metric);
            if (val >= target) continue;
            await notifyUser({ userId: u.uid, type: "reward", title: `🎁 ${r.name} — keep pushing!`, body: `You're at ${val}/${target} ${word}. Just ${target - val} more to earn it — you've got this! 💪`, link: "/app/rewards" });
          }
        }
      }
    } catch (e) { logger.warn("rewardMotivation failed for", companyId, e); }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// WEEKLY SEASON RECAP — every Friday evening, post a hype recap to each
// company's Team Chat: top 3 by points + the biggest climber vs. last week.
// Mirrors the client points model (lib/points.ts).
// ════════════════════════════════════════════════════════════════════════════
const STAT_PTS = { door: 1, lead: 3, appointment: 20, sale: 100, shift: 25 };
function pointsOf(s: any): number {
  return (
    (Number(s.doorsKnocked) || 0) * STAT_PTS.door +
    (Number(s.leadsCreated) || 0) * STAT_PTS.lead +
    (Number(s.appointments) || 0) * STAT_PTS.appointment +
    (Number(s.sales) || 0) * STAT_PTS.sale +
    (Number(s.shifts) || 0) * STAT_PTS.shift
  );
}

// ISO-week key matching the client (lib/season.ts) so the recap reads the same
// weekly bucket the leaderboard shows.
function isoWeekKey(d: Date): string {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt.getTime() - ys.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

async function weekPoints(companyId: string, weekKey: string): Promise<Map<string, { name: string; points: number }>> {
  const snap = await db.collection("seasonStats")
    .where("companyId", "==", companyId).where("period", "==", weekKey).get();
  const m = new Map<string, { name: string; points: number }>();
  snap.forEach((d) => {
    const s = d.data();
    m.set(s.uid || d.id, { name: (s.userName as string) || "Rep", points: pointsOf(s) });
  });
  return m;
}

export const weeklyRecap = onSchedule({ schedule: "0 17 * * 5", timeZone: "America/Denver" }, async () => {
  const thisWeek = isoWeekKey(new Date());
  const lastWeek = isoWeekKey(new Date(Date.now() - 7 * 86400000));
  const companies = await db.collection("companies").get();

  for (const co of companies.docs) {
    const companyId = co.id;
    const cur = await weekPoints(companyId, thisWeek);
    const top = [...cur.entries()]
      .map(([uid, v]) => ({ uid, ...v }))
      .filter((t) => t.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 3);
    if (!top.length) continue;

    // Most improved vs. last week's bucket.
    const prev = await weekPoints(companyId, lastWeek);
    let climber: { name: string; delta: number } | null = null;
    for (const [uid, v] of cur.entries()) {
      const delta = v.points - (prev.get(uid)?.points || 0);
      if (delta > 0 && (!climber || delta > climber.delta)) climber = { name: v.name, delta };
    }

    const medals = ["🥇", "🥈", "🥉"];
    const recapText = (label: string, rows: { uid: string; name: string; points: number }[], climb: { name: string; delta: number } | null) => {
      let m = `🏆 Weekly Recap — ${label}\n\nThis week's top performers:\n`;
      rows.slice(0, 3).forEach((t, i) => { m += `${medals[i]} ${t.name} — ${t.points.toLocaleString()} pts\n`; });
      if (climb) m += `\n🚀 Most improved: ${climb.name} (+${climb.delta.toLocaleString()} pts vs last week)`;
      m += "\n\nNew week, clean slate — let's get out there and run it back! 💪";
      return m;
    };

    // Company-wide recap → the company channel (this is genuinely company-wide info).
    await db.collection("chat").add({
      companyId, userId: "system", userName: "🏆 Weekly Recap",
      text: recapText("the board resets, fresh season starts now!", top, climber), createdAt: Date.now(),
    });

    // Per-team recaps → each team's Team Chat, so a rep sees THEIR team's board
    // (not just the company-wide one). Group reps by their team via the users
    // roster, since seasonStats has no teamId.
    try {
      const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
      const teamOf: Record<string, string> = {};
      usersSnap.forEach((u) => { const d = u.data() as any; if (d.teamId) teamOf[u.id] = d.teamId as string; });
      const byTeam: Record<string, { uid: string; name: string; points: number }[]> = {};
      for (const [uid, v] of cur.entries()) {
        const tid = teamOf[uid];
        if (!tid || v.points <= 0) continue;
        (byTeam[tid] ??= []).push({ uid, ...v });
      }
      for (const [teamId, rows] of Object.entries(byTeam)) {
        rows.sort((a, b) => b.points - a.points);
        let teamClimber: { name: string; delta: number } | null = null;
        for (const r of rows) {
          const delta = r.points - (prev.get(r.uid)?.points || 0);
          if (delta > 0 && (!teamClimber || delta > teamClimber.delta)) teamClimber = { name: r.name, delta };
        }
        await db.collection("teamChat").add({
          companyId, teamId, userId: "system", userName: "🏆 Weekly Recap",
          text: recapText("your team's week", rows, teamClimber), createdAt: Date.now(),
        });
      }
    } catch (e) {
      logger.warn(`per-team recap failed for ${companyId}`, e);
    }
    logger.info(`weekly recap posted for ${companyId}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PLATFORM ADMIN — provider keys (ATTOM/BatchData), Stripe billing config, and
// company plan assignment. Super-admin only.
// ════════════════════════════════════════════════════════════════════════════

// Show the keys actually in use (config override, else env) so the operator can
// see "our keys" in the super-admin screen.
export const getApiKeys = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  await refreshApiConfig();
  return {
    attomKey: ATTOM.key, attomUrl: ATTOM.baseUrl,
    batchKey: BATCH.key, batchUrl: BATCH.baseUrl, batchEnabled: BATCH.enabled,
    nrelKey: NREL.key, googleMapsKey: GMAPS.key,
  };
});

export const setApiKeys = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, unknown>;
  const u: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.attomKey === "string" && d.attomKey.trim()) u.attomKey = d.attomKey.trim();
  if (typeof d.attomUrl === "string") u.attomUrl = (d.attomUrl as string).trim();
  if (typeof d.batchKey === "string" && d.batchKey.trim()) u.batchKey = d.batchKey.trim();
  if (typeof d.batchUrl === "string") u.batchUrl = (d.batchUrl as string).trim();
  if (typeof d.batchEnabled === "boolean") u.batchEnabled = d.batchEnabled;
  if (typeof d.nrelKey === "string" && d.nrelKey.trim()) u.nrelKey = d.nrelKey.trim();
  if (typeof d.googleMapsKey === "string" && d.googleMapsKey.trim()) u.googleMapsKey = d.googleMapsKey.trim();
  await db.doc("config/api").set(u, { merge: true });
  return { ok: true };
});

// Which gateway charges companies: "stripe" (default) or "square". The whole
// platform uses one active provider at a time; the super-admin picks it here.
function billingProvider(c: Record<string, unknown>): "stripe" | "square" {
  return c.provider === "square" ? "square" : "stripe";
}

// Super-admin: choose the active payment provider.
export const setBillingProvider = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { provider } = (request.data || {}) as { provider?: string };
  if (provider !== "stripe" && provider !== "square") {
    throw new HttpsError("invalid-argument", "provider must be 'stripe' or 'square'.");
  }
  await db.doc("config/billing").set({ provider, updatedAt: Date.now(), updatedBy: caller.uid }, { merge: true });
  return { ok: true };
});

// Stripe keys — publishable is shown; secret + webhook are masked.
export const getStripeConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  return {
    provider: billingProvider(c),
    publishableKey: c.stripePublishableKey || "",
    secretConfigured: !!c.stripeSecretKey,
    secretMask: mask(c.stripeSecretKey),
    webhookConfigured: !!c.stripeWebhookSecret,
  };
});

export const setStripeConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const u: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.publishableKey === "string") u.stripePublishableKey = d.publishableKey.trim();
  if (typeof d.secretKey === "string" && d.secretKey.trim()) u.stripeSecretKey = d.secretKey.trim();
  if (typeof d.webhookSecret === "string" && d.webhookSecret.trim()) u.stripeWebhookSecret = d.webhookSecret.trim();
  await db.doc("config/billing").set(u, { merge: true });
  return { ok: true };
});

// Square keys — application/location IDs are shown; access token + webhook key
// are masked. `environment` is "sandbox" (testing) or "production" (live money).
export const getSquareConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  return {
    provider: billingProvider(c),
    environment: c.squareEnvironment === "production" ? "production" : "sandbox",
    applicationId: c.squareApplicationId || "",
    locationId: c.squareLocationId || "",
    accessTokenConfigured: !!c.squareAccessToken,
    accessTokenMask: mask(c.squareAccessToken),
    webhookConfigured: !!c.squareWebhookSignatureKey,
  };
});

export const setSquareConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const u: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (d.environment === "production" || d.environment === "sandbox") u.squareEnvironment = d.environment;
  if (typeof d.applicationId === "string") u.squareApplicationId = d.applicationId.trim();
  if (typeof d.locationId === "string") u.squareLocationId = d.locationId.trim();
  if (typeof d.accessToken === "string" && d.accessToken.trim()) u.squareAccessToken = d.accessToken.trim();
  if (typeof d.webhookSignatureKey === "string" && d.webhookSignatureKey.trim()) u.squareWebhookSignatureKey = d.webhookSignatureKey.trim();
  await db.doc("config/billing").set(u, { merge: true });
  return { ok: true };
});

// Assign / change a company's subscription plan + status.
export const setCompanyPlan = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { companyId, plan, status, billingExempt, features, planPrice } = (request.data || {}) as {
    companyId?: string; plan?: string; status?: string; billingExempt?: boolean;
    features?: string[]; planPrice?: number;
  };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");
  const u: Record<string, unknown> = { updatedAt: Date.now() };
  if (typeof status === "string") u.status = status;
  if (typeof billingExempt === "boolean") u.billingExempt = billingExempt;
  if (typeof plan === "string") {
    u.plan = plan;
    if (isTrialPlan(plan)) {
      // Put the company on a 3-day trial with full access. Keep an in-progress
      // trial's existing end date; otherwise start a fresh window. Trial wins as
      // the status unless the admin explicitly set one in the same change.
      const cur = (await db.doc(`companies/${companyId}`).get()).data() || {};
      const curEnd = Number(cur.trialEndsAt) || 0;
      u.trialEndsAt = curEnd > Date.now() ? curEnd : Date.now() + TRIAL_MS;
      u.trialExpired = false;
      if (typeof status !== "string") u.status = "trial";
      // Trial = the full product: drop any feature restriction (undefined = all on).
      u.features = FieldValue.delete();
    }
    // Copy the plan's feature set + limits onto the company so the app can gate.
    const ps = await db.collection("plans").where("name", "==", plan).limit(1).get();
    if (!ps.empty) {
      const p = ps.docs[0].data();
      u.planId = ps.docs[0].id;
      u.features = Array.isArray(p.features) ? p.features : [];
      u.maxUsers = Number(p.maxUsers) || 0;
      // Two-part pricing: base fee (covers includedUsers) + perUserPrice each extra.
      const baseFee = Number(p.baseFee ?? p.priceMonthly) || 0;
      const includedUsers = Number(p.includedUsers) || 0;
      const perUserPrice = Number(p.perUserPrice) || 0;
      u.baseFee = baseFee;
      u.includedUsers = includedUsers;
      u.perUserPrice = perUserPrice;
      // Effective monthly = base + overage based on the current active head-count.
      const us = await db.collection("users").where("companyId", "==", companyId).get();
      const activeUsers = us.docs.filter((d) => !d.data().disabled).length;
      const extra = Math.max(0, activeUsers - includedUsers);
      u.planPrice = baseFee + extra * perUserPrice;
    }
  }
  // Per-company overrides (applied after any plan copy so admin toggles win):
  // turn individual services on/off and set a custom price for this company.
  if (Array.isArray(features)) u.features = features.filter((x) => typeof x === "string");
  if (typeof planPrice === "number" && isFinite(planPrice)) u.planPrice = planPrice;
  await db.doc(`companies/${companyId}`).set(u, { merge: true });
  return { ok: true };
});

// Who the bill is addressed to + where it's sent. Super-admins set it for any
// company; a company admin may set it for their own company.
export const setCompanyBilling = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, billingContactName, billingEmail } = (request.data || {}) as {
    companyId?: string; billingContactName?: string; billingEmail?: string;
  };
  const cid = authorizeForCompany(caller, companyId);
  const email = (billingEmail || "").trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Enter a valid billing email.");
  }
  await db.doc(`companies/${cid}`).set({
    billingContactName: (billingContactName || "").trim(),
    billingEmail: email,
    updatedAt: Date.now(),
  }, { merge: true });
  return { ok: true };
});

// ════════════════════════════════════════════════════════════════════════════
// ORGANIZATIONS — a parent grouping over multiple company tenants (e.g. a
// franchise/dealer). Enterprise billing adds a per-company fee on every company
// in the org PLUS one org-wide fee. Locking an org for non-payment locks every
// company under it (reusing the per-company billingHold gate). Super-admin only.
// ════════════════════════════════════════════════════════════════════════════
const ENTERPRISE_COMPANY_FEE = 500; // added per company in an enterprise org
const ENTERPRISE_ORG_FEE = 85; // added once for the whole organization

function requireSuper(caller: Caller) {
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
}

export const createOrganization = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const name = String((request.data || {}).name || "").trim();
  if (!name) throw new HttpsError("invalid-argument", "Organization name required.");
  const ref = await db.collection("organizations").add({
    name, enterprise: false,
    perCompanyFee: ENTERPRISE_COMPANY_FEE, orgFee: ENTERPRISE_ORG_FEE,
    billingContactName: "", billingEmail: "",
    status: "active", billingHold: false, pastDueSince: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return { ok: true, orgId: ref.id };
});

export const setOrganization = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { orgId, name, billingContactName, billingEmail, enterprise, perCompanyFee, orgFee, monthlyOverride } =
    (request.data || {}) as {
      orgId?: string; name?: string; billingContactName?: string; billingEmail?: string;
      enterprise?: boolean; perCompanyFee?: number; orgFee?: number; monthlyOverride?: number;
    };
  if (!orgId) throw new HttpsError("invalid-argument", "orgId required.");
  const email = (billingEmail || "").trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Enter a valid billing email.");
  }
  const u: Record<string, unknown> = { updatedAt: Date.now() };
  if (typeof name === "string") u.name = name.trim();
  if (typeof billingContactName === "string") u.billingContactName = billingContactName.trim();
  if (typeof billingEmail === "string") u.billingEmail = email;
  if (typeof enterprise === "boolean") u.enterprise = enterprise;
  if (typeof perCompanyFee === "number" && isFinite(perCompanyFee)) u.perCompanyFee = Math.max(0, perCompanyFee);
  if (typeof orgFee === "number" && isFinite(orgFee)) u.orgFee = Math.max(0, orgFee);
  // Explicit monthly that overrides the computed total (0 = use computed).
  if (typeof monthlyOverride === "number" && isFinite(monthlyOverride)) u.monthlyOverride = Math.max(0, monthlyOverride);
  await db.doc(`organizations/${orgId}`).set(u, { merge: true });
  return { ok: true };
});

export const assignCompanyToOrg = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { companyId, orgId } = (request.data || {}) as { companyId?: string; orgId?: string | null };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");
  if (orgId) {
    const org = await db.doc(`organizations/${orgId}`).get();
    if (!org.exists) throw new HttpsError("not-found", "Organization not found.");
    await db.doc(`companies/${companyId}`).set({ organizationId: orgId, updatedAt: Date.now() }, { merge: true });
  } else {
    await db.doc(`companies/${companyId}`).set({ organizationId: FieldValue.delete(), updatedAt: Date.now() }, { merge: true });
  }
  return { ok: true };
});

// Lock (or unlock) an organization for non-payment. Locking suspends every
// company under it — the per-company billingHold gate then shows the
// "contact your administrator for payment" message. "Due on receipt" = lock
// immediately; unlock once the org pays.
export const setOrgLock = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { orgId, locked } = (request.data || {}) as { orgId?: string; locked?: boolean };
  if (!orgId) throw new HttpsError("invalid-argument", "orgId required.");
  const now = Date.now();
  const orgPatch = locked
    ? { status: "suspended", billingHold: true, pastDueSince: now, updatedAt: now }
    : { status: "active", billingHold: false, pastDueSince: 0, updatedAt: now };
  await db.doc(`organizations/${orgId}`).set(orgPatch, { merge: true });
  const companies = await db.collection("companies").where("organizationId", "==", orgId).get();
  const batch = db.batch();
  companies.docs.forEach((d) => batch.set(d.ref, orgPatch, { merge: true }));
  await batch.commit();
  return { ok: true, companies: companies.size };
});

// ════════════════════════════════════════════════════════════════════════════
// EMPLOYEE REPORTS — a manager/admin pulls one rep's detailed activity, and can
// "set a close" on the rep's behalf (which also credits the rep's stats).
// Authorization: super-admin, a company admin in the same company, or a manager
// the rep reports to (caller's uid is in the rep's managerPath).
// ════════════════════════════════════════════════════════════════════════════
const REPORT_CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
function rStartOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function rStartOfWeek() { const d = new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d.getTime(); }
function rStartOfMonth() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
const rKnock = (l: any) => l.knockedAt || l.createdAt || 0;
const rClose = (l: any) => l.soldAt || l.updatedAt || l.knockedAt || l.createdAt || 0;
function rFunnel(leads: any[], since: number) {
  // Doors/convos require on-site (verified) integrity; appointments and closes
  // are deliberate outcomes and count regardless of geofence. Closes count by
  // close date so a deal closed in the window counts even if knocked earlier.
  const onsite = (l: any) => l.verified !== false;
  const knocked = leads.filter((l) => rKnock(l) >= since);
  return {
    doors: knocked.filter(onsite).length,
    conv: knocked.filter((l) => onsite(l) && REPORT_CONVO.has(l.status)).length,
    appt: knocked.filter((l) => l.status === "appointment").length,
    closed: leads.filter((l) => l.status === "sold" && rClose(l) >= since).length,
  };
}

// Server-side season-period helpers (mirror youtilityknock-web/src/lib/season.ts).
function rPeriodKey(kind: string, d = new Date()): string {
  if (kind === "year") return `${d.getFullYear()}`;
  if (kind === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt.getTime() - ys.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}
const rSeasonDocId = (uid: string, kind: string, d = new Date()) => `${uid}__${kind[0].toUpperCase()}${rPeriodKey(kind, d)}`;

// Credit a rep's rolled-up stats (server-side bumpStats; Admin SDK bypasses the
// "only the user writes their own stats" rule so a manager can set a close).
async function serverBumpStats(rep: any, deltas: Record<string, number>) {
  const inc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(deltas)) inc[k] = FieldValue.increment(v);
  const base = {
    uid: rep.uid, companyId: rep.companyId, userName: rep.displayName || rep.email || "Rep",
    managerPath: rep.managerPath || [], closerManagerPath: rep.closerManagerPath || [],
    ...inc, updatedAt: Date.now(),
  };
  await Promise.all([
    db.doc(`userStats/${rep.uid}`).set(base, { merge: true }),
    ...["week", "month", "year"].map((kind) =>
      db.doc(`seasonStats/${rSeasonDocId(rep.uid, kind)}`).set(
        { ...base, kind, period: rPeriodKey(kind), joinedAt: rep.createdAt ?? null }, { merge: true })),
  ]);
}

// Adjust a rep's stats in the period a past event belongs to (by `atMs`), not
// the current one — so cancelling an appointment set last week decrements last
// week's bucket, leaving this week's board untouched. All-time (userStats) is
// always adjusted.
async function serverBumpStatsAt(rep: any, deltas: Record<string, number>, atMs: number) {
  const when = new Date(Number(atMs) || Date.now());
  const inc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(deltas)) inc[k] = FieldValue.increment(v);
  const base = {
    uid: rep.uid, companyId: rep.companyId, userName: rep.displayName || rep.email || "Rep",
    managerPath: rep.managerPath || [], closerManagerPath: rep.closerManagerPath || [],
    ...inc, updatedAt: Date.now(),
  };
  await Promise.all([
    db.doc(`userStats/${rep.uid}`).set(base, { merge: true }),
    ...["week", "month", "year"].map((kind) =>
      db.doc(`seasonStats/${rSeasonDocId(rep.uid, kind, when)}`).set(
        { ...base, kind, period: rPeriodKey(kind, when), joinedAt: rep.createdAt ?? null }, { merge: true })),
  ]);
}

// Auto-end shifts that a rep left running: either idle for 30+ minutes (the app
// was closed/backgrounded so the client couldn't stop it) or running past 8
// hours. Credits the rolled-up stats the same way a manual stop does. Runs
// server-side so it fires even with the app closed. The idle case ends the shift
// at its last activity, so idle time isn't counted as worked hours.
const SHIFT_MAX_MS = 8 * 60 * 60 * 1000;
const SHIFT_IDLE_MS = 30 * 60 * 1000;
export const shiftAutoStop = onSchedule("every 15 minutes", async () => {
  const now = Date.now();
  // Active shifts are few (one per working rep), so evaluate in code rather than
  // needing a composite index.
  const snap = await db.collection("shifts").where("status", "==", "active").get();
  for (const d of snap.docs) {
    const s = d.data();
    const startAt = Number(s.startAt) || 0;
    if (!startAt) continue;
    // The app heartbeats lastActivityAt while it's open and in use; older shifts
    // predate it, so fall back to startAt.
    const lastActive = Number(s.lastActivityAt) || startAt;
    const idle = now - lastActive >= SHIFT_IDLE_MS;
    const tooLong = now - startAt >= SHIFT_MAX_MS;
    if (!idle && !tooLong) continue;
    const endAt = idle ? lastActive : startAt + SHIFT_MAX_MS;
    await d.ref.set(
      { status: "ended", endAt, autoEnded: true, autoEndReason: idle ? "idle" : "max", updatedAt: now },
      { merge: true },
    );
    const uid = (s.userId as string) || "";
    if (uid) {
      const rep = (await db.doc(`users/${uid}`).get()).data();
      if (rep) await serverBumpStats(rep, { shifts: 1, doorsKnocked: Number(s.doorsKnocked) || 0 });
    }
  }
});

// True if the caller may manage this rep (see their report / set closes).
function canManageRep(caller: Caller, rep: any): boolean {
  if (caller.isSuper) return true;
  if (caller.role === "admin" && caller.companyId === rep.companyId) return true;
  return Array.isArray(rep.managerPath) && rep.managerPath.includes(caller.uid);
}

export const getEmployeeReport = onCall(async (request) => {
  const caller = await getCaller(request);
  const { repUid } = (request.data || {}) as { repUid?: string };
  if (!repUid) throw new HttpsError("invalid-argument", "repUid required.");
  const repSnap = await db.doc(`users/${repUid}`).get();
  const rep = repSnap.exists ? { uid: repSnap.id, ...repSnap.data() } as any : null;
  if (!rep) throw new HttpsError("not-found", "Employee not found.");
  if (!canManageRep(caller, rep)) throw new HttpsError("permission-denied", "Not allowed to view this employee.");

  const [leadSnap, shiftSnap, statSnap, pitchSnap] = await Promise.all([
    db.collection("leads").where("companyId", "==", rep.companyId).where("assignedTo", "==", repUid).get(),
    db.collection("shifts").where("companyId", "==", rep.companyId).where("userId", "==", repUid).get(),
    db.doc(`userStats/${repUid}`).get(),
    db.collection("pitches").where("companyId", "==", rep.companyId).where("uid", "==", repUid).get(),
  ]);
  // Keep all leads; rFunnel applies the on-site rule per metric (doors/convos
  // require it, appointments/closes don't). Filtering here dropped off-site
  // closes, zeroing the close rate.
  const leads = leadSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as any);
  const shifts = shiftSnap.docs.map((d) => d.data() as any);
  const today = rStartOfToday(), week = rStartOfWeek(), month = rStartOfMonth();
  const shiftHrs = (since: number) => Math.round(
    shifts.filter((s) => (s.startAt || 0) >= since)
      .reduce((sum, s) => sum + ((s.endAt ?? Date.now()) - (s.startAt || 0)), 0) / 3600000 * 10) / 10;

  const pitches = pitchSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as any)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((p) => ({
      id: p.id, address: p.address || "", createdAt: p.createdAt || 0, status: p.status,
      score: typeof p.score === "number" ? p.score : null,
      highlight: p.highlight || "", lowlight: p.lowlight || "", feedback: p.feedback || "",
    }));
  const scored = pitches.filter((p) => typeof p.score === "number");
  const best = scored.length ? scored.reduce((a, b) => (b.score! > a.score! ? b : a)) : null;
  const worst = scored.length ? scored.reduce((a, b) => (b.score! < a.score! ? b : a)) : null;

  const all = rFunnel(leads, 0);
  // Sit % (setter) and close % (closer), computed all-time from the appointment
  // EVENTS (authoritative) rather than the drifting stat counters — so the report
  // matches what actually happened. Sit rate = sits ÷ pitched appointments
  // (sits + no-shows; excludes turn-aways).
  const { setters: sm, closers: cm } = await computeApptMetrics(rep.companyId, 0);
  // Per-window CLOSER funnel — built from the SAME appointment metrics the closer
  // card uses (appointments SET in the window → sat → closed → dispositioned),
  // windowed by when the appointment was set, so the funnel matches the card
  // exactly instead of double-counting reschedules / future dates.
  const [cmToday, cmWeek, cmMonth] = await Promise.all([
    computeApptMetrics(rep.companyId, today),
    computeApptMetrics(rep.companyId, week),
    computeApptMetrics(rep.companyId, month),
  ]);
  const cWin = (cmObj: { closers: Record<string, any> }) => {
    const c = cmObj.closers[repUid] || { appts: 0, sits: 0, closes: 0, due: 0, dispositioned: 0 };
    return { appt: c.appts, sat: c.sits, closed: c.closes, due: c.due, dispositioned: c.dispositioned };
  };
  const sMet = sm[repUid] || { appts: 0, sits: 0, pitched: 0, noShow: 0, upcoming: 0, undispositioned: 0, other: 0 };
  const cMet = cm[repUid] || { appts: 0, sits: 0, closes: 0, turnedAways: 0, due: 0, dispositioned: 0 };
  const rate = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : null);
  const sitMetrics = {
    isCloser: rep.isCloser === true,
    // Setter lane
    apptsSet: sMet.appts,
    sits: sMet.sits,
    pitchedAppts: sMet.pitched,
    sitRate: rate(sMet.sits, sMet.pitched),
    // Closer lane — appts set FOR or BY this closer, dispositioned off outcomes
    closerAppts: cMet.appts,
    closerSits: cMet.sits,
    closerCloses: cMet.closes,
    closeRate: rate(cMet.closes, cMet.sits),
    turnedAways: cMet.turnedAways,
    closerDue: cMet.due,
    closerDispositioned: cMet.dispositioned,
    dispoRate: rate(cMet.dispositioned, cMet.due),
  };
  // Recorded conversations = geo-verified real door pitches only (never practice
  // certifications or off-location recordings).
  const recordedCount = pitchSnap.docs.filter((d) => {
    const p = d.data() as any; return (p.kind || "door") === "door" && p.atLocation === true;
  }).length;
  return {
    rep: { uid: rep.uid, displayName: rep.displayName || "", email: rep.email || "", title: rep.title || rep.role || "", role: rep.role || "" },
    funnel: { today: rFunnel(leads, today), week: rFunnel(leads, week), month: rFunnel(leads, month), all },
    closerFunnel: { today: cWin(cmToday), week: cWin(cmWeek), month: cWin(cmMonth), all: cWin({ closers: cm }) },
    stats: statSnap.exists ? statSnap.data() : {},
    sitMetrics,
    // Lifetime totals derived from the SAME lead set as the funnel, so the
    // footer matches the ALL-TIME column (the userStats counters drift).
    lifetime: { sold: all.closed, appts: all.appt, doors: all.doors },
    shiftHours: { week: shiftHrs(week), month: shiftHrs(month) },
    leads: leads
      .sort((a, b) => rKnock(b) - rKnock(a))
      .slice(0, 200)
      .map((l) => ({ id: l.id, address: l.address || "", status: l.status, knockedAt: rKnock(l), soldAt: l.soldAt || null })),
    pitches: { recent: pitches.slice(0, 30), best, worst, count: pitches.length, recordedCount },
  };
});

// Set a close (or other disposition) on a lead on a rep's behalf, and credit
// the rep's stats. Manager/admin only, for reps they manage.
export const setLeadStatusForRep = onCall(async (request) => {
  const caller = await getCaller(request);
  const { leadId, status } = (request.data || {}) as { leadId?: string; status?: string };
  if (!leadId || !status) throw new HttpsError("invalid-argument", "leadId and status required.");
  const leadSnap = await db.doc(`leads/${leadId}`).get();
  const lead = leadSnap.exists ? leadSnap.data() as any : null;
  if (!lead) throw new HttpsError("not-found", "Lead not found.");
  const repSnap = await db.doc(`users/${lead.assignedTo}`).get();
  const rep = repSnap.exists ? { uid: repSnap.id, ...repSnap.data() } as any : null;
  if (!rep) throw new HttpsError("not-found", "Lead owner not found.");
  if (!canManageRep(caller, rep)) throw new HttpsError("permission-denied", "Not allowed to manage this employee's leads.");

  const now = Date.now();
  const prev = lead.status;
  const patch: Record<string, unknown> = { status, updatedAt: now };
  if (status === "sold") patch.soldAt = now;
  await db.doc(`leads/${leadId}`).set(patch, { merge: true });
  // Credit the rep's stats for newly-set closes / appointments (don't double-count).
  if (status === "sold" && prev !== "sold") await serverBumpStats(rep, { sales: 1 });
  else if (status === "appointment" && prev !== "appointment") await serverBumpStats(rep, { appointments: 1 });
  return { ok: true, repUid: rep.uid };
});

// ════════════════════════════════════════════════════════════════════════════
// PITCH AI — when a rep's pitch recording lands, transcribe it (Google
// Speech-to-Text) and grade it (Claude), writing the score + coaching feedback
// back onto the pitch doc. Keys live in config/ai (set in the super-admin
// console). No keys → the pitch is marked "error" with a hint, nothing crashes.
// ════════════════════════════════════════════════════════════════════════════
const PITCH_CERT_PASS = 80; // a certification pitch scoring ≥ this certifies the rep
async function readAiConfig() {
  const c = ((await db.doc("config/ai").get()).data() as Record<string, string>) || {};
  return {
    googleSttKey: c.googleSttKey || process.env.GOOGLE_STT_KEY || "",
    anthropicKey: c.anthropicKey || process.env.ANTHROPIC_API_KEY || "",
    anthropicModel: c.anthropicModel || "claude-sonnet-4-6",
  };
}

// General-purpose Claude text call for the training/coaching features (role-play,
// success plans, territory education). Reuses the same key/model as pitch grading.
async function claudeText(system: string, messages: Array<{ role: string; content: string }>, maxTokens = 900): Promise<string> {
  const cfg = await readAiConfig();
  if (!cfg.anthropicKey) throw new HttpsError("failed-precondition", "AI coaching isn't configured yet — ask your admin to add an Anthropic key.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: maxTokens, system, messages }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpsError("internal", json?.error?.message || `Claude failed (${res.status})`);
  return (json.content?.[0]?.text as string) || "";
}

// Transcode any browser recording (webm/opus on Android/desktop, mp4/aac on
// iOS) to mono 16 kHz FLAC, which Google STT reliably ingests. ffmpeg also lets
// us send the audio inline so the transcriber never reads from the bucket.
async function transcodeToFlac(input: Buffer, ext: string): Promise<Buffer> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inPath = join(tmpdir(), `pitch_${stamp}.${ext || "webm"}`);
  const outPath = join(tmpdir(), `pitch_${stamp}.flac`);
  await writeFile(inPath, input);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath as string, ["-y", "-i", inPath, "-ac", "1", "-ar", "16000", "-c:a", "flac", outPath]);
      let err = "";
      p.stderr.on("data", (d) => { err += d.toString(); });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg failed: " + err.slice(-300)))));
    });
    return await readFile(outPath);
  } finally {
    await Promise.all([unlink(inPath).catch(() => {}), unlink(outPath).catch(() => {})]);
  }
}

// Transcribe FLAC audio (sent inline) via Google STT longRunningRecognize.
async function transcribeFlac(flacB64: string, key: string): Promise<string> {
  const start = await fetch(`https://speech.googleapis.com/v1/speech:longrunningrecognize?key=${key}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { encoding: "FLAC", sampleRateHertz: 16000, languageCode: "en-US", enableAutomaticPunctuation: true },
      audio: { content: flacB64 },
    }),
  });
  const startJson: any = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(startJson?.error?.message || `STT start failed (${start.status})`);
  const opName = startJson.name;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const op: any = await (await fetch(`https://speech.googleapis.com/v1/operations/${opName}?key=${key}`)).json().catch(() => ({}));
    if (op.done) {
      if (op.error) throw new Error(op.error.message);
      return ((op.response?.results) || []).map((r: any) => r.alternatives?.[0]?.transcript || "").join(" ").trim();
    }
  }
  throw new Error("Transcription timed out.");
}

// Grade a pitch transcript with Claude. Returns score + highlight/lowlight/feedback.
async function claudeGradePitch(transcript: string, key: string, model: string): Promise<any> {
  const prompt =
    "You are an expert door-to-door sales coach. Analyze this rep's pitch transcript and reply with ONLY a JSON object " +
    `(no prose) of the form {"score": <integer 0-100>, "highlight": "<the strongest moment / what worked, 1-2 sentences>", ` +
    `"lowlight": "<the weakest moment / what to improve, 1-2 sentences>", "feedback": "<2-3 sentence coaching summary addressed to the rep>"}.\n\nTranscript:\n` +
    transcript;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: "user", content: prompt }] }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Claude failed (${res.status})`);
  const text = (json.content?.[0]?.text as string) || "";
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : { score: null, feedback: text.slice(0, 500) }; }
  catch { return { score: null, feedback: text.slice(0, 500) }; }
}

export const onPitchCreated = onDocumentCreated(
  { document: "pitches/{id}", timeoutSeconds: 540, memory: "512MiB" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const p = snap.data() as any;
    if (p.status !== "recorded" || !p.audioPath) return;
    const cfg = await readAiConfig();
    if (!cfg.googleSttKey || !cfg.anthropicKey) {
      await snap.ref.set({ status: "error", feedback: "AI isn't configured — add Google STT + Anthropic keys in the admin console." }, { merge: true });
      return;
    }
    await snap.ref.set({ status: "analyzing" }, { merge: true });
    try {
      // Download with the function's own credentials (no "anonymous" GCS read),
      // transcode to FLAC (handles iOS mp4/aac + Android webm), transcribe inline.
      const [audio] = await getStorage().bucket().file(p.audioPath).download();
      const ext = (p.audioPath.split(".").pop() || "webm").toLowerCase();
      const flac = await transcodeToFlac(audio, ext);
      const transcript = await transcribeFlac(flac.toString("base64"), cfg.googleSttKey);
      if (!transcript) {
        await snap.ref.set({ status: "analyzed", transcript: "", feedback: "No clear speech was detected in this recording.", analyzedAt: Date.now() }, { merge: true });
        return;
      }
      const a = await claudeGradePitch(transcript, cfg.anthropicKey, cfg.anthropicModel);
      await snap.ref.set({
        status: "analyzed", transcript,
        score: typeof a.score === "number" ? a.score : null,
        highlight: a.highlight || "", lowlight: a.lowlight || "", feedback: a.feedback || "",
        analyzedAt: Date.now(),
      }, { merge: true });
      // A passing certification pitch unlocks full-credit canvassing for the rep.
      if (p.kind === "certification" && typeof a.score === "number" && a.score >= PITCH_CERT_PASS && p.uid) {
        await db.doc(`users/${p.uid}`).set(
          { pitchCertified: true, pitchCertScore: a.score, pitchCertifiedAt: Date.now(), pitchCertPitchId: snap.id },
          { merge: true }
        );
      }
    } catch (e: any) {
      logger.error("onPitchCreated failed", e);
      await snap.ref.set({ status: "error", feedback: (e?.message || "Analysis failed.").slice(0, 300) }, { merge: true });
    }
  }
);

// Super-admin: AI provider keys (Google STT + Anthropic) for pitch coaching.
export const getAiConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const c = ((await db.doc("config/ai").get()).data() as Record<string, string>) || {};
  return {
    stt: { configured: !!c.googleSttKey, keyMask: mask(c.googleSttKey) },
    anthropic: { configured: !!c.anthropicKey, keyMask: mask(c.anthropicKey), model: c.anthropicModel || "claude-sonnet-4-6" },
  };
});

export const setAiConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const d = (request.data || {}) as Record<string, string>;
  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.googleSttKey === "string" && d.googleSttKey.trim()) update.googleSttKey = d.googleSttKey.trim();
  if (typeof d.anthropicKey === "string" && d.anthropicKey.trim()) update.anthropicKey = d.anthropicKey.trim();
  if (typeof d.anthropicModel === "string" && d.anthropicModel.trim()) update.anthropicModel = d.anthropicModel.trim();
  await db.doc("config/ai").set(update, { merge: true });
  return { ok: true };
});

// ════════════════════════════════════════════════════════════════════════════
// TRAINING — AI homeowner role-play, personalized success plan, and a
// data-driven recommended territory. All reuse the pitch-coaching Claude key.
// ════════════════════════════════════════════════════════════════════════════

// A stay-in-character skeptical homeowner the rep can practice pitching against.
export const aiHomeowner = onCall(async (request) => {
  await getCaller(request); // any signed-in rep may practice
  const { messages, persona } = (request.data || {}) as { messages?: Array<{ role: string; content: string }>; persona?: string };
  const history = (Array.isArray(messages) ? messages : []).slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 2000),
  }));
  if (history.length === 0) history.push({ role: "user", content: "(The rep knocks on your door.)" });
  const system =
    `You are role-playing as a SKEPTICAL HOMEOWNER who just opened the door to a door-to-door ${persona || "solar"} sales rep. ` +
    "Stay fully in character as the homeowner for the entire conversation. Be realistic: start guarded and raise the common objections " +
    "(no time, not interested, already got quotes, my spouse decides, I don't trust door knockers, too expensive). If the rep listens, " +
    "builds value and handles objections well, gradually warm up; if they're pushy, vague or salesy, stay cold. Keep each reply to 1-3 " +
    "conversational sentences. No narration, no stage directions, never break character, never say you are an AI.";
  const reply = await claudeText(system, history, 300);
  return { reply: reply.trim() };
});

// Personalized study guide + succession plan built from the rep's own door data
// (notes, not-interested patterns) and recent pitch coaching.
export const getSuccessPlan = onCall(async (request) => {
  const caller = await getCaller(request);
  const repUid = ((request.data || {}) as { repUid?: string }).repUid || caller.uid;
  const repSnap = await db.doc(`users/${repUid}`).get();
  const rep = repSnap.exists ? ({ uid: repSnap.id, ...repSnap.data() } as any) : null;
  if (!rep) throw new HttpsError("not-found", "Rep not found.");
  if (repUid !== caller.uid && !canManageRep(caller, rep)) throw new HttpsError("permission-denied", "Not allowed.");
  const [leadSnap, pitchSnap] = await Promise.all([
    db.collection("leads").where("assignedTo", "==", repUid).get(),
    db.collection("pitches").where("uid", "==", repUid).get(),
  ]);
  const leads = leadSnap.docs.map((d) => d.data() as any);
  const counts: Record<string, number> = {};
  for (const l of leads) counts[l.status] = (counts[l.status] || 0) + 1;
  const niNotes = leads.filter((l) => l.status === "not_interested" && l.notes).slice(0, 25).map((l) => String(l.notes).slice(0, 200));
  const otherNotes = leads.filter((l) => l.notes && l.status !== "not_interested").slice(0, 30).map((l) => `[${l.status}] ${String(l.notes).slice(0, 160)}`);
  const pitchFb = pitchSnap.docs.map((d) => d.data() as any).filter((p) => p.status === "analyzed")
    .slice(0, 10).map((p) => `score ${p.score}: ${p.lowlight || p.feedback || ""}`.slice(0, 220));
  const system =
    "You are an elite door-to-door sales coach. Build a concrete, personalized improvement plan for this rep from their real field data. " +
    'Reply with ONLY a JSON object (no prose) of the form {"summary":"<2-3 sentence read on where they are>",' +
    '"focusAreas":["<3-5 short focus areas>"],"studyGuide":["<5-7 specific study/practice items>"],' +
    '"successionPlan":["<ordered steps to level up over the next few weeks>"],' +
    '"objectionScripts":[{"objection":"<a real objection they hit>","response":"<a crisp rebuttal to practice>"}]}.';
  const user =
    `Rep: ${rep.displayName || "rep"}. Disposition counts: ${JSON.stringify(counts)}.\n` +
    `NOT-INTERESTED notes (reduce these):\n${niNotes.join("\n") || "(none)"}\n\n` +
    `Other door notes:\n${otherNotes.join("\n") || "(none)"}\n\n` +
    `Recent AI pitch coaching:\n${pitchFb.join("\n") || "(none)"}`;
  const text = await claudeText(system, [{ role: "user", content: user }], 1600);
  const m = text.match(/\{[\s\S]*\}/);
  let plan: any;
  try { plan = m ? JSON.parse(m[0]) : { summary: text.slice(0, 800) }; }
  catch { plan = { summary: text.slice(0, 800) }; }
  return { plan, certified: rep.pitchCertified === true, certScore: rep.pitchCertScore ?? null, stats: counts };
});

// Manager tool: from a rep's worked areas, recommend a new "pre-drawn" area
// modeled on their best converter, plus AI coaching on what to replicate.
export const recommendTerritory = onCall(async (request) => {
  const caller = await getCaller(request);
  const { repUid } = (request.data || {}) as { repUid?: string };
  if (!repUid) throw new HttpsError("invalid-argument", "repUid required.");
  const repSnap = await db.doc(`users/${repUid}`).get();
  const rep = repSnap.exists ? ({ uid: repSnap.id, ...repSnap.data() } as any) : null;
  if (!rep) throw new HttpsError("not-found", "Rep not found.");
  if (!canManageRep(caller, rep)) throw new HttpsError("permission-denied", "Not allowed to manage this rep.");
  const cid = rep.companyId;
  const [terrSnap, leadSnap] = await Promise.all([
    db.collection("territories").where("companyId", "==", cid).get(),
    db.collection("leads").where("companyId", "==", cid).get(),
  ]);
  const repTerrs = terrSnap.docs
    .map((d) => ({ id: d.id, data: d.data() as any, polygon: normalizePoly((d.data() as any).polygon) }))
    .filter((t) => t.data.assignedTo === repUid && t.polygon.length >= 3);
  if (repTerrs.length === 0) throw new HttpsError("failed-precondition", "This rep has no drawn areas to learn from yet.");
  const leads = leadSnap.docs.map((d) => d.data() as any);
  const scored = repTerrs.map((t) => {
    let doors = 0, sold = 0, appt = 0; const notes: string[] = [];
    for (const l of leads) {
      const lat = Number(l.lat), lng = Number(l.lng);
      if (!isFinite(lat) || !isFinite(lng) || !pinInPolygon({ lat, lng }, t.polygon)) continue;
      doors++;
      if (l.status === "sold") sold++;
      if (l.status === "appointment") appt++;
      if (l.notes) notes.push(`[${l.status}] ${String(l.notes).slice(0, 160)}`);
    }
    return { t, doors, sold, appt, success: doors ? sold / doors : 0, notes };
  }).filter((s) => s.doors > 0).sort((a, b) => b.success - a.success);
  if (scored.length === 0) throw new HttpsError("failed-precondition", "Not enough door data to recommend an area yet.");
  const best = scored[0], worst = scored[scored.length - 1];
  // Pre-draw an adjacent untouched block: clone the best polygon shifted east by
  // its own width so the manager gets a ready-to-assign area near the winner.
  const lngs = best.t.polygon.map((p) => p.lng);
  const width = Math.max(...lngs) - Math.min(...lngs) || 0.003;
  const polygon = best.t.polygon.map((p) => ({ lat: p.lat, lng: p.lng + width }));
  let education = `Replicate "${best.t.data.name}" — it converted ${Math.round(best.success * 100)}% (${best.sold} sold / ${best.doors} doors).`;
  try {
    const sys = "You are a door-to-door sales coach addressing a manager. In 3-4 short sentences, explain what made this rep's best area convert and exactly what to replicate, plus one thing to avoid from their weakest area. Plain text only, no preamble.";
    const out = await claudeText(sys, [{ role: "user", content:
      `Best area "${best.t.data.name}": ${Math.round(best.success * 100)}% success (${best.sold}/${best.doors}).\nNotes:\n${best.notes.slice(0, 25).join("\n") || "(none)"}\n\n` +
      `Weakest area "${worst.t.data.name}": ${Math.round(worst.success * 100)}% success.\nNotes:\n${worst.notes.slice(0, 15).join("\n") || "(none)"}` }], 500);
    if (out.trim()) education = out.trim();
  } catch (e) { logger.warn("recommendTerritory education failed", e); }
  return {
    recommendation: {
      name: `Like ${best.t.data.name} — for ${rep.displayName || "rep"}`,
      polygon, basedOnTerritoryId: best.t.id, basedOnName: best.t.data.name,
      successRate: Math.round(best.success * 100), doors: best.doors, sold: best.sold,
      rationale: `Modeled on the rep's best area "${best.t.data.name}" (${Math.round(best.success * 100)}% success).`,
      education,
    },
  };
});

// Rep-facing: propose a new area for a manager to approve. Reps can't write
// territories directly (rules block it), so this runs with admin credentials and
// files the area as a pending proposal assigned to the proposing rep.
export const proposeTerritory = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.companyId) throw new HttpsError("failed-precondition", "No company on your account.");
  const { name, description, polygon, color } = (request.data || {}) as { name?: string; description?: string; polygon?: unknown; color?: string };
  if (!name || !String(name).trim()) throw new HttpsError("invalid-argument", "An area name is required.");
  const me = ((await db.doc(`users/${caller.uid}`).get()).data() as any) || {};
  const poly = normalizePoly(polygon);
  const ref = await db.collection("territories").add({
    name: String(name).trim(),
    description: description ? String(description).trim() : null,
    color: color || "#0EA5E9",
    companyId: caller.companyId,
    managerId: me.managerId || null,
    proposedBy: caller.uid,
    assignedTo: caller.uid,
    assignedToName: me.displayName || me.email || null,
    polygon: poly.length >= 3 ? poly : null,
    status: "pending",
    createdAt: Date.now(),
  });
  const mgr = (me.managerPath || [])[0];
  if (mgr) {
    try {
      await db.collection("notifications").add({
        userId: mgr, type: "territory_proposal",
        title: `${me.displayName || me.email || "A rep"} proposed an area`,
        body: String(name).trim(), link: "/territories", read: false, createdAt: Date.now(),
      });
    } catch { /* non-fatal */ }
  }
  return { ok: true, id: ref.id };
});

// Battery proposal — turn the deterministic sizing numbers into a warm,
// homeowner-facing narrative the closer can read or include in the proposal.
// Best-effort: if AI isn't configured the client just falls back to the numbers.
export const batteryProposalSummary = onCall(async (request) => {
  await getCaller(request);
  const d = (request.data || {}) as {
    customerName?: string; bill?: any; load?: any; solar?: any;
    recommendation?: any; goal?: string; backupDays?: number;
  };
  const rec = d.recommendation || {};
  const prod = rec.product || {};
  const system = `You are a top residential battery-storage consultant writing a short, persuasive but honest proposal summary for a homeowner. Plain text, warm and clear, no markdown headers, 4-6 short sentences. Explain what the recommended battery does for THEM (backup of their essentials, ${d.goal === "savings" ? "savings on their bill" : d.goal === "both" ? "backup plus bill savings" : "whole-home backup peace of mind"}), reference their actual numbers, and end with a confident next step. Don't invent prices.`;
  const user =
    `Homeowner: ${d.customerName || "the homeowner"}.\n` +
    `Bill: ~${d.bill?.monthlyKWh ?? "?"} kWh/mo, ~$${d.bill?.monthlyCost ?? "?"}/mo at $${d.bill?.ratePerKWh ?? "?"}/kWh.\n` +
    `Existing solar: ${d.solar?.hasSolar ? `${d.solar?.systemKwDc || "?"} kW` : "none"}.\n` +
    `Backup load: ${d.load?.dailyKWh ?? "?"} kWh/day, ${d.load?.continuousKW ?? "?"} kW continuous, ${d.load?.peakKW ?? "?"} kW surge.\n` +
    `Recommended: ${rec.units || 1}× ${prod.brand || ""} ${prod.model || ""} = ${rec.totalUsableKWh ?? "?"} kWh usable, ${rec.totalContinuousKW ?? "?"} kW continuous, covering ~${rec.backupDaysAchieved ?? "?"} days of their essentials. Goal: ${d.goal || "backup"} for ${d.backupDays || 1} day(s).`;
  try {
    const text = await claudeText(system, [{ role: "user", content: user }], 600);
    return { summary: text.trim() };
  } catch (e: any) {
    // Surface a typed, non-fatal signal so the UI degrades to the raw numbers.
    return { summary: "", error: e?.message || "AI summary unavailable." };
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ENERGY INCENTIVES — auto-discover local / AHJ / utility battery+solar
// incentives for an address. Identifies the electric utility via NREL, then uses
// Claude WITH LIVE WEB SEARCH to find current programs with real source links +
// dates. Cached per area so we don't re-bill the AI for every lookup. (No ITC.)
// ════════════════════════════════════════════════════════════════════════════
function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

// Claude with the server-side web_search tool. Returns the answer text plus the
// real citation URLs the model used (our verification links). Falls back to a
// knowledge-only call if web search isn't enabled on the key/model.
async function claudeWebResearch(system: string, prompt: string, maxTokens = 2500): Promise<{ text: string; sources: Array<{ url: string; title: string }>; usedWeb: boolean }> {
  const cfg = await readAiConfig();
  if (!cfg.anthropicKey) throw new HttpsError("failed-precondition", "AI isn't configured — add an Anthropic key in the admin console.");
  const headers = { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const base = { model: cfg.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] };
  let usedWeb = true;
  let res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers,
    body: JSON.stringify({ ...base, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }),
  });
  let json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn("web_search unavailable, falling back to knowledge-only", json?.error?.message);
    usedWeb = false;
    res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(base) });
    json = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpsError("internal", json?.error?.message || `Claude failed (${res.status})`);
  }
  const blocks: any[] = Array.isArray(json.content) ? json.content : [];
  let text = "";
  const sources: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (b.type === "text") {
      text += b.text || "";
      for (const c of (b.citations || [])) {
        if (c?.url && !seen.has(c.url)) { seen.add(c.url); sources.push({ url: c.url, title: c.title || c.url }); }
      }
    }
  }
  return { text, sources, usedWeb };
}

// Real electric-utility identification for a coordinate (NREL utility_rates v3).
async function nrelUtility(lat: number, lng: number): Promise<{ name: string; rate: number | null } | null> {
  try {
    const url = `https://developer.nrel.gov/api/utility_rates/v3.json?api_key=${encodeURIComponent(NREL.key)}&lat=${lat}&lon=${lng}`;
    const res = await fetch(url);
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const o = j.outputs || {};
    const name = o.utility_name || (Array.isArray(o.utility_info) ? o.utility_info[0]?.utility_name : "") || "";
    const rate = typeof o.residential === "number" && o.residential > 0 ? o.residential : null;
    return name || rate != null ? { name: name || "", rate } : null;
  } catch { return null; }
}

const INCENTIVE_CACHE_TTL = 30 * 86400000; // 30 days — incentives change slowly
function incentiveAreaKey(d: { zip?: string; state?: string; lat?: number; lng?: number }): string {
  if (d.zip && /^\d{5}$/.test(String(d.zip))) return `z_${d.zip}`;
  if (typeof d.lat === "number" && typeof d.lng === "number") return `g_${d.lat.toFixed(2)}_${d.lng.toFixed(2)}`;
  if (d.state) return `s_${String(d.state).toLowerCase().replace(/[^a-z]/g, "")}`;
  return "unknown";
}

export const getAreaIncentives = onCall({ timeoutSeconds: 120 }, async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as { lat?: number; lng?: number; address?: string; city?: string; state?: string; zip?: string; refresh?: boolean };
  await refreshApiConfig();
  const key = incentiveAreaKey(d);
  const ref = db.doc(`incentiveCache/${key}`);
  if (!d.refresh) {
    const cached = await ref.get();
    if (cached.exists) {
      const c = cached.data() as any;
      if (c.generatedAt && Date.now() - c.generatedAt < INCENTIVE_CACHE_TTL) return { ...c, cacheId: key, cached: true };
    }
  }
  let utility: { name: string; rate: number | null } | null = null;
  if (typeof d.lat === "number" && typeof d.lng === "number") utility = await nrelUtility(d.lat, d.lng);
  const loc = [d.address, d.city, d.state, d.zip].filter(Boolean).join(", ") || `${d.lat ?? "?"},${d.lng ?? "?"}`;
  const today = new Date().toISOString().slice(0, 10);
  const system =
    `You are a home solar + battery incentives researcher. Use web search to find CURRENT (as of ${today}) financial incentives for installing HOME BATTERY / energy storage (and rooftop solar) at the given U.S. location: electric-utility rebates, state programs, county/city/AHJ incentives, SGIP-style storage rebates, performance/demand-response or VPP payments, and property/sales-tax exemptions. EXCLUDE the federal ITC entirely (assume it is gone). Only include programs you can source from an official utility or government page. Reply with ONLY a JSON array (no prose).`;
  const utilLine = utility?.name ? `The electric utility serving this address is ${utility.name}. ` : "";
  const prompt =
    `Location: ${loc}. ${utilLine}\n` +
    `Return a JSON array (max 6, most valuable first) of: {"name","administrator","level":"utility|state|county|city|ahj|other","type":"rebate|tax|performance|financing|exemption","amount":"<human readable e.g. $0.25/Wh up to $5,000>","estValueUsd":<number estimate for a typical single-battery home install, or null>,"startDate":"<ISO/text/null>","endDate":"<ISO/text/'ongoing'>","url":"<official source URL>","summary":"<1-2 sentences>"}. If none, return [].`;
  let incentives: any[] = [];
  let sources: Array<{ url: string; title: string }> = [];
  let usedWeb = false;
  try {
    const r = await claudeWebResearch(system, prompt, 3000);
    usedWeb = r.usedWeb; sources = r.sources;
    const m = r.text.match(/\[[\s\S]*\]/);
    if (m) incentives = JSON.parse(m[0]);
  } catch (e) {
    logger.warn("incentive research failed", e);
  }
  const report = {
    location: loc, state: d.state || null, zip: d.zip || null,
    utility: utility || null,
    incentives: Array.isArray(incentives) ? incentives.slice(0, 8) : [],
    sources, usedWeb, generatedAt: Date.now(), generatedBy: caller.uid,
  };
  try { await ref.set(report, { merge: true }); } catch (e) { logger.warn("incentive cache write", e); }
  return { ...report, cacheId: key, cached: false };
});

// Email the discovered incentives (with dates + verification links) to the
// homeowner as proof the programs are real — the closer/setter's trust builder.
export const emailIncentivesToHomeowner = onCall(async (request) => {
  await getCaller(request);
  const d = (request.data || {}) as { to?: string; customerName?: string; address?: string; incentives?: any[]; utility?: { name?: string }; companyName?: string };
  if (!d.to || !/.+@.+\..+/.test(d.to)) throw new HttpsError("invalid-argument", "A valid homeowner email is required.");
  const items = Array.isArray(d.incentives) ? d.incentives : [];
  const rows = items.map((i) => {
    const dates = [i.startDate, i.endDate].filter(Boolean).join(" – ") || "see source";
    return `<tr><td style="padding:10px;border-bottom:1px solid #eee">` +
      `<strong>${escHtml(i.name)}</strong><br>` +
      `<span style="color:#555">${escHtml(i.administrator || "")}${i.type ? " · " + escHtml(i.type) : ""}</span><br>` +
      `${escHtml(i.summary || "")}<br>` +
      `<span style="color:#555">Amount: ${escHtml(i.amount || "—")} · Dates: ${escHtml(dates)}</span>` +
      `${i.url ? `<br><a href="${escHtml(i.url)}">Verify at the official source →</a>` : ""}</td></tr>`;
  }).join("");
  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:620px;color:#111">` +
    `<h2>Energy incentives for your home</h2>` +
    `${d.address ? `<p style="color:#555">${escHtml(d.address)}</p>` : ""}` +
    `${d.utility?.name ? `<p>Electric utility: <strong>${escHtml(d.utility.name)}</strong></p>` : ""}` +
    `<table style="width:100%;border-collapse:collapse">${rows || "<tr><td>No specific programs were found for your area yet — your rep can follow up.</td></tr>"}</table>` +
    `<p style="color:#777;font-size:12px;margin-top:16px">These programs are gathered from public/official sources and can change — please confirm current terms at each linked source${d.companyName ? `, or ask your ${escHtml(d.companyName)} rep` : ""}.</p></div>`;
  const text = items.map((i) => `• ${i.name} (${i.administrator || ""}) — ${i.amount || ""} — ${[i.startDate, i.endDate].filter(Boolean).join(" to ")} — ${i.url || ""}`).join("\n") || "No specific programs found yet.";
  const cfg = await getNotifyConfig();
  const r = await sendEmailDetailed(cfg, d.to, "Energy incentives for your home", text, undefined, html);
  if (!r.ok) throw new HttpsError("failed-precondition", r.detail);
  return { ok: true };
});

// Save the interactive proposal and email the homeowner a link to open it. The
// interactive experience can't live inside an email, so we persist the proposal
// under an unguessable id and send a link to the live, no-login viewer plus an
// HTML summary fallback.
export const emailProposalToHomeowner = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as { to?: string; payload?: Record<string, any>; leadId?: string };
  if (!d.to || !/.+@.+\..+/.test(d.to)) throw new HttpsError("invalid-argument", "A valid homeowner email is required.");
  const payload: Record<string, any> = { ...(d.payload || {}) };
  // A home-photo data URI can be hundreds of KB — drop it so the saved doc stays
  // comfortably under Firestore's 1 MB limit (the viewer falls back to the scene).
  if (typeof payload.homeImage === "string" && payload.homeImage.length > 300_000) delete payload.homeImage;

  const id = crypto.randomUUID().replace(/-/g, "");
  await db.doc(`sharedProposals/${id}`).set({
    payload, to: d.to, companyId: caller.companyId || payload.companyId || null,
    closerUid: caller.uid, createdAt: Date.now(),
  });
  const url = `${APP_URL}/app/?pid=${id}`;
  // Save the proposal to the homeowner's history so it can be reopened for a
  // follow-up or sale (a reopenable ?pid= link on their customer page).
  await appendProposalToLeadHistory(caller, d.leadId, id, url, payload).catch((e) => logger.warn("proposal→lead history failed", e));

  const money = (n: any) => (typeof n === "number" && isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—");
  const rec = payload.recommendation as any;
  const roi = payload.roi as any;
  const first = payload.customerName ? String(payload.customerName).split(" ")[0] : "there";
  const company = payload.companyName ? escHtml(payload.companyName) : "";
  const incs = Array.isArray(payload.incentives) ? payload.incentives.slice(0, 6) : [];

  const roiRows = roi
    ? `<table style="width:100%;border-collapse:collapse;margin:14px 0"><tr>` +
      `<td style="padding:10px 12px;background:#f5f3fb;border-radius:8px"><div style="font-size:20px;font-weight:700;color:#6d28d9">${money(roi.netCost)}</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em">Net cost after incentives</div></td>` +
      `<td style="width:10px"></td>` +
      `<td style="padding:10px 12px;background:#f5f3fb;border-radius:8px"><div style="font-size:20px;font-weight:700;color:#0a7d33">${money(roi.monthlySavings)}/mo</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em">Estimated monthly savings</div></td>` +
      `</tr></table>`
    : "";
  const incRows = incs.length
    ? `<div style="margin-top:14px"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:6px">Incentives you may qualify for</div>` +
      incs.map((i: any) => `<div style="padding:6px 0;border-bottom:1px solid #eee"><strong>${escHtml(i.name)}</strong>${i.amount ? ` — ${escHtml(i.amount)}` : ""}${i.url ? ` · <a href="${escHtml(i.url)}" style="color:#7c3aed">verify</a>` : ""}</div>`).join("") +
      `</div>`
    : "";

  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">` +
    `<div style="background:linear-gradient(135deg,#1a1030,#0a0712);border-radius:16px;padding:26px 24px;color:#fff">` +
      `<div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#a78bfa">Your Energy Future${company ? ` · ${company}` : ""}</div>` +
      `<h1 style="margin:8px 0 4px;font-size:25px">Hi ${escHtml(first)}, your proposal is ready</h1>` +
      `${rec ? `<div style="color:#cfc7e2;font-size:14px">Recommended: <strong>${escHtml(String(rec.units))}× ${escHtml(rec.brand)} ${escHtml(rec.model)}</strong> · ${escHtml(String(rec.totalUsableKWh))} kWh usable · ~${escHtml(String(rec.backupDaysAchieved))} day backup</div>` : ""}` +
    `</div>` +
    `${roiRows}` +
    `<div style="text-align:center;margin:22px 0">` +
      `<a href="${url}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:999px">▶ View your interactive proposal</a>` +
      `<div style="font-size:12px;color:#999;margin-top:8px">Tap to explore your home as a living energy system — solar, battery, backup &amp; savings.</div>` +
    `</div>` +
    `${incRows}` +
    `<p style="color:#999;font-size:12px;margin-top:20px">This link opens an interactive presentation${company ? ` from ${company}` : ""}. Figures are estimates for discussion and can change with final design and current incentive terms.</p>` +
    `</div>`;

  const text =
    `Hi ${first}, your energy proposal is ready.\n` +
    (rec ? `Recommended: ${rec.units}x ${rec.brand} ${rec.model} (${rec.totalUsableKWh} kWh usable, ~${rec.backupDaysAchieved} day backup).\n` : "") +
    (roi ? `Net cost after incentives: ${money(roi.netCost)} · Est. monthly savings: ${money(roi.monthlySavings)}.\n` : "") +
    `\nView your interactive proposal: ${url}\n`;

  const subject = `${payload.companyName ? payload.companyName + " — " : ""}Your interactive energy proposal`;
  const cfg = await getNotifyConfig();
  const r = await sendEmailDetailed(cfg, d.to, subject, text, undefined, html);
  if (!r.ok) throw new HttpsError("failed-precondition", r.detail);
  return { ok: true, url, pid: id };
});

// Append a "proposal created" entry to a lead's history timeline so the rep can
// reopen it from the homeowner's customer page in a follow-up or sale. Verifies
// the lead is in the caller's company; a failure never blocks the proposal.
async function appendProposalToLeadHistory(
  caller: { uid: string; companyId?: string | null; isSuper?: boolean },
  leadId: string | undefined,
  pid: string,
  url: string,
  payload: Record<string, any>,
): Promise<void> {
  const lid = String(leadId || "").trim();
  if (!lid) return;
  const snap = await db.doc(`leads/${lid}`).get();
  if (!snap.exists) return;
  const lead = snap.data() as any;
  if (!caller.isSuper && lead.companyId && lead.companyId !== caller.companyId) return;
  const rec = payload.recommendation as any;
  const label = rec ? `${rec.units}× ${rec.brand} ${rec.model}` : "battery system";
  let byName: string | null = null;
  try { byName = ((await db.doc(`users/${caller.uid}`).get()).data() as any)?.displayName || null; } catch { /* best effort */ }
  const entry = {
    at: Date.now(),
    kind: "proposal",
    notes: `Battery proposal created — ${label}`,
    byUid: caller.uid,
    byName,
    proposalPid: pid,
    proposalUrl: url,
  };
  await db.doc(`leads/${lid}`).set({ history: FieldValue.arrayUnion(entry), updatedAt: Date.now() }, { merge: true });
}

// Save a proposal (no email): create the reopenable shared record and, when a
// leadId is given, drop it into the homeowner's history — same result as the
// email path, for the "Save" button.
export const saveProposalRecord = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as { payload?: Record<string, any>; leadId?: string };
  const payload: Record<string, any> = { ...(d.payload || {}) };
  if (typeof payload.homeImage === "string" && payload.homeImage.length > 300_000) delete payload.homeImage;
  const id = crypto.randomUUID().replace(/-/g, "");
  await db.doc(`sharedProposals/${id}`).set({
    payload, to: null, companyId: caller.companyId || payload.companyId || null,
    closerUid: caller.uid, createdAt: Date.now(),
  });
  const url = `${APP_URL}/app/?pid=${id}`;
  await appendProposalToLeadHistory(caller, d.leadId, id, url, payload).catch((e) => logger.warn("proposal→lead history failed", e));
  return { ok: true, url, pid: id };
});

// Public (no auth): fetch a shared proposal payload by its unguessable id so the
// homeowner can open the interactive proposal from the emailed link.
export const getSharedProposal = onCall(async (request) => {
  const id = String(((request.data || {}) as { id?: string }).id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!id) throw new HttpsError("invalid-argument", "Missing proposal id.");
  const snap = await db.doc(`sharedProposals/${id}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "This proposal link is no longer available.");
  const data = snap.data() || {};
  return { payload: data.payload || {} };
});

// ─── Battery purchase & installation agreement (e-sign + auto-close) ──────────
const money$ = (n: any) => (typeof n === "number" && isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—");
const agDate = (ms: number) => new Date(ms || Date.now()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

// The standard agreement body as ordered sections. Used for both the on-screen
// (HTML) sign page and the PDF. installerName is left blank for the company to
// fill from the admin portal. NOTE: a standard template — have it reviewed by
// counsel for your jurisdiction.
function agreementSections(a: Record<string, any>): Array<{ h: string; body: string }> {
  const b = a.battery || {};
  const pay = a.payment || {};
  const sys = `${b.units || 1}× ${b.brand || ""} ${b.model || ""}`.trim();
  const specs = [
    b.totalUsableKWh ? `${b.totalUsableKWh} kWh usable` : "",
    b.totalContinuousKW ? `${b.totalContinuousKW} kW continuous` : "",
    b.backupDaysAchieved ? `~${b.backupDaysAchieved}-day backup` : "",
    b.chemistry ? `${b.chemistry} chemistry` : "",
  ].filter(Boolean).join(" · ");
  const installer = a.installerName || "______________________________ (to be completed by Seller)";
  const company = a.companyName || "Seller";

  let paymentBody: string;
  if (pay.method === "finance" && pay.finance) {
    const f = pay.finance;
    paymentBody =
      `Buyer elects to FINANCE the System. The total cash price is ${money$(pay.systemPrice)}. ` +
      `Financing is provided through ${f.lender || "the Seller's lending partner (Sungage Financial)"} under the ` +
      `"${f.name || "selected"}" plan: approximately ${money$(f.monthly)} per month, ${(Number(f.apr) * 100 || 0).toFixed(2)}% APR, ${f.termYears || 20}-year term` +
      `${f.escalator ? `, with a ${(f.escalator * 100).toFixed(1)}% annual payment escalator` : ""}` +
      `${f.deferred ? `, including a deferred-payment period` : ""}. ` +
      `Payment figures are estimates; the final rate, payment, and terms are set by the lender on credit approval and the executed lender loan documents control.`;
  } else {
    const c = pay.cash || {};
    const balance = typeof c.balance === "number" ? c.balance : Math.max(0, (pay.systemPrice || 0) - (c.depositUsd || 0));
    paymentBody =
      `Buyer elects to pay CASH. The total price is ${money$(pay.systemPrice || c.cashPrice)}. ` +
      `A deposit of ${money$(c.depositUsd)} is paid upon execution to reserve pricing and the installation schedule (fully credited to the total). ` +
      `The remaining balance of ${money$(balance)} is due upon completion of installation per the following schedule: ` +
      `(a) the deposit at signing; and (b) the balance upon substantial completion and passing of the required inspection.`;
  }

  return [
    { h: "1. Parties", body: `This Battery Purchase & Installation Agreement ("Agreement") is entered into between ${company} ("Seller"/"Installer") and ${a.customerName || "the homeowner"} ("Buyer") for the property at ${a.address || "the address on file"}.` },
    { h: "2. The System", body: `Seller will furnish and install: ${sys}${specs ? ` — ${specs}` : ""}, together with all balance-of-system components, mounting, and electrical work required for a complete, code-compliant battery energy storage installation ("System").` },
    { h: "3. Purchase Price & Payment", body: paymentBody },
    { h: "4. Scope of Work & Standard Installation", body: `Seller will perform a standard installation: mounting the equipment, electrical interconnection to the home's panel/backup loads, commissioning, and configuration of monitoring. Work is performed to the manufacturer's specifications and applicable electrical code. Non-standard work (e.g., main-panel upgrades, trenching, structural modifications, or additional circuits) discovered at site survey may require a written change order and price adjustment.` },
    { h: "5. Permits, Inspection & Interconnection", body: `Seller will obtain the permits required for the installation and coordinate the authority-having-jurisdiction inspection and any required utility interconnection approval. Installation timelines depend on permit and utility processing outside Seller's control.` },
    { h: "6. Warranties", body: `Manufacturer warranty: the battery and equipment carry the manufacturer's limited warranty (approximately ${b.warrantyYears || 10} years for the selected product), per the manufacturer's terms. Workmanship/Installation warranty: Seller warrants its installation workmanship against defects for the company's standard workmanship period. Warranties exclude damage from misuse, alteration, acts of nature, or work by others. This is a summary; the manufacturer and Seller written warranties control.` },
    { h: "7. Site Survey & Final Design", body: `This Agreement is based on the information available at signing and is subject to a site survey and final engineering. If the survey reveals conditions that materially change scope or cost, Seller will present a change order; Buyer may approve it or cancel for a refund of amounts paid less any non-recoverable costs already incurred.` },
    { h: "8. Right to Cancel", body: `Buyer may cancel this Agreement for any reason by written notice delivered within three (3) business days after signing and receive a full refund of any deposit, in accordance with applicable law.` },
    { h: "9. Limitation of Liability", body: `To the maximum extent permitted by law, Seller's total liability arising out of or relating to this Agreement will not exceed the total price paid by Buyer. Neither party is liable for indirect, incidental, special, or consequential damages.` },
    { h: "10. Entire Agreement & Governing Law", body: `This Agreement, together with any executed lender loan documents and written change orders, is the entire agreement between the parties. It is governed by the laws of the state in which the property is located. If any provision is unenforceable, the remainder stays in effect.` },
    { h: "Installer", body: `Installer / contractor of record: ${installer}. License #: ____________________.` },
  ];
}

function buildAgreementPdf(a: Record<string, any>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const dateStr = agDate(a.createdAt || Date.now());
    doc.fontSize(19).fillColor("#6d28d9").text(a.companyName || "Battery Agreement");
    doc.fillColor("#000").fontSize(14).text("Battery Purchase & Installation Agreement").moveDown(0.2);
    doc.fontSize(10).fillColor("#555").text(`Date: ${dateStr}`);
    if (a.reference) doc.text(`Agreement ref: ${a.reference}`);
    doc.fillColor("#000").fontSize(11).moveDown(0.6);

    for (const s of agreementSections(a)) {
      doc.moveDown(0.5).fontSize(12).fillColor("#2a1e55").text(s.h).moveDown(0.1).fillColor("#000").fontSize(10).text(s.body);
    }

    // Signature block — stamped if e-signed.
    doc.moveDown(1.2).fontSize(12).fillColor("#2a1e55").text("Acceptance").fillColor("#000").fontSize(10).moveDown(0.3);
    doc.text("By signing below, Buyer agrees to the terms of this Agreement.");
    doc.moveDown(1);
    if (a.signedName) {
      try {
        if (typeof a.signatureDataUrl === "string" && a.signatureDataUrl.startsWith("data:image")) {
          const b64 = a.signatureDataUrl.split(",")[1];
          doc.image(Buffer.from(b64, "base64"), { width: 200 });
        }
      } catch { /* ignore bad signature image */ }
      doc.fillColor("#2a1e55").text(`Signed electronically by: ${a.signedName}`).fillColor("#000");
      doc.text(`Date: ${agDate(a.signedAt || Date.now())}`);
      if (a.signedIp) doc.fontSize(8).fillColor("#888").text(`IP: ${a.signedIp}`).fillColor("#000").fontSize(10);
    } else {
      doc.text("Buyer signature: ________________________________");
      doc.moveDown(0.6);
      doc.text(`Printed name: ${a.customerName || "________________________________"}`);
      doc.moveDown(0.6);
      doc.text("Date: ________________________________");
    }
    doc.moveDown(1.2);
    doc.text(`Seller: ${a.companyName || ""}    By: ____________________________   (${a.closerName || "Sales representative"})`);

    doc.end();
  });
}

// Closer creates the agreement from the proposal + chosen payment. Returns a
// sign link for on-device signing or to email the customer.
export const createBatteryAgreement = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as Record<string, any>;
  const companyId = caller.companyId || d.companyId || null;
  const company = companyId ? (await db.doc(`companies/${companyId}`).get()).data() || {} : {};
  const id = crypto.randomUUID().replace(/-/g, "");
  const token = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const agreement = {
    customerName: String(d.customerName || "").slice(0, 200),
    customerEmail: String(d.customerEmail || "").slice(0, 200),
    address: String(d.address || "").slice(0, 300),
    companyId,
    companyName: company.name || d.companyName || "",
    closerUid: caller.uid,
    closerName: String(d.closerName || "").slice(0, 200),
    leadId: d.leadId || null,
    eventId: d.eventId || null,
    battery: d.battery || {},
    payment: d.payment || {},
    installerName: company.agreementInstallerName || "",
    templateUrl: company.agreementTemplateUrl || "",
    ccEmails: Array.isArray(company.agreementCcEmails) ? company.agreementCcEmails : [],
    reference: id.slice(0, 8).toUpperCase(),
    signToken: token,
    status: "sent",
    signedName: "",
    signedAt: 0,
    createdAt: now,
  };
  await db.doc(`battery_agreements/${id}`).set(agreement);
  const signUrl = `${APP_URL}/app/?agreement=${id}&t=${token}`;

  // Optionally email the customer the sign link.
  if (d.delivery === "email" && agreement.customerEmail && /.+@.+\..+/.test(agreement.customerEmail)) {
    const first = agreement.customerName.split(" ")[0] || "there";
    const html =
      `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">` +
      `<h2>Your battery agreement is ready to sign</h2>` +
      `<p>Hi ${escHtml(first)}, please review and sign your Battery Purchase &amp; Installation Agreement${agreement.companyName ? ` with ${escHtml(agreement.companyName)}` : ""}.</p>` +
      `<p style="text-align:center;margin:22px 0"><a href="${signUrl}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;padding:13px 26px;border-radius:999px">Review &amp; sign →</a></p>` +
      `<p style="color:#999;font-size:12px">If you didn't request this, you can ignore this email.</p></div>`;
    const cfg = await getNotifyConfig();
    await sendEmailDetailed(cfg, agreement.customerEmail, "Sign your battery agreement", `Review and sign: ${signUrl}`, undefined, html);
  }
  return { ok: true, id, token, signUrl };
});

// Public (no auth): load an agreement for the sign page by id + token.
export const getBatteryAgreement = onCall(async (request) => {
  const d = (request.data || {}) as { id?: string; t?: string };
  const id = String(d.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  const snap = id ? await db.doc(`battery_agreements/${id}`).get() : null;
  if (!snap || !snap.exists) throw new HttpsError("not-found", "This agreement link is no longer available.");
  const a = snap.data() as Record<string, any>;
  if (!d.t || d.t !== a.signToken) throw new HttpsError("permission-denied", "Invalid agreement link.");
  return {
    customerName: a.customerName, address: a.address, companyName: a.companyName,
    battery: a.battery, payment: a.payment, reference: a.reference,
    sections: agreementSections(a), templateUrl: a.templateUrl || "",
    status: a.status, signedName: a.signedName || "", signedAt: a.signedAt || 0,
  };
});

// Public (no auth): record the signature, email the signed copy to everyone,
// notify the company, mark the appointment closed/won, and record the sale.
export const signBatteryAgreement = onCall(async (request) => {
  const d = (request.data || {}) as { id?: string; t?: string; name?: string; signatureDataUrl?: string };
  const id = String(d.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  const ref = id ? db.doc(`battery_agreements/${id}`) : null;
  const snap = ref ? await ref.get() : null;
  if (!ref || !snap || !snap.exists) throw new HttpsError("not-found", "Agreement not found.");
  const a = snap.data() as Record<string, any>;
  if (!d.t || d.t !== a.signToken) throw new HttpsError("permission-denied", "Invalid agreement link.");
  if (a.status === "signed") return { ok: true, alreadySigned: true };
  const name = String(d.name || "").trim();
  if (!name) throw new HttpsError("invalid-argument", "Please type your full name to sign.");

  const now = Date.now();
  const sig = typeof d.signatureDataUrl === "string" && d.signatureDataUrl.startsWith("data:image") ? d.signatureDataUrl.slice(0, 400_000) : "";
  const ip = (request.rawRequest?.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || "";
  const signed = { ...a, signedName: name, signedAt: now, signedIp: ip, signatureDataUrl: sig, status: "signed" };
  await ref.set({ signedName: name, signedAt: now, signedIp: ip, signatureDataUrl: sig, status: "signed", updatedAt: now }, { merge: true });

  // Build the signed PDF once.
  let pdf: Buffer | null = null;
  try { pdf = await buildAgreementPdf(signed); } catch (e) { logger.warn("agreement pdf failed", e); }
  const attachments = pdf ? [{ filename: `Battery-Agreement-${a.reference}.pdf`, content: pdf.toString("base64"), type: "application/pdf" }] : undefined;

  // Recipients: customer + closer + company admins/managers + configured CCs.
  const recipients = new Set<string>();
  if (a.customerEmail) recipients.add(a.customerEmail);
  (a.ccEmails || []).forEach((e: string) => { if (e) recipients.add(e); });
  try {
    const closer = a.closerUid ? (await db.doc(`users/${a.closerUid}`).get()).data() : null;
    if (closer?.email) recipients.add(closer.email);
    if (a.companyId) {
      const mgrs = await db.collection("users").where("companyId", "==", a.companyId).where("role", "in", ["admin", "manager"]).get();
      mgrs.forEach((u) => { const e = (u.data() as any).email; if (e) recipients.add(e); });
    }
  } catch (e) { logger.warn("agreement recipients lookup failed", e); }

  const cfg = await getNotifyConfig();
  const subject = `Signed battery agreement — ${a.customerName || ""} (${a.reference})`;
  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">` +
    `<h2>Agreement signed ✅</h2>` +
    `<p><strong>${escHtml(a.customerName || "")}</strong> signed the Battery Purchase &amp; Installation Agreement${a.companyName ? ` with ${escHtml(a.companyName)}` : ""} on ${agDate(now)}.</p>` +
    `<p>${escHtml(a.address || "")}</p>` +
    `<p>A copy of the signed agreement is attached.</p></div>`;
  for (const to of recipients) {
    try { await sendEmailDetailed(cfg, to, subject, `${a.customerName} signed the agreement (${a.reference}).`, attachments, html); } catch (e) { logger.warn(`agreement email to ${to} failed`, e); }
  }

  // Record the sale.
  try {
    await db.doc(`soldCustomers/${id}`).set({
      agreementId: id, companyId: a.companyId, closerUid: a.closerUid, customerName: a.customerName,
      customerEmail: a.customerEmail, address: a.address, battery: a.battery, payment: a.payment,
      leadId: a.leadId, eventId: a.eventId, reference: a.reference, signedName: name, signedAt: now,
      status: "sold", createdAt: now,
    }, { merge: true });
  } catch (e) { logger.warn("soldCustomers write failed", e); }

  // Auto-disposition the appointment as Closed / Won.
  if (a.eventId) {
    try {
      await db.doc(`events/${a.eventId}`).set({
        apptStatus: "closed_won",
        apptNotes: `Battery agreement signed by ${name} (ref ${a.reference}).`,
        dispositionedAt: now, agreementId: id, updatedAt: now,
      }, { merge: true });
    } catch (e) { logger.warn("auto-disposition failed", e); }
  }
  if (a.leadId) {
    try { await db.doc(`leads/${a.leadId}`).set({ status: "sold", soldAt: now, agreementId: id }, { merge: true }); } catch { /* best effort */ }
  }

  return { ok: true };
});

// Sold projects for the field app. Reps see only their own (bullet summary);
// admins/managers see the whole company with full survey detail.
export const listMyProjects = onCall(async (request) => {
  const caller = await getCaller(request);
  const isMgr = caller.isSuper || caller.role === "admin" || caller.role === "manager";
  if (!caller.companyId && !caller.isSuper) return { items: [], isManager: false };
  let q: FirebaseFirestore.Query = db.collection("soldCustomers");
  if (isMgr) q = q.where("companyId", "==", caller.companyId);
  else q = q.where("closerUid", "==", caller.uid);
  let snap;
  try { snap = await q.get(); } catch (e) { logger.warn("listMyProjects query failed", e); return { items: [], isManager: isMgr }; }
  const items = snap.docs.map((doc) => {
    const x = doc.data() as Record<string, any>;
    const bat = x.battery || {};
    const pay = x.payment || {};
    const base = {
      id: doc.id,
      customerName: x.customerName || "",
      address: x.address || "",
      battery: `${bat.units || 1}× ${bat.brand || ""} ${bat.model || ""}`.trim(),
      batteryProductId: bat.productId || "",
      paymentMethod: pay.method || "",
      reference: x.reference || "",
      status: x.surveyStatus || "needs_survey",
      signedAt: x.signedAt || 0,
      submittedAt: x.surveySubmittedAt || 0,
    };
    // Admin/manager (and the PM portal) get the full record.
    return isMgr
      ? {
          ...base,
          customerEmail: x.customerEmail || "",
          signedName: x.signedName || "",
          payment: pay,
          batteryDetail: bat,
          survey: x.survey || null,
          placement: x.placement || [],
          surveyNotes: x.surveyNotes || "",
          surveyScheduledFor: x.surveyScheduledFor || 0,
          pmStatus: x.pmStatus || "",
          pmNotes: x.pmNotes || "",
          installerName: x.installerName || "",
          installDate: x.installDate || 0,
        }
      : base;
  });
  items.sort((a, b) => (b.signedAt || 0) - (a.signedAt || 0));
  return { items, isManager: isMgr };
});

// A rep submits the placement photos + site survey for a sold project; notify
// the company's project managers/admins for review.
export const submitProjectSurvey = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    projectId?: string;
    placement?: Array<{ url?: string; note?: string }>;
    survey?: { photos?: Record<string, string>; checklist?: Record<string, boolean> };
    notes?: string;
  };
  const id = String(d.projectId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!id) throw new HttpsError("invalid-argument", "Missing project id.");
  const ref = db.doc(`soldCustomers/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Project not found.");
  const proj = snap.data() as Record<string, any>;
  const isMgr = caller.isSuper || (caller.companyId === proj.companyId && (caller.role === "admin" || caller.role === "manager"));
  if (proj.closerUid !== caller.uid && !isMgr) throw new HttpsError("permission-denied", "Not your project.");

  const placement = (Array.isArray(d.placement) ? d.placement : [])
    .slice(0, 3)
    .map((p) => ({ url: String(p?.url || "").slice(0, 800), note: String(p?.note || "").slice(0, 300) }))
    .filter((p) => p.url);
  const photos: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.survey?.photos || {})) {
    if (typeof v === "string" && v) photos[k.slice(0, 40)] = v.slice(0, 800);
  }
  const checklist: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(d.survey?.checklist || {})) checklist[k.slice(0, 40)] = !!v;

  const now = Date.now();
  await ref.set({
    placement,
    survey: { photos, checklist },
    surveyNotes: String(d.notes || "").slice(0, 2000),
    surveyStatus: "submitted_for_review",
    surveySubmittedAt: now,
    surveySubmittedBy: caller.uid,
    updatedAt: now,
  }, { merge: true });

  // Notify the company's PMs/admins.
  try {
    const recipients = new Set<string>();
    (proj.ccEmails || []).forEach((e: string) => { if (e) recipients.add(e); });
    if (proj.companyId) {
      const mgrs = await db.collection("users").where("companyId", "==", proj.companyId).where("role", "in", ["admin", "manager"]).get();
      mgrs.forEach((u) => { const e = (u.data() as any).email; if (e) recipients.add(e); });
    }
    if (recipients.size) {
      const cfg = await getNotifyConfig();
      const subject = `Site survey submitted — ${proj.customerName || ""} (${proj.reference || id.slice(0, 8)})`;
      const html =
        `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">` +
        `<h2>Site survey ready for review</h2>` +
        `<p><strong>${escHtml(proj.customerName || "")}</strong> — ${escHtml(proj.address || "")}</p>` +
        `<p>${placement.length} placement photo(s) and ${Object.keys(photos).length} survey photo(s) submitted by the sales rep. Open the admin portal to review and schedule.</p></div>`;
      for (const to of recipients) {
        try { await sendEmailDetailed(cfg, to, subject, `${proj.customerName} site survey submitted for review.`, undefined, html); } catch { /* best effort */ }
      }
    }
  } catch (e) { logger.warn("survey notify failed", e); }

  return { ok: true };
});

// Schedule the site survey for later instead of doing it now. Saves the AR
// placement photos already taken, creates a site-survey calendar event for the
// rep, and notifies the company.
export const scheduleSiteSurvey = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    projectId?: string;
    startAt?: number;
    placement?: Array<{ url?: string; note?: string }>;
    notes?: string;
  };
  const id = String(d.projectId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!id) throw new HttpsError("invalid-argument", "Missing project id.");
  if (!d.startAt || d.startAt < Date.now() - 86400000) throw new HttpsError("invalid-argument", "Pick a valid date/time.");
  const ref = db.doc(`soldCustomers/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Project not found.");
  const proj = snap.data() as Record<string, any>;
  const isMgr = caller.isSuper || (caller.companyId === proj.companyId && (caller.role === "admin" || caller.role === "manager"));
  if (proj.closerUid !== caller.uid && !isMgr) throw new HttpsError("permission-denied", "Not your project.");

  const placement = (Array.isArray(d.placement) ? d.placement : [])
    .slice(0, 3)
    .map((p) => ({ url: String(p?.url || "").slice(0, 800), note: String(p?.note || "").slice(0, 300) }))
    .filter((p) => p.url);

  const now = Date.now();
  const me = (await db.doc(`users/${caller.uid}`).get()).data() as any || {};
  const visibility = Array.from(new Set([caller.uid, ...((me.managerPath as string[]) || []), ...((me.closerManagerPath as string[]) || [])]));
  const ev = {
    companyId: proj.companyId || caller.companyId || "",
    userId: caller.uid,
    userName: me.displayName || me.email || "",
    type: "site_survey",
    title: `Site survey — ${proj.customerName || ""}`.trim(),
    address: proj.address || "",
    phone: proj.phone || proj.phoneNumber || null,
    leadId: proj.leadId || null,
    projectId: id,
    customerName: proj.customerName || "",
    startAt: d.startAt,
    endAt: d.startAt + 60 * 60 * 1000,
    durationMin: 60,
    source: "site_survey",
    notes: String(d.notes || "").slice(0, 2000),
    apptStatus: "scheduled",
    visibilityPath: visibility,
    reminded: false,
    createdAt: now,
  };
  const evRef = await db.collection("events").add(ev);

  await ref.set({
    placement,
    surveyNotes: String(d.notes || "").slice(0, 2000),
    surveyStatus: "survey_scheduled",
    surveyScheduledFor: d.startAt,
    surveyEventId: evRef.id,
    updatedAt: now,
  }, { merge: true });

  // Notify PMs/admins.
  try {
    const recipients = new Set<string>();
    (proj.ccEmails || []).forEach((e: string) => { if (e) recipients.add(e); });
    if (proj.companyId) {
      const mgrs = await db.collection("users").where("companyId", "==", proj.companyId).where("role", "in", ["admin", "manager"]).get();
      mgrs.forEach((u) => { const e = (u.data() as any).email; if (e) recipients.add(e); });
    }
    if (recipients.size) {
      const cfg = await getNotifyConfig();
      const when = agDate(d.startAt);
      const subject = `Site survey scheduled — ${proj.customerName || ""} (${proj.reference || id.slice(0, 8)})`;
      const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111"><h2>Site survey scheduled</h2><p><strong>${escHtml(proj.customerName || "")}</strong> — ${escHtml(proj.address || "")}</p><p>Scheduled for <strong>${escHtml(when)}</strong>. ${placement.length} placement photo(s) already captured.</p></div>`;
      for (const to of recipients) { try { await sendEmailDetailed(cfg, to, subject, `Site survey for ${proj.customerName} scheduled ${when}.`, undefined, html); } catch { /* best effort */ } }
    }
  } catch (e) { logger.warn("schedule notify failed", e); }

  return { ok: true };
});

// PM portal: advance a project through the install pipeline. Manager/admin only.
const PM_STAGES = ["review", "approved", "permitting", "scheduled", "installed", "on_hold"];
export const updateProjectStatus = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as { projectId?: string; pmStatus?: string; pmNotes?: string; installerName?: string; installDate?: number };
  const id = String(d.projectId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!id) throw new HttpsError("invalid-argument", "Missing project id.");
  const ref = db.doc(`soldCustomers/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Project not found.");
  const proj = snap.data() as Record<string, any>;
  const isMgr = caller.isSuper || (caller.companyId === proj.companyId && (caller.role === "admin" || caller.role === "manager"));
  if (!isMgr) throw new HttpsError("permission-denied", "Project-management access required.");

  const now = Date.now();
  const patch: Record<string, unknown> = { updatedAt: now };
  if (d.pmStatus !== undefined) {
    const s = String(d.pmStatus || "");
    if (s && !PM_STAGES.includes(s)) throw new HttpsError("invalid-argument", "Unknown stage.");
    patch.pmStatus = s;
    patch.pmStatusAt = now;
  }
  if (d.pmNotes !== undefined) patch.pmNotes = String(d.pmNotes || "").slice(0, 4000);
  if (d.installerName !== undefined) patch.installerName = String(d.installerName || "").slice(0, 200);
  if (d.installDate !== undefined) patch.installDate = Math.max(0, Number(d.installDate) || 0);
  await ref.set(patch, { merge: true });

  // Let the rep know when the stage changes.
  if (d.pmStatus && proj.closerUid) {
    try {
      const closer = (await db.doc(`users/${proj.closerUid}`).get()).data() as any;
      if (closer?.email) {
        const cfg = await getNotifyConfig();
        const label = String(d.pmStatus).replace(/_/g, " ");
        await sendEmailDetailed(cfg, closer.email, `Project update — ${proj.customerName || ""}`, `Your deal ${proj.customerName || ""} (${proj.reference || ""}) is now: ${label}.`, undefined,
          `<div style="font-family:system-ui,Arial,sans-serif"><p>Your deal <strong>${escHtml(proj.customerName || "")}</strong> (${escHtml(proj.reference || "")}) is now: <strong>${escHtml(label)}</strong>.</p>${d.installDate ? `<p>Install date: <strong>${escHtml(agDate(Number(d.installDate)))}</strong></p>` : ""}</div>`);
      }
    } catch (e) { logger.warn("pm status notify failed", e); }
  }
  return { ok: true };
});

// Admin: set company-wide battery pricing (price + install adder per product).
export const setBatteryPricing = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, pricing, offered, depositUsd, depositPct, sungageApplyUrl, agreementInstallerName, agreementCcEmails, agreementTemplateUrl, financeOptions } = (request.data || {}) as {
    companyId?: string;
    pricing?: Record<string, { price?: number; adder?: number }>;
    offered?: string[];
    depositUsd?: number;
    depositPct?: number;
    sungageApplyUrl?: string;
    agreementInstallerName?: string;
    agreementCcEmails?: string[];
    agreementTemplateUrl?: string;
    financeOptions?: any[];
  };
  authorizeForCompany(caller, companyId);
  const clean: Record<string, { price: number; adder: number }> = {};
  for (const [pid, v] of Object.entries(pricing || {})) {
    const price = Math.max(0, Number(v?.price) || 0);
    const adder = Math.max(0, Number(v?.adder) || 0);
    if (price > 0 || adder > 0) clean[pid] = { price, adder };
  }
  const patch: Record<string, unknown> = { batteryPricing: clean, batteryPricingUpdatedAt: Date.now() };
  // Which products the company offers its reps. Only stored when provided so we
  // can treat "unset" as "offer everything" for existing companies.
  if (Array.isArray(offered)) patch.batteryOffered = offered.filter((x) => typeof x === "string").slice(0, 50);
  // Proposal pricing-slide settings (only written when provided).
  if (depositUsd !== undefined) patch.batteryDepositUsd = Math.max(0, Math.round(Number(depositUsd) || 0));
  if (depositPct !== undefined) patch.batteryDepositPct = Math.max(0, Math.min(100, Number(depositPct) || 0));
  if (sungageApplyUrl !== undefined) patch.sungageApplyUrl = String(sungageApplyUrl || "").trim().slice(0, 600);
  if (agreementInstallerName !== undefined) patch.agreementInstallerName = String(agreementInstallerName || "").trim().slice(0, 200);
  if (agreementTemplateUrl !== undefined) patch.agreementTemplateUrl = String(agreementTemplateUrl || "").trim().slice(0, 600);
  if (agreementCcEmails !== undefined) {
    patch.agreementCcEmails = (Array.isArray(agreementCcEmails) ? agreementCcEmails : [])
      .map((e) => String(e || "").trim()).filter((e) => /.+@.+\..+/.test(e)).slice(0, 20);
  }
  // Company-configurable proposal financing plans (dealer fees, APR, terms, and
  // which lender). Only the enabled ones are shown on the proposal.
  if (Array.isArray(financeOptions)) {
    const pctClamp = (v: unknown) => Math.max(0, Math.min(0.9999, Number(v) || 0));
    patch.financeOptions = financeOptions.slice(0, 12).map((o: any, i: number) => {
      const kind = ["escalator", "deferred", "level"].includes(o?.kind) ? o.kind : "level";
      const opt: Record<string, unknown> = {
        id: (String(o?.id || "").trim() || `fin${i}`).slice(0, 40),
        name: (String(o?.name || "").trim() || "Financing plan").slice(0, 80),
        financeCompany: String(o?.financeCompany || "").trim().slice(0, 80),
        blurb: String(o?.blurb || "").trim().slice(0, 200),
        termYears: Math.max(1, Math.min(40, Math.round(Number(o?.termYears) || 20))),
        apr: pctClamp(o?.apr),
        dealerFee: pctClamp(o?.dealerFee),
        kind,
        applyUrl: String(o?.applyUrl || "").trim().slice(0, 600),
        enabled: o?.enabled !== false,
      };
      if (kind === "escalator") opt.escalator = pctClamp(o?.escalator);
      if (kind === "deferred") {
        opt.deferMonths = Math.max(0, Math.min(120, Math.round(Number(o?.deferMonths) || 0)));
        opt.deferPct = pctClamp(o?.deferPct);
      }
      return opt;
    });
  }
  await db.doc(`companies/${companyId}`).set(patch, { merge: true });
  return { ok: true };
});

// Save a company's Battery Field Playbook overrides (rate-reality copy + utility
// export rates + savings-calculator numbers). The app deep-merges these over the
// built-in regional default, so admins keep the playbook current as utility
// rates change without a code deploy. Company admin / super-admin only.
export const setBatteryPlaybook = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, playbook } = (request.data || {}) as { companyId?: string; playbook?: any };
  authorizeForCompany(caller, companyId);
  const p = (playbook && typeof playbook === "object") ? playbook : {};
  const str = (v: unknown, n = 2000) => String(v ?? "").slice(0, n);
  const out: Record<string, unknown> = {};

  if (p.rateAngle && typeof p.rateAngle === "object") {
    out.rateAngle = {
      headline: str(p.rateAngle.headline, 200),
      body: str(p.rateAngle.body, 1200),
      analogy: str(p.rateAngle.analogy, 1200),
    };
  }
  if (Array.isArray(p.utilities)) {
    out.utilities = p.utilities.slice(0, 12).map((u: any) => ({
      name: str(u?.name, 120),
      sub: str(u?.sub, 160),
      heat: ["warm", "hot", "max"].includes(u?.heat) ? u.heat : "warm",
      pay: str(u?.pay, 40),
      getLabel: str(u?.getLabel, 60),
      getValue: str(u?.getValue, 60),
      gap: str(u?.gap, 800),
      angle: str(u?.angle, 800),
      hoods: Array.isArray(u?.hoods) ? u.hoods.slice(0, 12).map((h: any) => str(h, 60)) : [],
    }));
  }
  if (Array.isArray(p.savingsUtilities)) {
    out.savingsUtilities = p.savingsUtilities.slice(0, 12).map((u: any) => ({
      name: str(u?.name, 120),
      pay: Math.max(0, Number(u?.pay) || 0),
      get: Math.max(0, Number(u?.get) || 0),
    }));
  }
  await db.doc(`companies/${companyId}`).set(
    { batteryPlaybook: out, batteryPlaybookUpdatedAt: Date.now() }, { merge: true },
  );
  return { ok: true };
});

// Analyze an uploaded utility bill or solar-production document (image or PDF)
// with Claude vision and return structured numbers for the battery tool.
export const analyzeEnergyDocument = onCall({ timeoutSeconds: 120 }, async (request) => {
  await getCaller(request);
  const { base64, mediaType, kind } = (request.data || {}) as { base64?: string; mediaType?: string; kind?: "bill" | "solar" };
  if (!base64 || !mediaType) throw new HttpsError("invalid-argument", "A file (base64 + mediaType) is required.");
  // ~7MB raw → ~9.5MB base64; keep within the callable payload ceiling.
  if (base64.length > 9_500_000) throw new HttpsError("invalid-argument", "File too large — please upload one under 7 MB.");
  const cfg = await readAiConfig();
  if (!cfg.anthropicKey) throw new HttpsError("failed-precondition", "Document analysis isn't configured — ask your admin to add an Anthropic key.");
  const isPdf = mediaType === "application/pdf";
  const fileBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
  const ask = kind === "solar"
    ? 'This is a solar-monitoring screenshot or report. Extract the PV system + production info. Reply with ONLY a JSON object (no prose): {"systemKwDc":<number|null>,"annualProductionKWh":<number|null>,"monthlyProductionKWh":<number|null>,"inverterBrand":<string|null>,"notes":"<what you saw / caveats>"}.'
    : 'This is a residential electricity (utility) bill. Extract usage + cost. Reply with ONLY a JSON object (no prose): {"monthlyKWh":<number|null>,"monthlyCost":<number|null>,"ratePerKWh":<number|null>,"utilityName":<string|null>,"billingDays":<number|null>,"notes":"<what you saw / caveats>"}. If the bill shows a billing period other than a month, still report the monthly figures (normalize to ~30 days).';
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.anthropicModel, max_tokens: 700,
      messages: [{ role: "user", content: [fileBlock, { type: "text", text: ask }] }],
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpsError("internal", json?.error?.message || `Document analysis failed (${res.status})`);
  const text = (Array.isArray(json.content) ? json.content : []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  let data: any = {};
  try { data = m ? JSON.parse(m[0]) : {}; } catch { data = {}; }
  return { kind: kind || "bill", data };
});

// Real imagery of the customer's home for the proposal hero — Street View (if the
// address has coverage) with a satellite/aerial fallback. Images are returned as
// base64 data URIs so the Google Maps key never leaves the server.
export const getHomeImagery = onCall({ timeoutSeconds: 60 }, async (request) => {
  await getCaller(request);
  let { lat, lng } = (request.data || {}) as { lat?: number; lng?: number };
  const { address } = (request.data || {}) as { address?: string };
  await refreshApiConfig();
  if (!GMAPS.key) throw new HttpsError("failed-precondition", "Home imagery isn't configured — ask your admin to add a Google Maps API key.");
  const key = GMAPS.key;
  // Geocode the address when we don't already have coordinates.
  if ((typeof lat !== "number" || typeof lng !== "number") && address) {
    try {
      const g: any = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`)).json();
      const loc = g?.results?.[0]?.geometry?.location;
      if (loc) { lat = loc.lat; lng = loc.lng; }
    } catch (e) { logger.warn("geocode failed", e); }
  }
  if (typeof lat !== "number" || typeof lng !== "number") throw new HttpsError("invalid-argument", "Need an address or coordinates.");
  const fetchImg = async (url: string): Promise<string | null> => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const ct = r.headers.get("content-type") || "image/jpeg";
      if (!ct.startsWith("image/")) return null; // Google returns JSON on error
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1500) return null; // tiny = "no imagery" placeholder
      return `data:${ct};base64,${buf.toString("base64")}`;
    } catch { return null; }
  };
  // Street View coverage check first (avoids the gray "no image" tile).
  let hasStreetView = false;
  try {
    const meta: any = await (await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${key}`)).json();
    hasStreetView = meta?.status === "OK";
  } catch { /* fall back to satellite */ }
  const [streetView, satellite] = await Promise.all([
    hasStreetView ? fetchImg(`https://maps.googleapis.com/maps/api/streetview?size=640x360&location=${lat},${lng}&fov=78&pitch=8&source=outdoor&key=${key}`) : Promise.resolve(null),
    fetchImg(`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=640x360&maptype=satellite&key=${key}`),
  ]);
  return { streetView, satellite, hasStreetView: !!streetView, lat, lng };
});

// Forward-geocode a typed address → coordinates, so the map's address search
// can fly straight to a property even when there's no lead pin there yet.
export const geocodeAddress = onCall(async (request) => {
  await getCaller(request);
  const { address } = (request.data || {}) as { address?: string };
  const q = String(address || "").trim();
  if (!q) throw new HttpsError("invalid-argument", "Enter an address to search.");
  await refreshApiConfig();
  if (!GMAPS.key) throw new HttpsError("failed-precondition", "Address search isn't configured — ask your admin to add a Google Maps API key.");
  try {
    const g: any = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${GMAPS.key}`)).json();
    const r = g?.results?.[0];
    const loc = r?.geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return { found: false as const };
    }
    return { found: true as const, lat: loc.lat, lng: loc.lng, formatted: r.formatted_address || q };
  } catch (e) {
    logger.warn("geocodeAddress failed", e);
    throw new HttpsError("internal", "Couldn't look up that address — try again.");
  }
});

// Type-ahead address suggestions for the map search box (Google Places
// Autocomplete). Returns lightweight predictions; the client geocodes the one
// the rep picks. Key stays server-side.
export const addressAutocomplete = onCall(async (request) => {
  await getCaller(request);
  const { input, types } = (request.data || {}) as { input?: string; types?: string };
  const q = String(input || "").trim();
  if (q.length < 3) return { predictions: [] as string[] };
  await refreshApiConfig();
  if (!GMAPS.key) return { predictions: [] as string[] };
  // "address" (default) = street addresses only, for the pin search. "geocode"
  // = addresses + cities + ZIP codes, for the market-recommendations search.
  const t = types === "geocode" ? "geocode" : "address";
  try {
    // Preferred: Google Places Autocomplete. This needs the *Places API* enabled
    // on the key (separate from the Geocoding API the map's "Go"/reverse-geocode
    // already use) — if it isn't, Google returns REQUEST_DENIED and no
    // predictions, which is the usual reason the box shows nothing.
    const u = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&types=${t}&components=country:us&key=${GMAPS.key}`;
    const g: any = await (await fetch(u)).json();
    if (g?.status && g.status !== "OK" && g.status !== "ZERO_RESULTS") {
      logger.warn(`addressAutocomplete: Places status=${g.status}`, g?.error_message || "");
    }
    let predictions = (g?.predictions || [])
      .map((p: any) => String(p?.description || ""))
      .filter(Boolean)
      .slice(0, 5);
    // Fallback: if Places returned nothing (or is disabled on the key), derive
    // suggestions from the Geocoding API — which is already enabled — so the box
    // still helps even without the Places API turned on.
    if (predictions.length === 0) {
      const gu = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:US&key=${GMAPS.key}`;
      const gc: any = await (await fetch(gu)).json();
      predictions = Array.from(new Set(
        (gc?.results || []).map((r: any) => String(r?.formatted_address || "")).filter(Boolean),
      )).slice(0, 5) as string[];
    }
    return { predictions, status: String(g?.status || "") };
  } catch (e) {
    logger.warn("addressAutocomplete failed", e);
    return { predictions: [] as string[], status: "ERROR" };
  }
});

// Reverse-geocode a map point → the nearest street address, so a long-press on
// a home fills in its address (the disposition modal then pulls owner info).
export const reverseGeocode = onCall(async (request) => {
  await getCaller(request);
  const { lat, lng } = (request.data || {}) as { lat?: number; lng?: number };
  if (typeof lat !== "number" || typeof lng !== "number") throw new HttpsError("invalid-argument", "Need a map location.");
  await refreshApiConfig();
  if (!GMAPS.key) throw new HttpsError("failed-precondition", "Address lookup isn't configured — ask your admin to add a Google Maps API key.");
  try {
    // Don't hard-filter to street_address — a rooftop tap often only resolves to
    // a premise/subpremise/route, and filtering those out returned an empty
    // address (leads then got logged with no address and couldn't enrich).
    // Take the best rooftop-ish result, else the first result Google returns.
    const g: any = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GMAPS.key}`)).json();
    const results: any[] = Array.isArray(g?.results) ? g.results : [];
    const rank = ["street_address", "premise", "subpremise", "route"];
    const best =
      rank.map((t) => results.find((r) => (r?.types || []).includes(t))).find(Boolean) ||
      results[0];
    const address = String(best?.formatted_address || "");
    // Also hand back the matched address's rooftop/parcel coordinate so the
    // caller can SNAP the pin onto the actual home instead of leaving it at the
    // raw spot the rep tapped (which can be a yard, the street, or water).
    const loc = best?.geometry?.location;
    const snapLat = loc && typeof loc.lat === "number" ? loc.lat : null;
    const snapLng = loc && typeof loc.lng === "number" ? loc.lng : null;
    return { address, lat: snapLat, lng: snapLng };
  } catch (e) {
    logger.warn("reverseGeocode failed", e);
    throw new HttpsError("internal", "Couldn't look up that home — try again.");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STRIPE BILLING — checkout, billing portal, and a webhook that flips a
// company's status from the live subscription state. Keys live in config/billing
// (set in the super-admin screen).
// ════════════════════════════════════════════════════════════════════════════
async function stripeClient() {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (!c.stripeSecretKey) throw new HttpsError("failed-precondition", "Stripe isn't configured. Add keys in the admin console.");
  return new Stripe(c.stripeSecretKey);
}

// Map a Stripe subscription status → our company status vocabulary.
function mapSubStatus(s: string): string {
  switch (s) {
    case "active": return "active";
    case "trialing": return "trial";
    case "past_due": case "unpaid": return "past_due";
    case "canceled": case "incomplete_expired": return "suspended";
    default: return "trial";
  }
}

// ── Billing helpers: mirror Stripe invoices + notify company admins ──────────
const BILLING_INTERVAL_DAYS = 30;

async function companyAdminEmails(companyId: string): Promise<string[]> {
  try {
    const s = await db.collection("users").where("companyId", "==", companyId).where("role", "==", "admin").get();
    return s.docs.map((d) => (d.data().email as string) || "").filter(Boolean);
  } catch { return []; }
}

// Upsert a Stripe invoice into invoices/{id} so it shows in-app (AR + profiles).
async function mirrorInvoice(inv: any): Promise<{ companyId: string } | null> {
  let companyId: string | null = inv?.subscription_details?.metadata?.companyId || inv?.metadata?.companyId || null;
  let companyName = "";
  if (companyId) {
    companyName = (await db.doc(`companies/${companyId}`).get()).data()?.name || "";
  } else if (inv?.customer) {
    const s = await db.collection("companies").where("stripeCustomerId", "==", inv.customer).limit(1).get();
    if (!s.empty) { companyId = s.docs[0].id; companyName = s.docs[0].data().name || ""; }
  }
  if (!companyId) return null;
  const lines = ((inv.lines && inv.lines.data) || []).map((l: any) => ({
    description: l.description || "Subscription", amount: l.amount,
  }));
  await db.doc(`invoices/${inv.id}`).set({
    stripeInvoiceId: inv.id, companyId, companyName,
    number: inv.number || "", status: inv.status || "open",
    amountDue: inv.amount_due ?? 0, amountPaid: inv.amount_paid ?? 0, currency: inv.currency || "usd",
    created: (inv.created || 0) * 1000,
    dueDate: inv.due_date ? inv.due_date * 1000 : (inv.next_payment_attempt ? inv.next_payment_attempt * 1000 : null),
    periodStart: inv.period_start ? inv.period_start * 1000 : null,
    periodEnd: inv.period_end ? inv.period_end * 1000 : null,
    hostedInvoiceUrl: inv.hosted_invoice_url || "", invoicePdf: inv.invoice_pdf || "",
    lines, updatedAt: Date.now(),
  }, { merge: true });
  return { companyId };
}

// Start a Checkout session for a company + plan; returns the hosted URL.
export const createCheckoutSession = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, planId } = (request.data || {}) as { companyId?: string; planId?: string };
  authorizeForCompany(caller, companyId);
  if (!planId) throw new HttpsError("invalid-argument", "planId required.");
  const planSnap = await db.doc(`plans/${planId}`).get();
  if (!planSnap.exists) throw new HttpsError("not-found", "Plan not found.");
  const plan = planSnap.data()!;
  if (!plan.stripePriceId) throw new HttpsError("failed-precondition", `Plan "${plan.name}" has no Stripe Price ID.`);
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  const stripe = await stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: plan.stripePriceId as string, quantity: 1 }],
    customer: (company.stripeCustomerId as string) || undefined,
    success_url: `${APP_URL}/admin.html?billing=success`,
    cancel_url: `${APP_URL}/admin.html?billing=cancel`,
    metadata: { companyId: companyId!, planId, planName: (plan.name as string) || "" },
    subscription_data: { metadata: { companyId: companyId!, planId } },
  });
  return { url: session.url };
});

// Open the Stripe billing portal for an already-subscribed company.
export const createBillingPortalSession = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId } = (request.data || {}) as { companyId?: string };
  authorizeForCompany(caller, companyId);
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  if (!company.stripeCustomerId) throw new HttpsError("failed-precondition", "No subscription yet for this company.");
  const stripe = await stripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: company.stripeCustomerId as string,
    return_url: `${APP_URL}/admin.html`,
  });
  return { url: session.url };
});

// Stripe webhook (Hosting rewrites /stripe/** here). Verifies the signature and
// syncs the company's subscription state. Configure the URL + signing secret in
// the Stripe Dashboard, then paste the signing secret in the admin console.
export const stripeWebhook = onRequest({ cors: false }, async (req, res) => {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (!c.stripeSecretKey || !c.stripeWebhookSecret) { res.status(503).send("Stripe not configured"); return; }
  const stripe = new Stripe(c.stripeSecretKey);
  let event: { type: string; data: { object: any } };
  try {
    const sig = req.headers["stripe-signature"] as string;
    event = stripe.webhooks.constructEvent((req as unknown as { rawBody: Buffer }).rawBody, sig, c.stripeWebhookSecret);
  } catch (e: any) {
    logger.warn("Stripe webhook signature failed", e?.message);
    res.status(400).send(`Webhook Error: ${e?.message}`);
    return;
  }

  try {
    const obj = event.data.object as any;
    if (event.type === "checkout.session.completed") {
      const companyId = obj.metadata?.companyId;
      if (companyId) {
        const u: Record<string, unknown> = {
          stripeCustomerId: obj.customer, stripeSubscriptionId: obj.subscription,
          status: "active", trialEndsAt: 0, trialExpired: false, updatedAt: Date.now(),
        };
        const planId = obj.metadata?.planId;
        if (planId) {
          const p = await db.doc(`plans/${planId}`).get();
          if (p.exists) {
            const pd = p.data()!;
            u.plan = pd.name; u.planId = planId;
            u.features = Array.isArray(pd.features) ? pd.features : [];
            u.maxUsers = Number(pd.maxUsers) || 0;
            u.planPrice = Number(pd.priceMonthly) || 0;
          }
        }
        await db.doc(`companies/${companyId}`).set(u, { merge: true });
      }
    } else if (event.type.startsWith("customer.subscription.")) {
      const status = mapSubStatus(obj.status);
      const patch: Record<string, unknown> = { status, updatedAt: Date.now() };
      if (obj.current_period_end) patch.nextBillingAt = obj.current_period_end * 1000;
      const companyId = obj.metadata?.companyId;
      if (companyId) {
        await db.doc(`companies/${companyId}`).set(patch, { merge: true });
      } else if (obj.customer) {
        const snap = await db.collection("companies").where("stripeCustomerId", "==", obj.customer).limit(1).get();
        if (!snap.empty) await snap.docs[0].ref.set(patch, { merge: true });
      }
    } else if (event.type.startsWith("invoice.")) {
      // Mirror every invoice for in-app viewing, and drive dunning / reactivation.
      const res2 = await mirrorInvoice(obj);
      if (res2) {
        const ref = db.doc(`companies/${res2.companyId}`);
        if (event.type === "invoice.payment_failed") {
          const c = (await ref.get()).data() || {};
          const patch: Record<string, unknown> = { status: "past_due", updatedAt: Date.now() };
          if (!c.pastDueSince) patch.pastDueSince = Date.now(); // start the 3-day grace clock
          await ref.set(patch, { merge: true });
          const cfg = await getNotifyConfig();
          const amt = ((obj.amount_due || 0) / 100).toFixed(2);
          for (const to of await companyAdminEmails(res2.companyId)) {
            await sendEmail(cfg, to, "Payment failed — action needed",
              `We couldn't process your YoutilityKnock payment of $${amt}. Please update the card on file to avoid interruption — your account will be paused if payment isn't received within 3 days.${obj.hosted_invoice_url ? "\n\nPay now: " + obj.hosted_invoice_url : ""}`);
          }
        } else if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
          const patch: Record<string, unknown> = { status: "active", pastDueSince: 0, billingHold: false, updatedAt: Date.now() };
          const periodEnd = obj.lines?.data?.[0]?.period?.end;
          if (periodEnd) patch.nextBillingAt = periodEnd * 1000;
          await ref.set(patch, { merge: true });
        }
      }
    }
    res.json({ received: true });
  } catch (e: any) {
    logger.error("Stripe webhook handler error", e);
    res.status(500).send("handler error");
  }
});

// Public config for the embedded card field (any authed company admin/super).
// Returns the active provider plus only the non-secret keys that the browser
// SDK needs (Stripe publishable key, or Square app/location id + environment).
export const getBillingPublicConfig = onCall(async (request) => {
  await getCaller(request);
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  return {
    provider: billingProvider(c),
    publishableKey: c.stripePublishableKey || "",
    square: {
      environment: c.squareEnvironment === "production" ? "production" : "sandbox",
      applicationId: c.squareApplicationId || "",
      locationId: c.squareLocationId || "",
    },
  };
});

// List invoices for in-app viewing: super-admin sees all (optionally filtered to
// one company); a company admin sees only their own. Read via the admin SDK so
// it doesn't depend on Firestore-rules deployment.
export const listInvoices = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, orgId } = (request.data || {}) as { companyId?: string; orgId?: string };
  let q: FirebaseFirestore.Query = db.collection("invoices");
  if (orgId) {
    // Org/enterprise admins (and super) can list their organization's invoices.
    await authorizeForOrg(caller, orgId);
    q = q.where("organizationId", "==", orgId);
  } else if (caller.isSuper) {
    if (companyId) q = q.where("companyId", "==", companyId);
  } else {
    if (caller.role !== "admin" || !caller.companyId) throw new HttpsError("permission-denied", "Company admins only.");
    if (companyId && companyId !== caller.companyId) throw new HttpsError("permission-denied", "Not allowed.");
    q = q.where("companyId", "==", caller.companyId);
  }
  const snap = await q.get();
  const invoices = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
    .sort((a: any, b: any) => (b.created || 0) - (a.created || 0));
  return { invoices };
});

// Ensure a Stripe customer + start a SetupIntent so the embedded card field can
// save a card on file for this company.
export const createSetupIntent = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = authorizeForCompany(caller, (request.data || {}).companyId);
  const stripe = await stripeClient();
  const ref = db.doc(`companies/${companyId}`);
  const company = (await ref.get()).data() || {};
  let customerId = company.stripeCustomerId as string | undefined;
  if (!customerId) {
    const cust = await stripe.customers.create({ name: (company.name as string) || companyId, metadata: { companyId } });
    customerId = cust.id;
    await ref.set({ stripeCustomerId: customerId, updatedAt: Date.now() }, { merge: true });
  }
  const si = await stripe.setupIntents.create({ customer: customerId, usage: "off_session", metadata: { companyId } });
  return { clientSecret: si.client_secret };
});

// After the card is confirmed client-side: set it as the default, store the
// brand/last4, and (re)start the 30-day subscription priced from the company's
// effective monthly price. The first charge runs immediately.
export const saveCardAndSubscribe = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId: cid, paymentMethodId } = (request.data || {}) as { companyId?: string; paymentMethodId?: string };
  const companyId = authorizeForCompany(caller, cid);
  if (!paymentMethodId) throw new HttpsError("invalid-argument", "paymentMethodId required.");
  const stripe = await stripeClient();
  const ref = db.doc(`companies/${companyId}`);
  const company = (await ref.get()).data() || {};
  const customerId = company.stripeCustomerId as string;
  if (!customerId) throw new HttpsError("failed-precondition", "No customer yet — call createSetupIntent first.");
  await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }).catch(() => {});
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  const card = (pm as any).card || {};
  const update: Record<string, unknown> = { cardBrand: card.brand || "", cardLast4: card.last4 || "", updatedAt: Date.now() };
  // Charge the company's effective monthly price every 30 days from now.
  // Per-job companies keep the card on file but are billed by their own crons.
  const cents = Math.round((Number(company.planPrice) || 0) * 100);
  if (!company.billingExempt && cents > 0 && !company.perJobBilling?.enabled) {
    const subId = company.stripeSubscriptionId as string | undefined;
    if (subId) {
      await stripe.subscriptions.update(subId, { default_payment_method: paymentMethodId });
    } else {
      const product = await stripe.products.create({
        name: `YoutilityKnock — ${company.plan || "Subscription"}`,
        metadata: { companyId },
      });
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        default_payment_method: paymentMethodId,
        items: [{ price_data: {
          currency: "usd",
          product: product.id,
          unit_amount: cents,
          recurring: { interval: "day", interval_count: BILLING_INTERVAL_DAYS },
        } }],
        metadata: { companyId },
      });
      update.stripeSubscriptionId = sub.id;
      if ((sub as any).current_period_end) update.nextBillingAt = (sub as any).current_period_end * 1000;
      update.status = "active"; update.pastDueSince = 0; update.billingHold = false;
    }
  }
  await ref.set(update, { merge: true });
  return { ok: true, brand: update.cardBrand, last4: update.cardLast4 };
});

// Re-email an invoice to the company's admins (with the pay/view link).
// Build a per-plan service agreement PDF (returned as a Buffer) for the
// customer to sign and return. Parameterized by the company's plan + price and,
// for enterprise orgs, the per-company / org-wide fees.
function buildContractPdf(opts: {
  companyName: string; contactName: string; plan: string; monthly: number;
  enterprise: boolean; perCompanyFee: number; orgFee: number; dateStr: string;
  referenceNumber?: string;
  // A per-company custom agreement. When set, it REPLACES the standard plan
  // sections (1–7) below; the header, acceptance, and e-signature blocks stay,
  // so the sign-then-pay flow still stamps the signatures on it.
  customBody?: string;
  // When the customer has e-signed (sign-then-pay), stamp the acceptance block.
  signedName?: string; signedDateStr?: string;
  // When the Provider (super-admin) has counter-signed, stamp that block too.
  providerSignedName?: string; providerSignedDateStr?: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const H = (t: string) => doc.moveDown(0.7).fontSize(13).fillColor("#0b2a44").text(t).moveDown(0.15).fillColor("#000").fontSize(11);
    doc.fontSize(20).fillColor("#0EA5E9").text(PRODUCT_NAME);
    doc.fillColor("#666").fontSize(9).text(`a product of ${PROVIDER_LEGAL_NAME}`);
    doc.fillColor("#000").fontSize(14).text("Service Agreement").moveDown(0.2);
    doc.fontSize(10).fillColor("#555").text(`Date: ${opts.dateStr}`);
    if (opts.referenceNumber) doc.fillColor("#555").text(`Agreement ref: ${opts.referenceNumber}`);
    doc.fillColor("#000").fontSize(11).moveDown(0.8);

    doc.text(`This Service Agreement ("Agreement") is between ${PROVIDER_LEGAL_NAME}, provider of the ${PRODUCT_NAME} platform ("Provider"), and ${opts.companyName} ("Customer").`);

    if (opts.customBody && opts.customBody.trim()) {
      // Render the custom agreement text. Light Markdown: "#"/"##" lines become
      // section headings, "-"/"*"/"1." lines become bullets, blank lines break
      // paragraphs, and **bold**/backtick markers are stripped for clean print.
      const strip = (s: string) => s.replace(/\*\*/g, "").replace(/`/g, "").trim();
      for (const raw of opts.customBody.replace(/\r/g, "").split("\n")) {
        const t = raw.trim();
        if (!t) { doc.moveDown(0.4); continue; }
        if (/^#{1,6}\s+/.test(t)) H(strip(t.replace(/^#{1,6}\s+/, "")));
        else if (/^([-*•]|\d+[.)])\s+/.test(t)) doc.text("•  " + strip(t.replace(/^([-*•]|\d+[.)])\s+/, "")), { indent: 12 });
        else doc.text(strip(t));
      }
    } else {
      H("1. Service & Plan");
      doc.text(`Provider will make the ${PRODUCT_NAME} platform available to Customer under the "${opts.plan}" plan at $${opts.monthly} per month.`);
      if (opts.enterprise) {
        doc.text(`Enterprise terms apply: an additional $${opts.perCompanyFee} per company and $${opts.orgFee} per organization, per month.`);
      }

      H("2. Recurring Billing & Cancellation");
      doc.text(`This is a recurring monthly fee. The plan covers up to 100 users across all of Customer's organizations; each additional user beyond 100 is billed at $85 per user, per month. The card on file is automatically charged on a 30-day cycle based on the companies and users on the account. Customer must provide written notice of cancellation at least 30 days in advance; charges already billed for the then-current cycle are non-refundable.`);

      H("3. Billing — Due on Receipt");
      doc.text("Invoices are due on receipt. If an invoice is not paid, Provider may suspend access to the platform until payment is received. Suspension does not delete Customer data.");

      H("4. Term & Termination");
      doc.text("This Agreement continues month-to-month until terminated by either party with written notice as described in Section 2. Provider may suspend or terminate the service for non-payment.");

      H("5. Data");
      doc.text(`Customer owns its data. Provider stores and processes it solely to provide the service, in accordance with the Privacy Policy at ${PRIVACY_URL}.`);

      H("6. Limitation of Liability");
      doc.text(`To the maximum extent permitted by law, Provider's total liability arising out of or related to this Agreement will not exceed the amounts paid by Customer to Provider in the three (3) months preceding the claim. Neither party will be liable for indirect, incidental, special, or consequential damages. The service is provided "as is" without warranties of any kind.`);

      H("7. Governing Law");
      doc.text(`This Agreement is governed by the laws of the State of ${GOVERNING_LAW_STATE}, without regard to its conflict-of-laws rules. The parties consent to the exclusive jurisdiction of the state and federal courts located in ${GOVERNING_LAW_STATE}.`);
    }

    H(opts.customBody && opts.customBody.trim() ? "Acceptance" : "8. Acceptance");
    doc.text("This Agreement is executed by the Provider first and then by the Customer. By signing below, each party agrees to the terms of this Agreement.");

    // Provider counter-signature (executed first) — stamped if signed.
    doc.moveDown(1.4);
    doc.text(`Provider: ${PROVIDER_LEGAL_NAME}`);
    doc.moveDown(1);
    if (opts.providerSignedName) {
      doc.fillColor("#0b2a44").text(`Signed electronically by: ${opts.providerSignedName}`).fillColor("#000");
      doc.moveDown(0.5);
      doc.text(`Date: ${opts.providerSignedDateStr || opts.dateStr}`);
    } else {
      doc.text("Signature: ________________________________");
      doc.moveDown(0.7);
      doc.text("Date: ________________________________");
    }

    // Customer signature — stamped if e-signed, otherwise a blank line to sign.
    doc.moveDown(1.4);
    doc.text(`Customer: ${opts.companyName}`);
    doc.moveDown(1);
    if (opts.signedName) {
      doc.fillColor("#0b2a44").text(`Signed electronically by: ${opts.signedName}`).fillColor("#000");
      doc.moveDown(0.5);
      doc.text(`Date: ${opts.signedDateStr || opts.dateStr}`);
    } else {
      doc.text("Signature: ________________________________");
      doc.moveDown(0.7);
      doc.text(`Printed name: ${opts.contactName || "________________________________"}`);
      doc.moveDown(0.7);
      doc.text("Date: ________________________________");
    }

    doc.end();
  });
}

// Build the company's per-plan service agreement PDF (with enterprise terms if
// the company is in an enterprise org). Shared by the invoice email + preview.
// `sig` stamps the acceptance block once the customer has e-signed.
interface ContractSig {
  referenceNumber?: string;
  signedName?: string; signedAt?: number;
  providerSignedName?: string; providerSignedAt?: number;
}
const contractDateFmt = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

async function buildCompanyContractPdf(companyId: string, opts?: ContractSig): Promise<Buffer> {
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  let enterprise = false, perCompanyFee = 0, orgFee = 0;
  if (company.organizationId) {
    const org = (await db.doc(`organizations/${company.organizationId}`).get()).data();
    if (org && org.enterprise) {
      enterprise = true;
      perCompanyFee = Number(org.perCompanyFee) || 0;
      orgFee = Number(org.orgFee) || 0;
    }
  }
  return buildContractPdf({
    companyName: (company.name as string) || "Customer",
    contactName: ((company.billingContactName as string) || "").trim(),
    plan: (company.plan as string) || "Standard",
    monthly: Number(company.planPrice) || 0,
    enterprise, perCompanyFee, orgFee,
    customBody: (company.contractCustomText as string) || undefined,
    dateStr: contractDateFmt(Date.now()),
    referenceNumber: opts?.referenceNumber,
    signedName: opts?.signedName,
    signedDateStr: opts?.signedAt ? contractDateFmt(opts.signedAt) : undefined,
    providerSignedName: opts?.providerSignedName,
    providerSignedDateStr: opts?.providerSignedAt ? contractDateFmt(opts.providerSignedAt) : undefined,
  });
}

// Build a printable invoice PDF (itemized) for attaching to the invoice email
// and downloading from the console. Works for company- and org-scoped invoices.
function buildInvoicePdf(inv: Record<string, any>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const money = (cents: number) => "$" + ((cents || 0) / 100).toFixed(2);
    const dateFmt = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    doc.fontSize(20).fillColor("#0EA5E9").text(PRODUCT_NAME);
    doc.fillColor("#666").fontSize(9).text(`a product of ${PROVIDER_LEGAL_NAME}`).moveDown(0.6);
    doc.fillColor("#000").fontSize(16).text("Invoice");
    doc.fontSize(10).fillColor("#555")
      .text(`Invoice #: ${inv.number || inv.id || ""}`)
      .text(`Date: ${dateFmt(inv.created || Date.now())}`)
      .text(`Due: ${inv.dueDate ? dateFmt(inv.dueDate) : "On receipt"}`)
      .text(`Status: ${inv.status || "open"}`);
    doc.moveDown(0.6).fillColor("#000").fontSize(11)
      .text(`From: ${PROVIDER_LEGAL_NAME}`)
      .text(`Bill to: ${inv.companyName || ""}`);

    // Line-items table.
    doc.moveDown(1);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const amountX = right - 90;
    doc.fontSize(10).fillColor("#0b2a44")
      .text("Description", left, doc.y, { continued: true })
      .text("Amount", amountX, doc.y, { align: "right" });
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor("#cccccc").stroke();
    doc.moveDown(0.5).fillColor("#000").fontSize(11);
    const lines: Array<{ description?: string; amount?: number }> =
      Array.isArray(inv.lines) && inv.lines.length ? inv.lines : [{ description: "Subscription", amount: inv.amountDue }];
    for (const l of lines) {
      const y = doc.y;
      doc.text(l.description || "Item", left, y, { width: amountX - left - 10 });
      doc.text(money(l.amount || 0), amountX, y, { align: "right" });
      doc.moveDown(0.3);
    }
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor("#cccccc").stroke();
    doc.moveDown(0.5);
    const ty = doc.y;
    doc.fontSize(13).fillColor("#0b2a44")
      .text("Total due", left, ty, { continued: true })
      .text(money(inv.amountDue || 0), amountX, ty, { align: "right" });

    doc.moveDown(2).fontSize(9).fillColor("#888")
      .text("Payment is due on receipt. A signed service agreement is required before payment.");
    doc.end();
  });
}

// All admin emails across the companies in an organization (org-invoice fallback
// when no org billing email is on file).
async function orgAdminEmails(orgId: string): Promise<string[]> {
  const members = await db.collection("companies").where("organizationId", "==", orgId).get();
  const all: string[] = [];
  for (const d of members.docs) all.push(...await companyAdminEmails(d.id));
  return Array.from(new Set(all));
}

// The organization's monthly amount: the super-admin's explicit override
// (organizations/{id}.monthlyOverride, in dollars) when set, otherwise the
// computed sum of member companies + enterprise fees.
function computeOrgMonthly(org: Record<string, any>, memberCount: number, memberPlanTotal: number): number {
  const override = Number(org.monthlyOverride) || 0;
  if (override > 0) return override;
  if (!org.enterprise) return memberPlanTotal;
  return memberPlanTotal + memberCount * (Number(org.perCompanyFee) || 0) + (Number(org.orgFee) || 0);
}

// Build the service agreement for an organization (single agreement covering the
// whole org). Stamped with the e-signatures once accepted.
async function buildOrgContractPdf(orgId: string, opts?: ContractSig): Promise<Buffer> {
  const org = (await db.doc(`organizations/${orgId}`).get()).data() || {};
  const members = await db.collection("companies").where("organizationId", "==", orgId).get();
  const base = members.docs.reduce((s, d) => s + (Number(d.data().planPrice) || 0), 0);
  const monthly = computeOrgMonthly(org, members.size, base);
  return buildContractPdf({
    companyName: (org.name as string) || "Organization",
    contactName: ((org.billingContactName as string) || "").trim(),
    plan: "Organization", monthly,
    enterprise: !!org.enterprise,
    perCompanyFee: Number(org.perCompanyFee) || 0,
    orgFee: Number(org.orgFee) || 0,
    dateStr: contractDateFmt(Date.now()),
    referenceNumber: opts?.referenceNumber,
    signedName: opts?.signedName,
    signedDateStr: opts?.signedAt ? contractDateFmt(opts.signedAt) : undefined,
    providerSignedName: opts?.providerSignedName,
    providerSignedDateStr: opts?.providerSignedAt ? contractDateFmt(opts.providerSignedAt) : undefined,
  });
}

// Pick the right contract (company- or org-scoped) for an invoice, carrying
// whatever signatures have been recorded so far.
async function buildContractForInvoice(inv: Record<string, any>): Promise<Buffer> {
  const sig: ContractSig = {
    referenceNumber: inv.number,
    signedName: inv.signedName, signedAt: inv.signedAt,
    providerSignedName: inv.providerSignedName, providerSignedAt: inv.providerSignedAt,
  };
  return inv.organizationId
    ? buildOrgContractPdf(inv.organizationId, sig)
    : buildCompanyContractPdf(inv.companyId, sig);
}

// HTML body for an invoice email. The primary CTA routes through the sign page
// (sign-then-pay) so the customer e-signs the agreement before paying.
function invoiceEmailHtml(opts: {
  contactName: string; billedTo: string; number: string; amt: string;
  lines: Array<{ description?: string; amount?: number }>; signUrl: string; plain?: boolean;
}): string {
  const money = (c: number) => "$" + ((c || 0) / 100).toFixed(2);
  const rows = opts.lines.map((l) =>
    `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">${escEmail(l.description || "Item")}</td>`+
    `<td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">${money(l.amount || 0)}</td></tr>`).join("");
  // A plain invoice has no service agreement to sign — the CTA just goes to pay.
  const cta = opts.plain ? "Review &amp; pay" : "Review, sign &amp; pay";
  const note = opts.plain
    ? "Pay securely online — payment is due on receipt."
    : "You'll review and electronically sign the service agreement, then pay securely. Payment is due on receipt.";
  const ctaBlock = opts.signUrl
    ? `<p style="margin:20px 0;"><a href="${escEmail(opts.signUrl)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;">${cta}</a></p>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;margin:0 auto;">
    <div style="font-size:22px;font-weight:700;color:#0EA5E9;">${PRODUCT_NAME}</div>
    <div style="font-size:11px;color:#888;margin-bottom:16px;">a product of ${PROVIDER_LEGAL_NAME}</div>
    <p>${opts.contactName ? "Hi " + escEmail(opts.contactName) + "," : "Hello,"}</p>
    <p>Your ${PRODUCT_NAME} invoice <strong>${escEmail(opts.number)}</strong> for <strong>${opts.amt}</strong> is ready.</p>
    <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">${rows}
      <tr><td style="padding:8px 0;font-weight:700;">Total due</td>
      <td style="padding:8px 0;font-weight:700;text-align:right;">${opts.amt}</td></tr></table>
    ${ctaBlock}
    <p style="color:#555;font-size:13px;">${note}</p>
    <p style="color:#888;font-size:12px;margin-top:24px;">Billed to: ${escEmail(opts.billedTo)}</p>
  </div>`;
}
// Minimal HTML-escape for values interpolated into the email body.
function escEmail(s: string): string {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

// Every super-admin's email (the YoutilityKnock "Provider" side).
async function superAdminEmails(): Promise<string[]> {
  const snap = await db.collection("users").where("superAdmin", "==", true).get();
  return Array.from(new Set(snap.docs
    .map((d) => String(d.data()?.email || "").trim())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))));
}

// Stage 1 of two-stage signing: email the Provider (super-admins) a link to
// counter-sign the agreement first. Once they sign, the customer is emailed.
async function sendProviderSignEmail(invoiceId: string): Promise<{ sent: number; error: string }> {
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");
  const emails = await superAdminEmails();
  if (!emails.length) return { sent: 0, error: "No super-admin email on file to sign as Provider." };
  const cfg = await getNotifyConfig();
  const amt = "$" + ((inv.amountDue || 0) / 100).toFixed(2);
  const signUrl = `${APP_URL}/sign?inv=${invoiceId}&t=${inv.providerSignToken}&role=provider`;
  const attachments: EmailAttachment[] = [];
  try {
    const pdf = await buildContractForInvoice({ id: invoiceId, ...inv });
    attachments.push({ filename: `${PRODUCT_NAME}-Service-Agreement.pdf`, content: pdf.toString("base64"), type: "application/pdf" });
  } catch (e) { logger.warn("provider contract pdf failed", e); }
  const text = `Action needed: counter-sign the ${PRODUCT_NAME} service agreement for ${inv.companyName || ""} (invoice ${inv.number || ""}, ${amt}).`+
    `\n\nSign as Provider here — the customer is emailed automatically once you sign:\n${signUrl}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;margin:0 auto;">
    <div style="font-size:22px;font-weight:700;color:#0EA5E9;">${PRODUCT_NAME}</div>
    <div style="font-size:11px;color:#888;margin-bottom:16px;">a product of ${PROVIDER_LEGAL_NAME}</div>
    <p>Counter-sign the service agreement for <strong>${escEmail(inv.companyName || "")}</strong> (invoice ${escEmail(inv.number || "")}, ${amt}).</p>
    <p style="margin:20px 0;"><a href="${escEmail(signUrl)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;">Sign as Provider</a></p>
    <p style="color:#555;font-size:13px;">The customer is automatically emailed to review, sign, and pay once you've signed.</p>
  </div>`;
  let sent = 0, lastError = "";
  for (const to of emails) {
    const r = await sendEmailDetailed(cfg, to, `Sign required — agreement for ${inv.companyName || ""} (${inv.number || ""})`, text, attachments, html);
    if (r.ok) sent++; else lastError = r.detail;
  }
  return { sent, error: sent ? "" : lastError };
}

// Stage 3: once both parties have signed, email the fully-executed agreement to
// everyone — the customer/org billing contact AND every super-admin.
async function sendSignedCopyToAllParties(invoiceId: string): Promise<void> {
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv) return;
  const cfg = await getNotifyConfig();
  const recipients = new Set<string>(await superAdminEmails());
  if (inv.organizationId) {
    const org = (await db.doc(`organizations/${inv.organizationId}`).get()).data() || {};
    const e = ((org.billingEmail as string) || "").trim();
    if (e) recipients.add(e); else (await orgAdminEmails(inv.organizationId)).forEach((x) => recipients.add(x));
  } else {
    const company = (await db.doc(`companies/${inv.companyId}`).get()).data() || {};
    const e = ((company.billingEmail as string) || "").trim();
    if (e) recipients.add(e); else (await companyAdminEmails(inv.companyId)).forEach((x) => recipients.add(x));
  }
  if (!recipients.size) return;
  const attachments: EmailAttachment[] = [];
  try {
    const pdf = await buildContractForInvoice({ id: invoiceId, ...inv });
    attachments.push({ filename: `${PRODUCT_NAME}-Signed-Agreement-${inv.number || invoiceId}.pdf`, content: pdf.toString("base64"), type: "application/pdf" });
  } catch (e) { logger.warn("signed copy pdf failed", e); }
  const text = `The ${PRODUCT_NAME} service agreement for ${inv.companyName || ""} (ref ${inv.number || ""}) is now fully signed by both parties. A copy is attached for your records.`;
  for (const to of recipients) {
    await sendEmailDetailed(cfg, to, `Signed agreement — ${inv.companyName || ""} (${inv.number || ""})`, text, attachments);
  }
}

// Email an invoice (with the service agreement + a printable invoice PDF
// attached) to the billing contact. Works for company- and org-scoped invoices.
// Shared by the emailInvoice callable, createInvoice, and createOrgInvoice.
async function sendInvoiceEmail(invoiceId: string, includeContract: boolean): Promise<{ sent: number; contractAttached: boolean; error: string }> {
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");

  // Resolve recipient(s): prefer the explicit billing email, then admins.
  let billingEmail = "", contactName = "", billedTo = (inv.companyName as string) || "";
  let emails: string[] = [];
  if (inv.organizationId) {
    const org = (await db.doc(`organizations/${inv.organizationId}`).get()).data() || {};
    billingEmail = ((org.billingEmail as string) || "").trim();
    contactName = ((org.billingContactName as string) || "").trim();
    billedTo = (org.name as string) || billedTo;
    emails = billingEmail ? [billingEmail] : await orgAdminEmails(inv.organizationId);
  } else {
    const company = (await db.doc(`companies/${inv.companyId}`).get()).data() || {};
    billingEmail = ((company.billingEmail as string) || "").trim();
    contactName = ((company.billingContactName as string) || "").trim();
    billedTo = (company.name as string) || billedTo;
    emails = billingEmail ? [billingEmail] : await companyAdminEmails(inv.companyId);
  }
  if (!emails.length) throw new HttpsError("failed-precondition", "No billing email or admin email on file.");

  const cfg = await getNotifyConfig();
  const amt = "$" + ((inv.amountDue || 0) / 100).toFixed(2);
  const lines: Array<{ description?: string; amount?: number }> =
    Array.isArray(inv.lines) && inv.lines.length ? inv.lines : [{ description: "Subscription", amount: inv.amountDue }];
  // A plain invoice (no signToken) skips the sign-then-pay agreement entirely —
  // the CTA links straight to the pay link and no contract is attached.
  const plain = !inv.signToken;
  const signUrl = inv.signToken
    ? `${APP_URL}/sign?inv=${invoiceId}&t=${inv.signToken}`
    : (inv.payUrl || inv.hostedInvoiceUrl || "");

  // Attachments: printable invoice + (for non-plain) the service agreement.
  const attachments: EmailAttachment[] = [];
  try {
    const invPdf = await buildInvoicePdf({ id: invoiceId, ...inv });
    attachments.push({ filename: `Invoice-${inv.number || invoiceId}.pdf`, content: invPdf.toString("base64"), type: "application/pdf" });
  } catch (e) { logger.warn("invoice pdf build failed", e); }
  let contractAttached = false;
  if (includeContract && !plain) {
    try {
      const pdf = await buildContractForInvoice({ id: invoiceId, ...inv });
      attachments.push({ filename: `${PRODUCT_NAME}-Service-Agreement.pdf`, content: pdf.toString("base64"), type: "application/pdf" });
      contractAttached = true;
    } catch (e) { logger.warn("contract pdf build failed", e); }
  }

  const greeting = contactName ? `Hi ${contactName},\n\n` : "";
  const textBody = `${greeting}Your ${PRODUCT_NAME} invoice ${inv.number || ""} for ${amt} is ready.`+
    `${signUrl ? `\n\n${plain ? "Review & pay" : "Review, sign & pay"}: ${signUrl}` : ""}`+
    `${contractAttached ? "\n\nThe service agreement is attached — you'll sign it before payment." : ""}`;
  const htmlBody = invoiceEmailHtml({ contactName, billedTo, number: (inv.number as string) || "", amt, lines, signUrl, plain });

  let sent = 0, lastError = "";
  for (const to of emails) {
    const r = await sendEmailDetailed(cfg, to, `Invoice ${inv.number || ""} — ${amt}`, textBody, attachments, htmlBody);
    if (r.ok) sent++; else lastError = r.detail;
  }
  return { sent, contractAttached, error: sent ? "" : lastError };
}

export const emailInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId: cid, invoiceId, includeContract } =
    (request.data || {}) as { companyId?: string; invoiceId?: string; includeContract?: boolean };
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required.");
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");
  // Org invoices are super-admin only; company invoices follow the company gate.
  if (inv.organizationId) requireSuper(caller);
  else authorizeForCompany(caller, inv.companyId || cid);
  // While the Provider hasn't counter-signed yet, re-email goes to the Provider;
  // afterward it goes to the customer (sign-then-pay).
  if (inv.signStage === "awaiting_provider") {
    const r = await sendProviderSignEmail(invoiceId);
    return { ok: true, sent: r.sent, stage: "awaiting_provider", error: r.error };
  }
  return { ok: true, ...(await sendInvoiceEmail(invoiceId, includeContract !== false)) };
});

// Provider (super-admin) counter-signs from the console. Records the signature,
// advances the stage, and triggers the customer's sign-then-pay email.
export const providerSignInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { invoiceId, name } = (request.data || {}) as { invoiceId?: string; name?: string };
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required.");
  const signerName = String(name || "").trim();
  if (signerName.length < 2) throw new HttpsError("invalid-argument", "Enter your full name to sign.");
  const ref = db.doc(`invoices/${invoiceId}`);
  const inv = (await ref.get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");
  const now = Date.now();
  if (!inv.providerSignedAt) {
    await ref.set({ providerSignedAt: now, providerSignedName: signerName, signStage: "awaiting_customer", updatedAt: now }, { merge: true });
  }
  // Now email the customer to review, sign & pay.
  let emailResult = { sent: 0, contractAttached: false, error: "" };
  try { emailResult = await sendInvoiceEmail(invoiceId, true); }
  catch (e: any) { emailResult.error = e?.message || "Email send failed."; logger.warn("providerSign customer email failed", e); }
  return { ok: true, ...emailResult };
});

// Create a manual invoice (super-admin) and, by default, email it with the
// service-agreement contract attached. "Due on receipt"; optionally lock the
// company immediately until it's paid.
export const createInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { companyId, amount, description, lines: rawLines, lockUntilPaid, send, skipContract } = (request.data || {}) as {
    companyId?: string; amount?: number; description?: string;
    lines?: Array<{ description?: string; amount?: number }>; lockUntilPaid?: boolean; send?: boolean; skipContract?: boolean;
  };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  // Companies that belong to an organization are billed through the org — block
  // standalone invoicing here so charges aren't duplicated.
  if (company.organizationId) {
    throw new HttpsError("failed-precondition", "This company is billed through its organization. Invoice the organization instead.");
  }

  // Accept either an explicit line-item array or a single amount + description.
  const cleanLines = Array.isArray(rawLines)
    ? rawLines
        .map((l) => ({ description: String(l.description || "").trim() || "YoutilityKnock services", amount: Math.round(Number(l.amount) * 100) }))
        .filter((l) => isFinite(l.amount) && l.amount > 0)
    : [];
  let lineItems: Array<{ description: string; amount: number }>;
  if (cleanLines.length) {
    lineItems = cleanLines;
  } else {
    const dollars = Number(amount);
    if (!isFinite(dollars) || dollars <= 0) throw new HttpsError("invalid-argument", "Enter an amount greater than 0.");
    lineItems = [{ description: (description || "").trim() || "YoutilityKnock services", amount: Math.round(dollars * 100) }];
  }
  const cents = lineItems.reduce((s, l) => s + l.amount, 0);

  // Plain invoice: no service agreement to counter-sign — just email the billing
  // contact a payable invoice. Otherwise use the two-stage sign-then-pay flow.
  const plain = skipContract === true;
  const now = Date.now();
  const ref = db.collection("invoices").doc();
  const number = `INV-${now.toString(36).toUpperCase()}`;
  const signToken = crypto.randomBytes(16).toString("hex");
  const providerSignToken = crypto.randomBytes(16).toString("hex");
  await ref.set({
    companyId, companyName: (company.name as string) || "",
    number,
    status: "open", manual: true,
    amountDue: cents, amountPaid: 0, currency: "usd",
    created: now, dueDate: now, // due on receipt
    lines: lineItems,
    lockUntilPaid: !!lockUntilPaid,
    // Two-stage signing (skipped for a plain invoice — no tokens, no stage).
    signStage: plain ? "none" : "awaiting_provider",
    signToken: plain ? "" : signToken, signedAt: 0, signedName: "",
    providerSignToken: plain ? "" : providerSignToken, providerSignedAt: 0, providerSignedName: "",
    updatedAt: now,
  });
  // Generate a Square hosted payment link so the customer can pay online. If
  // Square isn't configured this returns "" and the invoice just has no link.
  const payUrl = await squarePaymentLink(cents, `${number} — ${(company.name as string) || "YoutilityKnock"}`);
  if (payUrl) await ref.set({ payUrl, hostedInvoiceUrl: payUrl, updatedAt: Date.now() }, { merge: true });
  // Due on receipt → optionally lock the account immediately until paid.
  if (lockUntilPaid) {
    await db.doc(`companies/${companyId}`).set(
      { status: "suspended", billingHold: true, pastDueSince: now, updatedAt: now }, { merge: true });
  }
  let emailRes = { sent: 0, error: "" };
  if (send !== false) {
    try {
      if (plain) {
        // Email the billing contact the payable invoice directly.
        const r = await sendInvoiceEmail(ref.id, false);
        emailRes = { sent: r.sent, error: r.error };
      } else {
        // Stage 1: email the Provider (super-admins) to counter-sign first; the
        // customer is emailed automatically once the Provider signs.
        emailRes = await sendProviderSignEmail(ref.id);
      }
    } catch (e: any) { emailRes.error = e?.message || "Email send failed."; logger.warn("createInvoice send failed", e); }
  }
  return { ok: true, invoiceId: ref.id, payUrl, plain, stage: plain ? "sent" : "awaiting_provider", sent: emailRes.sent, error: emailRes.error };
});

// Create an invoice for an ORGANIZATION (super-admin). Itemizes one line per
// member company (its monthly + the enterprise per-company fee) plus the org
// fee, then sign-then-pay emails the org's billing contact. Locking cascades to
// every company under the org.
export const createOrgInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { orgId, description, lockUntilPaid, send } = (request.data || {}) as {
    orgId?: string; description?: string; lockUntilPaid?: boolean; send?: boolean;
  };
  if (!orgId) throw new HttpsError("invalid-argument", "orgId required.");
  const org = (await db.doc(`organizations/${orgId}`).get()).data();
  if (!org) throw new HttpsError("not-found", "Organization not found.");
  const members = await db.collection("companies").where("organizationId", "==", orgId).get();
  if (members.empty) throw new HttpsError("failed-precondition", "This organization has no companies to bill.");

  const enterprise = !!org.enterprise;
  const perCompanyFee = Number(org.perCompanyFee) || 0;
  const orgFee = Number(org.orgFee) || 0;
  const override = Number(org.monthlyOverride) || 0;
  const lines: Array<{ description: string; amount: number }> = [];
  if (override > 0) {
    // Flat organization monthly the super-admin entered — bill that exact amount.
    lines.push({ description: "Organization monthly plan (up to 100 users)", amount: Math.round(override * 100) });
  } else {
    members.docs.forEach((d) => {
      const co = d.data();
      const base = Number(co.planPrice) || 0;
      const each = enterprise ? base + perCompanyFee : base;
      lines.push({ description: `${(co.name as string) || d.id}${enterprise ? " (incl. per-company fee)" : ""}`, amount: Math.round(each * 100) });
    });
    if (enterprise && orgFee > 0) lines.push({ description: "Organization fee", amount: Math.round(orgFee * 100) });
  }
  if (description && description.trim()) lines.push({ description: description.trim(), amount: 0 });
  const cents = lines.reduce((s, l) => s + l.amount, 0);
  if (cents <= 0) throw new HttpsError("invalid-argument", "Organization total is $0 — set a monthly amount, plan prices, or fees first.");

  const now = Date.now();
  const ref = db.collection("invoices").doc();
  const number = `ORG-${now.toString(36).toUpperCase()}`;
  const signToken = crypto.randomBytes(16).toString("hex");
  const providerSignToken = crypto.randomBytes(16).toString("hex");
  await ref.set({
    organizationId: orgId, companyName: (org.name as string) || "",
    number, status: "open", manual: true,
    amountDue: cents, amountPaid: 0, currency: "usd",
    created: now, dueDate: now,
    lines, lockUntilPaid: !!lockUntilPaid,
    signStage: "awaiting_provider",
    signToken, signedAt: 0, signedName: "",
    providerSignToken, providerSignedAt: 0, providerSignedName: "",
    updatedAt: now,
  });
  const payUrl = await squarePaymentLink(cents, `${number} — ${(org.name as string) || "Organization"}`);
  if (payUrl) await ref.set({ payUrl, hostedInvoiceUrl: payUrl, updatedAt: Date.now() }, { merge: true });
  // Lock the whole org (and every member company) until paid.
  if (lockUntilPaid) {
    const patch = { status: "suspended", billingHold: true, pastDueSince: now, updatedAt: now };
    await db.doc(`organizations/${orgId}`).set(patch, { merge: true });
    const batch = db.batch();
    members.docs.forEach((d) => batch.set(d.ref, patch, { merge: true }));
    await batch.commit();
  }
  // Stage 1: Provider counter-signs first; customer email auto-sends after.
  let providerEmail = { sent: 0, error: "" };
  if (send !== false) {
    try { providerEmail = await sendProviderSignEmail(ref.id); }
    catch (e: any) { providerEmail.error = e?.message || "Email send failed."; logger.warn("createOrgInvoice provider send failed", e); }
  }
  return { ok: true, invoiceId: ref.id, payUrl, stage: "awaiting_provider", sent: providerEmail.sent, error: providerEmail.error };
});

// Build the company's (or an org's) service-agreement PDF and return it (base64)
// so the super-admin console can preview/download it without relying on email.
export const getContractPdf = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, orgId } = (request.data || {}) as { companyId?: string; orgId?: string };
  let pdf: Buffer;
  if (orgId) {
    await authorizeForOrg(caller, orgId);
    pdf = await buildOrgContractPdf(orgId);
  } else {
    pdf = await buildCompanyContractPdf(authorizeForCompany(caller, companyId));
  }
  return { filename: `${PRODUCT_NAME}-Service-Agreement.pdf`, base64: pdf.toString("base64") };
});

// setCompanyContract — save (or clear) a per-company custom service agreement.
// When set, it replaces the standard plan sections on this company's contract
// everywhere it's built (preview, and the invoice/sign-then-pay flow), so a
// custom deal can be sent for signature through the normal billing flow.
// Super-admin only (it's the Provider's own legal terms).
export const setCompanyContract = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { companyId, contractCustomText } = (request.data || {}) as
    { companyId?: string; contractCustomText?: string };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");
  const text = typeof contractCustomText === "string" ? contractCustomText.trim() : "";
  await db.doc(`companies/${companyId}`).set(
    { contractCustomText: text || null, contractCustomUpdatedAt: Date.now(), contractCustomBy: caller.uid },
    { merge: true },
  );
  return { ok: true, hasCustom: !!text };
});

// Lift a due-on-receipt lock once an invoice is paid — cascades to every member
// company for an org invoice. Shared by markInvoicePaid + the sign/pay flow.
async function unlockInvoiceTarget(inv: Record<string, any>): Promise<void> {
  if (!inv.lockUntilPaid) return;
  const now = Date.now();
  const patch = { status: "active", billingHold: false, pastDueSince: 0, updatedAt: now };
  if (inv.organizationId) {
    await db.doc(`organizations/${inv.organizationId}`).set(patch, { merge: true });
    const members = await db.collection("companies").where("organizationId", "==", inv.organizationId).get();
    const batch = db.batch();
    members.docs.forEach((d) => batch.set(d.ref, patch, { merge: true }));
    await batch.commit();
  } else if (inv.companyId) {
    await db.doc(`companies/${inv.companyId}`).set(patch, { merge: true });
  }
}

// Mark an invoice paid (super-admin). If it locked the account/org (due on
// receipt), unlock it.
export const markInvoicePaid = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { invoiceId } = (request.data || {}) as { invoiceId?: string };
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required.");
  const ref = db.doc(`invoices/${invoiceId}`);
  const inv = (await ref.get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");
  const now = Date.now();
  await ref.set({ status: "paid", amountPaid: inv.amountDue || 0, updatedAt: now }, { merge: true });
  await unlockInvoiceTarget(inv);
  return { ok: true };
});

// ── Two-stage sign-then-pay: public endpoint behind /sign-api/** (no login). ──
// The Provider (super-admin) counter-signs FIRST via ?role=provider using the
// providerSignToken; that auto-emails the customer, who then signs with the
// customer signToken before the pay link unlocks. The token decides the role.
//   GET  /sign-api/<id>?t=<token>           → summary + role + signed state
//   GET  /sign-api/<id>/contract?t=<token>  → the service-agreement PDF
//   POST /sign-api/<id>  { t, name }        → record signature for that role
export const invoiceSign = onRequest({ cors: true }, async (req, res) => {
  try {
    // Path may arrive with or without the "/sign-api" rewrite prefix.
    const parts = req.path.split("/").filter(Boolean).filter((p) => p !== "sign-api");
    const invoiceId = parts[0] || "";
    const wantContract = parts[parts.length - 1] === "contract";
    const token = String((req.method === "POST" ? (req.body?.t ?? req.query.t) : req.query.t) || "");
    if (!invoiceId) { res.status(400).json({ error: "Missing invoice id." }); return; }
    const ref = db.doc(`invoices/${invoiceId}`);
    const inv = (await ref.get()).data();
    if (!inv) { res.status(404).json({ error: "Invoice not found." }); return; }
    // Identify the signer by which token matches.
    const role = token && token === inv.providerSignToken ? "provider"
      : token && token === inv.signToken ? "customer" : "";
    if (!role) { res.status(404).json({ error: "Invoice not found." }); return; }

    if (wantContract) {
      const pdf = await buildContractForInvoice({ id: invoiceId, ...inv });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${PRODUCT_NAME}-Service-Agreement.pdf"`);
      res.status(200).send(pdf);
      return;
    }

    const providerSigned = !!inv.providerSignedAt;
    const customerSigned = !!inv.signedAt;
    // The customer can only act once the Provider has signed.
    const customerReady = providerSigned;
    const summary = {
      role, number: inv.number || "", companyName: inv.companyName || "",
      amountDue: inv.amountDue || 0, currency: inv.currency || "usd",
      status: inv.status || "open",
      lines: Array.isArray(inv.lines) ? inv.lines : [],
      providerSigned, providerSignedName: inv.providerSignedName || "",
      customerSigned, signedName: inv.signedName || "",
      // For the customer view: whether it's their turn yet.
      ready: role === "provider" ? true : customerReady,
      signed: role === "provider" ? providerSigned : customerSigned,
      // Pay link only revealed to the customer after they've signed.
      payUrl: (role === "customer" && customerSigned) ? (inv.payUrl || inv.hostedInvoiceUrl || "") : "",
      governingLaw: GOVERNING_LAW_STATE, provider: PROVIDER_LEGAL_NAME, product: PRODUCT_NAME,
    };

    if (req.method === "GET") { res.status(200).json(summary); return; }

    if (req.method === "POST") {
      const name = String(req.body?.name || "").trim();
      if (name.length < 2) { res.status(400).json({ error: "Type your full name to sign." }); return; }
      const now = Date.now();
      const ip = (req.headers["x-forwarded-for"] as string || "").split(",")[0].trim() || req.ip || "";

      if (role === "provider") {
        if (!inv.providerSignedAt) {
          await ref.set({ providerSignedAt: now, providerSignedName: name, providerSignedIp: ip, signStage: "awaiting_customer", updatedAt: now }, { merge: true });
          // Provider just signed → email the customer to review, sign & pay.
          try { await sendInvoiceEmail(invoiceId, true); }
          catch (e) { logger.warn("provider-sign customer email failed", e); }
        }
        res.status(200).json({ ok: true, role, signed: true, signedName: inv.providerSignedName || name });
        return;
      }

      // role === "customer": the Provider must have signed first.
      if (!inv.providerSignedAt) { res.status(409).json({ error: "This agreement is awaiting the provider's signature. Please try again shortly." }); return; }
      if (!inv.signedAt) {
        await ref.set({ signedAt: now, signedName: name, signedIp: ip, signStage: "fully_signed", updatedAt: now }, { merge: true });
        // Fully signed → email the executed copy to all parties.
        try { await sendSignedCopyToAllParties(invoiceId); }
        catch (e) { logger.warn("signed-copy email failed", e); }
      }
      const payUrl = inv.payUrl || inv.hostedInvoiceUrl || "";
      res.status(200).json({ ok: true, role, signed: true, signedName: inv.signedName || name, payUrl });
      return;
    }
    res.status(405).json({ error: "Method not allowed." });
  } catch (e: any) {
    logger.error("invoiceSign error", e);
    res.status(500).json({ error: "Server error." });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SQUARE BILLING — the alternative to Stripe. Square has no "metered recurring
// for an arbitrary amount" primitive that fits per-company pricing, so instead
// we save a card on file (tokenized in the browser by the Square Web Payments
// SDK), charge the effective monthly price immediately, and let a daily cron
// re-charge it every 30 days. Status sync + dunning reuse the same fields and
// the same billingDunning job as Stripe. Keys live in config/billing.
// ════════════════════════════════════════════════════════════════════════════
const SQUARE_VERSION = "2025-01-23"; // Square API version pin

async function squareCfg() {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (!c.squareAccessToken) throw new HttpsError("failed-precondition", "Square isn't configured. Add keys in the admin console.");
  const production = c.squareEnvironment === "production";
  return {
    token: c.squareAccessToken,
    locationId: c.squareLocationId || "",
    base: production ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com",
  };
}

// Thin REST wrapper (Square's Node SDK churns its types; the codebase already
// talks to ATTOM/SendGrid/Telnyx over fetch, so we do the same here).
async function squareApi(cfg: { token: string; base: string }, path: string, body?: unknown) {
  const res = await fetch(cfg.base + path, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.errors?.[0]?.detail || `Square API ${res.status}`;
    throw new HttpsError("internal", detail);
  }
  return json;
}

// Create a Square hosted payment link for a one-off amount (manual invoices).
// Returns the pay URL, or "" if Square isn't configured / the call fails.
async function squarePaymentLink(amountCents: number, name: string): Promise<string> {
  let cfg;
  try { cfg = await squareCfg(); } catch { return ""; } // Square not configured
  if (!cfg.locationId) { logger.warn("square payment link: no locationId configured"); return ""; }
  try {
    const json = await squareApi(cfg, "/v2/online-checkout/payment-links", {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: name.slice(0, 255),
        price_money: { amount: amountCents, currency: "USD" },
        location_id: cfg.locationId,
      },
    });
    return json?.payment_link?.url || "";
  } catch (e) {
    logger.warn("square payment link failed", e);
    return "";
  }
}

// Mirror a completed Square payment into invoices/{id} so it shows in the same
// in-app AR / invoice views Stripe payments use.
async function mirrorSquarePayment(companyId: string, payment: any): Promise<void> {
  const companyName = (await db.doc(`companies/${companyId}`).get()).data()?.name || "";
  const cents = payment?.amount_money?.amount ?? 0;
  const paid = payment?.status === "COMPLETED";
  await db.doc(`invoices/${payment.id}`).set({
    squarePaymentId: payment.id, companyId, companyName,
    number: payment.receipt_number || "",
    status: paid ? "paid" : (payment.status || "open").toLowerCase(),
    amountDue: cents, amountPaid: paid ? cents : 0,
    currency: (payment?.amount_money?.currency || "USD").toLowerCase(),
    created: payment.created_at ? new Date(payment.created_at).getTime() : Date.now(),
    hostedInvoiceUrl: payment.receipt_url || "", invoicePdf: payment.receipt_url || "",
    lines: [{ description: "YoutilityKnock subscription", amount: cents }],
    updatedAt: Date.now(),
  }, { merge: true });
}

// Charge a company's saved Square card for its effective monthly price. Advances
// the 30-day clock + records the invoice on success; marks it past_due on
// failure (billingDunning then pauses it after the 3-day grace window).
async function runSquareCharge(companyId: string): Promise<{ ok: boolean; error?: string }> {
  const ref = db.doc(`companies/${companyId}`);
  const company = (await ref.get()).data() || {};
  const cents = Math.round((Number(company.planPrice) || 0) * 100);
  if (company.billingExempt || cents <= 0) return { ok: true };
  const cardId = company.squareCardId as string | undefined;
  const customerId = company.squareCustomerId as string | undefined;
  if (!cardId || !customerId) return { ok: false, error: "No card on file." };
  const cfg = await squareCfg();
  try {
    const { payment } = await squareApi(cfg, "/v2/payments", {
      idempotency_key: crypto.randomUUID(),
      source_id: cardId,
      customer_id: customerId,
      location_id: cfg.locationId || undefined,
      amount_money: { amount: cents, currency: "USD" },
      note: `YoutilityKnock — ${company.plan || "Subscription"}`,
    });
    await mirrorSquarePayment(companyId, payment);
    await ref.set({
      status: "active", pastDueSince: 0, billingHold: false,
      nextBillingAt: Date.now() + BILLING_INTERVAL_DAYS * 86400000, updatedAt: Date.now(),
    }, { merge: true });
    return { ok: true };
  } catch (e: any) {
    const patch: Record<string, unknown> = { status: "past_due", updatedAt: Date.now() };
    if (!company.pastDueSince) patch.pastDueSince = Date.now();
    await ref.set(patch, { merge: true });
    const cfgN = await getNotifyConfig();
    for (const to of await companyAdminEmails(companyId)) {
      await sendEmail(cfgN, to, "Payment failed — action needed",
        `We couldn't process your YoutilityKnock payment. Please update the card on file to avoid interruption — your account will be paused if payment isn't received within 3 days.`);
    }
    return { ok: false, error: e?.message || "Charge failed." };
  }
}

// Save a Square card on file (token from the browser Web Payments SDK) and, if
// billing isn't already running, take the first monthly charge to start it.
export const squareSaveCardAndSubscribe = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId: cid, sourceId } = (request.data || {}) as { companyId?: string; sourceId?: string };
  const companyId = authorizeForCompany(caller, cid);
  if (!sourceId) throw new HttpsError("invalid-argument", "sourceId (card token) required.");
  const cfg = await squareCfg();
  const ref = db.doc(`companies/${companyId}`);
  const company = (await ref.get()).data() || {};

  // Ensure a Square customer for this company.
  let customerId = company.squareCustomerId as string | undefined;
  if (!customerId) {
    const { customer } = await squareApi(cfg, "/v2/customers", {
      idempotency_key: crypto.randomUUID(),
      company_name: (company.name as string) || companyId,
      reference_id: companyId,
    });
    customerId = customer.id;
    await ref.set({ squareCustomerId: customerId, updatedAt: Date.now() }, { merge: true });
  }

  // Store the card on file.
  const { card } = await squareApi(cfg, "/v2/cards", {
    idempotency_key: crypto.randomUUID(),
    source_id: sourceId,
    card: { customer_id: customerId },
  });
  const hadBilling = !!company.squareCardId && (Number(company.nextBillingAt) || 0) > Date.now();
  await ref.set({
    squareCardId: card.id,
    cardBrand: card.card_brand || "", cardLast4: card.last_4 || "",
    updatedAt: Date.now(),
  }, { merge: true });

  // Start the cycle with an immediate charge unless billing is already active.
  // Per-job companies keep the card on file but are billed by their own crons.
  const cents = Math.round((Number(company.planPrice) || 0) * 100);
  if (!company.billingExempt && cents > 0 && !hadBilling && !company.perJobBilling?.enabled) {
    const r = await runSquareCharge(companyId);
    if (!r.ok) throw new HttpsError("internal", r.error || "Could not take first payment.");
  }
  return { ok: true, brand: card.card_brand || "", last4: card.last_4 || "" };
});

// ── Organization-level Square recurring ───────────────────────────────────
// An org can keep its own card on file and be auto-billed its monthly (the
// super-admin's override, else the computed total) every 30 days — the same
// model as a company, but charged once for the whole org.
async function orgMonthlyCents(orgId: string): Promise<number> {
  const org = (await db.doc(`organizations/${orgId}`).get()).data() || {};
  const members = await db.collection("companies").where("organizationId", "==", orgId).get();
  const base = members.docs.reduce((s, d) => s + (Number(d.data().planPrice) || 0), 0);
  return Math.round(computeOrgMonthly(org, members.size, base) * 100);
}

// Mirror an org Square payment into invoices/{paymentId} (org-scoped).
async function mirrorSquareOrgPayment(orgId: string, payment: any): Promise<void> {
  const orgName = (await db.doc(`organizations/${orgId}`).get()).data()?.name || "";
  const cents = payment?.amount_money?.amount ?? 0;
  const paid = payment?.status === "COMPLETED";
  await db.doc(`invoices/${payment.id}`).set({
    squarePaymentId: payment.id, organizationId: orgId, companyName: orgName,
    number: payment.receipt_number || "",
    status: paid ? "paid" : (payment.status || "open").toLowerCase(),
    amountDue: cents, amountPaid: paid ? cents : 0,
    currency: (payment?.amount_money?.currency || "USD").toLowerCase(),
    created: payment.created_at ? new Date(payment.created_at).getTime() : Date.now(),
    hostedInvoiceUrl: payment.receipt_url || "", invoicePdf: payment.receipt_url || "",
    lines: [{ description: "YoutilityKnock — organization monthly", amount: cents }],
    updatedAt: Date.now(),
  }, { merge: true });
}

// Charge an org's saved card for its monthly; advance the 30-day clock + unlock
// on success, mark past_due (and the whole org) on failure.
async function runSquareChargeOrg(orgId: string): Promise<{ ok: boolean; error?: string }> {
  const ref = db.doc(`organizations/${orgId}`);
  const org = (await ref.get()).data() || {};
  const cents = await orgMonthlyCents(orgId);
  if (org.billingExempt || cents <= 0) return { ok: true };
  const cardId = org.squareCardId as string | undefined;
  const customerId = org.squareCustomerId as string | undefined;
  if (!cardId || !customerId) return { ok: false, error: "No card on file." };
  const cfg = await squareCfg();
  try {
    const { payment } = await squareApi(cfg, "/v2/payments", {
      idempotency_key: crypto.randomUUID(),
      source_id: cardId, customer_id: customerId,
      location_id: cfg.locationId || undefined,
      amount_money: { amount: cents, currency: "USD" },
      note: `YoutilityKnock — ${(org.name as string) || "Organization"} monthly`,
    });
    await mirrorSquareOrgPayment(orgId, payment);
    const now = Date.now();
    const patch = { status: "active", pastDueSince: 0, billingHold: false, nextBillingAt: now + BILLING_INTERVAL_DAYS * 86400000, updatedAt: now };
    await ref.set(patch, { merge: true });
    // Lift any hold on member companies too.
    const members = await db.collection("companies").where("organizationId", "==", orgId).get();
    const batch = db.batch();
    members.docs.forEach((d) => batch.set(d.ref, { status: "active", billingHold: false, pastDueSince: 0, updatedAt: now }, { merge: true }));
    await batch.commit();
    return { ok: true };
  } catch (e: any) {
    const patch: Record<string, unknown> = { status: "past_due", updatedAt: Date.now() };
    if (!org.pastDueSince) patch.pastDueSince = Date.now();
    await ref.set(patch, { merge: true });
    return { ok: false, error: e?.message || "Charge failed." };
  }
}

// Save an org's card on file and start its 30-day recurring billing.
export const squareSaveOrgCardAndSubscribe = onCall(async (request) => {
  const caller = await getCaller(request);
  const { orgId, sourceId } = (request.data || {}) as { orgId?: string; sourceId?: string };
  await authorizeForOrg(caller, orgId); // super OR an admin of a member company
  if (!orgId) throw new HttpsError("invalid-argument", "orgId required.");
  if (!sourceId) throw new HttpsError("invalid-argument", "sourceId (card token) required.");
  const cfg = await squareCfg();
  const ref = db.doc(`organizations/${orgId}`);
  const org = (await ref.get()).data();
  if (!org) throw new HttpsError("not-found", "Organization not found.");

  let customerId = org.squareCustomerId as string | undefined;
  if (!customerId) {
    const { customer } = await squareApi(cfg, "/v2/customers", {
      idempotency_key: crypto.randomUUID(),
      company_name: (org.name as string) || orgId,
      reference_id: `org:${orgId}`,
    });
    customerId = customer.id;
    await ref.set({ squareCustomerId: customerId, updatedAt: Date.now() }, { merge: true });
  }
  const { card } = await squareApi(cfg, "/v2/cards", {
    idempotency_key: crypto.randomUUID(),
    source_id: sourceId,
    card: { customer_id: customerId },
  });
  const hadBilling = !!org.squareCardId && (Number(org.nextBillingAt) || 0) > Date.now();
  await ref.set({
    squareCardId: card.id, cardBrand: card.card_brand || "", cardLast4: card.last_4 || "",
    updatedAt: Date.now(),
  }, { merge: true });

  const cents = await orgMonthlyCents(orgId);
  if (!org.billingExempt && cents > 0 && !hadBilling) {
    const r = await runSquareChargeOrg(orgId);
    if (!r.ok) throw new HttpsError("internal", r.error || "Could not take first payment.");
  }
  return { ok: true, brand: card.card_brand || "", last4: card.last_4 || "" };
});

// Daily Square recurring charge: re-bill each Square company AND organization
// when its 30-day clock comes due. (Stripe is billed by Stripe's subscriptions.)
export const squareBillingCron = onSchedule("every 24 hours", async () => {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (billingProvider(c) !== "square") return; // only when Square is the active gateway
  const now = Date.now();
  const snap = await db.collection("companies").where("squareCardId", ">", "").get();
  for (const d of snap.docs) {
    const co = d.data();
    if (co.billingExempt || co.status === "suspended") continue;
    // A company billed through its org is charged by the org, not individually.
    if (co.organizationId) continue;
    // Per-job companies are billed by their own monthly-base + weekly crons.
    if (co.perJobBilling?.enabled) continue;
    if ((Number(co.nextBillingAt) || 0) > now) continue; // not due yet
    await runSquareCharge(d.id);
  }
  // Organizations with their own card on file.
  const orgSnap = await db.collection("organizations").where("squareCardId", ">", "").get();
  for (const d of orgSnap.docs) {
    const org = d.data();
    if (org.billingExempt || org.status === "suspended") continue;
    if ((Number(org.nextBillingAt) || 0) > now) continue;
    await runSquareChargeOrg(d.id);
  }
});

// Square webhook (Hosting rewrites /square/** here). Verifies the HMAC-SHA256
// signature, then mirrors payments + keeps the company status in sync.
export const squareWebhook = onRequest({ cors: false }, async (req, res) => {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  const key = c.squareWebhookSignatureKey;
  if (!key) { res.status(503).send("Square not configured"); return; }
  const raw = (req as unknown as { rawBody: Buffer }).rawBody?.toString("utf8") || "";
  const sig = req.headers["x-square-hmacsha256-signature"] as string;
  const expected = crypto.createHmac("sha256", key).update(`${APP_URL}/square/webhook` + raw).digest("base64");
  if (!sig || sig !== expected) { res.status(400).send("bad signature"); return; }

  try {
    const event = JSON.parse(raw || "{}");
    const payment = event?.data?.object?.payment;
    if (payment?.customer_id) {
      const snap = await db.collection("companies").where("squareCustomerId", "==", payment.customer_id).limit(1).get();
      if (!snap.empty) {
        const companyId = snap.docs[0].id;
        await mirrorSquarePayment(companyId, payment);
        if (payment.status === "COMPLETED") {
          await snap.docs[0].ref.set({ status: "active", pastDueSince: 0, billingHold: false, updatedAt: Date.now() }, { merge: true });
        }
      } else {
        // Not a company — it may be an organization's own card.
        const orgSnap = await db.collection("organizations").where("squareCustomerId", "==", payment.customer_id).limit(1).get();
        if (!orgSnap.empty) {
          const orgId = orgSnap.docs[0].id;
          await mirrorSquareOrgPayment(orgId, payment);
          if (payment.status === "COMPLETED") {
            await orgSnap.docs[0].ref.set({ status: "active", pastDueSince: 0, billingHold: false, updatedAt: Date.now() }, { merge: true });
          }
        }
      }
    }
    res.json({ received: true });
  } catch (e: any) {
    logger.error("Square webhook handler error", e);
    res.status(500).send("handler error");
  }
});

// Daily dunning: pause companies still unpaid 3 days after a failed charge.
export const billingDunning = onSchedule("every 24 hours", async () => {
  const cutoff = Date.now() - 3 * 86400000;
  const snap = await db.collection("companies").where("pastDueSince", ">", 0).get();
  const cfg = await getNotifyConfig();
  for (const d of snap.docs) {
    const c = d.data();
    if (c.billingHold || c.status === "suspended") continue;
    if ((c.pastDueSince as number) > cutoff) continue; // still inside the 3-day grace window
    await d.ref.set({ status: "suspended", billingHold: true, updatedAt: Date.now() }, { merge: true });
    for (const to of await companyAdminEmails(d.id)) {
      await sendEmail(cfg, to, "Account paused — payment overdue",
        `Your YoutilityKnock account has been paused because payment is more than 3 days overdue. Update the card on file to restore access immediately.`);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// trialExpiry — pause companies whose 3-day trial has elapsed. Suspending only
// gates access; every lead, shift, and setting they entered is preserved, so
// subscribing later resumes them exactly where they left off.
// ───────────────────────────────────────────────────────────────────────────
export const trialExpiry = onSchedule("every 1 hours", async () => {
  const now = Date.now();
  const snap = await db.collection("companies").where("status", "==", "trial").get();
  const cfg = await getNotifyConfig();
  for (const d of snap.docs) {
    const c = d.data();
    const end = Number(c.trialEndsAt) || 0;
    if (!end || end > now) continue; // still inside the trial window
    await d.ref.set({ status: "suspended", trialExpired: true, updatedAt: now }, { merge: true });
    for (const to of await companyAdminEmails(d.id)) {
      await sendEmail(cfg, to, "Trial ended — account paused",
        `Your YoutilityKnock ${TRIAL_DAYS}-day trial has ended, so the account is now paused. All of your data is saved — subscribe to a plan to pick up right where you left off.`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PER-JOB BILLING (custom plan) — a company on this model pays a fixed monthly
// base on the 1st that includes the first N sold jobs; every sold job beyond
// that is billed per-job, weekly. Each Sunday the billing contact gets a tokened
// form to approve the week's dispositioned "sold" jobs and classify any that
// weren't dispositioned; on submit, the super-admin is emailed to review and
// bill. Auto-charges the card on file, else sends an invoice due the next Wed.
// Config lives on the company doc under `perJobBilling` (so it's opt-in, not
// wired to any company name). Standard recurring billing is skipped for these
// companies (see guards in saveCardAndSubscribe / squareSaveCardAndSubscribe /
// squareBillingCron) so the base isn't double-charged.
// ════════════════════════════════════════════════════════════════════════════
const PERJOB_TZ = "America/Denver"; // "MST" — DST-aware Mountain time

interface PerJobCfg { enabled: boolean; monthlyBase: number; includedJobs: number; perJobPrice: number; tz: string; }
function perJobCfg(company: Record<string, any>): PerJobCfg {
  const p = (company && company.perJobBilling) || {};
  return {
    enabled: p.enabled === true,
    monthlyBase: Number(p.monthlyBase) || 500,
    includedJobs: Number.isFinite(Number(p.includedJobs)) ? Number(p.includedJobs) : 5,
    perJobPrice: Number(p.perJobPrice) || 100,
    tz: typeof p.tz === "string" && p.tz ? p.tz : PERJOB_TZ,
  };
}

// ── Timezone helpers (no external lib): compute wall-clock day boundaries in a
// named IANA zone from a UTC instant. Good enough for weekly billing windows. ──
function tzOffsetMs(ms: number, tz: string): number {
  const d = new Date(ms);
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const loc = new Date(d.toLocaleString("en-US", { timeZone: tz })).getTime();
  return loc - utc;
}
function tzStartOfDay(ms: number, tz: string): number {
  const off = tzOffsetMs(ms, tz);
  const dayStartLocal = Math.floor((ms + off) / 86400000) * 86400000;
  return dayStartLocal - off;
}
function tzMonthKey(ms: number, tz: string): string {
  const s = new Date(ms).toLocaleString("en-US", { timeZone: tz, month: "2-digit", year: "numeric" });
  const m = s.match(/(\d{2})\D+(\d{4})/);
  return m ? `${m[2]}-${m[1]}` : s;
}
function perJobFmt(ms: number, tz: string): string {
  return new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
}
// The billing week for a Sunday fire = the completed Sun 00:00 → next Sun 00:00
// window that just ended (i.e. the prior Sun–Sat).
function perJobWeekWindow(fireMs: number, tz: string): { weekStart: number; weekEnd: number } {
  const weekEnd = tzStartOfDay(fireMs, tz);       // this Sunday 00:00 (fire day)
  const weekStart = weekEnd - 7 * 86400000;        // previous Sunday 00:00
  return { weekStart, weekEnd };
}

// Charge a company's saved card (Square card-on-file, else Stripe default PM)
// off-session for an arbitrary amount, mirroring the result into invoices/{id}.
// Returns { noCard:true } when there's no usable card so callers fall back to an
// emailed invoice.
async function chargeCardOnFile(
  companyId: string, cents: number, note: string, lineDesc: string,
): Promise<{ ok: boolean; noCard?: boolean; invoiceId?: string; error?: string }> {
  if (cents <= 0) return { ok: true };
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  const sqCard = company.squareCardId as string | undefined;
  const sqCust = company.squareCustomerId as string | undefined;
  if (sqCard && sqCust) {
    try {
      const cfg = await squareCfg();
      const { payment } = await squareApi(cfg, "/v2/payments", {
        idempotency_key: crypto.randomUUID(),
        source_id: sqCard, customer_id: sqCust,
        location_id: cfg.locationId || undefined,
        amount_money: { amount: cents, currency: "USD" },
        note: note.slice(0, 500),
      });
      await mirrorSquarePayment(companyId, payment);
      await db.doc(`invoices/${payment.id}`).set(
        { lines: [{ description: lineDesc, amount: cents }], perJob: true, updatedAt: Date.now() }, { merge: true });
      return { ok: true, invoiceId: payment.id };
    } catch (e: any) { return { ok: false, error: e?.message || "Square charge failed." }; }
  }
  const stCust = company.stripeCustomerId as string | undefined;
  if (stCust) {
    try {
      const stripe = await stripeClient();
      const cust: any = await stripe.customers.retrieve(stCust);
      const pmRef = cust?.invoice_settings?.default_payment_method;
      if (!pmRef) return { ok: false, noCard: true };
      const pi = await stripe.paymentIntents.create({
        amount: cents, currency: "usd", customer: stCust,
        payment_method: typeof pmRef === "string" ? pmRef : pmRef.id,
        off_session: true, confirm: true, description: note,
        metadata: { companyId, kind: "perjob" },
      });
      const now = Date.now();
      const paid = pi.status === "succeeded";
      await db.doc(`invoices/${pi.id}`).set({
        stripePaymentIntentId: pi.id, companyId, companyName: company.name || "",
        number: `PJ-${now.toString(36).toUpperCase()}`, status: paid ? "paid" : "open", perJob: true,
        amountDue: cents, amountPaid: paid ? cents : 0, currency: "usd",
        created: now, lines: [{ description: lineDesc, amount: cents }], updatedAt: now,
      }, { merge: true });
      return paid ? { ok: true, invoiceId: pi.id } : { ok: false, error: `Payment ${pi.status}` };
    } catch (e: any) { return { ok: false, error: e?.message || "Stripe charge failed." }; }
  }
  return { ok: false, noCard: true };
}

// Create a simple (no-signature) invoice for a per-job amount, attach a Square
// hosted pay link, and email the billing contact. "Pay by <dueMs>".
async function createOverageInvoice(
  companyId: string, cents: number, lines: Array<{ description: string; amount: number }>, dueMs: number,
): Promise<{ invoiceId: string; payUrl: string; sent: number; error: string }> {
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  const now = Date.now();
  const ref = db.collection("invoices").doc();
  const number = `PJ-${now.toString(36).toUpperCase()}`;
  await ref.set({
    companyId, companyName: company.name || "",
    number, status: "open", manual: true, perJob: true,
    amountDue: cents, amountPaid: 0, currency: "usd",
    created: now, dueDate: dueMs, lines, updatedAt: now,
  });
  const payUrl = await squarePaymentLink(cents, `${number} — ${company.name || "YoutilityKnock"}`);
  if (payUrl) await ref.set({ payUrl, hostedInvoiceUrl: payUrl, updatedAt: Date.now() }, { merge: true });

  let sent = 0, error = "";
  try {
    const cfgN = await getNotifyConfig();
    const to = String(company.billingEmail || "").trim();
    const recipients = to ? [to] : await companyAdminEmails(companyId);
    if (!recipients.length) { error = "No billing email on file."; }
    const amt = "$" + (cents / 100).toFixed(2);
    const dueStr = new Date(dueMs).toLocaleString("en-US", { timeZone: PERJOB_TZ, weekday: "long", month: "short", day: "numeric" });
    const rows = lines.map((l) =>
      `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${escEmail(l.description)}</td>`+
      `<td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right">$${((l.amount || 0) / 100).toFixed(2)}</td></tr>`).join("");
    const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">`+
      `<div style="font-size:22px;font-weight:800;color:#0EA5E9">${PRODUCT_NAME}</div>`+
      `<p>${company.billingContactName ? "Hi " + escEmail(String(company.billingContactName)) + "," : "Hello,"}</p>`+
      `<p>Your ${PRODUCT_NAME} invoice <strong>${escEmail(number)}</strong> for <strong>${amt}</strong> is ready.</p>`+
      `<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px">${rows}`+
      `<tr><td style="padding:8px 0;font-weight:700">Total due</td><td style="padding:8px 0;font-weight:700;text-align:right">${amt}</td></tr></table>`+
      (payUrl ? `<p style="margin:22px 0"><a href="${escEmail(payUrl)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700;display:inline-block">Pay now →</a></p>` : "")+
      `<p style="color:#555;font-size:13px">Please pay by <strong>${escEmail(dueStr)}</strong>.</p></div>`;
    const text = `Your ${PRODUCT_NAME} invoice ${number} for ${amt} is ready. Please pay by ${dueStr}.${payUrl ? "\n\nPay now: " + payUrl : ""}`;
    for (const r of recipients) {
      const res = await sendEmailDetailed(cfgN, r, `Invoice ${number} — ${amt}`, text, undefined, html);
      if (res.ok) sent++; else error = res.detail;
    }
  } catch (e: any) { error = e?.message || "Email failed."; }
  return { invoiceId: ref.id, payUrl, sent, error };
}

// ── HTML builders for the emailed weekly form and its confirmation pages ──────
function perJobPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`+
    `<title>${escEmail(title)} — ${PRODUCT_NAME}</title>`+
    `<style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b1220;color:#f4f7fb;margin:0;padding:24px;line-height:1.5}`+
    `.wrap{max-width:640px;margin:0 auto}.card{background:#131c2e;border:1px solid #22304a;border-radius:16px;padding:22px 20px;margin:14px 0}`+
    `.brand{font-size:22px;font-weight:800;color:#38BDF8}.muted{color:#9fb0c8;font-size:13px}`+
    `h2,h3{font-family:'Space Grotesk',system-ui,sans-serif}`+
    `.job{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid #22304a;border-radius:12px;margin:8px 0;background:#0f1728}`+
    `.job h4{margin:0 0 3px;font-size:15px}.job .sub{color:#9fb0c8;font-size:12px}`+
    `label.opt{display:inline-flex;align-items:center;gap:6px;margin-right:16px;font-size:14px}`+
    `.btn{display:inline-block;background:#38BDF8;color:#04121f;font-weight:800;border:none;border-radius:10px;padding:14px 28px;font-size:15px;cursor:pointer;text-decoration:none}`+
    `input[type=checkbox],input[type=radio]{width:18px;height:18px;accent-color:#38BDF8}`+
    `.txt{width:100%;padding:11px;border-radius:8px;border:1px solid #33425f;background:#0f1728;color:#fff;font-size:15px}`+
    `.pill{display:inline-block;background:#0f1728;border:1px solid #22304a;border-radius:999px;padding:3px 10px;font-size:12px;color:#9fb0c8;margin-left:6px}</style></head>`+
    `<body><div class="wrap"><div class="brand">${PRODUCT_NAME}</div>${body}</div></body></html>`;
}
function perJobFormPage(w: any, id: string, token: string, label: string, tz: string): string {
  const price = Number(w.perJobPrice) || 100;
  const inc = Number.isFinite(Number(w.includedJobs)) ? Number(w.includedJobs) : 5;
  const sold: any[] = Array.isArray(w.soldJobs) ? w.soldJobs : [];
  const undis: any[] = Array.isArray(w.undispositioned) ? w.undispositioned : [];
  const sub = (it: any) => `${escEmail(perJobFmt(it.startAt, tz))}${it.closerName ? " · " + escEmail(String(it.closerName)) : ""}${it.address ? " · " + escEmail(String(it.address)) : ""}`;
  const soldRows = sold.length ? sold.map((it) =>
    `<div class="job"><input type="checkbox" name="sold_${escEmail(String(it.eventId))}" checked>`+
    `<div><h4>${escEmail(String(it.title || "Appointment"))}</h4><div class="sub">${sub(it)}</div>`+
    `<div class="sub">Checked = confirmed sold. Uncheck to dispute.</div></div></div>`).join("")
    : `<p class="muted">No dispositioned sold jobs recorded for this week.</p>`;
  const undisRows = undis.length ? undis.map((it) =>
    `<div class="job"><div style="flex:1"><h4>${escEmail(String(it.title || "Appointment"))}</h4><div class="sub">${sub(it)}</div>`+
    `<div style="margin-top:8px">`+
    `<label class="opt"><input type="radio" name="appt_${escEmail(String(it.eventId))}" value="sold"> Sold</label>`+
    `<label class="opt"><input type="radio" name="appt_${escEmail(String(it.eventId))}" value="not" checked> Not sold</label>`+
    `</div></div></div>`).join("")
    : `<p class="muted">No undispositioned appointments this week.</p>`;
  const body =
    `<div class="card"><h2 style="margin:0 0 4px">Weekly sold-jobs approval</h2>`+
    `<div class="muted">${escEmail(String(w.companyName || ""))} · Week of <strong style="color:#f4f7fb">${escEmail(label)}</strong></div>`+
    `<p class="muted" style="margin-top:10px">Your monthly base includes the first ${inc} sold jobs. Each confirmed sold job beyond that is $${price}, billed weekly.</p></div>`+
    `<form method="post" action="/billing-week/${escEmail(id)}">`+
    `<input type="hidden" name="t" value="${escEmail(token)}">`+
    `<div class="card"><h3 style="margin-top:0">✅ Sold jobs to approve<span class="pill">${sold.length}</span></h3>`+
    `<p class="muted">Marked sold by your closers — confirm each.</p>${soldRows}</div>`+
    `<div class="card"><h3 style="margin-top:0">❓ Appointments needing a decision<span class="pill">${undis.length}</span></h3>`+
    `<p class="muted">Not yet dispositioned — mark each Sold or Not sold.</p>${undisRows}</div>`+
    `<div class="card"><label class="muted">Your name (optional)</label><input class="txt" name="contact" placeholder="Billing contact name" style="margin-top:6px">`+
    `<div style="margin-top:18px"><button class="btn" type="submit">Submit approval →</button></div>`+
    `<p class="muted" style="margin-top:12px">Please submit by Monday 11:00 AM MST. Your account team is notified to finalize billing once you submit.</p></div>`+
    `</form>`;
  return perJobPage("Weekly approval", body);
}
function perJobEmailHtml(contactName: string, companyName: string, label: string, soldN: number, undisN: number, url: string, dueStr: string): string {
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">`+
    `<div style="font-size:22px;font-weight:800;color:#0EA5E9">${PRODUCT_NAME}</div>`+
    `<h2 style="margin:14px 0 6px">Weekly sold-jobs approval</h2>`+
    `<p>${contactName ? "Hi " + escEmail(contactName) + "," : "Hello,"}</p>`+
    `<p>Your weekly billing approval for <strong>${escEmail(companyName)}</strong> — week of <strong>${escEmail(label)}</strong> — is ready.</p>`+
    `<p>${soldN} sold job${soldN === 1 ? "" : "s"} to approve · ${undisN} appointment${undisN === 1 ? "" : "s"} to review.</p>`+
    `<p style="margin:22px 0"><a href="${escEmail(url)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700;display:inline-block">Review &amp; approve →</a></p>`+
    `<p style="color:#555;font-size:13px">Please submit by <strong>${escEmail(dueStr)}, 11:00 AM MST</strong>. Each confirmed sold job beyond your monthly included jobs is billed at your per-job rate.</p></div>`;
}
function perJobSubmitEmailHtml(companyName: string, label: string, soldCount: number, price: number, adminUrl: string): string {
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">`+
    `<div style="font-size:22px;font-weight:800;color:#0EA5E9">${PRODUCT_NAME}</div>`+
    `<h2 style="margin:14px 0 6px">Weekly approval submitted</h2>`+
    `<p><strong>${escEmail(companyName)}</strong> submitted their sold-jobs approval for the week of <strong>${escEmail(label)}</strong>.</p>`+
    `<p>Confirmed sold jobs: <strong>${soldCount}</strong> (per-job rate $${price}).</p>`+
    `<p style="margin:22px 0"><a href="${escEmail(adminUrl)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700;display:inline-block">Review, approve &amp; bill →</a></p>`+
    `<p style="color:#555;font-size:13px">Open the console to confirm the count, then approve to auto-charge the card on file (or send an invoice due Wednesday).</p></div>`;
}

// setPerJobBilling (super) — enable/disable + set the numbers on a company.
export const setPerJobBilling = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { companyId, enabled, monthlyBase, includedJobs, perJobPrice, invoiceMode } = (request.data || {}) as {
    companyId?: string; enabled?: boolean; monthlyBase?: number; includedJobs?: number; perJobPrice?: number; invoiceMode?: string;
  };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");
  const ref = db.doc(`companies/${companyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Company not found.");
  const existing = (snap.data()?.perJobBilling as Record<string, unknown>) || {};
  const on = enabled !== false;
  const base = Math.max(0, Number(monthlyBase) || 0) || 500;
  const inc = Number.isFinite(Number(includedJobs)) ? Math.max(0, Number(includedJobs)) : 5;
  const per = Math.max(0, Number(perJobPrice) || 0) || 100;
  const mode = invoiceMode === "auto" ? "auto" : "manual"; // manual = review & Approve; auto = send Sunday
  const patch: Record<string, unknown> = {
    // Preserve basePaidMonths (and any other prior fields) across edits.
    perJobBilling: { ...existing, enabled: on, monthlyBase: base, includedJobs: inc, perJobPrice: per, invoiceMode: mode, tz: PERJOB_TZ, updatedAt: Date.now() },
    updatedAt: Date.now(),
  };
  if (on) { patch.planPrice = base; patch.plan = "Per-job billing"; }
  await ref.set(patch, { merge: true });
  return { ok: true, enabled: on, monthlyBase: base, includedJobs: inc, perJobPrice: per, invoiceMode: mode };
});

// markPerJobBasePaid (super) — record a company's monthly base as paid (or clear
// it) for a given month. Writes a paid invoice record for visibility and adds
// the month to basePaidMonths so the monthly cron won't bill it again.
export const markPerJobBasePaid = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { companyId, monthKey, paid } = (request.data || {}) as { companyId?: string; monthKey?: string; paid?: boolean };
  if (!companyId || !monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) throw new HttpsError("invalid-argument", "companyId and monthKey (YYYY-MM) required.");
  const ref = db.doc(`companies/${companyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Company not found.");
  const company = snap.data() || {};
  const pj = (company.perJobBilling as Record<string, any>) || {};
  const cfg = perJobCfg(company);
  const months = new Set(Array.isArray(pj.basePaidMonths) ? pj.basePaidMonths : []);
  const markPaid = paid !== false;
  if (markPaid) months.add(monthKey); else months.delete(monthKey);
  await ref.set({ perJobBilling: { ...pj, basePaidMonths: Array.from(months), updatedAt: Date.now() } }, { merge: true });
  const invId = `perjobbase_${companyId}_${monthKey}`;
  if (markPaid) {
    const cents = Math.round(cfg.monthlyBase * 100);
    const y = Number(monthKey.slice(0, 4)), m = Number(monthKey.slice(5, 7));
    const monthName = new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
    await db.doc(`invoices/${invId}`).set({
      companyId, companyName: company.name || "", number: `PJ-BASE-${monthKey}`,
      status: "paid", manual: true, perJob: true, perJobBase: true, monthKey,
      amountDue: cents, amountPaid: cents, currency: "usd",
      created: Date.now(), paidAt: Date.now(),
      lines: [{ description: `Monthly base — ${monthName} (includes first ${cfg.includedJobs} sold jobs)`, amount: cents }],
      updatedAt: Date.now(),
    }, { merge: true });
  } else {
    await db.doc(`invoices/${invId}`).delete().catch(() => {});
  }
  return { ok: true, paid: markPaid, basePaidMonths: Array.from(months) };
});

// perJobMonthlyBase — charge/invoice the fixed monthly base on the 1st.
export const perJobMonthlyBase = onSchedule({ schedule: "7 6 1 * *", timeZone: PERJOB_TZ }, async () => {
  const snap = await db.collection("companies").where("perJobBilling.enabled", "==", true).get();
  for (const d of snap.docs) {
    try {
      const company = d.data();
      const cfg = perJobCfg(company);
      const cents = Math.round(cfg.monthlyBase * 100);
      if (cents <= 0) continue;
      const monthKey = tzMonthKey(Date.now(), cfg.tz);
      const paidMonths = Array.isArray(company.perJobBilling?.basePaidMonths) ? company.perJobBilling.basePaidMonths : [];
      if (paidMonths.includes(monthKey)) { logger.info(`perJobMonthlyBase: ${d.id} ${monthKey} already billed — skip`); continue; }
      const monthStr = new Date().toLocaleString("en-US", { timeZone: cfg.tz, month: "long", year: "numeric" });
      const desc = `Monthly base — ${monthStr} (includes first ${cfg.includedJobs} sold jobs)`;
      const charge = await chargeCardOnFile(d.id, cents, `YoutilityKnock ${desc}`, desc);
      if (!charge.ok) {
        const due = tzStartOfDay(Date.now() + 5 * 86400000, cfg.tz) + 23 * 3600000;
        await createOverageInvoice(d.id, cents, [{ description: desc, amount: cents }], due);
      }
      // Record the month as billed so a re-run can't double-charge.
      await d.ref.set({ perJobBilling: { ...(company.perJobBilling || {}), basePaidMonths: Array.from(new Set([...paidMonths, monthKey])), updatedAt: Date.now() } }, { merge: true });
      logger.info(`perJobMonthlyBase: ${d.id} ${charge.ok ? "charged" : "invoiced"} $${cfg.monthlyBase}`);
    } catch (e) { logger.warn(`perJobMonthlyBase failed for ${d.id}`, e); }
  }
});

// perJobWeeklyForms — every Sunday, build each per-job company's week doc and
// email the billing contact a tokened approval form.
export const perJobWeeklyForms = onSchedule({ schedule: "7 17 * * 0", timeZone: PERJOB_TZ }, async () => {
  const now = Date.now();
  const snap = await db.collection("companies").where("perJobBilling.enabled", "==", true).get();
  const cfgN = await getNotifyConfig();
  for (const d of snap.docs) {
    try {
      const company = d.data();
      const cfg = perJobCfg(company);
      const { weekStart, weekEnd } = perJobWeekWindow(now, cfg.tz);
      const weekDocId = `${d.id}_${weekStart}`;
      if ((await db.doc(`perJobWeeks/${weekDocId}`).get()).exists) continue; // already generated
      const evSnap = await db.collection("events").where("companyId", "==", d.id).get();
      const sold: any[] = []; const undis: any[] = [];
      evSnap.forEach((e) => {
        const ev = e.data();
        if (ev.type !== "appointment") return;
        const start = Number(ev.startAt) || 0;
        if (start < weekStart || start >= weekEnd) return;
        const item = {
          eventId: e.id, title: ev.title || ev.address || "Appointment", address: ev.address || "",
          startAt: start, closerName: ev.closerName || "", setterName: ev.setterName || "", decision: null as string | null,
        };
        if (ev.apptStatus === "closed_won") { item.decision = "approved"; sold.push(item); }
        else if (!ev.apptStatus || ev.apptStatus === "scheduled") { undis.push(item); }
      });
      const token = crypto.randomBytes(16).toString("hex");
      const dueBy = tzStartOfDay(weekEnd + 36 * 3600000, cfg.tz) + 11 * 3600000; // Monday 11:00 local
      const mode = company.perJobBilling?.invoiceMode === "auto" ? "auto" : "manual";
      const label = `${perJobFmt(weekStart, cfg.tz)} – ${perJobFmt(weekEnd - 86400000, cfg.tz)}`;
      await db.doc(`perJobWeeks/${weekDocId}`).set({
        companyId: d.id, companyName: company.name || "",
        weekStart, weekEnd, monthKey: tzMonthKey(weekStart, cfg.tz), tz: cfg.tz,
        perJobPrice: cfg.perJobPrice, includedJobs: cfg.includedJobs,
        token, mode, status: "pending", createdAt: now, dueBy,
        soldJobs: sold, undispositioned: undis, soldCount: 0, amountCents: 0,
      });
      const to = String(company.billingEmail || "").trim();
      const recipients = to ? [to] : await companyAdminEmails(d.id);

      if (mode === "auto") {
        // Auto-send: bill the week immediately from the closers' dispositioned
        // sold jobs (undispositioned treated as not sold), then email a receipt
        // to the contact and the super-admin — no approval form, no manual step.
        const undisNot = undis.map((it) => ({ ...it, decision: "not" }));
        const wObj = { companyId: d.id, monthKey: tzMonthKey(weekStart, cfg.tz), weekStart, weekEnd, tz: cfg.tz, includedJobs: cfg.includedJobs, perJobPrice: cfg.perJobPrice };
        const r = await finalizePerJobWeek(weekDocId, wObj, company, sold, undisNot, "auto");
        const amt = "$" + (r.amountCents / 100).toFixed(2);
        const rHtml = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">`+
          `<div style="font-size:22px;font-weight:800;color:#0EA5E9">${PRODUCT_NAME}</div>`+
          `<h2 style="margin:14px 0 6px">Weekly per-job billing — ${escEmail(label)}</h2>`+
          `<p>${company.billingContactName ? "Hi " + escEmail(String(company.billingContactName)) + "," : "Hello,"}</p>`+
          `<p><strong>${escEmail(String(company.name || ""))}</strong> had <strong>${r.soldCount}</strong> sold job${r.soldCount === 1 ? "" : "s"} this week. `+
          (r.amountCents > 0
            ? `${r.billableThisWeek} beyond your ${r.includedJobs} monthly included ${r.charged ? "were charged" : "were invoiced"}: <strong>${amt}</strong>.`
            : `All were within your ${r.includedJobs} monthly included jobs — nothing extra to bill.`)+
          `</p></div>`;
        const rText = `${company.name || ""} — weekly per-job billing (${label}): ${r.soldCount} sold, ${r.billableThisWeek} billable, ${amt} ${r.charged ? "charged" : (r.amountCents > 0 ? "invoiced" : "—")}.`;
        for (const rc of recipients) await sendEmailDetailed(cfgN, rc, `Weekly billing — ${company.name || ""} (${label})`, rText, undefined, rHtml);
        for (const s of await superAdminEmails()) await sendEmailDetailed(cfgN, s, `Auto-billed weekly — ${company.name || ""} (${label})`, rText, undefined, rHtml);
        logger.info(`perJobWeeklyForms: ${d.id} AUTO → ${r.soldCount} sold / ${r.billableThisWeek} billable / ${amt}`);
      } else {
        // Manual: email the billing contact the approval form.
        if (recipients.length) {
          const url = `${APP_URL}/billing-week/${weekDocId}?t=${token}`;
          const dueStr = perJobFmt(dueBy, cfg.tz);
          const html = perJobEmailHtml(String(company.billingContactName || ""), String(company.name || ""), label, sold.length, undis.length, url, dueStr);
          const text = `Your weekly sold-jobs approval for ${company.name || ""} (${label}) is ready. Please review and submit by ${dueStr}, 11:00 AM MST:\n${url}`;
          for (const r of recipients) await sendEmailDetailed(cfgN, r, `Approve weekly sold jobs — ${company.name || ""} (${label})`, text, undefined, html);
        }
        logger.info(`perJobWeeklyForms: ${d.id} MANUAL → ${sold.length} sold / ${undis.length} undispositioned`);
      }
    } catch (e) { logger.warn(`perJobWeeklyForms failed for ${d.id}`, e); }
  }
});

// perJobDeadline — Monday 11:00 MST: any week still un-submitted is marked
// overdue and the super-admin is emailed to finalize it manually.
export const perJobDeadline = onSchedule({ schedule: "0 11 * * 1", timeZone: PERJOB_TZ }, async () => {
  const now = Date.now();
  const snap = await db.collection("perJobWeeks").where("status", "==", "pending").get();
  if (snap.empty) return;
  const supers = await superAdminEmails();
  const cfgN = await getNotifyConfig();
  for (const d of snap.docs) {
    const w = d.data() as any;
    if ((Number(w.dueBy) || 0) > now) continue; // deadline not reached yet
    await d.ref.set({ status: "overdue", overdueAt: now }, { merge: true });
    if (!supers.length) continue;
    const tz = w.tz || PERJOB_TZ;
    const label = `${perJobFmt(w.weekStart, tz)} – ${perJobFmt(w.weekEnd - 86400000, tz)}`;
    const adminUrl = `${APP_URL}/admin.html?company=${w.companyId}&perjob=${d.id}`;
    const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">`+
      `<div style="font-size:22px;font-weight:800;color:#0EA5E9">${PRODUCT_NAME}</div>`+
      `<h2 style="margin:14px 0 6px">Weekly billing not submitted</h2>`+
      `<p><strong>${escEmail(String(w.companyName || ""))}</strong> did not submit their sold-jobs approval for the week of <strong>${escEmail(label)}</strong> by the Monday 11:00 AM MST deadline.</p>`+
      `<p style="margin:22px 0"><a href="${escEmail(adminUrl)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700;display:inline-block">Review &amp; finalize →</a></p>`+
      `<p style="color:#555;font-size:13px">Open the console to confirm each job and bill the week manually.</p></div>`;
    const text = `${w.companyName || ""} has not submitted the weekly sold-jobs form (week ${label}). Review and finalize in the console:\n${adminUrl}`;
    for (const s of supers) await sendEmailDetailed(cfgN, s, `Action needed — weekly billing not submitted (${w.companyName || ""})`, text, undefined, html);
  }
});

// perJobForm — public (tokened) weekly approval form. GET renders it; POST
// records the billing contact's decisions and notifies the super-admin.
// Hosting rewrites /billing-week/** here.
export const perJobForm = onRequest({ cors: true }, async (req, res) => {
  try {
    const parts = req.path.split("/").filter(Boolean).filter((p) => p !== "billing-week");
    const weekId = parts[0] || "";
    const token = String((req.method === "POST" ? (req.body?.t ?? req.query.t) : req.query.t) || "");
    if (!weekId) { res.status(400).send(perJobPage("Invalid link", `<div class="card"><p>Missing form id.</p></div>`)); return; }
    const ref = db.doc(`perJobWeeks/${weekId}`);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).send(perJobPage("Not found", `<div class="card"><p>This form link is no longer available.</p></div>`)); return; }
    const w = snap.data() as any;
    if (!token || token !== w.token) { res.status(403).send(perJobPage("Invalid link", `<div class="card"><p>This form link is invalid.</p></div>`)); return; }
    const tz = w.tz || PERJOB_TZ;
    const label = `${perJobFmt(w.weekStart, tz)} – ${perJobFmt(w.weekEnd - 86400000, tz)}`;
    const done = ["submitted", "approved", "charged", "invoiced"].includes(w.status);

    if (req.method === "POST") {
      if (done) { res.status(200).send(perJobPage("Already submitted", `<div class="card"><p>Thanks — this week (${escEmail(label)}) was already submitted.</p></div>`)); return; }
      const sold = (Array.isArray(w.soldJobs) ? w.soldJobs : []).map((it: any) => ({ ...it, decision: req.body[`sold_${it.eventId}`] ? "approved" : "disputed" }));
      const undis = (Array.isArray(w.undispositioned) ? w.undispositioned : []).map((it: any) => ({ ...it, decision: req.body[`appt_${it.eventId}`] === "sold" ? "sold" : "not" }));
      const soldCount = sold.filter((x: any) => x.decision === "approved").length + undis.filter((x: any) => x.decision === "sold").length;
      const now = Date.now();
      await ref.set({ soldJobs: sold, undispositioned: undis, soldCount, status: "submitted", submittedAt: now, submittedName: String(req.body.contact || "").slice(0, 200) }, { merge: true });
      try {
        const supers = await superAdminEmails();
        if (supers.length) {
          const cfgN = await getNotifyConfig();
          const adminUrl = `${APP_URL}/admin.html?company=${w.companyId}&perjob=${weekId}`;
          const price = Number(w.perJobPrice) || 100;
          const html = perJobSubmitEmailHtml(String(w.companyName || ""), label, soldCount, price, adminUrl);
          const text = `${w.companyName || ""} submitted their weekly sold-jobs approval (${label}). Confirmed sold: ${soldCount}. Review, approve & bill:\n${adminUrl}`;
          for (const s of supers) await sendEmailDetailed(cfgN, s, `Ready to bill — ${w.companyName || ""} weekly (${label})`, text, undefined, html);
        }
      } catch (e) { logger.warn("perJobForm submit notify failed", e); }
      res.status(200).send(perJobPage("Submitted ✓",
        `<div class="card"><h2 style="margin-top:0">Thank you! ✅</h2>`+
        `<p>Your weekly approval for <strong>${escEmail(String(w.companyName || ""))}</strong> (${escEmail(label)}) has been submitted.</p>`+
        `<p>You confirmed <strong>${soldCount}</strong> sold job${soldCount === 1 ? "" : "s"}. Your account team will finalize billing.</p></div>`));
      return;
    }

    if (done) { res.status(200).send(perJobPage("Already submitted", `<div class="card"><p>This week (${escEmail(label)}) has already been submitted. Thank you!</p></div>`)); return; }
    res.status(200).send(perJobFormPage(w, weekId, token, label, tz));
  } catch (e: any) {
    logger.error("perJobForm error", e);
    res.status(500).send(perJobPage("Error", `<div class="card"><p>Something went wrong. Please try again.</p></div>`));
  }
});

// listPerJobWeeks (super) — weeks for a company (or all), newest first.
export const listPerJobWeeks = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { companyId } = (request.data || {}) as { companyId?: string };
  let q: FirebaseFirestore.Query = db.collection("perJobWeeks");
  if (companyId) q = q.where("companyId", "==", companyId);
  const snap = await q.get();
  const weeks: any[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, any>) }))
    .sort((a: any, b: any) => (b.weekStart || 0) - (a.weekStart || 0));
  // Attach a light invoice summary to each billed week (for the View-invoice links).
  await Promise.all(weeks.map(async (w) => {
    if (!w.invoiceId) return;
    try {
      const inv = (await db.doc(`invoices/${w.invoiceId}`).get()).data();
      if (inv) w.invoice = { number: inv.number || "", status: inv.status || "open", amountDue: inv.amountDue || 0, url: inv.payUrl || inv.hostedInvoiceUrl || "" };
    } catch { /* best effort */ }
  }));
  // Company config + outstanding per-job receivables (open/past-due invoices).
  let config: any = null; let basePaidMonths: string[] = []; let openInvoices: any[] = [];
  if (companyId) {
    const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
    const pj = (company.perJobBilling as Record<string, any>) || {};
    config = {
      enabled: pj.enabled === true, monthlyBase: Number(pj.monthlyBase) || 500,
      includedJobs: Number.isFinite(Number(pj.includedJobs)) ? Number(pj.includedJobs) : 5,
      perJobPrice: Number(pj.perJobPrice) || 100, invoiceMode: pj.invoiceMode === "auto" ? "auto" : "manual",
    };
    basePaidMonths = Array.isArray(pj.basePaidMonths) ? pj.basePaidMonths : [];
    const invSnap = await db.collection("invoices").where("companyId", "==", companyId).get();
    openInvoices = invSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))
      .filter((i) => i.perJob === true && (i.status === "open" || i.status === "past_due"))
      .map((i) => ({ id: i.id, number: i.number || "", amountDue: i.amountDue || 0, dueDate: i.dueDate || null, status: i.status, url: i.payUrl || i.hostedInvoiceUrl || "", perJobBase: !!i.perJobBase }))
      .sort((a, b) => (b.dueDate || 0) - (a.dueDate || 0));
  }
  return { weeks, config, basePaidMonths, openInvoices };
});

// Finalize a week: given the confirmed sold/undispositioned decisions, compute
// the billable count against the rolling monthly included-jobs allowance, then
// auto-charge the card on file (else invoice, due the following Wed), and write
// the result onto the week doc. Shared by the manual approval and the Sunday
// auto-send path.
async function finalizePerJobWeek(
  weekId: string, w: any, company: Record<string, any>, sold: any[], undis: any[], approvedBy: string,
): Promise<{ status: string; soldCount: number; billableThisWeek: number; includedJobs: number; amountCents: number; invoiceId: string; charged: boolean; error: string }> {
  const cfg = perJobCfg(company);
  const tz = w.tz || cfg.tz;
  // A dispositioned sold job counts unless explicitly disputed; an
  // undispositioned appointment only counts if explicitly marked sold.
  const soldCount = sold.filter((x) => x.decision !== "disputed").length + undis.filter((x) => x.decision === "sold").length;
  const includedJobs = Number.isFinite(Number(w.includedJobs)) ? Number(w.includedJobs) : cfg.includedJobs;
  const price = Number(w.perJobPrice) || cfg.perJobPrice;

  // Roll the monthly included-jobs allowance across already-billed weeks.
  const priorSnap = await db.collection("perJobWeeks").where("companyId", "==", w.companyId).where("monthKey", "==", w.monthKey).get();
  let prior = 0;
  priorSnap.forEach((d) => { if (d.id === weekId) return; const x = d.data() as any; if (["approved", "invoiced", "charged"].includes(x.status)) prior += Number(x.billedSoldCount) || 0; });
  const billableThisWeek = Math.max(0, Math.max(0, (prior + soldCount) - includedJobs) - Math.max(0, prior - includedJobs));
  const amountCents = Math.round(billableThisWeek * price * 100);

  const now = Date.now();
  let status = "approved", invoiceId = "", charged = false, error = "";
  if (amountCents > 0) {
    const label = `${perJobFmt(w.weekStart, tz)} – ${perJobFmt(w.weekEnd - 86400000, tz)}`;
    const desc = `${billableThisWeek} sold job${billableThisWeek === 1 ? "" : "s"} @ $${price} — week ${label}`;
    const charge = await chargeCardOnFile(w.companyId, amountCents, `YoutilityKnock per-job billing — ${desc}`, desc);
    if (charge.ok) { status = "charged"; invoiceId = charge.invoiceId || ""; charged = true; }
    else {
      const wed = tzStartOfDay(w.weekEnd + 3 * 86400000 + 12 * 3600000, tz) + 23 * 3600000 + 59 * 60000; // Wed EOD, following week
      const inv = await createOverageInvoice(w.companyId, amountCents, [{ description: desc, amount: amountCents }], wed);
      status = "invoiced"; invoiceId = inv.invoiceId; error = charge.error || "";
    }
  }
  await db.doc(`perJobWeeks/${weekId}`).set({
    soldJobs: sold, undispositioned: undis,
    soldCount, billedSoldCount: soldCount, billableThisWeek, priorSoldThisMonth: prior,
    amountCents, status, invoiceId, approvedAt: now, approvedBy,
  }, { merge: true });
  return { status, soldCount, billableThisWeek, includedJobs, amountCents, invoiceId, charged, error };
}

// approvePerJobWeek (super) — apply any decision overrides, then finalize & bill.
export const approvePerJobWeek = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { weekId, decisions } = (request.data || {}) as { weekId?: string; decisions?: Record<string, string> };
  if (!weekId) throw new HttpsError("invalid-argument", "weekId required.");
  const ref = db.doc(`perJobWeeks/${weekId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Billing week not found.");
  const w = snap.data() as any;
  if (w.status === "charged" || w.status === "invoiced") throw new HttpsError("failed-precondition", "This week has already been billed.");
  const company = (await db.doc(`companies/${w.companyId}`).get()).data() || {};
  let sold: any[] = Array.isArray(w.soldJobs) ? w.soldJobs.slice() : [];
  let undis: any[] = Array.isArray(w.undispositioned) ? w.undispositioned.slice() : [];
  if (decisions && typeof decisions === "object") {
    sold = sold.map((it) => (decisions[it.eventId] ? { ...it, decision: decisions[it.eventId] } : it));
    undis = undis.map((it) => (decisions[it.eventId] ? { ...it, decision: decisions[it.eventId] } : it));
  }
  const r = await finalizePerJobWeek(weekId, w, company, sold, undis, caller.uid);
  return { ok: true, ...r };
});

// ════════════════════════════════════════════════════════════════════════════
// YOUTILITYCRM INTEGRATION — provision a Knock company as a CRM add-on, sync
// leads + appointments + customer data both ways, and keep schedules linked.
//
// The link is configured PER COMPANY (crmLinks/{companyId}): each tenant in the
// CRM has its own company login, so each gets its own 4 settings —
//   enabled · crmCompanyId · webhookUrl (Knock→CRM) · apiSecret.
// External calls send the company's secret in the `x-crm-secret` header.
// A single global "master" secret (config/crm.apiSecret) authenticates the
// /provision bootstrap (run before any company exists) and is accepted as a
// fallback. Hosting rewrites /crm/** here.
// ════════════════════════════════════════════════════════════════════════════
async function crmMasterSecret(): Promise<string> {
  const c = ((await db.doc("config/crm").get()).data() as Record<string, string>) || {};
  return c.apiSecret || "";
}

// Master provisioning key (super-admin only) — the CRM↔Knock platform key.
export const getCrmConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const secret = await crmMasterSecret();
  return { secretConfigured: !!secret, secretMask: mask(secret) };
});

export const setCrmConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const u: Record<string, unknown> = { updatedAt: Date.now() };
  if (typeof d.apiSecret === "string" && d.apiSecret.trim()) u.apiSecret = d.apiSecret.trim();
  await db.doc("config/crm").set(u, { merge: true });
  return { ok: true };
});

// ── Per-company CRM link (the config fields) ─────────────────────────────────
interface CompanyCrm { enabled: boolean; crmCompanyId: string; webhookUrl: string; appointmentWebhookUrl: string; apiSecret: string; }
async function companyCrm(companyId: string): Promise<CompanyCrm> {
  const c = ((await db.doc(`crmLinks/${companyId}`).get()).data() as Record<string, any>) || {};
  return {
    enabled: !!c.enabled,
    crmCompanyId: c.crmCompanyId || "",
    webhookUrl: c.webhookUrl || "",
    appointmentWebhookUrl: c.appointmentWebhookUrl || "",
    apiSecret: c.apiSecret || "",
  };
}

// Read one company's link (super-admin, or that company's own admin).
export const getCompanyCrm = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = authorizeForCompany(caller, (request.data || {}).companyId);
  const c = await companyCrm(companyId);
  return {
    enabled: c.enabled, crmCompanyId: c.crmCompanyId,
    webhookUrl: c.webhookUrl, appointmentWebhookUrl: c.appointmentWebhookUrl,
    secretConfigured: !!c.apiSecret, secretMask: mask(c.apiSecret),
  };
});

// Save one company's link. Mirrors non-secret fields onto the company doc so
// the app/console can see CRM status without reading the server-only secret.
export const setCompanyCrm = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as Record<string, any>;
  const companyId = authorizeForCompany(caller, d.companyId);
  const u: Record<string, unknown> = { companyId, updatedAt: Date.now() };
  if (typeof d.enabled === "boolean") u.enabled = d.enabled;
  if (typeof d.crmCompanyId === "string") u.crmCompanyId = d.crmCompanyId.trim();
  if (typeof d.webhookUrl === "string") u.webhookUrl = d.webhookUrl.trim();
  if (typeof d.appointmentWebhookUrl === "string") u.appointmentWebhookUrl = d.appointmentWebhookUrl.trim();
  if (typeof d.apiSecret === "string" && d.apiSecret.trim()) u.apiSecret = d.apiSecret.trim();
  await db.doc(`crmLinks/${companyId}`).set(u, { merge: true });
  const mirror: Record<string, unknown> = {};
  if ("enabled" in u) mirror.crmEnabled = u.enabled;
  if ("crmCompanyId" in u) mirror.crmCompanyId = (u.crmCompanyId as string) || null;
  if (Object.keys(mirror).length) await db.doc(`companies/${companyId}`).set(mirror, { merge: true });
  return { ok: true };
});

// Authenticate a CRM request: prefer the company's own secret, fall back to the
// global master key (covers the provision bootstrap before a company exists).
async function crmAuth(sent: string, companyId?: string): Promise<boolean> {
  if (!sent) return false;
  if (companyId) {
    const link = await companyCrm(companyId);
    if (link.apiSecret && sent === link.apiSecret) return true;
  }
  const master = await crmMasterSecret();
  return !!master && sent === master;
}

// Push a changed lead / appointment to that company's CRM webhook (best-effort).
// Leads and appointments have separate endpoints in the CRM add-on.
async function pushToCrm(kind: "lead" | "event" | "reward", companyId: string, id: string, data: any) {
  if (data?._syncedFrom === "crm") return; // came from the CRM — don't echo back
  const link = await companyCrm(companyId);
  if (!link.enabled) return; // sync paused
  const url = kind === "event"
    ? (link.appointmentWebhookUrl || link.webhookUrl)
    : link.webhookUrl; // rewards/contests ride the main webhook
  if (!url) return; // no endpoint configured for this kind
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-crm-secret": link.apiSecret },
      body: JSON.stringify({ type: kind, companyId, crmCompanyId: link.crmCompanyId, id, data }),
    });
  } catch (e) { logger.warn(`pushToCrm ${kind} failed`, e); }
}

export const onLeadSync = onDocumentWritten("leads/{id}", async (event) => {
  const after = event.data?.after?.data();
  if (!after?.companyId) return;
  await pushToCrm("lead", after.companyId, event.params.id, after);
});

export const onEventSync = onDocumentWritten("events/{id}", async (event) => {
  const after = event.data?.after?.data();
  if (!after?.companyId) return;
  await pushToCrm("event", after.companyId, event.params.id, after);
});

// Keep companies/{id}.schedulerActive in sync with the roster, so the door
// booking flow hides closer-selection whenever any Scheduler is active — even for
// Schedulers enabled before the flag existed. Writes only when the value changes.
export const onUserSchedulerSync = onDocumentWritten("users/{uid}", async (event) => {
  const after = event.data?.after?.data();
  const before = event.data?.before?.data();
  const companyId = (after?.companyId || before?.companyId) as string | undefined;
  if (!companyId) return;
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const schedulerActive = usersSnap.docs.some((d) => { const u = d.data() as any; return u.disabled !== true && u.isScheduler === true; });
  const cur = (await db.doc(`companies/${companyId}`).get()).data()?.schedulerActive === true;
  if (cur !== schedulerActive) await db.doc(`companies/${companyId}`).set({ schedulerActive }, { merge: true });
});

// When an appointment is removed from a rep's schedule (the event doc is
// deleted, by any path), also pull the invite off their linked Google/Outlook
// calendar so it never lingers there. cancelAppointment / reassign already clean
// up their own paths; this is the catch-all for direct deletes. Deleting an
// already-gone external event just 404s (caught), so double-cleanup is harmless.
export const onEventDeletedRemoveCalendar = onDocumentDeleted("events/{id}", async (event) => {
  const ev = event.data?.data();
  if (!ev) return;
  if (ev.userId && (ev.googleEventId || ev.microsoftEventId)) {
    await deleteExternalEvent(ev.userId as string, {
      googleEventId: ev.googleEventId as string | undefined,
      microsoftEventId: ev.microsoftEventId as string | undefined,
    }).catch((e) => logger.warn("event delete: external calendar remove failed", e));
  }
});

// Rewards & contests sync to the CRM in real time (and skip CRM-originated ones
// so the two dashboards stay in sync without looping).
export const onRewardSync = onDocumentWritten("companies/{cid}/rewards/{rid}", async (event) => {
  const after = event.data?.after?.data();
  if (!after) return; // deletion — leave the CRM copy to its own lifecycle
  await pushToCrm("reward", event.params.cid, event.params.rid, after);
});

// ── Solar Scanner pins (CRM → field app) ─────────────────────────────────────
// The CRM pushes its solar-scanner pins here (POST /crm/solar-pins) and the
// field map reads them back through getSolarPins. A plain pin marks a home the
// scanner mailed/texted/emailed; `hot` marks one where the homeowner engaged
// (scanned the postcard QR / clicked the SMS or email link) — the 🔥 hot lead.
// Visibility: admins, managers and super-admins see every pin; a rep sees only
// pins that fall inside a territory assigned to them.
function pinInPolygon(pt: { lat: number; lng: number }, poly: Array<{ lat: number; lng: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
    const hit = yi > pt.lat !== yj > pt.lat && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export const getSolarPins = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = ((request.data || {}) as { companyId?: string }).companyId || caller.companyId;
  if (!companyId) throw new HttpsError("invalid-argument", "companyId is required.");
  if (!caller.isSuper && caller.companyId !== companyId) {
    throw new HttpsError("permission-denied", "Not allowed to read this company.");
  }
  const snap = await db.collection("companies").doc(companyId).collection("solarPins").get();
  let pins = (snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, any>>)
    .filter((p) => typeof p.lat === "number" && typeof p.lng === "number");

  // Admins / managers / super-admins see every pin. A rep sees only the pins
  // inside a territory assigned to them (assignedTo === uid, or legacy
  // territoryIds membership for unassigned-but-listed areas).
  const seeAll = caller.isSuper || caller.role === "admin" || caller.role === "manager";
  if (!seeAll) {
    const [tSnap, uSnap] = await Promise.all([
      db.collection("territories").where("companyId", "==", companyId).get(),
      db.doc(`users/${caller.uid}`).get(),
    ]);
    const myIds: string[] = (uSnap.data()?.territoryIds as string[]) || [];
    const mine = (tSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, any>>)
      .filter((t) => Array.isArray(t.polygon) && t.polygon.length >= 3)
      .filter((t) => (t.assignedTo ? t.assignedTo === caller.uid : myIds.includes(t.id)));
    pins = pins.filter((p) => mine.some((t) => pinInPolygon({ lat: p.lat, lng: p.lng }, t.polygon)));
  }
  return { pins };
});

// ── /crm/** router (provision · export · ingest) ─────────────────────────────

// Block CRM data access for a company that's locked. A billing lock (unpaid /
// dunning hold / expired trial) returns 402 with the payment message the linked
// CRM should show; a plain admin suspension returns 403. Returns true if it
// sent a blocking response (caller should `return`).
async function crmCompanyAccessBlocked(companyId: string, res: any): Promise<boolean> {
  const c = (await db.doc(`companies/${companyId}`).get()).data();
  if (!c) return false; // unknown company → let the normal handler respond
  const status = String(c.status || "active").toLowerCase();
  const billingLocked = Boolean(c.billingHold || c.trialExpired || c.pastDueSince || status === "past_due");
  if (billingLocked) {
    res.status(402).json({ error: "Please contact your administrator for payment to reactivate your account.", code: "PAYMENT_REQUIRED" });
    return true;
  }
  if (status === "suspended" || status === "inactive") {
    res.status(403).json({ error: "This account is inactive. Please contact your system administrator.", code: "ACCOUNT_INACTIVE" });
    return true;
  }
  return false;
}

export const crmApi = onRequest({ cors: true }, async (req, res) => {
  const sent = req.get("x-crm-secret") || "";
  const path = req.path;
  try {
    // ── Provision a Knock company (the add-on toggle) ──
    if (req.method === "POST" && path.endsWith("/provision")) {
      // Bootstrap runs before the company exists → master key only.
      if (!(await crmAuth(sent))) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { name, crmCompanyId, adminEmail, adminName, plan, webhookUrl, appointmentWebhookUrl, apiSecret } =
        (req.body || {}) as Record<string, string>;
      if (!name || !adminEmail) { res.status(400).json({ error: "name and adminEmail required" }); return; }

      // Reuse an existing linked company if this CRM company was already provisioned.
      const existing = crmCompanyId
        ? await db.collection("companies").where("crmCompanyId", "==", crmCompanyId).limit(1).get()
        : null;
      let companyId: string;
      if (existing && !existing.empty) {
        companyId = existing.docs[0].id;
      } else {
        const ref = await db.collection("companies").add({
          name, plan: plan || "knock", status: "active", addons: ["knock"],
          crmCompanyId: crmCompanyId || null, crmEnabled: true, createdAt: Date.now(), createdBy: "crm",
        });
        companyId = ref.id;
        const roles = ref.collection("roles");
        await roles.add({ companyId, title: "Manager", baseTier: "manager", rank: 100, isDefault: true, createdAt: Date.now() });
        await roles.add({ companyId, title: "User", baseTier: "user", rank: 10, isDefault: true, createdAt: Date.now() });
        await ref.collection("teams").add({ companyId, name: "Company", parentTeamId: null, kind: "company", createdAt: Date.now() });
      }

      // Establish this company's own CRM link. Use the secret the CRM sent, or
      // mint one and hand it back so the CRM can store it for future calls.
      const companySecret = (apiSecret && apiSecret.trim()) ||
        "yk_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await db.doc(`crmLinks/${companyId}`).set({
        companyId, enabled: true, crmCompanyId: crmCompanyId || "",
        webhookUrl: (webhookUrl || "").trim(), appointmentWebhookUrl: (appointmentWebhookUrl || "").trim(),
        apiSecret: companySecret, updatedAt: Date.now(),
      }, { merge: true });

      // Create the company admin (or reuse), then a magic sign-in link.
      let uid: string;
      try {
        const u = await getAuth().getUserByEmail(adminEmail);
        uid = u.uid;
      } catch {
        const u = await getAuth().createUser({
          email: adminEmail, password: "Yk-" + Math.random().toString(36).slice(2, 10) + "A9!",
          displayName: adminName || adminEmail.split("@")[0],
        });
        uid = u.uid;
      }
      await getAuth().setCustomUserClaims(uid, { role: "admin", companyId });
      await db.doc(`users/${uid}`).set({
        uid, email: adminEmail, displayName: adminName || adminEmail.split("@")[0],
        role: "admin", companyId, managerPath: [], disabled: false, createdAt: Date.now(), createdBy: "crm",
      }, { merge: true });

      let inviteLink = "";
      try {
        inviteLink = await getAuth().generateSignInWithEmailLink(adminEmail, { url: `${APP_URL}/app/login?invite=1`, handleCodeInApp: true });
      } catch (e) { logger.warn("provision invite link failed", e); }

      res.json({ ok: true, companyId, adminEmail, apiSecret: companySecret, inviteLink, appUrl: `${APP_URL}/app` });
      return;
    }

    // ── Export a company's leads + appointments + users (CRM pull) ──
    if (req.method === "GET" && path.endsWith("/export")) {
      const companyId = req.query.companyId as string;
      if (!companyId) { res.status(400).json({ error: "companyId required" }); return; }
      if (!(await crmAuth(sent, companyId))) { res.status(401).json({ error: "Unauthorized" }); return; }
      if (await crmCompanyAccessBlocked(companyId, res)) return;
      const [company, usersSnap, leadsSnap, eventsSnap, rewardsSnap, statsSnap] = await Promise.all([
        db.doc(`companies/${companyId}`).get(),
        db.collection("users").where("companyId", "==", companyId).get(),
        db.collection("leads").where("companyId", "==", companyId).get(),
        db.collection("events").where("companyId", "==", companyId).get(),
        db.collection("companies").doc(companyId).collection("rewards").get(),
        db.collection("userStats").where("companyId", "==", companyId).get(),
      ]);
      // Leaderboard = company head-to-head ranking, sorted by closes then appts.
      const leaderboard = statsSnap.docs
        .map((d) => ({ uid: d.id, ...d.data() }) as Record<string, any>)
        .sort((a, b) => (b.sales || 0) - (a.sales || 0) || (b.appointments || 0) - (a.appointments || 0))
        .map((r, i) => ({ rank: i + 1, ...r }));
      res.json({
        company: company.exists ? { id: company.id, ...company.data() } : null,
        users: usersSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        leads: leadsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        appointments: eventsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        rewards: rewardsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        leaderboard,
      });
      return;
    }

    // ── Ingest / upsert a lead OR reward/contest from the CRM (push into Knock) ──
    if (req.method === "POST" && path.endsWith("/ingest")) {
      const { companyId, lead, reward } = (req.body || {}) as { companyId?: string; lead?: any; reward?: any };
      if (!companyId || (!lead && !reward)) { res.status(400).json({ error: "companyId and lead or reward required" }); return; }
      if (!(await crmAuth(sent, companyId))) { res.status(401).json({ error: "Unauthorized" }); return; }
      if (await crmCompanyAccessBlocked(companyId, res)) return;

      // Reward / contest from the CRM → companies/{id}/rewards so reps see it in-app.
      if (reward) {
        const now = Date.now();
        const data: Record<string, unknown> = {
          companyId,
          name: reward.name || "Reward",
          description: reward.description || "",
          imageUrl: reward.imageUrl || "",
          kind: reward.kind === "store" ? "store" : "benchmark",
          audience: reward.audience === "team" ? "team" : "individual",
          metric: reward.kind === "store" ? "points" : (reward.metric || "sales"),
          period: reward.period || "monthly",
          target: Number(reward.target) || 1,
          active: reward.active !== false,
          startsAt: Number(reward.startsAt) || 0,
          expiresAt: Number(reward.expiresAt) || 0,
          crmRewardId: reward.crmRewardId || null,
          _syncedFrom: "crm", updatedAt: now,
        };
        const col = db.collection("companies").doc(companyId).collection("rewards");
        let existingR = null;
        if (reward.crmRewardId) {
          const q = await col.where("crmRewardId", "==", reward.crmRewardId).limit(1).get();
          if (!q.empty) existingR = q.docs[0];
        }
        let rid: string;
        if (existingR) { await existingR.ref.set(data, { merge: true }); rid = existingR.id; }
        else { const ref = await col.add({ ...data, createdAt: now, createdBy: "crm" }); rid = ref.id; }
        res.json({ ok: true, rewardId: rid });
        return;
      }
      // Default owner = a company admin, so the lead is visible in the app.
      const adminSnap = await db.collection("users").where("companyId", "==", companyId).where("role", "==", "admin").limit(1).get();
      const ownerUid = adminSnap.empty ? null : adminSnap.docs[0].id;
      const now = Date.now();
      const fields: any = {
        companyId, address: lead.address || "", city: lead.city || null, state: lead.state || null, zip: lead.zip || null,
        ownerName: lead.ownerName || lead.name || null, phone: lead.phone || null, email: lead.email || null,
        status: lead.status || "new", notes: lead.notes || null,
        lat: typeof lead.lat === "number" ? lead.lat : null, lng: typeof lead.lng === "number" ? lead.lng : null,
        crmLeadId: lead.crmLeadId || null, _syncedFrom: "crm",
        assignedTo: ownerUid, visibilityPath: ownerUid ? [ownerUid] : [], createdBy: ownerUid || "crm", updatedAt: now,
      };
      // Upsert by crmLeadId when provided.
      let existing = null;
      if (lead.crmLeadId) {
        const q = await db.collection("leads").where("companyId", "==", companyId).where("crmLeadId", "==", lead.crmLeadId).limit(1).get();
        if (!q.empty) existing = q.docs[0];
      }
      let id: string;
      if (existing) { await existing.ref.set(fields, { merge: true }); id = existing.id; }
      else { const ref = await db.collection("leads").add({ ...fields, createdAt: now }); id = ref.id; }
      res.json({ ok: true, leadId: id });
      return;
    }

    // ── Upsert solar-scanner pins from the CRM (push into the field map) ──
    if (req.method === "POST" && path.endsWith("/solar-pins")) {
      const { companyId, pins } = (req.body || {}) as { companyId?: string; pins?: any[] };
      if (!companyId || !Array.isArray(pins)) { res.status(400).json({ error: "companyId and pins[] required" }); return; }
      if (!(await crmAuth(sent, companyId))) { res.status(401).json({ error: "Unauthorized" }); return; }
      const col = db.collection("companies").doc(companyId).collection("solarPins");
      const now = Date.now();
      let upserted = 0;
      // Firestore caps a batch at 500 writes — chunk to stay well under it.
      for (let i = 0; i < pins.length; i += 400) {
        const batch = db.batch();
        for (const p of pins.slice(i, i + 400)) {
          if (typeof p?.lat !== "number" || typeof p?.lng !== "number") continue;
          const id = String(p.id || `${p.scanId}_${p.resultIdx}`).replace(/[^\w-]/g, "_");
          batch.set(col.doc(id), {
            companyId,
            scanId: p.scanId ?? null,
            resultIdx: typeof p.resultIdx === "number" ? p.resultIdx : null,
            lat: p.lat, lng: p.lng,
            address: p.address || "",
            ownerName: p.ownerName || "",
            // Outreach sent — powers the "Mailed/Texted/Emailed on <date>" popup.
            mailedAt: p.mailedAt ?? null,
            smsAt: p.smsAt ?? null,
            emailAt: p.emailAt ?? null,
            hot: !!p.hotLead,
            hotSource: p.hotLeadSource || "",
            hotAt: p.hotLeadAt ?? null,
            crmContactId: p.contactId ?? null,
            _syncedFrom: "crm", updatedAt: now,
          }, { merge: true });
          upserted++;
        }
        await batch.commit();
      }
      res.json({ ok: true, upserted });
      return;
    }

    res.status(404).json({ error: "Unknown CRM endpoint" });
  } catch (e: any) {
    logger.error("crmApi error", e);
    res.status(500).json({ error: e?.message || "internal" });
  }
});
