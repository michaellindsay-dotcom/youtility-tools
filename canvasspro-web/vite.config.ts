import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build output goes to dist/ which Firebase Hosting serves and Capacitor
// bundles into the native iOS / Android apps.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: true,
  },
});
