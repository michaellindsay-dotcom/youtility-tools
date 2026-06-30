// Tiny dependency-free confetti burst. Spawns colored shards that fall and
// fade, then clean themselves up. Safe to call repeatedly.
const COLORS = ["#0EA5E9", "#38BDF8", "#34D399", "#FBBF24", "#F87171", "#A78BFA", "#fff"];

export function confettiBurst(count = 90): void {
  if (typeof document === "undefined") return;
  // Respect reduced-motion preferences.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  document.body.appendChild(layer);

  for (let i = 0; i < count; i++) {
    const s = document.createElement("i");
    const left = Math.random() * 100;
    const size = 6 + Math.random() * 8;
    const dur = 1.6 + Math.random() * 1.4;
    const delay = Math.random() * 0.4;
    const drift = (Math.random() - 0.5) * 240;
    s.style.cssText =
      `left:${left}vw;width:${size}px;height:${size * 0.6}px;` +
      `background:${COLORS[i % COLORS.length]};` +
      `animation-duration:${dur}s;animation-delay:${delay}s;` +
      `--drift:${drift}px;transform:rotate(${Math.random() * 360}deg)`;
    layer.appendChild(s);
  }
  setTimeout(() => layer.remove(), 3600);
}
