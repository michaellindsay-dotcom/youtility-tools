import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor wraps the built web app (dist/) into native iOS and Android
// shells. Run `npm run cap:ios` / `npm run cap:android` to open the native
// projects after adding platforms with `npx cap add ios|android`.
//
// App icons + splash screens are generated from the source art in `assets/`
// by `npm run assets:generate` (uses @capacitor/assets). CI regenerates them
// on every build, so they never have to be committed into the native projects.
const config: CapacitorConfig = {
  appId: "us.youtility.knock",
  appName: "YoutilityKnock",
  webDir: "dist",
  server: {
    // Allow https scheme so Firebase Auth popups / redirects behave.
    androidScheme: "https",
  },
  plugins: {
    // Show the branded splash on cold start, then hand off to the WebView as
    // soon as it's ready. launchAutoHide keeps it from ever getting stuck if
    // the app forgets to call SplashScreen.hide().
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: "#0f1727",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: false,
    },
  },
};

export default config;
