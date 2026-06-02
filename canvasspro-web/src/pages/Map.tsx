import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addDoc, collection, getDocs, query, where } from "firebase/firestore";
import { Geolocation } from "@capacitor/geolocation";
import { db, auth } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { useNav } from "../components/NavContext";
import { DISP_COLOR } from "../lib/dispositions";
import { lookupArea, parseAreaProperties } from "../lib/knockstat";
import { getTile, putTile, nearbyCachedHomes } from "../lib/homeCache";
import DispositionModal, { type DispoInput } from "../components/DispositionModal";
import ShiftHud from "../components/ShiftHud";
import type { Lead, Territory, LatLng, UserProfile } from "../types";

type MapMode = "view" | "draw" | "drop";

const DEFAULT_CENTER: [number, number] = [40.34, -111.91];
const NEAREST_N = 200;
const ROAM_THRESHOLD_M = 450; // reload nearby homes once you've moved ~0.28 mi
const HOME_CAP = 700; // accumulate up to this many roaming pins, then reset

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
  const { profile, role, companyId } = useAuth();
  const { openNav } = useNav();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const leadLayer = useRef<L.LayerGroup>(L.layerGroup());
  const homeLayer = useRef<L.LayerGroup>(L.layerGroup());
  const leadsRef = useRef<Lead[]>([]);
  const homeKeys = useRef<Set<string>>(new Set()); // dedupe accumulated home pins
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
    if (cached) {
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

  // Manual / initial load: assigned territory(ies), or nearest 200 around the rep.
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
        lastLoadCenter.current = null;
        setStatus(`${homeLayer.current.getLayers().length} homes in your area`);
      } else {
        const c = myLoc.current || { lat: map.getCenter().lat, lng: map.getCenter().lng };
        await fetchNearby(c);
        lastLoadCenter.current = L.latLng(c.lat, c.lng);
        setStatus(`${homeLayer.current.getLayers().length} homes nearby · move to load more`);
      }
    } catch (e: any) {
      setStatus("Could not load homes: " + (e?.message || ""));
    } finally {
      setLoadingHomes(false);
    }
  }

  // Auto-load as the rep moves: when the map center drifts past the threshold
  // (and they're not in an assigned area or drawing), pull homes around the new
  // center and accumulate them — no manual refresh needed.
  async function autoRoam() {
    const map = mapRef.current;
    if (!map || !profile || loadingRef.current) return;
    if (assigned.current.length || modeRef.current === "draw") return;
    const ctr = map.getCenter();
    if (lastLoadCenter.current && ctr.distanceTo(lastLoadCenter.current) < ROAM_THRESHOLD_M) return;
    loadingRef.current = true;
    setLoadingHomes(true);
    try {
      if (homeLayer.current.getLayers().length > HOME_CAP) {
        homeLayer.current.clearLayers();
        homeKeys.current.clear();
      }
      await fetchNearby({ lat: ctr.lat, lng: ctr.lng });
      lastLoadCenter.current = ctr;
      setStatus(`${homeLayer.current.getLayers().length} homes loaded · keep moving`);
    } catch {
      /* silent — keep what's already shown */
    } finally {
      loadingRef.current = false;
      setLoadingHomes(false);
    }
  }

  function setYou(lat: number, lng: number) {
    if (youMarker.current) youMarker.current.setLatLng([lat, lng]);
    else if (mapRef.current) {
      youMarker.current = L.circleMarker([lat, lng], {
        radius: 7, color: "#fff", weight: 3, fillColor: "#0EA5E9", fillOpacity: 1,
      }).addTo(mapRef.current).bindTooltip("You");
    }
  }

  // Keep the map locked on the rep's GPS as they walk. Recentering triggers the
  // debounced auto-load so homes appear ahead of them (served from cache when
  // already pulled). A small threshold avoids jitter from GPS noise.
  async function startFollowing() {
    if (watchId.current) return;
    try {
      watchId.current = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 10000 }, (pos) => {
        if (!pos) return;
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        myLoc.current = { lat, lng };
        setYou(lat, lng);
        const map = mapRef.current;
        if (map && map.getCenter().distanceTo(L.latLng(lat, lng)) > 12) map.panTo([lat, lng], { animate: true });
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
      void startFollowing(); // keep the map on the rep as they walk
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
        <button className="map-fab" onClick={loadHomes} disabled={loadingHomes} aria-label="Refresh homes" title="Refresh homes">
          {loadingHomes ? "…" : "⟳"}
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

      {/* Bottom-left: shift HUD / start button */}
      <div className="map-overlay map-bl">
        <ShiftHud />
      </div>

      {/* Chat FAB is rendered globally by Layout (with unread alert). */}

      <DispositionModal target={dispoTarget} onClose={() => setDispoTarget(null)} onSaved={buildPins} />
    </div>
  );
}
