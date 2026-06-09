import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addDoc, collection, getDocs, query, where } from "firebase/firestore";
import { Geolocation } from "@capacitor/geolocation";
import { db, auth } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { hasFeature } from "../lib/features";
import { useNav } from "../components/NavContext";
import { DISP_COLOR } from "../lib/dispositions";
import { lookupArea, parseAreaProperties, lookupMovers, parseMovers, type MoverHome } from "../lib/knockstat";
import { moverIcon, moverColor, moverPopupHtml, daysAgo, MOVER_DAYS } from "../lib/movers";
import { getTile, putTile, nearbyCachedHomes } from "../lib/homeCache";
import DispositionModal, { type DispoInput } from "../components/DispositionModal";
import ShiftHud from "../components/ShiftHud";
import type { Lead, Territory, LatLng, UserProfile } from "../types";

type MapMode = "view" | "draw" | "drop";

const DEFAULT_CENTER: [number, number] = [40.34, -111.91];
const NEAREST_N = 200;
const ROAM_THRESHOLD_M = 450; // reload nearby homes once you've moved ~0.28 mi
const HOME_CAP = 700; // accumulate up to this many roaming pins, then reset
const MOVER_CAP = 500; // accumulate up to this many roaming mover pins, then reset

const HOUSE_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M12 3 3 10.5h2.4V21h5.1v-6h3v6h5.1V10.5H21z"/></svg>';

