# Changelog

All notable changes to YoutilityKnock. The public marketing version is the
`MAJOR.MINOR` set by `VERSION_NAME` in `codemagic.yaml`; CI auto-appends the
build index as the patch (e.g. `1.4` → `1.4.56`) so every build is a fresh,
always-increasing App Store release train and never collides with a released
version. Bump `VERSION_NAME` for a new public milestone and add a section here.

## [Unreleased]

### Added
- **Edit a lead's name, address, and phone** — an **✏️ Edit** action on the Leads
  list and the customer screen opens a quick editor for name / address / phone /
  email, so a rep can fix a mistyped detail without re-dispositioning.
- **Owner contacts on the door card** — the disposition card now shows the owner
  phone(s) and email(s) pulled from property data (ATTOM + **BatchData**
  skip-trace) as tap-to-fill chips, so a rep can drop a real number/email onto
  the lead in one tap.
- **See who worked a home first** — tapping a lead pin on the map now shows
  **who last set / dispositioned it and when**, right at the top of the card.

### Fixed
- **Setter/Closer Rankings and Reports sit rate now come from the actual
  appointments, not the stat counters.** The `appointments` counter had drifted
  (double-counted), so the Setter Rankings showed inflated appointment numbers
  (e.g. 10 when only 5 were set) and sit % read "—" because its denominator
  hadn't accrued. Both boards, the Reports "Sit & close rates" card, and the
  Leaderboard's "📅 Appointments" tile are now computed straight from the
  appointment events: an appointment counts once when the setter sets it,
  reschedule follow-ups don't add, cancelled appointments drop out, and sit % =
  sits ÷ (sits + no-shows) shows a real percentage.
- **Leaderboard Rep Rankings now match Reports.** The company Rep Rankings
  windowed appointments/doors/convos by *lead creation date* while Reports
  windowed by *knock date*, so a lead created earlier but re-knocked / set as an
  appointment this week showed up in Reports but not on the leaderboard (e.g. 9
  vs 7 appts). Both now window by knock date over the same lead set.
- Appointment counts no longer **double** on the leaderboard. The on-the-door
  disposition modal counted an appointment on every save, so re-opening an
  already-booked lead (to add a photo, tweak notes, confirm the closer, or fix
  the time) re-counted it. It now counts only the transition *into* appointment
  (and, likewise, *into* sold) — mirroring the server-side guard — and validates
  the appointment time up front so a bail-and-retry can't count twice.

### Added
- **Field Playbook rate figures are now admin-editable.** Under Battery pricing
  in the admin console, a **"Field Playbook — rates & talk track"** editor lets a
  company admin update the rate-reality copy, each utility's export rates, and the
  savings-calculator ¢/kWh numbers. Saved per company and merged over the built-in
  defaults, so reps' playbooks stay current as utility rates change — no code
  deploy. Backed by a new `setBatteryPlaybook` callable and a `batteryPlaybook`
  company field.
- **Shareable Battery Playbook page** — a self-contained, no-login HTML version of
  the Field Playbook (`/battery-playbook.html`) with the full interactive demo,
  utility intel, and calculators, so reps can send it to homeowners or teammates
  to explore on their own.
- **Battery Tool → Field Playbook** — a rep-facing sales aid launched from the
  Battery Tool header. Three tabs: **Pitch** (an interactive grid-down demo —
  flip the grid off / battery on and watch the loads react — plus discovery
  questions, a **rate-reality** card leaning on the recent Dominion increase /
  time-of-use / low buy-back rates with a "utility-as-middleman" analogy, a
  **who's-watching-your-system** angle for owners left behind by installers that
  folded or don't monitor, battery-vs-generator, and objection handling), **Utility**
  (local utility intel with export rates and per-utility talk tracks), and
  **Numbers** (quick storm-runtime and "solar you're giving away" calculators).
  The Pitch page is written for **homeowners who already have solar**. Full-screen
  overlay themed to match the tool (violet glass, Space Grotesk / Inter /
  JetBrains Mono). Ships with the Charleston / South Carolina market; the region
  content is data-driven so more markets can be added later.
- **Cancel / delete an appointment** from the Edit-appointment dialog (setter,
  team manager, or company admin). Cancelling fully unwinds it: it reverses the
  appointment credit in the exact period it was earned (so both the leaderboard
  counters and the weekly/monthly boards drop it), reverts the lead out of
  "appointment" so Reports and Rep Rankings stop counting it, removes the event
  from the owner's Google/Outlook calendar, and deletes it. (A won deal can't be
  cancelled this way — reverse the sale first.) Reschedules, go-backs, and
  follow-ups have never counted as new appointments; only a setter setting one
  does.
