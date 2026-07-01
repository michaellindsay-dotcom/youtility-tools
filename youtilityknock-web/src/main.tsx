import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ShiftProvider } from "./shift/ShiftContext";
import SharedProposalView from "./pages/SharedProposalView";
import AgreementSignView from "./pages/AgreementSignView";
import PublicCard from "./pages/PublicCard";
import "./index.css";

// On iOS this WKWebView reports env(safe-area-inset-top) as 0, so the fixed
// header drew over the status bar. Rather than fight env(), tell the native
// status bar NOT to overlay the WebView — the OS then positions the web content
// below the status bar, so the header sits correctly from the very first paint.
if (Capacitor.isNativePlatform()) {
  void import("@capacitor/status-bar").then(({ StatusBar, Style }) => {
    StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {}); // light text on the dark bar
    StatusBar.setBackgroundColor({ color: "#0a0f1a" }).catch(() => {}); // Android; no-op on iOS
  }).catch(() => {});
}

// Native (Capacitor) builds run from the bundle root; the web build is served
// under /app on Firebase Hosting.
const basename = import.meta.env.VITE_NATIVE === "1" ? "/" : "/app";

const root = ReactDOM.createRoot(document.getElementById("root")!);
const qs = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();

// Standalone, no-login entry points (outside the auth gate + router):
//  • ?pid=<id>        → the homeowner's interactive proposal viewer
//  • ?agreement=<id>  → the customer's battery-agreement sign page
//  • ?card=<slug>     → a rep's public digital business card
if (qs.has("agreement")) {
  root.render(
    <React.StrictMode>
      <AgreementSignView />
    </React.StrictMode>
  );
} else if (qs.has("pid")) {
  root.render(
    <React.StrictMode>
      <SharedProposalView />
    </React.StrictMode>
  );
} else if (qs.has("card")) {
  root.render(
    <React.StrictMode>
      <PublicCard />
    </React.StrictMode>
  );
} else {
  root.render(
    <React.StrictMode>
      <BrowserRouter basename={basename}>
        <AuthProvider>
          <ShiftProvider>
            <App />
          </ShiftProvider>
        </AuthProvider>
      </BrowserRouter>
    </React.StrictMode>
  );
}
