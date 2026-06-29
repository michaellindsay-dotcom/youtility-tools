# youtility-tools

Home of **YoutilityKnock** — a multi-tenant, door-to-door canvassing platform —
plus the Firebase hosting, security rules, and CI that ship it to the web and
both app stores. **v1.0 is live on the Apple App Store** (distributed as an
unlisted business app — installed via direct link rather than public search).

## What's here

| Path | What it is |
|------|------------|
| `canvasspro-web/` | The React + Vite + TypeScript **field app** (web + iOS + Android via Capacitor) and its Cloud Functions. **Start here** — see [`canvasspro-web/README.md`](canvasspro-web/README.md). |
| `admin.html` | Back-office console for super-admins + company admins (create companies, provision users, manage plans, mirror users). |
| `index.html`, `privacy.html`, `terms.html` | Marketing landing page and the public Privacy Policy / Terms (linked from the app login and the store listings). |
| `firebase.json`, `firestore.rules`, `firestore.indexes.json`, `storage.rules` | Firebase Hosting + Firestore/Storage security and indexes (per-company isolation is enforced here, not just in the UI). |
| `codemagic.yaml` | CI that builds, signs, and ships the iOS IPA → TestFlight/App Store and the Android AAB → Play, with **no Mac required**. |
| `STORE_LISTING.md` | Ready-to-paste App Store / Play listing copy + reviewer notes. |
| `STORE_DEPLOYMENT.md` | Step-by-step store submission / release runbook. |
| `CHANGELOG.md` | Release history. |
| `docs/USER_GUIDE.md` | How reps and managers use the app. |
| *other `*.html`* | Standalone Youtility/solar web tools that share this Firebase project. |

## App at a glance

YoutilityKnock is a field tool for door-to-door sales teams: map your turf,
capture leads on the doorstep with a two-step disposition card, track shifts and
door knocks automatically (GPS-verified), and pace yourself against a
close-goal-driven Success Planner. Managers see their downstream team; companies
are fully isolated by `companyId`. Accounts are **provisioned by an admin** in
`admin.html` — there is no public sign-up. See
[`canvasspro-web/README.md`](canvasspro-web/README.md) for the full feature tour
and architecture.

## Versioning & releases

- **Marketing version** (what the store shows): currently **1.0**. Bump it for a
  new store release by setting the `VERSION_NAME` env var in Codemagic; it flows
  into both the iOS (`agvtool new-marketing-version`) and Android (`versionName`)
  builds. Update `CHANGELOG.md` and the store "What's New" at the same time.
- **Build number**: Codemagic's incrementing build index (`$BUILD_NUMBER`),
  applied to both platforms automatically.

## Deploy

```bash
firebase use <your-project-id>   # also update .firebaserc
npm run deploy                   # from canvasspro-web/ — builds + deploys hosting, functions, rules
```

Mobile builds run in **Codemagic** (`ios-release` / `android-release`
workflows) — see the header comments in `codemagic.yaml` for the one-time
signing setup, and `STORE_DEPLOYMENT.md` for the release runbook.
