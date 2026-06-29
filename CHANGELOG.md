# Changelog

All notable changes to YoutilityKnock. This project uses a simple
`MAJOR.MINOR` marketing version (what the App Store shows); CI assigns the build
number automatically.

## [Unreleased]

- Docs brought up to date with the shipped app (README, user guide, changelog).
- Removed an unused `PTS` re-export in `lib/rewards.ts`.
- Versioning: web package set to `1.0.0`; iOS marketing version now driven by
  the `VERSION_NAME` CI variable (defaults to `1.0`).

## [1.0] — 2026-06 — Initial App Store release

First public release. YoutilityKnock ships as one React codebase running on the
web and as the native iOS/Android field app (Capacitor), backed by Firebase
(Auth, Firestore, Functions, Hosting, Storage). Distributed as an **unlisted**
business app on the App Store.

### Field
- **Map** of your turf (Leaflet): territories, leads colored by disposition,
  recent move-ins, optional solar pins; homes auto-load while roaming and a
  follow-me mode tracks your location.
- **Two-step homeowner card**: step 1 captures disposition + name/phone/email/
  notes (auto-filled from address enrichment); step 2 — only for Appointment,
  Go Back, Pipeline, or Sold — handles on-the-spot scheduling and photos (front
  of home, utility bill). The card renders above the fixed header and only
  scrolls vertically.
- **GPS geofence**: a knock counts toward your shift and stats only when you're
  within ~100 ft of the home.
- **Shifts**: one-tap start/stop from the header with a live timer and door
  counter; auto-stops after 5 minutes idle.
- **Leads** list with filtering and re-disposition.
- **Lookup**: standalone address-enrichment tool.

### Plan, pace & motivate
- **Success Planner**: set a single **monthly close goal**; daily/weekly/monthly
  targets for closes, appointments, conversations, doors, and hours are derived
  from it through your rolling 30-day average and are read-only. The close goal
  is editable only on Sundays. Doors/hours adjust to your real pace from day one.
- **Shift history**: in the app, your own shifts rolled up one row per day for
  the last 30 days; in the web/manager console, the per-shift downstream list.
- **Dashboard** with today's funnel, goal pacing, and top performers.
- **Rewards, Leaderboard, Gamify** (rewards plan): points, levels, badges,
  benchmark + redeemable rewards, ranked leaderboards.
- **Team Chat & Who's Working** (chat plan): company channel, DMs, and a live
  on-shift board with shout-outs.

### Manage
- **Schedule**, **Territories**, **Team** org chart, **Settings** (SMS phone,
  Google/Microsoft calendar links, password).

### Platform
- Multi-tenant: companies isolated by `companyId`, enforced in Firestore rules.
- Role-based downstream visibility (admin / manager / rep) via `visibilityPath`
  and `managerPath`.
- Super-admin "mirror" (impersonation) from `admin.html`, with an audit log.
- Offline-friendly: Firestore persistence so queued work survives a dead zone.
- Native niceties: portrait-locked, branded splash, location/camera/photo
  permission strings, export-compliance declared (standard HTTPS only).
