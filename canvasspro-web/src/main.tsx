import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ShiftProvider } from "./shift/ShiftContext";
import SharedProposalView from "./pages/SharedProposalView";
import AgreementSignView from "./pages/AgreementSignView";
import "./index.css";

// Native (Capacitor) builds run from the bundle root; the web build is served
// under /app on Firebase Hosting.
const basename = import.meta.env.VITE_NATIVE === "1" ? "/" : "/app";

const root = ReactDOM.createRoot(document.getElementById("root")!);
const qs = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();

// Standalone, no-login entry points (outside the auth gate + router):
//  • ?pid=<id>        → the homeowner's interactive proposal viewer
//  • ?agreement=<id>  → the customer's battery-agreement sign page
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
