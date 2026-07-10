# Push Notifications — setup checklist

The **code** for native push is in place (token registration in the app, and
`notifyUser` sends an FCM push to each of a user's devices for the app's
existing events — new appointment, appointment reassigned/rescheduled, chat
DMs, invoices). What's left is **console setup + credentials only you can do.**

Until these are done, push is inactive but nothing breaks: the Codemagic steps
are guarded and skip themselves when the env vars below aren't set.

> ⚠️ **Order matters.** Do the Firebase/Apple/Google steps and set the Codemagic
> env vars **before** you run the next native build with this change. Building
> the iOS app with the Firebase Messaging SDK but **no** `GoogleService-Info.plist`
> can fail at launch. If a native build goes red, send me the log.

## 1. Firebase Cloud Messaging (both platforms)
1. Firebase Console → your **youtilityknock** project → **Project settings**.
2. **Cloud Messaging** tab → **Apple app configuration** → upload your **APNs
   Authentication Key** (`.p8`) from the Apple Developer portal (Keys → +, enable
   Apple Push Notifications service). This is what lets FCM deliver to iOS.
3. Under **Project settings → General → Your apps**, make sure both apps exist
   with bundle/package id **`us.youtility.knock`**:
   - iOS app → download **`GoogleService-Info.plist`**.
   - Android app → download **`google-services.json`**.

## 2. Apple Developer (iOS)
- Certificates, IDs & Profiles → **Identifiers** → `us.youtility.knock` → enable
  the **Push Notifications** capability. (Signing in Codemagic will pick up the
  updated profile on the next build.)

## 3. Codemagic secure env vars
Add these as **secure** variables (base64-encoded so they paste cleanly):
- `GOOGLE_SERVICE_INFO_PLIST` = `base64 -i GoogleService-Info.plist` (iOS)
- `GOOGLE_SERVICES_JSON` = `base64 -i google-services.json` (Android)

Put them in the same variable group each workflow already uses, or add them to
the `ios-release` / `android-release` `environment.groups`.

## 4. Build
Run the `ios-release` and `android-release` workflows from Codemagic as usual.
The guarded steps will now inject the Firebase config, add the iOS push
entitlement, and apply the Android Google-Services plugin.

## How it works once live
- On first launch after sign-in, the app asks for notification permission and
  registers its FCM token (`registerPushToken`). Tokens live on the user doc
  (`pushTokens`).
- Any `notifyUser(...)` event sends a push to all of that user's devices; dead
  tokens are pruned automatically. Tapping a push opens the app to the linked
  screen.
- Sign-out drops the device token so a shared phone stops getting the previous
  user's pushes.
