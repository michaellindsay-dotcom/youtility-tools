import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ShiftProvider } from "./shift/ShiftContext";
import "./index.css";

// Native (Capacitor) builds run from the bundle root; the web build is served
// under /app on Firebase Hosting.
const basename = import.meta.env.VITE_NATIVE === "1" ? "/" : "/app";

ReactDOM.createRoot(document.getElementById("root")!).render(
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
