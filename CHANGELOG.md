# Changelog

All notable changes to YoutilityKnock. This project uses a simple
`MAJOR.MINOR` marketing version (what the App Store shows); CI assigns the build
number automatically.

## [Unreleased]

### Added
- **RallyCard** (formerly "Digital Business Card") — every rep can publish a
  public, no-login profile page (photo, bio, service area, reviews,
  click-to-call/text/email, and a lead-capture form that drops straight into
  their Leads) at a shareable link and downloadable QR code. Manage it from
  **RallyCard** in the sidebar. It's on by default for every company and can't
  be bundled away from an existing plan — but it's also a real standalone
  product now: a company can be provisioned on the new **RallyCard** plan
  (admin.html → Plans → "Create default packages"), which drops the canvassing
  map/movers/territories/closer tools entirely and turns the whole app into a
  card + leads + team-chat + competitions surface. Upgrading later to a
  Canvass/Pro/Elite plan adds the map back with nothing else to migrate.

## [1.2] — 2026-06

### App Store "What's New" (user-facing)
- Smoother, more stable screens: pages no longer drift side-to-side, the layout
  is sized correctly the moment you log in, and the chat button stays put.
- The battery proposal now fills the screen, signatures show on the signed
  agreement, and after signing you go straight to the site survey.

### Fixed
- Pinned the app layout: global horizontal-overflow guard so pages can't pan
  side-to-side, a forced reflow on login so the WKWebView sizes correctly from
  the start, and the floating chat button now renders to `<body>` so it stays
  pinned to the viewport.
- Battery proposal flow: the full-screen presentation renders through a portal
  (it was trapped below the header by a blurred ancestor); the signature pad
  uses dark ink on a light pad so it's visible in the emailed/stored PDF (it was
  near-white on transparent → invisible on the white page); and after signing on
  the rep's device the app routes straight to the site-survey / AR capture.
- Deactivated accounts and suspended/inactive companies are now locked out on
  devices with a warm cache, not just on a fresh (incognito) sign-in. The app
  trusts an explicit cached `suspended`/`inactive` company status to block the
  UI immediately (it self-corrects from the live company listener if the
  company is actually active), and the signed-in user's profile is now a live
  listener so disabling an account mid-session takes effect right away instead
  of lingering until the next full app reload.

## [1.1] — 2026-06

### App Store "What's New" (user-facing)
- Refreshed **Success Planner**: set a single **weekly close goal** and get your
  daily/weekly/monthly game plan, built from your real rolling-average pace.
  Doors and hours start adjusting from your first shift.
- Smoother field experience: the **homeowner card** opens cleanly above the
  header and only scrolls vertically, and the **map fills the screen**.
- Your **shift history** now rolls up one row per day for the last 30 days.

### Under the hood
- Docs brought up to date (README, user guide, changelog).
- Web deploy now publishes every root HTML page by default (deny-list); fixed
  `oauth-callback.html` not deploying (calendar OAuth).
- Removed an unused `PTS` re-export in `lib/rewards.ts`.
- Versioning: marketing version driven by the `VERSION_NAME` CI variable
  (set to `1.1` for this release).

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
- **Success Planner**: set a single **weekly close goal**; daily/weekly/monthly
  targets for closes, appointments, conversations, doors, and hours are derived
  from it and read-only (as are the rolling-average "Your numbers"). Doors/hours
  blend from a baseline toward your real pace from day one (full 30-day average
  by day 30). The close goal is editable on Sundays or your first login of a new
  week, then locks for the week.
- **Shift history**: in the app, your own shifts rolled up one row per day for
  the last 30 days; in the web/manager console, a drill-down (rep → last 4 weeks
  → that week's days, with time/doors/appointments/closes).
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
