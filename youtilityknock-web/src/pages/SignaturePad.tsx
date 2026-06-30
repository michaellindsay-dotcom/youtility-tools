import { useEffect, useRef, useState } from "react";

// Minimal canvas signature pad (pointer events → PNG data URL). No deps.
export default function SignaturePad({
  accent = "#8b5cf6",
  onChange,
}: {
  accent?: string;
  onChange?: (dataUrl: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  // Size the canvas to its container with a crisp backing store.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const resize = () => {
      const rect = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        // Dark ink: the exported PNG is transparent, so near-white strokes were
        // invisible once embedded on the white agreement PDF. Dark ink reads on
        // both the (now light) pad and the white PDF.
        ctx.strokeStyle = "#10121a";
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const pos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    drawing.current = true;
    last.current = pos(e);
    canvasRef.current?.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !last.current) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!hasInk) setHasInk(true);
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (hasInk && canvasRef.current) onChange?.(canvasRef.current.toDataURL("image/png"));
  };
  const clear = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    onChange?.(null);
  };

  return (
    <div>
      <div
        style={{
          position: "relative",
          height: 150,
          borderRadius: 12,
          border: `1px solid rgba(255,255,255,0.18)`,
          // Light, paper-like pad so the dark ink is visible while signing (and
          // matches what gets embedded on the white PDF).
          background: "#f6f4fb",
          overflow: "hidden",
          touchAction: "none",
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          style={{ width: "100%", height: "100%", display: "block", cursor: "crosshair" }}
        />
        {!hasInk && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              color: "#8a8199",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              letterSpacing: "0.1em",
            }}
          >
            ✍︎ sign here
          </div>
        )}
        <div style={{ position: "absolute", left: 14, right: 14, bottom: 10, borderBottom: "1px solid rgba(0,0,0,0.22)" }} />
      </div>
      <button
        onClick={clear}
        style={{
          marginTop: 8,
          fontSize: 12,
          fontFamily: "'JetBrains Mono', monospace",
          color: accent,
          background: "transparent",
          border: 0,
          cursor: "pointer",
          padding: 0,
        }}
      >
        Clear signature
      </button>
    </div>
  );
}
