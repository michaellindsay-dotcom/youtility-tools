# Canvass Pro — Web + iOS + Android

Door-to-door canvassing dashboard built on **React + Vite + TypeScript**, backed
by **Firebase** (Auth, Firestore, Hosting, Cloud Functions) and packaged for
**iOS / Android** with **Capacitor** — one frontend codebase everywhere.

## What's here

```
canvasspro-web/
├─ src/                  React app (dashboard, lookup, leads, territories, admin)
│  ├─ auth/              Auth context + route guards
│  ├─ components/        Layout, sidebar, topbar, property cards
│  ├─ lib/               Knockstat normalization + formatters (ported from canvass-pro.html)
│  └─ pages/             Login, Dashboard, Lookup, Leads, Territories, Admin, Settings
├─ functions/            Cloud Functions: Knockstat proxy + role management
├─ firebase.json         Hosting + Functions + Firestore + emulators
├─ firestore.rules       Role-based security rules
├─ capacitor.config.ts   Native iOS/Android wrapper config
└─ .env.example          Firebase web config (copy to .env)
```

Roles: **admin** (full control + role management), **manager** (sees all
leads/territories), **rep** (only their own leads). Roles are stored in
`users/{uid}.role` and can only be changed server-side via the `setUserRole`
Cloud Function.

## 1. Prerequisites

- Node 20+
- A Firebase project (the configs assume project id `canvasspro-web` — change
  in `.firebaserc` and `.env`)
- `npm i -g firebase-tools`

## 2. Configure

```bash
cp .env.example .env          # fill in Firebase web SDK config
cp functions/.env.example functions/.env   # add your Knockstat API key
```

In the Firebase console: enable **Email/Password** and **Google** sign-in
providers, and create a **Firestore** database.

## 3. Run locally

```bash
npm install
npm run dev                   # web app at http://localhost:5173

# optional: full local Firebase stack
npm run emulators             # set VITE_USE_EMULATORS=1 in .env first
```

## 4. Make yourself an admin

The first account you create is a `rep`. To bootstrap an admin, set the role
directly in Firestore (console → `users/{your-uid}` → `role: "admin"`). After
that you can manage everyone else from the in-app **Admin** screen.

## 5. Deploy the web app + backend

```bash
firebase login
firebase use canvasspro-web   # or your project id
npm run deploy                # builds, then deploys hosting + functions + rules
```

## 6. Build the mobile apps (Capacitor)

```bash
npm install                   # capacitor deps already in package.json
npx cap add ios               # requires macOS + Xcode
npx cap add android           # requires Android Studio
npm run cap:ios               # build web → sync → open Xcode
npm run cap:android           # build web → sync → open Android Studio
```

The native apps load the same built `dist/` and talk to the same Firebase
backend. For Google sign-in on native you'll also add the iOS/Android OAuth
client IDs in the Firebase console and the reversed-client-id URL scheme.

## Security notes

- The Knockstat API key lives **only** in `functions/.env` (server-side). The
  browser/app calls the `/api/knockstat` proxy with a Firebase ID token — the
  key is never shipped to clients (a real improvement over the original
  single-file `canvass-pro.html`, which held the key in the browser).
- `VITE_FIREBASE_*` values are public client identifiers; access is controlled
  by Auth + `firestore.rules`, not by hiding them.
