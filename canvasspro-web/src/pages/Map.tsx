import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addDoc, collection, getDocs, query, where } from "firebase/firestore";
import { Geolocation } from "@capacitor/geolocation";
import { db, auth } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISPOSITIONS, DISP_COLOR } from "../lib/dispositions";
import { lookupArea, parseAreaProperties } from "../lib/knockstat";
import DispositionModal, { type DispoInput } from "../components/DispositionModal";
import type { Lead, Territory, LatLng } from "../types";

const DEFAULT_CENTER: [number, number] = [40.34, -111.91];
const NEAREST_N = 30;

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
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const leadLayer = useRef<L.LayerGroup>(L.layerGroup());
  const homeLayer = useRef<L.LayerGroup>(L.layerGroup());
  const territoryLayer = useRef<L.LayerGroup>(L.layerGroup());
  const assigned = useRef<Territory[]>([]);
  const myLoc = useRef<LatLng | null>(null);
  const drawPts = useRef<LatLng[]>([]);
  const drawLayer = useRef<L.Polygon | null>(null);
  const modeRef = useRef<"view" | "draw">("view");

  const [status, setStatus] = useState("Loading map…");
  const [mode, setMode] = useState<"view" | "draw">("view");
  const [loadingHomes, setLoadingHomes] = useState(false);
  const [dispoTarget, setDispoTarget] = useState<DispoInput | null>(null);
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
    leads.forEach((lead) => {
      if (lead.lat == null || lead.lng == null) return;
      L.marker([lead.lat, lead.lng], {
        icon: homeIcon(DISP_COLOR[lead.status] || "#94A3B8", lead.verified === false),
      })
        .on("click", () =>
          setDispoTarget({
            leadId: lead.id, address: lead.address, lat: lead.lat, lng: lead.lng, status: lead.status,
            name: lead.ownerName || "", phone: lead.phone || "", email: lead.email || "", notes: lead.notes || "",
            enrichment: lead.enrichment,
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
    const mine = profile?.territoryIds || [];
    snap.forEach((d) => {
      const t = { id: d.id, ...(d.data() as Omit<Territory, "id">) };
      if (!t.polygon || t.polygon.length < 3) return;
      L.polygon(t.polygon.map((p) => [p.lat, p.lng] as [number, number]), {
        color: t.color || "#34D399", weight: 2, fillOpacity: 0.08,
      })
        .bindTooltip(t.name)
        .addTo(territoryLayer.current);
      if (!mine.length || mine.includes(t.id)) assigned.current.push(t);
    });
  }

  function addHomeMarker(h: { address: string; lat: number; lng: number }) {
    L.marker([h.lat, h.lng], { icon: homeIcon("#475569") })
      .on("click", () => setDispoTarget({ address: h.address, lat: h.lat, lng: h.lng }))
      .addTo(homeLayer.current);
  }

  // Auto-load homes: inside the assigned territory(ies), or nearest 30 if none.
  async function loadHomes() {
    const map = mapRef.current;
    if (!map || !profile) return;
    setLoadingHomes(true);
    homeLayer.current.clearLayers();
    try {
      const token = await auth.currentUser!.getIdToken();
      if (assigned.current.length) {
        let total = 0;
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
            .forEach((h) => { addHomeMarker(h); total++; });
        }
        setStatus(`${total} homes in your area`);
      } else {
        const c = myLoc.current || { lat: map.getCenter().lat, lng: map.getCenter().lng };
        const raw = await lookupArea(c.lat, c.lng, 0.5, token);
        const nearest = parseAreaProperties(raw)
          .map((h) => ({ ...h, d: L.latLng(c.lat, c.lng).distanceTo(L.latLng(h.lat, h.lng)) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, NEAREST_N);
        nearest.forEach((h) => addHomeMarker(h));
        setStatus(`Nearest ${nearest.length} homes (draw an area to focus)`);
      }
    } catch (e: any) {
      setStatus("Could not load homes: " + (e?.message || ""));
    } finally {
      setLoadingHomes(false);
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!companyId || !profile || !elRef.current || mapRef.current) return;

    // Google satellite tiles are georeferenced to GPS (Esri imagery is offset a
    // few meters in some areas, which made rooftop pins look misplaced).
    const gSub = { subdomains: ["mt0", "mt1", "mt2", "mt3"], maxZoom: 21, attribution: "© Google" };
    const hybrid = L.tileLayer("https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", gSub);
    const satellite = L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", gSub);
    const esri = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Tiles © Esri" }
    );
    const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });

    const map = L.map(elRef.current, { center: DEFAULT_CENTER, zoom: 14, maxZoom: 21, layers: [hybrid] });
    L.control.layers({ "Satellite + labels": hybrid, Satellite: satellite, "Esri imagery": esri, Street: street }).addTo(map);
    territoryLayer.current.addTo(map);
    homeLayer.current.addTo(map);
    leadLayer.current.addTo(map);
    mapRef.current = map;

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
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        myLoc.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setView([myLoc.current.lat, myLoc.current.lng], 18);
        L.circleMarker([myLoc.current.lat, myLoc.current.lng], {
          radius: 7, color: "#fff", weight: 3, fillColor: "#0EA5E9", fillOpacity: 1,
        }).addTo(map).bindTooltip("You");
      } catch {
        /* location denied */
      }
      await buildTerritories();
      await buildPins();
      await loadHomes();
    })();

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, profile, role]);

  async function finishDraw() {
    if (drawPts.current.length < 3) { setStatus("Tap at least 3 points to make an area."); return; }
    const name = window.prompt("Name this territory:");
    if (name && companyId && profile) {
      try {
        await addDoc(collection(db, "territories"), {
          companyId, name: name.trim(), color: "#34D399", polygon: drawPts.current, managerId: profile.uid, createdAt: Date.now(),
        });
        await buildTerritories();
        await loadHomes();
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

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>Map</h1>
          <p className="page-sub">{status}</p>
        </div>
        <div className="filter-bar">
          <button className="chip-btn" onClick={loadHomes} disabled={loadingHomes}>
            {loadingHomes ? "Loading…" : "⟳ Refresh homes"}
          </button>
          {canDraw && (
            <button className={"chip-btn" + (mode === "draw" ? " active" : "")} onClick={() => setMode(mode === "draw" ? "view" : "draw")}>
              ✏ Draw area
            </button>
          )}
        </div>
      </div>

      {mode === "draw" && (
        <div className="card route-bar">
          <span className="muted">Tap the map to drop the corners of your area, then save.</span>
          <div className="row">
            <button className="btn sm" onClick={cancelDraw}>Cancel</button>
            <button className="btn primary sm" onClick={finishDraw}>Save area</button>
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
        <span className="legend-item muted">· tap a house to disposition · red ✕ = logged off-site</span>
      </div>

      <DispositionModal target={dispoTarget} onClose={() => setDispoTarget(null)} onSaved={buildPins} />
    </div>
  );
}
