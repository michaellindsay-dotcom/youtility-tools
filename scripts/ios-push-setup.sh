#!/usr/bin/env bash
# ============================================================================
# Wire up native push notifications (Firebase Cloud Messaging) into the freshly
# generated Capacitor iOS project. Run by codemagic.yaml AFTER `npx cap add ios`
# / `npx cap sync ios`, BEFORE `pod install` and the signed build.
#
# Nothing native is committed, so every piece below is (re)applied on each build:
#   1. GoogleService-Info.plist   — Firebase iOS config (REQUIRED; the app
#                                   crashes at launch without it, so we fail
#                                   loudly rather than ship a broken build).
#   2. App.entitlements           — aps-environment = production (TestFlight and
#                                   the App Store both use the production APNs).
#   3. Info.plist UIBackgroundModes += remote-notification (handle background
#                                   pushes).
#   4. Xcode project edits        — reference the entitlements file and add
#                                   GoogleService-Info.plist to Copy Bundle
#                                   Resources, via the `xcodeproj` gem that
#                                   ships with CocoaPods.
#
# One-time setup you must do (see STORE_DEPLOYMENT.md → "Push notifications"):
#   • Apple Developer portal: enable the Push Notifications capability on the
#     App ID  us.youtility.knock.
#   • Create an APNs Auth Key (.p8) and upload it in Firebase Console →
#     Project Settings → Cloud Messaging.
#   • Register the iOS app in Firebase, download GoogleService-Info.plist, and
#     paste it (base64-encoded) into the Codemagic secure env var
#     GOOGLE_SERVICE_INFO_PLIST_B64.
# ============================================================================
set -euo pipefail

# Resolve the iOS app dir relative to this script's location (repo/scripts/..).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/../youtilityknock-web/ios/App"
cd "$APP_DIR"

# 1) GoogleService-Info.plist — required.
if [ -z "${GOOGLE_SERVICE_INFO_PLIST_B64:-}" ]; then
  echo "ERROR: GOOGLE_SERVICE_INFO_PLIST_B64 is not set." >&2
  echo "Add your iOS GoogleService-Info.plist (base64-encoded) as a secure" >&2
  echo "Codemagic env var before building with push notifications." >&2
  exit 1
fi
printf '%s' "$GOOGLE_SERVICE_INFO_PLIST_B64" | base64 --decode > App/GoogleService-Info.plist
echo "push-setup: wrote App/GoogleService-Info.plist"

# 2) Entitlements — production APNs.
cat > App/App.entitlements <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>production</string>
</dict>
</plist>
PLIST
echo "push-setup: wrote App/App.entitlements"

# 3) Background remote-notification mode.
P=/usr/libexec/PlistBuddy
$P -c "Delete :UIBackgroundModes" App/Info.plist 2>/dev/null || true
$P -c "Add :UIBackgroundModes array" App/Info.plist
$P -c "Add :UIBackgroundModes:0 string remote-notification" App/Info.plist
echo "push-setup: added UIBackgroundModes remote-notification"

# 4) Xcode project: reference entitlements + bundle GoogleService-Info.plist.
ruby <<'RUBY'
require 'xcodeproj'
project = Xcodeproj::Project.open('App.xcodeproj')
target = project.targets.find { |t| t.name == 'App' }
raise 'App target not found' unless target

target.build_configurations.each do |c|
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
end

app_group = project.main_group.find_subpath('App', true)
unless app_group.files.any? { |f| f.display_name == 'GoogleService-Info.plist' }
  ref = app_group.new_reference('GoogleService-Info.plist')
  target.resources_build_phase.add_file_reference(ref)
end

project.save
puts 'push-setup: entitlements + GoogleService-Info.plist wired into App.xcodeproj'
RUBY
