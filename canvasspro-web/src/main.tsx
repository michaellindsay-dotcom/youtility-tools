import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ShiftProvider } from "./shift/ShiftContext";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename="/app">
      <AuthProvider>
        <ShiftProvider>
          <App />
        </ShiftProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
