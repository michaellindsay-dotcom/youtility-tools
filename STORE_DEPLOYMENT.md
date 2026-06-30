# Shipping YoutilityKnock to the App Store & Google Play

YoutilityKnock is one React/Vite codebase (`youtilityknock-web/`) wrapped for native
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
| Icon/splash art | [`youtilityknock-web/assets/`](./youtilityknock-web/assets/) |
| Listing copy    | [`STORE_LISTING.md`](./STORE_LISTING.md) |
| Publisher       | Sun Service (info@sunservice.io) |

---

## What's already done in this repo

- ✅ **Android platform** wired into Capacitor (`@capacitor/android`) — previously
  iOS-only.
- ✅ **App icons + splash screens** for both platforms, generated from
  `youtilityknock-web/assets/` via `@capacitor/assets` (`npm run assets:generate`).
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

## Push notifications (one-time setup)

The app code, the backend, and the CI wiring for native push are already in the
repo: every notification the app already produces (chat, DMs, appointment
reminders) is delivered as a lock-screen push to offline users via Firebase
Cloud Messaging. The device registers its token through the `registerPushToken`
Cloud Function; the `sendPush` helper inside `notifyUser` fans out to it.

Push only needs a handful of account/console steps that can't live in the repo.
Until they're done, push is simply silent — nothing else breaks. The
`ios-release` build **fails loudly** if the `GoogleService-Info.plist` secret is
missing, so you can't accidentally ship a build that crashes at launch.

Do these once:

1. **Register the iOS app in Firebase.** Firebase Console → Project Settings →
   *Your apps* → Add app → iOS → bundle ID `us.youtility.knock`. Download the
   **`GoogleService-Info.plist`** it gives you.
2. **Enable the Push capability on the App ID.** developer.apple.com →
   Certificates, Identifiers & Profiles → Identifiers → `us.youtility.knock` →
   check **Push Notifications** → Save. (The next signed build regenerates the
   provisioning profile with the capability included.)
3. **Create an APNs Auth Key.** developer.apple.com → Keys → **+** → enable
   *Apple Push Notifications service (APNs)* → download the `.p8` (note the Key
   ID and your Team ID).
4. **Give the key to Firebase.** Firebase Console → Project Settings → **Cloud
   Messaging** → *Apple app configuration* → upload the `.p8` with its Key ID +
   Team ID.
5. **Put the plist in Codemagic.** Base64-encode the file and add it as a
   **secure** environment variable named `GOOGLE_SERVICE_INFO_PLIST_B64` (in the
   group used by `ios-release`):
   ```bash
   base64 -i GoogleService-Info.plist | pbcopy   # macOS — paste as the value
   ```

That's it — the next `ios-release` build (`scripts/ios-push-setup.sh` runs
automatically) ships with working push. Verify on a TestFlight device by sending
yourself a chat/DM while the app is backgrounded.

> **Android push** isn't wired yet (the app ships iOS-only today). When you're
> ready for Play, the parallel setup is: register the Android app in Firebase,
> drop `google-services.json` into `android/app/`, and add the
> `com.google.gms:google-services` Gradle plugin in the `android-release`
> workflow — mirror of the iOS steps above.

## In-app AR battery placement (iOS)

On the project capture screen, supported iPhones show a **📷 Place in AR**
button: the rep points the camera at the wall, drops the battery model on it
(drag to move, pinch to resize, two-finger rotate), and taps **Capture** — the
framed AR photo drops straight into the placement photos. Devices without ARKit
just see the normal **+ Add photo** flow.

Nothing to configure — it's wired automatically on every `ios-release` build:

- Native sources live in [`youtilityknock-web/ios-src/`](./youtilityknock-web/ios-src/)
  (`ARPlacementPlugin.swift`, `ARPlacementViewController.swift`,
  `ARPlacementPlugin.m`) and are injected by `scripts/ios-ar-setup.sh`.
- The 3D model is the same `youtilityknock-web/public/battery.usdz` the web app
  ships; Capacitor bundles it into the app automatically. To use a more
  detailed model, replace that `.usdz` (keep the filename) and rebuild — no code
  change needed.

> ⚠️ ARKit only runs on a **physical device** (not the simulator), so this can
> only be verified from a TestFlight build on a real iPhone.

## Building / testing locally

```bash
cd youtilityknock-web
npm install

# Web build that Capacitor bundles (points the API at the live backend):
npm run build:native

# iOS (needs a Mac + Xcode):
npx cap add ios && npx cap sync ios && npm run assets:generate && npx cap open ios

# Android (needs Android Studio / SDK):
npx cap add android && npx cap sync android && npm run assets:generate && npx cap open android
```

To rebrand the icon/splash, replace the PNGs in `youtilityknock-web/assets/`
(same names + sizes) and re-run `npm run assets:generate`.
