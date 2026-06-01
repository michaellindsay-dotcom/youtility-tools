import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addDoc, collection, doc, getDocs, query, updateDoc, where } from "firebase/firestore";
import { Geolocation } from "@capacitor/geolocation";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Lead, Territory, LatLng } from "../types";

const STATUS_COLOR: Record<string, string> = {
  new: "#38BDF8",
  contacted: "#A78BFA",
  appointment: "#34D399",
  not_home: "#F59E0B",
  not_interested: "#F87171",
  sold: "#22C55E",
};

const DEFAULT_CENTER: [number, number] = [40.34, -111.91]; // Utah County fallback
const PIN_ZOOM = 13; // only show home pins at/above this zoom

type Mode = "view" | "draw" | "route";

function statusIcon(status: string): L.DivIcon {
  const color = STATUS_COLOR[status] || "#94A3B8";
  return L.divIcon({
    className: "lead-pin",
    html: `<span style="background:${color}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });
}

function haversine(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Greedy nearest-neighbour ordering from a start point.
function orderRoute(start: LatLng, stops: Lead[]): Lead[] {
  const remaining = [...stops];
  const out: Lead[] = [];
  let cur = start;
  while (remaining.length) {
    let bi = 0;
    let bd = Infinity;
    remaining.forEach((l, i) => {
      const d = haversine(cur, { lat: l.lat!, lng: l.lng! });
      if (d < bd) { bd = d; bi = i; }
    });
    const next = remaining.splice(bi, 1)[0];
    out.push(next);
    cur = { lat: next.lat!, lng: next.lng! };
  }
  return out;
}

const GEOCODE_KEY =
  import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "AIzaSyAAfrLWkY_WS7yabCgW_WZJu973J5iGcBI";

type GeoResult = { loc: LatLng; source: "google" | "nominatim" } | null;

// Prefer Google Geocoding (fast, high quality); fall back to free OSM Nominatim
// if Google is unavailable (CORS, quota, key restriction).
async function geocode(addr: string): Promise<GeoResult> {
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${GEOCODE_KEY}`
    );
    const data = await res.json();
    if (data.status === "OK" && data.results?.[0]) {
      const l = data.results[0].geometry.location;
      return { loc: { lat: l.lat, lng: l.lng }, source: "google" };
    }
  } catch {
    /* fall through to Nominatim */
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(addr)}`,
      { headers: { Accept: "application/json" } }
    );
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (data?.[0]) return { loc: { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }, source: "nominatim" };
  } catch {
    /* ignore */
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function MapPage() {
  const { profile, role, companyId } = useAuth();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pinsLayer = useRef<L.LayerGroup>(L.layerGroup());
  const territoryLayer = useRef<L.LayerGroup>(L.layerGroup());
  const routeLine = useRef<L.Polyline | null>(null);
  const myLoc = useRef<LatLng | null>(null);
  const leadsCache = useRef<Lead[]>([]);
  const modeRef = useRef<Mode>("view");
  const drawPts = useRef<LatLng[]>([]);
  const drawLayer = useRef<L.Polygon | null>(null);

  const [status, setStatus] = useState("Loading map…");
  const [mode, setMode] = useState<Mode>("view");
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRef = useRef<string[]>([]);
  selectedRef.current = selected;
  modeRef.current = mode;

  const canDraw = role === "admin" || role === "manager";

  function refreshPinVisibility() {
    const map = mapRef.current;
    if (!map) return;
    if (map.getZoom() >= PIN_ZOOM) {
      if (!map.hasLayer(pinsLayer.current)) map.addLayer(pinsLayer.current);
    } else if (map.hasLayer(pinsLayer.current)) {
      map.removeLayer(pinsLayer.current);
    }
  }

  function toggleSelect(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

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
    pinsLayer.current.clearLayers();
    const leads = await fetchLeads();
    leadsCache.current = leads;
    let plotted = 0;
    let needGeo = leads.filter((l) => (l.lat == null || l.lng == null) && l.address);

    // Plot the ones that already have coords immediately.
    for (const lead of leads) {
      if (lead.lat == null || lead.lng == null) continue;
      addPin(lead);
      plotted++;
    }
    setStatus(`${plotted} leads plotted${needGeo.length ? ` · geocoding ${needGeo.length}…` : ""}`);
    refreshPinVisibility();

    // Geocode the rest (Google-first, Nominatim fallback) and persist back.
    for (const lead of needGeo) {
      const full = [lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ");
      const r = await geocode(full);
      if (r) {
        lead.lat = r.loc.lat;
        lead.lng = r.loc.lng;
        addPin(lead);
        plotted++;
        setStatus(`${plotted} leads plotted`);
        refreshPinVisibility();
        await updateDoc(doc(db, "leads", lead.id), { lat: r.loc.lat, lng: r.loc.lng }).catch(() => {});
      }
      // Only throttle hard when we hit Nominatim's ~1 req/sec policy.
      await sleep(r?.source === "google" ? 120 : 1100);
    }
    setStatus(`${plotted} leads plotted`);
  }

  function addPin(lead: Lead) {
    if (lead.lat == null || lead.lng == null) return;
    const m = L.marker([lead.lat, lead.lng], { icon: statusIcon(lead.status) });
    m.bindPopup(
      `<strong>${lead.ownerName ?? "Lead"}</strong><br/>` +
        `${lead.address ?? ""}<br/>` +
        `Status: ${(lead.status ?? "new").replace("_", " ")}<br/>` +
        (lead.phone ? `📞 ${lead.phone}<br/>` : "") +
        (lead.notes ? `${lead.notes}` : "")
    );
    m.on("click", () => {
      if (modeRef.current === "route") toggleSelect(lead.id);
    });
    pinsLayer.current.addLayer(m);
  }

  async function buildTerritories() {
    territoryLayer.current.clearLayers();
    if (!companyId) return;
    const snap = await getDocs(query(collection(db, "territories"), where("companyId", "==", companyId)));
    snap.forEach((d) => {
      const t = { id: d.id, ...(d.data() as Omit<Territory, "id">) };
      if (!t.polygon || t.polygon.length < 3) return;
      L.polygon(
        t.polygon.map((p) => [p.lat, p.lng] as [number, number]),
        { color: t.color || "#34D399", weight: 2, fillOpacity: 0.1 }
      )
        .bindTooltip(t.name)
        .addTo(territoryLayer.current);
    });
  }

  // ── Init map ────────────────────────────────────────────────────────────────
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
    const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    });
    const hybrid = L.layerGroup([satellite, labels]);

    const map = L.map(elRef.current, { center: DEFAULT_CENTER, zoom: 14, layers: [hybrid] });
    L.control.layers({ Satellite: satellite, Hybrid: hybrid, Street: street }).addTo(map);
    territoryLayer.current.addTo(map);
    mapRef.current = map;

    map.on("zoomend", refreshPinVisibility);

    // Draw mode: click to add polygon vertices.
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (modeRef.current !== "draw") return;
      drawPts.current.push({ lat: e.latlng.lat, lng: e.latlng.lng });
      if (drawLayer.current) drawLayer.current.remove();
      drawLayer.current = L.polygon(
        drawPts.current.map((p) => [p.lat, p.lng] as [number, number]),
        { color: "#38BDF8", weight: 2, fillOpacity: 0.15 }
      ).addTo(map);
    });

    (async () => {
      // Center on current location if available.
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        myLoc.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setView([myLoc.current.lat, myLoc.current.lng], 16);
        L.circleMarker([myLoc.current.lat, myLoc.current.lng], {
          radius: 7,
          color: "#fff",
          weight: 3,
          fillColor: "#0EA5E9",
          fillOpacity: 1,
        })
          .addTo(map)
          .bindTooltip("You");
      } catch {
        /* location denied — keep default center */
      }
      await buildTerritories();
      await buildPins();
    })();

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, profile, role]);

  // ── Draw area: finish / cancel ───────────────────────────────────────────────
  async function finishDraw() {
    if (drawPts.current.length < 3) { setStatus("Tap at least 3 points to make an area."); return; }
    const name = window.prompt("Name this territory:");
    if (name && companyId && profile) {
      try {
        await addDoc(collection(db, "territories"), {
          companyId,
          name: name.trim(),
          color: "#34D399",
          polygon: drawPts.current,
          managerId: profile.uid,
          createdAt: Date.now(),
        });
        setStatus(`Territory “${name.trim()}” saved`);
        await buildTerritories();
      } catch (e: any) {
        setStatus("Could not save: " + (e?.message || ""));
      }
    }
    cancelDraw();
  }
  function cancelDraw() {
    drawPts.current = [];
    if (drawLayer.current) { drawLayer.current.remove(); drawLayer.current = null; }
    setMode("view");
  }

  // ── Route ─────────────────────────────────────────────────────────────────
  function buildRoute() {
    const map = mapRef.current;
    if (!map) return;
    const stops = selectedRef.current
      .map((id) => leadsCache.current.find((l) => l.id === id))
      .filter((l): l is Lead => !!l && l.lat != null && l.lng != null);
    if (!stops.length) { setStatus("Tap leads on the map to add stops."); return; }
    const start = myLoc.current || { lat: stops[0].lat!, lng: stops[0].lng! };
    const ordered = orderRoute(start, stops);
    const pts: [number, number][] = [
      [start.lat, start.lng],
      ...ordered.map((l) => [l.lat!, l.lng!] as [number, number]),
    ];
    if (routeLine.current) routeLine.current.remove();
    routeLine.current = L.polyline(pts, { color: "#0EA5E9", weight: 4, dashArray: "6 6" }).addTo(map);
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
    setStatus(`Route: ${ordered.length} stops (nearest-first)`);
  }

  function navigateRoute() {
    const stops = selectedRef.current
      .map((id) => leadsCache.current.find((l) => l.id === id))
      .filter((l): l is Lead => !!l && l.lat != null && l.lng != null);
    if (!stops.length) return;
    const start = myLoc.current || { lat: stops[0].lat!, lng: stops[0].lng! };
    const ordered = orderRoute(start, stops);
    const origin = myLoc.current ? `${myLoc.current.lat},${myLoc.current.lng}` : "";
    const dest = `${ordered[ordered.length - 1].lat},${ordered[ordered.length - 1].lng}`;
    const waypoints = ordered.slice(0, -1).map((l) => `${l.lat},${l.lng}`).join("|");
    const url =
      `https://www.google.com/maps/dir/?api=1&travelmode=walking` +
      (origin ? `&origin=${origin}` : "") +
      `&destination=${dest}` +
      (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : "");
    window.open(url, "_blank");
  }

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>Map</h1>
          <p className="page-sub">{status}</p>
        </div>
        <div className="filter-bar">
          <button className={"chip-btn" + (mode === "view" ? " active" : "")} onClick={() => setMode("view")}>
            View
          </button>
          {canDraw && (
            <button className={"chip-btn" + (mode === "draw" ? " active" : "")} onClick={() => setMode("draw")}>
              ✏ Draw area
            </button>
          )}
          <button className={"chip-btn" + (mode === "route" ? " active" : "")} onClick={() => setMode("route")}>
            ⤳ Route
          </button>
        </div>
      </div>

      {mode === "draw" && (
        <div className="card route-bar">
          <span className="muted">Tap the map to drop area corners, then save.</span>
          <div className="row">
            <button className="btn sm" onClick={cancelDraw}>Cancel</button>
            <button className="btn primary sm" onClick={finishDraw}>Save area</button>
          </div>
        </div>
      )}

      {mode === "route" && (
        <div className="card route-bar">
          <span className="muted">{selected.length} stop(s) — tap leads on the map.</span>
          <div className="row">
            <button className="btn sm" onClick={() => { setSelected([]); routeLine.current?.remove(); }}>Clear</button>
            <button className="btn sm" onClick={buildRoute}>Build route</button>
            <button className="btn primary sm" onClick={navigateRoute}>Navigate ↗</button>
          </div>
        </div>
      )}

      <div ref={elRef} className="map-canvas" />

      <div className="map-legend">
        {Object.entries(STATUS_COLOR).map(([s, c]) => (
          <span key={s} className="legend-item">
            <span className="legend-dot" style={{ background: c }} /> {s.replace("_", " ")}
          </span>
        ))}
        <span className="legend-item muted">· pins appear at zoom {PIN_ZOOM}+</span>
      </div>
    </div>
  );
}