- **Setter & Closer leaderboards** — the Leaderboard now splits by lane so a
  setter sees where they rank among other setters (doors / appts / sat / **sit
  %**) and a closer among other closers (assigned / sat / closed / **close %**).
  Reps land on their own lane automatically; managers and admins get a
  Setters/Closers toggle.
- **Sit rate** in Reports: for each rep, "Sit & close rates" shows appointments
  set, sat, pitched appointments, and **sit % (sat ÷ pitched appointments)** on
  the setter side, plus assigned/sat/closed/**close %**/turned-away on the
  closer side.
- New closer disposition **"Turned Away"** (homeowner refused the pitch at the
  door). It's tracked for the closer but deliberately **does not count as a
  pitched appointment** against the setter's sit rate — a turn-away isn't the
  setter's miss.
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
- RallyCard now looks like an actual business card: a logo/photo/name hero
  panel (shared between the live public card and the editor's preview) shows
  the **company logo** — set once by an admin under Settings → RallyCard
  branding (also carries website + phone), used on every rep's card — or a
  rep's own uploaded logo if they override it. Every card also gets a stable,
  randomly-assigned display number ("No. 348219") the first time it's saved,
  so a brand-new account doesn't read as customer/rep #1.
- **Lead outreach automation**, built on a rep's own ported phone number
  (via Telnyx, not a shared company line): calls forward to the rep's real
  personal number; texts show/reply from that same number and live in a new
  **Texts** inbox in the app. Company admins define outreach rules (Settings →
  Lead outreach automation) that fire an SMS or email a set delay after a
  lead's disposition changes (e.g. a "go back" follow-up an hour later).
  TCPA compliance is built in from day one: a homeowner must opt in at the
  door before any automated text goes out (`DispositionModal` now asks), a
  STOP/HELP/START keyword handler suppresses future texts platform-wide, and
  sends are held to 8am–9pm in the company's timezone. Admins assign each
  rep's ported number under Accounts once porting is complete — porting
  itself is a carrier process outside the app.

## [1.4] — 2026-07

### App Store "What's New" (user-facing)
- **Reschedule appointments** right from the calendar — double-tap or use the new
  Reschedule / reassign-closer button, or drag them to a new time. Setters,
  managers, and admins can change the date or the assigned closer, and it syncs to
  Google/Outlook.
- **Throw Downs**: challenge a teammate head-to-head (doors, appointments, sales,
  or points — today or this week), put fun stakes on the line, and let the app
  crown the winner. Battles show up in Team Chat.
- **Pitch Library** for everyone: see the week's Top 3 company pitches to learn
  from the best; managers can review their team's pitches.
- **Gamify** upgrades: standard milestone ladders for all, plus custom company
  milestones, and reward nudges in chat and on your dashboard.
- Smoother app: no more getting stuck zoomed in, faster sign-outs after inactivity,
  and role changes take effect right away.

### Added
- Appointment **edit / drag-reschedule / reassign closer** (setter, manager, or
  admin), syncing the move to the owner's Google/Outlook calendar in place.
- Appointment popout shows the **setter**, and a **tagged DM** to the setter/closer
  that links back to the appointment in Team Chat.
- **⚔️ Throw Downs** — rep-vs-rep challenges with auto-settlement from stats and
  Team-Chat battle updates (throttled: 90 min for daily, start/end of day for
  weekly).
- **Gamify milestones** — standard predesigned ladders + a company-customizable
  ladder builder in the admin console; **reward shout-outs** (team chat +
  individual nudges) and a dashboard **"Rewards in reach"** tracker.
- **Company Rep Rankings** on the leaderboard (Doors/Convos/Appts/Closed/Close%).
- **Pitch Library** for every rep: weekly Top 3 company pitches + manager downline
  drill-in; surfaced by the "Voice recording & training" service.
- **Leads** filtering by rep (downline/self) and date for admins/managers.
- Admin **Company → Region → Team** hierarchy with regional managers; **Accounts**
  profile modal with personal info; admin **change-email** (password + reason);
  **Company Settings** tabs.
- **30-minute inactivity auto-logout**; server-side **auto-close of idle shifts**.

### Fixed
- Removing the **Battery tool** service now hides both **Battery Tool** and
  **Sold Projects** app-wide; the company-services baseline is enforced everywhere.
- Role/permission changes apply **without a re-login** (incl. iOS).
- iOS app no longer **stuck zoomed in** (pinch-zoom locked).
- Pitch tools appear when **"Voice recording & training"** is enabled (no hidden
  plan flag required).

### Under the hood
- Marketing version auto-increments (`VERSION_NAME` major.minor + build index),
  so App Store publishing no longer fails with a closed release train.

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
