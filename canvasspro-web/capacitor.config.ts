import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor wraps the built web app (dist/) into native iOS and Android
// shells. Run `npm run cap:ios` / `npm run cap:android` to open the native
// projects after adding platforms with `npx cap add ios|android`.
const config: CapacitorConfig = {
  appId: "us.youtility.knock",
  appName: "YoutilityKnock",
  webDir: "dist",
  server: {
    // Allow https scheme so Firebase Auth popups / redirects behave.
    androidScheme: "https",
  },
};

export default config;
