import { createContext, useContext } from "react";
import type { Position } from "../types";

export type PreviewPos = Position | "";

// Roles an admin can preview the menu as (admin themselves sees everything).
// The picker lives on the Settings page; the sidebar reads the selection here.
export const PREVIEW_POSITIONS: { value: Position; label: string }[] = [
  { value: "team_manager", label: "Team Manager" },
  { value: "closer_manager", label: "Closer Manager" },
  { value: "setter_manager", label: "Setter Manager" },
  { value: "closer", label: "Closer" },
  { value: "setter", label: "Setter" },
];

// Lets any page (e.g. the full-screen Map) open the slide-in nav drawer, and
// shares the admin "preview menu as" role between Settings (the picker) and the
// Sidebar (which filters its links to match).
export const NavContext = createContext<{
  openNav: () => void;
  previewPos: PreviewPos;
  setPreviewPos: (p: PreviewPos) => void;
}>({ openNav: () => {}, previewPos: "", setPreviewPos: () => {} });
// eslint-disable-next-line react-refresh/only-export-components
export const useNav = () => useContext(NavContext);
