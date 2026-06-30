import { createContext, useContext } from "react";

// Lets any page (e.g. the full-screen Map) open the slide-in nav drawer.
export const NavContext = createContext<{ openNav: () => void }>({ openNav: () => {} });
// eslint-disable-next-line react-refresh/only-export-components
export const useNav = () => useContext(NavContext);
