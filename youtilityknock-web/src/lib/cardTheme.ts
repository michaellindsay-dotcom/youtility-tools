import type { CSSProperties } from "react";

// RallyCard background presets a rep can pick for their public card.
export const CARD_THEMES: Record<string, { label: string; bg: string }> = {
  default: { label: "Default", bg: "linear-gradient(180deg, var(--bg-0), var(--bg-1) 60%, var(--bg-2))" },
  midnight: { label: "Midnight", bg: "linear-gradient(180deg, #0b1120, #111827 60%, #1e293b)" },
  forest: { label: "Forest", bg: "linear-gradient(180deg, #06231a, #0b3b2c 60%, #114a37)" },
  sunset: { label: "Sunset", bg: "linear-gradient(180deg, #2a0e1f, #4a1942 60%, #6b2a5c)" },
  royal: { label: "Royal", bg: "linear-gradient(180deg, #150b30, #241454 60%, #341d7a)" },
  slate: { label: "Slate", bg: "linear-gradient(180deg, #14181f, #1c222c 60%, #232a36)" },
};

export const CARD_THEME_KEYS = Object.keys(CARD_THEMES);
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function darken(hex: string, amount: number): string {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((num >> 16) & 255) - amount);
  const g = Math.max(0, ((num >> 8) & 255) - amount);
  const b = Math.max(0, (num & 255) - amount);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// Recolors every `.btn.primary` (and accent-bordered element) inside the
// card by overriding the `--accent`/`--accent-2` custom properties the
// site's base styles already read from.
export function cardAccentVars(accentColor?: string): CSSProperties {
  if (!accentColor || !HEX_COLOR_RE.test(accentColor)) return {};
  return { "--accent": accentColor, "--accent-2": darken(accentColor, 40) } as CSSProperties;
}

export function cardThemeBg(theme?: string): string {
  return (theme && CARD_THEMES[theme]?.bg) || CARD_THEMES.default.bg;
}