function homeIcon(color: string, flagged = false): L.DivIcon {
  return L.divIcon({
    className: "home-pin",
    html: `<span style="background:${color}">${HOUSE_SVG}</span>${flagged ? '<i class="pin-x">✕</i>' : ""}`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// Guard against corrupt/missing coordinates (the cause of pins smearing across
// the globe): must be finite, in range, and not the 0,0 null-island.
function validCoord(lat: unknown, lng: unknown): [number, number] | null {
  const la = Number(lat);
  const ln = Number(lng);
  if (!isFinite(la) || !isFinite(ln)) return null;
  if (la === 0 && ln === 0) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return [la, ln];
}

function inPolygon(pt: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
    const intersect = yi > pt.lat !== yj > pt.lat && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export default function MapPage() {
  const { profile, role, companyId, company } = useAuth();
  const { openNav } = useNav();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const leadLayer = useRef<L.LayerGroup>(L.layerGroup());
  const homeLayer = useRef<L.LayerGroup>(L.layerGroup());
  const moverLayer = useRef<L.LayerGroup>(L.layerGroup());
  const leadsRef = useRef<Lead[]>([]);
  const homeKeys = useRef<Set<string>>(new Set()); // dedupe accumulated home pins
  const moverKeys = useRef<Set<string>>(new Set()); // dedupe accumulated mover pins
  const lastLoadCenter = useRef<L.LatLng | null>(null);
  const loadingRef = useRef(false);
  const roamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const youMarker = useRef<L.CircleMarker | null>(null);
  const watchId = useRef<string | null>(null);
  const territoryLayer = useRef<L.LayerGroup>(L.layerGroup());
  const assigned = useRef<Territory[]>([]);
  const myLoc = useRef<LatLng | null>(null);
  const drawPts = useRef<LatLng[]>([]);
  const drawLayer = useRef<L.Polygon | null>(null);
  const modeRef = useRef<MapMode>("view");

  const [status, setStatus] = useState("Loading map…");
  const [mode, setMode] = useState<MapMode>("view");
  const [loadingHomes, setLoadingHomes] = useState(false);
  // "Movers only" hides the lead + gray home pins so just the recent move-ins
  // show. The ref lets the async roam loop read the current toggle state.
  const [moversOnly, setMoversOnly] = useState(false);
  const moversOnlyRef = useRef(false);
  moversOnlyRef.current = moversOnly;
  // Follow mode: when ON (compass button), the map recenters on the rep's live
  // location as they move. OFF (default) lets them pan/zoom freely. The ref lets
  // the geolocation watch read the current toggle without re-subscribing.
  const [following, setFollowing] = useState(false);
  const followRef = useRef(false);
  followRef.current = following;
  const [dispoTarget, setDispoTarget] = useState<DispoInput | null>(null);
  // Save panel shown after an area is drawn: name it + assign it to a rep.
  const [savePanel, setSavePanel] = useState(false);
  const [drawName, setDrawName] = useState("");
  const [drawAssignee, setDrawAssignee] = useState("");
  const [reps, setReps] = useState<UserProfile[]>([]);
  modeRef.current = mode;

  const canDraw = role === "admin" || role === "manager";

  async function fetchLeads(): Promise<Lead[]> {
    if (!companyId || !profile) return [];
    const base = collection(db, "leads");
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId))
        : query(base, where("companyId", "==", companyId), where("visibilityPath", "array-contains", profile.uid));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Lead, "id">) }));
  }

  async function buildPins() {
    leadLayer.current.clearLayers();
    const leads = await fetchLeads();
    leadsRef.current = leads;
    leads.forEach((lead) => {
      const c = validCoord(lead.lat, lead.lng);
      if (!c) return;
      L.marker(c, {
        icon: homeIcon(DISP_COLOR[lead.status] || "#94A3B8", lead.verified === false),
        zIndexOffset: 1000, // always above generic home pins
      })
        .on("click", () =>
          setDispoTarget({
            leadId: lead.id, address: lead.address, lat: c[0], lng: c[1], status: lead.status,
            name: lead.ownerName || "", phone: lead.phone || "", email: lead.email || "", notes: lead.notes || "",
            enrichment: lead.enrichment,
            photoHomeUrl: lead.photoHomeUrl, photoBillUrl: lead.photoBillUrl,
          })
        )
        .addTo(leadLayer.current);
    });
  }

  async function buildTerritories() {
    territoryLayer.current.clearLayers();
    assigned.current = [];
    if (!companyId) return;
    const snap = await getDocs(query(collection(db, "territories"), where("companyId", "==", companyId)));
    const mineIds = profile?.territoryIds || [];
    snap.forEach((d) => {
      const t = { id: d.id, ...(d.data() as Omit<Territory, "id">) };
      if (!t.polygon || t.polygon.length < 3) return;
      const label = t.assignedToName ? `${t.name} · ${t.assignedToName}` : t.name;
      L.polygon(t.polygon.map((p) => [p.lat, p.lng] as [number, number]), {
        color: t.color || "#34D399", weight: 2, fillOpacity: 0.08,
      })
        .bindTooltip(label)
        .addTo(territoryLayer.current);
      // A rep's working area is the one assigned to them. If an area has no
      // assignee, fall back to the legacy territoryIds membership (or show-all).
      const isMine = t.assignedTo
        ? t.assignedTo === profile?.uid
        : !mineIds.length || mineIds.includes(t.id);
      if (isMine) assigned.current.push(t);
    });
  }

  // A loaded home is "already a lead" only if it's the SAME house — matched by
  // address, or within ~8 m (a lead is created from that exact home pin, so its
  // coords match within a meter or two). Kept tight so neighboring homes — which
  // sit ~15–20 m away — still get their own pins.
  function isExistingLead(h: { address: string; lat: number; lng: number }): boolean {
    const norm = (a?: string) => (a || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
    const ha = norm(h.address);
    const here = L.latLng(h.lat, h.lng);
    return leadsRef.current.some((l) => {
      if (ha && norm(l.address) === ha) return true;
      const c = validCoord(l.lat, l.lng);
      return !!c && here.distanceTo(L.latLng(c[0], c[1])) < 8;
    });
  }

  function addHomeMarker(h: { address: string; lat: number; lng: number }): boolean {
    const key = `${h.lat.toFixed(5)},${h.lng.toFixed(5)}`;
    if (homeKeys.current.has(key)) return false; // already on the map
    homeKeys.current.add(key);
    if (isExistingLead(h)) return false; // keep the existing lead pin, don't recreate
    L.marker([h.lat, h.lng], { icon: homeIcon("#475569") })
      .on("click", () => setDispoTarget({ address: h.address, lat: h.lat, lng: h.lng }))
      .addTo(homeLayer.current);
    return true;
  }

  // Nearest ~200 homes around a center → pins (dedupes against what's shown;
  // accumulates). Serves from the local cache when this tile was already pulled,
  // so walking/panning back over loaded ground costs no ATTOM call.
  async function fetchNearby(center: LatLng) {
    const cached = getTile(center.lat, center.lng);
    if (cached && cached.length) {
      cached.forEach((h) => addHomeMarker(h));
      return;
    }
    const token = await auth.currentUser!.getIdToken();
    const raw = await lookupArea(center.lat, center.lng, 0.5, token);
    const homes = parseAreaProperties(raw)
      .map((h) => ({ address: h.address, lat: h.lat, lng: h.lng, d: L.latLng(center.lat, center.lng).distanceTo(L.latLng(h.lat, h.lng)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, NEAREST_N)
      .map(({ address, lat, lng }) => ({ address, lat, lng }));
    putTile(center.lat, center.lng, homes);
    homes.forEach((h) => addHomeMarker(h));
  }

  // ── Movers (recent move-ins) ────────────────────────────────────────────────
  // Mover pins ride on their own layer above the leads/homes, colored by how
  // recently the home sold. They load automatically for the rep's assigned area
  // (or around their live location) alongside the regular home pins.
  function addMoverMarker(m: MoverHome): boolean {
    const c = validCoord(m.lat, m.lng);
    if (!c) return false;
    const d = daysAgo(m.saleDate);
    const color = moverColor(d);
    if (!color) return false; // older than the widest window — not a mover
    const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
    if (moverKeys.current.has(key)) return false;
    moverKeys.current.add(key);
    L.marker(c, { icon: moverIcon(color), zIndexOffset: 2000 }) // sit above lead pins
      .bindPopup(moverPopupHtml(m))
      .addTo(moverLayer.current);
    return true;
  }

  async function fetchNearbyMovers(center: LatLng) {
    const token = await auth.currentUser!.getIdToken();
    const raw = await lookupMovers(center.lat, center.lng, 1, MOVER_DAYS, token);
    parseMovers(raw).forEach((m) => addMoverMarker(m));
  }

  // Load movers. Assigned-area move-ins ALWAYS show. Move-ins outside the
  // assigned area only show when "movers only" (🚚) is selected — otherwise the
  // recent move-in pins stay hidden so they don't clutter the normal view.
  async function loadMovers() {
    const map = mapRef.current;
    if (!map || !profile) return;
    moverLayer.current.clearLayers();
    moverKeys.current.clear();
    try {
      const token = await auth.currentUser!.getIdToken();
      if (assigned.current.length) {
        for (const t of assigned.current) {
          const poly = t.polygon!;
          const lats = poly.map((p) => p.lat);
          const lngs = poly.map((p) => p.lng);
          const center = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
          const radius = Math.min(
            L.latLng(center.lat, center.lng).distanceTo(L.latLng(Math.max(...lats), Math.max(...lngs))) / 1609.34,
            2
          );
          const raw = await lookupMovers(center.lat, center.lng, Math.max(0.1, +radius.toFixed(2)), MOVER_DAYS, token);
          parseMovers(raw)
            .filter((m) => inPolygon({ lat: m.lat, lng: m.lng }, poly))
            .forEach((m) => addMoverMarker(m));
        }
      }
      // Movers outside the assigned area: only when isolating movers.
      if (moversOnlyRef.current) {
        const c = myLoc.current || { lat: map.getCenter().lat, lng: map.getCenter().lng };
        await fetchNearbyMovers(c);
      }
    } catch {
      /* silent — movers are supplemental to the home pins */
    }
  }

  // Manual / initial load: assigned territory(ies) PLUS the homes around the
  // rep's current location/viewport, so pins always show where they're actually
  // standing or looking — not only over their territory. Roaming then keeps
  // loading more as they pan/walk.
  async function loadHomes() {
    const map = mapRef.current;
    if (!map || !profile) return;
    setLoadingHomes(true);
    homeLayer.current.clearLayers();
    homeKeys.current.clear();
    try {
      const token = await auth.currentUser!.getIdToken();
      if (assigned.current.length) {
        for (const t of assigned.current) {
          const poly = t.polygon!;
          const lats = poly.map((p) => p.lat);
          const lngs = poly.map((p) => p.lng);
          const center = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
          const radius = Math.min(
            L.latLng(center.lat, center.lng).distanceTo(L.latLng(Math.max(...lats), Math.max(...lngs))) / 1609.34,
            2
          );
          const raw = await lookupArea(center.lat, center.lng, Math.max(0.1, +radius.toFixed(2)), token);
          parseAreaProperties(raw)
            .filter((h) => inPolygon({ lat: h.lat, lng: h.lng }, poly))
            .forEach((h) => addHomeMarker(h));
        }
      }
      // Always also pull homes around where the rep is / is looking.
      const c = myLoc.current || { lat: map.getCenter().lat, lng: map.getCenter().lng };
      await fetchNearby(c);
      lastLoadCenter.current = L.latLng(c.lat, c.lng);
      setStatus(`${homeLayer.current.getLayers().length} homes loaded · move to load more`);
    } catch (e: any) {
      setStatus("Could not load homes: " + (e?.message || ""));
    } finally {
      setLoadingHomes(false);
    }
  }

  // Auto-load as the rep moves: when the map center drifts past the threshold
  // (and they're not drawing), pull homes around the new center and accumulate
  // them — no manual refresh needed. Runs everywhere now, including for reps
  // who have an assigned territory, so pins follow wherever they look/walk.
  async function autoRoam() {
    const map = mapRef.current;
    if (!map || !profile || loadingRef.current) return;
    if (modeRef.current === "draw") return;
    const ctr = map.getCenter();
    if (lastLoadCenter.current && ctr.distanceTo(lastLoadCenter.current) < ROAM_THRESHOLD_M) return;
    loadingRef.current = true;
    setLoadingHomes(true);
    try {
      if (moverLayer.current.getLayers().length > MOVER_CAP) {
        moverLayer.current.clearLayers();
        moverKeys.current.clear();
      }
      // Skip the gray home pulls while isolating movers — saves the ATTOM call.
      if (!moversOnlyRef.current) {
        if (homeLayer.current.getLayers().length > HOME_CAP) {
          homeLayer.current.clearLayers();
          homeKeys.current.clear();
        }
        await fetchNearby({ lat: ctr.lat, lng: ctr.lng });
      }
      // Move-ins outside the assigned area only roam in when isolating movers.
      if (moversOnlyRef.current) await fetchNearbyMovers({ lat: ctr.lat, lng: ctr.lng });
      lastLoadCenter.current = ctr;
      setStatus(
        moversOnlyRef.current
          ? `${moverLayer.current.getLayers().length} recent movers · keep moving`
          : `${homeLayer.current.getLayers().length} homes loaded · keep moving`
      );
    } catch {
      /* silent — keep what's already shown */
    } finally {
      loadingRef.current = false;
      setLoadingHomes(false);
    }
  }

  // Toggle "movers only": detach the lead + home pin layers (leaving just the
  // mover pins), or restore them. Used by the 🚚 FAB under the pencil. Reloads
  // movers so the recent move-ins outside the assigned area appear when ON, and
  // are cleared when OFF (leaving only assigned-area move-ins).
  async function toggleMoversOnly() {
    const map = mapRef.current;
    if (!map) return;
    const next = !moversOnly;
    setMoversOnly(next);
    moversOnlyRef.current = next;
    if (next) {
      map.removeLayer(homeLayer.current);
      map.removeLayer(leadLayer.current);
    } else {
      homeLayer.current.addTo(map);
      leadLayer.current.addTo(map);
    }
    await loadMovers();
    if (next) setStatus(`${moverLayer.current.getLayers().length} recent movers · other pins hidden`);
  }

  // Refresh button: recenter on the rep's live location, then reload movers
  // always and the homes/leads too unless hidden.
  async function refresh() {
    await recenterToMe();
    if (!moversOnly) await loadHomes();
    await loadMovers();
  }

  // Center the map on the rep's exact location (acquiring a fresh fix if we
  // don't have one yet). Used on login, on refresh, and by the compass button.
  async function recenterToMe(): Promise<void> {
    const map = mapRef.current;
    if (!map) return;
    let loc = myLoc.current;
    if (!loc) {
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        myLoc.current = loc;
        setYou(loc.lat, loc.lng);
      } catch {
        return; // location unavailable
      }
    }
    map.setView([loc.lat, loc.lng], Math.max(map.getZoom(), 18), { animate: true });
  }

  // Compass button: jump to the rep's exact location and follow them until they
  // tap it again. While off, the map stays wherever they panned/zoomed.
  async function toggleFollow() {
    const next = !following;
    setFollowing(next);
    followRef.current = next;
    if (next) await recenterToMe();
  }

  function setYou(lat: number, lng: number) {
    if (youMarker.current) youMarker.current.setLatLng([lat, lng]);
    else if (mapRef.current) {
      youMarker.current = L.circleMarker([lat, lng], {
        radius: 7, color: "#fff", weight: 3, fillColor: "#0EA5E9", fillOpacity: 1,
      }).addTo(mapRef.current).bindTooltip("You");
    }
  }

  // Watch the rep's GPS to keep the "You" marker current. The map only recenters
  // when follow mode is ON (compass button) — otherwise they're free to pan and
  // zoom without being yanked back. A small threshold avoids jitter from GPS
  // noise. Recentering triggers the debounced auto-load so homes appear ahead.
  async function startWatching() {
    if (watchId.current) return;
    try {
      watchId.current = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 10000 }, (pos) => {
        if (!pos) return;
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        myLoc.current = { lat, lng };
        setYou(lat, lng);
        const map = mapRef.current;
        if (followRef.current && map && map.getCenter().distanceTo(L.latLng(lat, lng)) > 12)
          map.panTo([lat, lng], { animate: true });
      });
    } catch {
      /* location unavailable — map just won't follow */
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!companyId || !profile || !elRef.current || mapRef.current) return;

    const satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Tiles © Esri — Maxar, Earthstar Geographics" }
    );
    const labels = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19 }
    );
    const hybrid = L.layerGroup([satellite, labels]);
    const gSat = L.tileLayer("https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
      subdomains: ["mt0", "mt1", "mt2", "mt3"], maxZoom: 21, attribution: "© Google",
    });
    const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });

    const map = L.map(elRef.current, { center: DEFAULT_CENTER, zoom: 14, maxZoom: 21, layers: [hybrid], zoomControl: false });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.layers({ "Esri satellite": hybrid, "Google satellite": gSat, Street: street }, undefined, { position: "topright" }).addTo(map);
    territoryLayer.current.addTo(map);
    homeLayer.current.addTo(map);
    leadLayer.current.addTo(map);
    moverLayer.current.addTo(map); // always on; sits above the other pins
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 120);

    map.on("click", (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      // Drop-a-pin mode: place a home pin where there isn't one, then open the
      // knock form so the rep can disposition it right away.
      if (modeRef.current === "drop") {
        L.marker([lat, lng], { icon: homeIcon("#475569") })
          .on("click", () => setDispoTarget({ address: "", lat, lng }))
          .addTo(homeLayer.current);
        setDispoTarget({ address: "", lat, lng });
        setMode("view");
        return;
      }
      if (modeRef.current !== "draw") return;
      drawPts.current.push({ lat, lng });
      if (drawLayer.current) drawLayer.current.remove();
      drawLayer.current = L.polygon(
        drawPts.current.map((p) => [p.lat, p.lng] as [number, number]),
        { color: "#38BDF8", weight: 2, fillOpacity: 0.15 }
      ).addTo(map);
    });

    // Auto-load homes as the rep pans / walks the map (debounced).
    map.on("moveend", () => {
      if (roamTimer.current) clearTimeout(roamTimer.current);
      roamTimer.current = setTimeout(() => void autoRoam(), 700);
    });

    (async () => {
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        myLoc.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setView([myLoc.current.lat, myLoc.current.lng], 18);
        setYou(myLoc.current.lat, myLoc.current.lng);
        // Instantly repaint homes we've cached nearby (no network), then refresh.
        nearbyCachedHomes(myLoc.current.lat, myLoc.current.lng).forEach((h) => addHomeMarker(h));
      } catch {
        /* location denied */
      }
      await buildTerritories();
      await buildPins();
      await loadHomes();
      void loadMovers(); // drop recent move-in pins for the area / live location
      void startWatching(); // track the "You" marker (recenters only in follow mode)
    })();

    return () => {
      if (roamTimer.current) clearTimeout(roamTimer.current);
      if (watchId.current) { Geolocation.clearWatch({ id: watchId.current }).catch(() => {}); watchId.current = null; }
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, profile, role]);

  // Load the reps this manager/admin can assign areas to (their downstream).
  useEffect(() => {
    if (!companyId || !profile || !canDraw) return;
    let cancelled = false;
    (async () => {
      try {
        const base = collection(db, "users");
        const q =
          role === "admin"
            ? query(base, where("companyId", "==", companyId))
            : query(base, where("companyId", "==", companyId), where("managerPath", "array-contains", profile.uid));
        const snap = await getDocs(q);
        let list = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserProfile, "uid">) }));
        if (!list.some((u) => u.uid === profile.uid)) list = [profile as UserProfile, ...list];
        list = list.filter((u) => !u.disabled).sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
        if (!cancelled) setReps(list);
      } catch (e) {
        console.error("load reps failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, profile, role, canDraw]);

  // Drawing finished → open the save panel (name + assignee), don't save yet.
  function finishDraw() {
    if (drawPts.current.length < 3) { setStatus("Tap at least 3 points to make an area."); return; }
    setDrawName("");
    setDrawAssignee(profile?.uid || "");
    setSavePanel(true);
  }

  async function saveArea() {
    if (!companyId || !profile) return;
    if (drawPts.current.length < 3) { cancelDraw(); return; }
    const rep = reps.find((r) => r.uid === drawAssignee);
    try {
      await addDoc(collection(db, "territories"), {
        companyId,
        name: drawName.trim() || "New area",
        color: "#34D399",
        polygon: drawPts.current,
        managerId: profile.uid,
        assignedTo: rep ? rep.uid : null,
        assignedToName: rep ? rep.displayName || rep.email || null : null,
        createdAt: Date.now(),
      });
      setStatus(rep ? `Area assigned to ${rep.displayName || rep.email}.` : "Area saved.");
      await buildTerritories();
      await loadHomes();
    } catch (e: any) {
      setStatus("Could not save: " + (e?.message || ""));
    }
    cancelDraw();
  }

  function cancelDraw() {
    drawPts.current = [];
    if (drawLayer.current) { drawLayer.current.remove(); drawLayer.current = null; }
    setSavePanel(false);
    setMode("view");
  }

  return (
    <div className="map-screen">
      <div ref={elRef} className="map-canvas-full" />

      {/* Top-left: menu + controls */}
      <div className="map-overlay map-tl">
        <button className="map-fab" onClick={openNav} aria-label="Menu">☰</button>
        <button className="map-fab" onClick={refresh} disabled={loadingHomes} aria-label="Refresh homes" title="Refresh homes & movers">
          {loadingHomes ? "…" : "⟳"}
        </button>
        {/* Compass: jump to my exact location and follow me until tapped again. */}
        <button
          className={"map-fab" + (following ? " active" : "")}
          onClick={toggleFollow}
          aria-label={following ? "Stop following my location" : "Go to my location"}
          title={following ? "Following you — tap to stop" : "Go to my location & follow"}
        >
          🧭
        </button>
        <button
          className={"map-fab" + (mode === "drop" ? " active" : "")}
          onClick={() => setMode(mode === "drop" ? "view" : "drop")}
          aria-label="Drop a home pin" title="Drop a home pin"
        >
          📍
        </button>
        {canDraw && (
          <button
            className={"map-fab" + (mode === "draw" ? " active" : "")}
            onClick={() => setMode(mode === "draw" ? "view" : "draw")}
            aria-label="Draw area" title="Draw area"
          >
            ✏
          </button>
        )}
        {/* Movers: isolate recent move-in pins (hide leads + gray homes). */}
        <button
          className={"map-fab" + (moversOnly ? " active" : "")}
          onClick={toggleMoversOnly}
          aria-label="Show movers only" title="Movers — recent move-ins only"
        >
          🚚
        </button>
      </div>

      {/* Top-center: status pill */}
      {status && <div className="map-status-pill">{status}</div>}

      {/* Drop-pin instructions */}
      {mode === "drop" && (
        <div className="map-draw-bar">
          <span>Tap the home to drop a pin and knock it.</span>
          <button className="btn sm" onClick={() => setMode("view")}>Cancel</button>
        </div>
      )}

      {/* Draw instructions */}
      {mode === "draw" && !savePanel && (
        <div className="map-draw-bar">
          <span>Tap to drop corners, then save your area.</span>
          <div className="row">
            <button className="btn sm" onClick={cancelDraw}>Cancel</button>
            <button className="btn primary sm" onClick={finishDraw}>Save</button>
          </div>
        </div>
      )}

      {/* Save panel: name the area + assign it to a rep */}
      {savePanel && (
        <div className="map-save-panel">
          <div className="msp-title">Save area</div>
          <label className="field">
            <span>Area name</span>
            <input value={drawName} onChange={(e) => setDrawName(e.target.value)} placeholder="e.g. Maple Heights" autoFocus />
          </label>
          <label className="field">
            <span>Assign to</span>
            <select value={drawAssignee} onChange={(e) => setDrawAssignee(e.target.value)}>
              <option value="">— Unassigned —</option>
              {reps.map((r) => (
                <option key={r.uid} value={r.uid}>
                  {(r.displayName || r.email) + (r.uid === profile?.uid ? " (me)" : "")}
                </option>
              ))}
            </select>
          </label>
          <div className="row end">
            <button className="btn sm" onClick={cancelDraw}>Cancel</button>
            <button className="btn primary sm" onClick={saveArea}>Save area</button>
          </div>
        </div>
      )}

      {/* Bottom-left: shift HUD / start button (Success Planner service) */}
      {hasFeature(company, "planner") && (
        <div className="map-overlay map-bl">
          <ShiftHud />
        </div>
      )}

      {/* Chat FAB is rendered globally by Layout (with unread alert). */}

      <DispositionModal target={dispoTarget} onClose={() => setDispoTarget(null)} onSaved={buildPins} />
    </div>
  );
}
