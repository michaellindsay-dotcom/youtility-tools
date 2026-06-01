import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addDoc, collection, doc, getDocs, query, updateDoc, where } from "firebase/firestore";
import { Geolocation } from "@capacitor/geolocation";
import { db, auth } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISPOSITIONS, DISP_COLOR, DISP_LABEL } from "../lib/dispositions";
import { lookupAddress, normalizeKnockstatResponse, buildEnrichment } from "../lib/knockstat";
import { bumpStats } from "../lib/stats";
import type { Lead, Territory, LatLng } from "../types";

const DEFAULT_CENTER: [number, number] = [40.34, -111.91]; // Utah County fallback
const PIN_ZOOM = 13; // only show home pins at/above this zoom

type Mode = "view" | "draw" | "route";

function statusIcon(status: string): L.DivIcon {
  const color = DISP_COLOR[status] || "#94A3B8";
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
    m.bindPopup(() => makePopupEl(lead, m), { minWidth: 250, maxWidth: 300 });
    m.on("click", () => {
      if (modeRef.current === "route") {
        toggleSelect(lead.id);
        m.closePopup();
      }
    });
    pinsLayer.current.addLayer(m);
  }

  // Update a home's disposition from its pin.
  async function setDisposition(lead: Lead, value: Lead["status"], m: L.Marker) {
    try {
      await updateDoc(doc(db, "leads", lead.id), { status: value, updatedAt: Date.now() });
      lead.status = value;
      m.setIcon(statusIcon(value));
      if (profile && (value === "appointment" || value === "sold")) {
        void bumpStats(profile, value === "sold" ? { sales: 1 } : { appointments: 1 });
      }
      m.setPopupContent(makePopupEl(lead, m));
    } catch (e: any) {
      setStatus("Could not update: " + (e?.message || ""));
    }
  }

  // Pull homeowner / property data (public records via the Knockstat proxy) and
  // attach it to the lead.
  async function enrich(lead: Lead, m: L.Marker, btn: HTMLButtonElement) {
    btn.disabled = true;
    btn.textContent = "Enriching…";
    try {
      const token = await auth.currentUser!.getIdToken();
      const full = [lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ");
      const raw = await lookupAddress(full, token);
      const rec = normalizeKnockstatResponse(raw);
      const { enrichment, ownerName, phone, email } = buildEnrichment(rec);
      lead.enrichment = enrichment;
      lead.enriched = true;
      lead.enrichedAt = Date.now();
      lead.ownerName = ownerName || lead.ownerName;
      lead.phone = phone || lead.phone;
      lead.email = email || lead.email;
      await updateDoc(doc(db, "leads", lead.id), {
        enrichment,
        enriched: true,
        enrichedAt: lead.enrichedAt,
        ownerName: lead.ownerName ?? null,
        phone: lead.phone ?? null,
        email: lead.email ?? null,
      });
      m.setPopupContent(makePopupEl(lead, m));
    } catch (e: any) {
      btn.disabled = false;
      btn.textContent = "Retry enrich";
      const msg = document.createElement("div");
      msg.className = "muted small";
      msg.style.marginTop = "6px";
      msg.textContent = "Enrichment unavailable: " + (e?.message || "error");
      btn.parentElement?.appendChild(msg);
    }
  }

  // Build the interactive pin popup (homeowner data + disposition buttons).
  function makePopupEl(lead: Lead, m: L.Marker): HTMLElement {
    const el = document.createElement("div");
    el.className = "pin-popup";
    const e = lead.enrichment;
    const ownerLine = lead.ownerName ? `<strong>${lead.ownerName}</strong>` : "<strong>Lead</strong>";
    const contacts =
      (lead.phone ? `📞 ${lead.phone} ` : "") + (lead.email ? `✉ ${lead.email}` : "");
    const propBits = e
      ? [
          e.propertyType,
          e.beds != null ? `${e.beds}bd` : null,
          e.baths != null ? `${e.baths}ba` : null,
          e.sqft != null ? `${Number(e.sqft).toLocaleString()} sqft` : null,
          e.yearBuilt ? `built ${e.yearBuilt}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    const money = (n?: number) =>
      n == null ? "" : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const valueLine = e
      ? [
          e.estValue ? `Est. ${money(e.estValue)}` : null,
          e.equity ? `Equity ${money(e.equity)}` : null,
          e.ownerOccupied || null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

    el.innerHTML =
      `<div class="pin-head">${ownerLine}<span class="pin-disp" style="background:${DISP_COLOR[lead.status] || "#94A3B8"}">${DISP_LABEL[lead.status] || lead.status}</span></div>` +
      `<div class="pin-addr">${lead.address ?? ""}</div>` +
      (contacts ? `<div class="pin-contacts">${contacts}</div>` : "") +
      (propBits ? `<div class="pin-prop">${propBits}</div>` : "") +
      (valueLine ? `<div class="pin-prop">${valueLine}</div>` : "") +
      (lead.notes ? `<div class="pin-notes">${lead.notes}</div>` : "");

    // Disposition buttons
    const grid = document.createElement("div");
    grid.className = "pin-disp-grid";
    DISPOSITIONS.forEach((d) => {
      const b = document.createElement("button");
      b.className = "pin-disp-btn" + (lead.status === d.value ? " active" : "");
      b.textContent = d.label;
      b.style.borderColor = d.color;
      if (lead.status === d.value) b.style.background = d.color;
      b.onclick = () => setDisposition(lead, d.value, m);
      grid.appendChild(b);
    });
    el.appendChild(grid);

    // Enrich
    if (!lead.enriched) {
      const wrap = document.createElement("div");
      const eb = document.createElement("button");
      eb.className = "btn sm";
      eb.style.marginTop = "8px";
      eb.textContent = "＋ Homeowner data";
      eb.onclick = () => enrich(lead, m, eb);
      wrap.appendChild(eb);
      el.appendChild(wrap);
    } else if (e?.owners && e.owners.length > 1) {
      const extra = document.createElement("div");
      extra.className = "muted small";
      extra.style.marginTop = "6px";
      extra.textContent =
        "Also: " + e.owners.slice(1).map((o) => o.name).filter(Boolean).join(", ");
      el.appendChild(extra);
    }
    return el;
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
        {DISPOSITIONS.map((d) => (
          <span key={d.value} className="legend-item">
            <span className="legend-dot" style={{ background: d.color }} /> {d.label}
          </span>
        ))}
        <span className="legend-item muted">· pins appear at zoom {PIN_ZOOM}+</span>
      </div>
    </div>
  );
}
