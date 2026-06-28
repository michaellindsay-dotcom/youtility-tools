import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ShiftProvider } from "./shift/ShiftContext";
import SharedProposalView from "./pages/SharedProposalView";
import "./index.css";

// Native (Capacitor) builds run from the bundle root; the web build is served
// under /app on Firebase Hosting.
const basename = import.meta.env.VITE_NATIVE === "1" ? "/" : "/app";

const root = ReactDOM.createRoot(document.getElementById("root")!);

// A homeowner opening the emailed proposal link (…/app/?pid=<id>) gets the
// standalone, no-login interactive viewer — outside the auth gate and router.
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("pid")) {
  root.render(
    <React.StrictMode>
      <SharedProposalView />
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
