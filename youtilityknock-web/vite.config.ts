import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build output goes to dist/ which Firebase Hosting serves and Capacitor
// bundles into the native iOS / Android apps.
//
// Web build  → served under /app on Firebase Hosting (base "/app/").
// Native build (VITE_NATIVE=1) → served from the app bundle root (base "/"),
//   so set it when building for Capacitor: `npm run build:native`.
const native = process.env.VITE_NATIVE === "1";

export default defineConfig({
  plugins: [react()],
  base: native ? "/" : "/app/",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: true,
  },
});
