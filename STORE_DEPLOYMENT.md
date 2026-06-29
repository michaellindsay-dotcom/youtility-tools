# Shipping YoutilityKnock to the App Store & Google Play

YoutilityKnock is one React/Vite codebase (`canvasspro-web/`) wrapped for native
with **Capacitor** and built **without a Mac** on **Codemagic**. This guide is
the end-to-end runbook to get it live on **both** stores.

Everything native — the iOS/Android projects, the app icons, and the splash
screens — is generated fresh on every CI build. Nothing native is committed.
You supply signing credentials once per store in the Codemagic UI.

| Item            | Value                              |
|-----------------|------------------------------------|
| App name        | YoutilityKnock                     |
| Bundle / Package | `us.youtility.knock`              |
| Privacy Policy  | `https://youtilityknock.web.app/privacy` |
| Terms of Service | `https://youtilityknock.web.app/terms`  |
| CI config       | [`codemagic.yaml`](./codemagic.yaml) |
| Icon/splash art | [`canvasspro-web/assets/`](./canvasspro-web/assets/) |
| Listing copy    | [`STORE_LISTING.md`](./STORE_LISTING.md) |
| Publisher       | Sun Service (info@sunservice.io) |

---

## What's already done in this repo

- ✅ **Android platform** wired into Capacitor (`@capacitor/android`) — previously
  iOS-only.
- ✅ **App icons + splash screens** for both platforms, generated from
  `canvasspro-web/assets/` via `@capacitor/assets` (`npm run assets:generate`).
- ✅ **Codemagic `android-release` workflow** — builds a signed `.aab`, targets
  Android 15 (API 35, required by Play), injects location permissions, and ships
  to the Play **Internal** track.
- ✅ **Codemagic `ios-release` workflow** — now also generates the icon/splash so
  App Store validation passes.
- ✅ **Location permissions** declared for Android (the geolocation plugin ships
  an empty manifest) and iOS (Info.plist usage strings).
- ✅ **Privacy Policy & Terms** pages published at `/privacy` and `/terms`.

## What only you can do (accounts + credentials)

Store submission requires paid developer accounts and signing secrets that must
live in your Codemagic account, not in the repo. Do these once.

### Apple (App Store)
1. Enroll in the **Apple Developer Program** — $99/yr — at developer.apple.com.
2. **App Store Connect → Users and Access → Integrations → App Store Connect API**
   → generate a key (Admin or App Manager). Download the `.p8`.
3. **Codemagic → Teams → Integrations → App Store Connect** → add the key and
   name it **exactly** `YoutilityKnock ASC`.
4. **App Store Connect → My Apps → + → New App**: iOS, name *YoutilityKnock*,
   bundle ID `us.youtility.knock`.
5. Run the **`ios-release`** workflow in Codemagic → it uploads to TestFlight.
   Promote to the public App Store from App Store Connect.

### Google (Play)
1. Pay the one-time **$25** Play Developer fee at play.google.com/console.
2. Create the app: name *YoutilityKnock*, package `us.youtility.knock`.
3. Generate an **upload keystore** once:
   ```bash
   keytool -genkey -v -keystore youtilityknock.keystore \
     -alias youtilityknock -keyalg RSA -keysize 2048 -validity 10000
   ```
   Upload it under **Codemagic → Teams → Code signing identities → Android
   keystores** with reference name **exactly** `youtilityknock_keystore`.
   *(Keep this keystore safe — losing it means you can't update the app.)*
4. Create a **Play service account** with the *Release manager* role, download
   its JSON key. In **Codemagic → Environment variables** add a group named
   **`google_play`** with one secure variable:
   `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` = the whole JSON.
5. **First release only:** upload one signed `.aab` to Play **manually** (the
   API can't create the very first build). Build it by running the
   `android-release` workflow and downloading the artifact, then upload it in the
   Play Console once. After that, the workflow ships to the Internal track
   automatically on each run.

---

## Store listing checklist (per store)

You'll fill these in the App Store Connect / Play Console UIs:

- [ ] App icon (the stores pull the 512/1024 icon from the build, but Play also
      wants a 512×512 PNG in the listing — export from `assets/icon-only.png`).
- [ ] Feature graphic (Play, 1024×500) and screenshots (phone + tablet).
- [ ] Short + full description, category (**Business**), contact email.
- [ ] **Privacy Policy URL** → `https://youtilityknock.web.app/privacy`.
- [ ] **Data safety (Play) / App Privacy (Apple)** — declare what the app
      collects. For YoutilityKnock that is: **Location** (precise, app-in-use,
      for app functionality), **Photos** (user-initiated), **Personal info**
      (name/email for account), and **App activity** (the leads/notes users
      create). None is used for advertising; nothing is sold.
- [ ] Content rating questionnaire.
- [ ] **Location permission justification** — both stores ask why you need
      precise location. Answer: *"Field reps use the map to find nearby homes and
      to confirm a knock happened on-site. Location is only used while the app is
      open; there is no background tracking."*

> ⚠️ Account model: YoutilityKnock accounts are **provisioned by an
> administrator** — there's no public sign-up. App Store and Play reviewers need
> working credentials to get past the login screen. Provide a **demo account**
> (email + password) in the review notes, or reviewers will reject the build for
> "incomplete access."

---

## Shipping an update (after 1.0 is live)

Each store update needs a **higher version number** and a **new build**, and is
re-reviewed by Apple/Google (yes, even an unlisted app).

1. **Set the version.** The marketing version is the `VERSION_NAME` variable in
   `codemagic.yaml` (both the `ios-release` and `android-release` workflows).
   Bump it for each release — e.g. `1.0` → `1.1` for features, `1.0.1` for a
   patch. The CI build applies it via `agvtool new-marketing-version` (iOS) and
   `versionName` (Android); the build number auto-increments from `$BUILD_NUMBER`.
2. **Run the Codemagic workflow** (`ios-release` and/or `android-release`) off
   `main`. It builds, signs, and uploads to **TestFlight** / the Play **Internal**
   track automatically.
3. **iOS — create the new App Store version:** App Store Connect → your app →
   **(+) next to "iOS App" → Add Version** → enter the new number → fill
   **"What's New in This Version"** (see `STORE_LISTING.md`) → attach the new
   build. Screenshots/metadata carry over; update them only if the UI changed.
4. **Submit for Review** → the demo login is already saved under App Review
   Information → **Add for Review → Submit** (auto-release).
5. **Android:** the workflow ships to the Internal track; promote to Production
   in the Play Console and roll out.

> Quick loop for future releases: merge to `main` → bump `VERSION_NAME` →
> run the workflow → add the version + "What's New" in App Store Connect →
> submit.

## Building / testing locally

```bash
cd canvasspro-web
npm install

# Web build that Capacitor bundles (points the API at the live backend):
npm run build:native

# iOS (needs a Mac + Xcode):
npx cap add ios && npx cap sync ios && npm run assets:generate && npx cap open ios

# Android (needs Android Studio / SDK):
npx cap add android && npx cap sync android && npm run assets:generate && npx cap open android
```

To rebrand the icon/splash, replace the PNGs in `canvasspro-web/assets/`
(same names + sizes) and re-run `npm run assets:generate`.
