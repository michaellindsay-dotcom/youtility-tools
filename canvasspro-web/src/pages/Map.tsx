import { useEffect, useRef, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { Geolocation } from "@capacitor/geolocation";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Lead, Territory, LatLng } from "../types";

const MAPS_KEY =
  import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "AIzaSyAAfrLWkY_WS7yabCgW_WZJu973J5iGcBI";

const STATUS_COLOR: Record<string, string> = {
  new: "#38BDF8",
  contacted: "#A78BFA",
  appointment: "#34D399",
  not_home: "#F59E0B",
  not_interested: "#F87171",
  sold: "#22C55E",
};

const US_CENTER = { lat: 39.5, lng: -98.35 };

type Mode = "view" | "draw" | "route";

export default function MapPage() {
  const { profile, role, companyId } = useAuth();
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const geocoder = useRef<google.maps.Geocoder | null>(null);
  const markers = useRef<Map<string, google.maps.Marker>>(new Map());
  const polys = useRef<google.maps.Polygon[]>([]);
  const drawingMgr = useRef<google.maps.drawing.DrawingManager | null>(null);
  const dirRenderer = useRef<google.maps.DirectionsRenderer | null>(null);
  const myLoc = useRef<LatLng | null>(null);
  const leadsCache = useRef<Lead[]>([]);

  const [status, setStatus] = useState("Loading map…");
  const [mode, setMode] = useState<Mode>("view");
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRef = useRef<string[]>([]);
  selectedRef.current = selected;

  // ── Load leads (downstream-scoped) ─────────────────────────────────────────
  async function fetchLeads(): Promise<Lead[]> {
    if (!companyId || !profile) return [];
    const base = collection(db, "leads");
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId))
        : query(
            base,
            where("companyId", "==", companyId),
            where("visibilityPath", "array-contains", profile.uid)
          );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Lead, "id">) }));
  }

  function statusIcon(lead: Lead): google.maps.Symbol {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: STATUS_COLOR[lead.status] || "#94A3B8",
      fillOpacity: 1,
      strokeColor: "#0A0F1A",
      strokeWeight: 1.5,
    };
  }

  function toggleSelect(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function placeLeadMarkers() {
    const leads = await fetchLeads();
    leadsCache.current = leads;
    for (const lead of leads) {
      let pos: LatLng | null =
        lead.lat != null && lead.lng != null ? { lat: lead.lat, lng: lead.lng } : null;

      // Geocode + persist any lead missing coordinates.
      if (!pos && lead.address && geocoder.current) {
        try {
          const res = await geocoder.current.geocode({ address: [lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ") });
          const loc = res.results[0]?.geometry.location;
          if (loc) {
            pos = { lat: loc.lat(), lng: loc.lng() };
            await updateDoc(doc(db, "leads", lead.id), { lat: pos.lat, lng: pos.lng }).catch(() => {});
          }
        } catch {
          /* geocode failed — skip pin */
        }
      }
      if (!pos || !map.current) continue;

      const marker = new google.maps.Marker({
        position: pos,
        map: map.current,
        title: `${lead.address}${lead.ownerName ? " · " + lead.ownerName : ""} (${lead.status})`,
        icon: statusIcon(lead),
      });
      marker.addListener("click", () => {
        if (mode === "route") toggleSelect(lead.id);
        else {
          const url = `https://www.google.com/maps/dir/?api=1&destination=${pos!.lat},${pos!.lng}&travelmode=driving`;
          window.open(url, "_blank");
        }
      });
      markers.current.set(lead.id, marker);
    }
    setStatus(`${markers.current.size} leads plotted`);
  }

  async function loadTerritories() {
    if (!companyId || !map.current) return;
    const snap = await getDocs(
      query(collection(db, "territories"), where("companyId", "==", companyId))
    );
    snap.forEach((d) => {
      const t = { id: d.id, ...(d.data() as Omit<Territory, "id">) };
      if (!t.polygon || t.polygon.length < 3) return;
      const poly = new google.maps.Polygon({
        paths: t.polygon,
        strokeColor: t.color || "#0EA5E9",
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: t.color || "#0EA5E9",
        fillOpacity: 0.12,
        map: map.current!,
      });
      polys.current.push(poly);
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!MAPS_KEY) {
      setStatus("Google Maps API key not set — add VITE_GOOGLE_MAPS_API_KEY and redeploy.");
      return;
    }
    if (!companyId || !profile) return;
    let cancelled = false;

    (async () => {
      try {
        const loader = new Loader({ apiKey: MAPS_KEY, version: "weekly" });
        const [{ Map: GMap }] = await Promise.all([
          loader.importLibrary("maps"),
          loader.importLibrary("marker"),
          loader.importLibrary("drawing"),
          loader.importLibrary("geometry"),
          loader.importLibrary("routes"),
        ]);
        if (cancelled || !mapEl.current) return;

        // Current location (Capacitor on native, browser on web).
        let center = US_CENTER;
        let zoom = 5;
        try {
          const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
          center = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          myLoc.current = center;
          zoom = 15;
        } catch {
          /* location denied/unavailable — fall back to US view */
        }

        const gmap = new GMap(mapEl.current, {
          center,
          zoom,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
        });
        map.current = gmap;
        geocoder.current = new google.maps.Geocoder();
        dirRenderer.current = new google.maps.DirectionsRenderer({ map: gmap, suppressMarkers: true });

        if (myLoc.current) {
          new google.maps.Marker({
            position: myLoc.current,
            map: gmap,
            title: "You",
            zIndex: 999,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 7,
              fillColor: "#0EA5E9",
              fillOpacity: 1,
              strokeColor: "#fff",
              strokeWeight: 3,
            },
          });
        }

        // Drawing manager for territory areas (managers/admins).
        const canDraw = role === "admin" || role === "manager";
        if (canDraw) {
          const dm = new google.maps.drawing.DrawingManager({
            drawingControl: false,
            polygonOptions: { strokeColor: "#38BDF8", fillColor: "#38BDF8", fillOpacity: 0.15, strokeWeight: 2, editable: false },
          });
          dm.setMap(gmap);
          drawingMgr.current = dm;
          google.maps.event.addListener(dm, "polygoncomplete", async (poly: google.maps.Polygon) => {
            const path = poly.getPath().getArray().map((p) => ({ lat: p.lat(), lng: p.lng() }));
            const name = window.prompt("Name this territory:");
            if (!name) { poly.setMap(null); return; }
            try {
              await addDoc(collection(db, "territories"), {
                companyId,
                name: name.trim(),
                color: "#38BDF8",
                polygon: path,
                managerId: profile.uid,
                createdAt: Date.now(),
              });
              setStatus(`Territory “${name.trim()}” saved`);
            } catch (e: any) {
              setStatus("Could not save territory: " + (e?.message || ""));
              poly.setMap(null);
            }
            dm.setDrawingMode(null);
            setMode("view");
          });
        }

        await loadTerritories();
        await placeLeadMarkers();
        setStatus(`${markers.current.size} leads plotted`);
      } catch (e: any) {
        if (!cancelled) setStatus("Map failed to load: " + (e?.message || e));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, profile, role]);

  // Reflect drawing mode.
  useEffect(() => {
    if (!drawingMgr.current) return;
    drawingMgr.current.setDrawingMode(
      mode === "draw" ? google.maps.drawing.OverlayType.POLYGON : null
    );
  }, [mode]);

  // ── Route optimization ─────────────────────────────────────────────────────
  async function optimizeRoute() {
    if (!map.current || !dirRenderer.current) return;
    const ids = selectedRef.current;
    if (ids.length < 1) { setStatus("Pick at least one stop (tap leads in Route mode)."); return; }
    const stops = ids
      .map((id) => leadsCache.current.find((l) => l.id === id))
      .filter((l): l is Lead => !!l && l.lat != null && l.lng != null);
    const origin = myLoc.current || { lat: stops[0].lat!, lng: stops[0].lng! };
    const svc = new google.maps.DirectionsService();
    try {
      const res = await svc.route({
        origin,
        destination: origin, // round trip back to start
        waypoints: stops.map((l) => ({ location: { lat: l.lat!, lng: l.lng! }, stopover: true })),
        optimizeWaypoints: true,
        travelMode: google.maps.TravelMode.WALKING,
      });
      dirRenderer.current.setDirections(res);
      setStatus(`Route: ${stops.length} stops optimized`);
    } catch (e: any) {
      setStatus("Routing failed: " + (e?.message || e));
    }
  }

  function openRouteInMaps() {
    const ids = selectedRef.current;
    const stops = ids
      .map((id) => leadsCache.current.find((l) => l.id === id))
      .filter((l): l is Lead => !!l && l.lat != null && l.lng != null);
    if (!stops.length) return;
    const origin = myLoc.current ? `${myLoc.current.lat},${myLoc.current.lng}` : "";
    const dest = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lng}`;
    const waypoints = stops.slice(0, -1).map((l) => `${l.lat},${l.lng}`).join("|");
    const url =
      `https://www.google.com/maps/dir/?api=1&travelmode=walking` +
      (origin ? `&origin=${origin}` : "") +
      `&destination=${dest}` +
      (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : "");
    window.open(url, "_blank");
  }

  const canDraw = role === "admin" || role === "manager";

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

      {mode === "route" && (
        <div className="card route-bar">
          <span className="muted">{selected.length} stop(s) selected — tap leads on the map.</span>
          <div className="row">
            <button className="btn sm" onClick={() => setSelected([])}>Clear</button>
            <button className="btn sm" onClick={optimizeRoute}>Optimize</button>
            <button className="btn primary sm" onClick={openRouteInMaps}>Navigate ↗</button>
          </div>
        </div>
      )}

      <div ref={mapEl} className="map-canvas" />

      <div className="map-legend">
        {Object.entries(STATUS_COLOR).map(([s, c]) => (
          <span key={s} className="legend-item">
            <span className="legend-dot" style={{ background: c }} /> {s.replace("_", " ")}
          </span>
        ))}
      </div>
    </div>
  );
}
