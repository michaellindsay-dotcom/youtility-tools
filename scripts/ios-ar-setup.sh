#!/usr/bin/env bash
# ============================================================================
# Inject the in-app AR battery-placement plugin into the freshly generated
# Capacitor iOS project. Run by codemagic.yaml AFTER `npx cap add ios` /
# `npx cap sync ios`, BEFORE `pod install` and the signed build.
#
# Nothing native is committed in the iOS project, so the three native sources
# (kept under youtilityknock-web/ios-src/) are copied in and registered on the
# App target's Compile Sources on every build, via the `xcodeproj` gem that
# ships with CocoaPods.
#
#   ARPlacementPlugin.swift          — Capacitor bridge (CAPPlugin subclass)
#   ARPlacementViewController.swift  — the ARKit placement + capture screen
#   ARPlacementPlugin.m              — CAP_PLUGIN registration macro
#
# The model itself (battery.usdz) already ships in the web bundle, which
# Capacitor copies under <App>.app/public, so no extra asset wiring is needed.
# Camera use is covered by the NSCameraUsageDescription already injected by the
# "Inject iOS permission strings" step.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$SCRIPT_DIR/../youtilityknock-web"
APP_DIR="$WEB/ios/App"
SRC="$WEB/ios-src"
cd "$APP_DIR"

cp "$SRC/ARPlacementPlugin.swift"         App/ARPlacementPlugin.swift
cp "$SRC/ARPlacementViewController.swift"  App/ARPlacementViewController.swift
cp "$SRC/ARPlacementPlugin.m"              App/ARPlacementPlugin.m
echo "ar-setup: copied AR plugin sources into App/"

ruby <<'RUBY'
require 'xcodeproj'
project = Xcodeproj::Project.open('App.xcodeproj')
target = project.targets.find { |t| t.name == 'App' }
raise 'App target not found' unless target
group = project.main_group.find_subpath('App', true)
%w[ARPlacementPlugin.swift ARPlacementViewController.swift ARPlacementPlugin.m].each do |fname|
  next if group.files.any? { |f| f.display_name == fname }
  ref = group.new_reference(fname)
  target.source_build_phase.add_file_reference(ref)
end
project.save
puts 'ar-setup: registered AR plugin sources on the App target'
RUBY
