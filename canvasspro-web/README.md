# YoutilityKnock — Web + iOS + Android

Multi-tenant door-to-door canvassing platform built on **React + Vite +
TypeScript**, backed by **Firebase** (Auth, Firestore, Hosting, Cloud
Functions) and packaged for **iOS / Android** with **Capacitor** — one frontend
codebase everywhere.

> Deploy config lives at the **repo root** (`/firebase.json`, `/firestore.rules`,
> `/firestore.indexes.json`). This folder is just the React field app + Cloud
> Functions. See the root README for the deploy overview.

## Surfaces

| Path | What | Who |
|------|------|-----|
| `/` | Landing page (`index.html`) | anyone |
| `/app` | React field app (this folder) | reps, managers, company admins |
| `/admin.html` | Back-office console | super-admins + company admins |
| `/api/knockstat` | Knockstat proxy Cloud Function | authenticated app users |

## Multi-tenancy model

- **Company** = a tenant org. Each has its own users, leads, territories — fully
  isolated by `companyId` in Firestore rules.
- **User accounts** belong to one company with a role: `admin` / `manager` /
  `rep`. Accounts are **provisioned from `/admin.html`**, never self-registered
  in the app.
- **Super-admin** (platform operator) — a Firebase custom claim
  `superAdmin: true`. Manages all companies + users from `/admin.html`.

The in-app experience is field-only (Dashboard, Lookup, Leads, Territories,
Settings). User/company management is intentionally **not** in the app.

### Roles, hierarchy & downstream visibility

- **Per-company roles** (`companies/{id}/roles`) are **titles on a base tier**
  (`manager` | `user`). Every company is seeded with **Manager** and **User**;
  company admins add custom titles and order them by `rank`.
- **Teams + reporting tree:** each user has `managerId` + `managerPath`
  (ancestors). Leads carry a denormalized `visibilityPath = [owner, ...managers]`.
- **Downstream-only visibility:** a manager sees only their reports and below —
  enforced in `firestore.rules` via `array-contains` on `visibilityPath`
  (leads/shifts) and `managerPath` (users/stats), not just in the UI. Company
  admins see the whole company; super-admins see everything.
- Hierarchy is maintained server-side: `assignUserHierarchy` rebuilds
  `managerPath` + lead `visibilityPath` after any reorg.

### Super-admin "mirror" (impersonation)

From `admin.html`, a super-admin can **Mirror** any user — `impersonate`
returns a custom token, opened at `/app/#imp=<token>`. The app runs that session
on a separate in-memory Firebase instance (so the operator's own session isn't
clobbered), shows a mirror banner, and writes an `impersonationLogs` audit
record. This is full act-as.

## Layout

```
canvasspro-web/
├─ src/
│  ├─ auth/        AuthContext (sign-in only) + route guards
│  ├─ components/  Layout, sidebar, topbar, property cards
│  ├─ lib/         Knockstat normalization + formatters (ported from canvass-pro.html)
│  └─ pages/       Login, Dashboard, Lookup, Leads, Territories, Settings
└─ functions/      Cloud Functions: knockstat proxy + company/account management
```

## 1. Configure

```bash
cp .env.example .env                        # Firebase web config (Vite app)
cp functions/.env.example functions/.env    # Knockstat API key (server-side)
```

Also paste the same Firebase web config into `../admin.html` (`FIREBASE_CONFIG`).

In the Firebase console: enable **Email/Password** + **Google** sign-in and
create a **Firestore** database.

## 2. Run locally

```bash
# from repo root — builds the app, assembles public/, starts emulators
cd .. && npm install && npm run emulators
# or just the Vite dev server for the app:
cd canvasspro-web && npm install && npm run dev   # http://localhost:5173/app
```

## 3. Bootstrap the first super-admin (one time)

There's no super-admin yet, so do this once with the Admin SDK / a small script
(or the Firebase CLI). Given a user's `uid`:

```js
// node, using firebase-admin with a service account
await admin.auth().setCustomUserClaims(uid, { superAdmin: true });
```

Then sign in at `/admin.html` → create a company → create its `admin` account.
From there, company admins manage their own users.

## 4. Deploy (from repo root)

```bash
firebase login
firebase use <your-project-id>     # also update /.firebaserc and configs
npm run deploy                     # builds app, assembles public/, deploys
                                   # hosting + functions + firestore rules
```

## 5. Build the mobile apps (Capacitor)

```bash
npm install
npx cap add ios        # requires macOS + Xcode
npx cap add android    # requires Android Studio
npm run cap:ios        # build web → sync → open Xcode
npm run cap:android    # build web → sync → open Android Studio
```

The native apps load the same built app and talk to the same Firebase backend.
For native Google sign-in, add the iOS/Android OAuth client IDs + reversed
client-id URL scheme in the Firebase console.

## Security notes

- The Knockstat API key lives **only** in `functions/.env` (server-side). The
  app calls `/api/knockstat` with a Firebase ID token — the key never reaches
  the browser/app (an improvement over the original `canvass-pro.html`, which
  held the key in the browser).
- All company/user mutations go through Cloud Functions (admin SDK).
  `firestore.rules` forbid client-side writes to `companies/` and `users/` and
  enforce per-company isolation on `leads`, `territories`, and `lookups`.
- `VITE_FIREBASE_*` and the values in `admin.html` are public client
  identifiers; access is controlled by Auth + rules, not by hiding them.
