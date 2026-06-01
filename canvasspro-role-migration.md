# CanvassPro — Role Migration Plan (Setter/Closer/Admin → four-tier)

Target backend: **canvasspro-7edd6**. Pairs with `canvasspro-firestore.rules` and
`scripts/bootstrap-superadmin.mjs`. This is the app-side plan to run **in the
CanvassPro source repo** once it's located.

## Core principle: split access from job function

The live app's `Setter / Closer / Admin` conflates two independent ideas:

| Concept | What it controls | New field | Values |
|---|---|---|---|
| **Access tier** | What you can read/write/administer | `role` | `superadmin` > `admin` > `manager` > `user` |
| **Job function** | What you do in the field (comp, leaderboards, reports) | `position` | `setter`, `closer` (extensible) |

Keeping `position` preserves Setter-vs-Closer reporting/leaderboards/comp, which
a pure 4-tier `role` would erase.

## Mapping

| Live role | New `role` (access) | New `position` (job) | Notes |
|---|---|---|---|
| Setter | `user` | `setter` | Base field rep — own leads/shifts/stats |
| Closer | `user` | `closer` | Same access as setter by default (see decision #1) |
| Admin | `admin` | *(unset/null)* | Full app admin |
| — (owner) | `superadmin` | — | michael@rockymountainsolar.net (set by bootstrap) |
| — (new tier) | `manager` | optional | Team/regional lead: sees team data, not full admin |

> After `bootstrap-superadmin.mjs` runs, the only account is michael as
> `superadmin`. Everyone else is **re-created going forward** through the admin
> flow with an explicit `role` + `position` — there's no in-place conversion of
> old user docs because they were wiped.

## Open decisions (confirm before coding)

1. **Do Closers outrank Setters in access?** Default: no — both are `user`,
   distinguished only by `position`. If closers manage setters/see team data,
   map **Closer → `manager`** instead.
2. **Is there a real `manager` tier today?** If team leads exist, define what
   `manager` can see (their team's leads/stats but not config/invites).
3. **Keep `position` at all?** If you truly don't need Setter/Closer reporting,
   drop `position` and map both to `user`. (Not recommended — loses comp data.)

## App code changes (in the CanvassPro repo)

1. **Role vocabulary**
   - Replace the `Setter/Closer/Admin` dropdown(s) with two controls:
     a **Role** select (`superadmin`/`admin`/`manager`/`user`) and a
     **Position** select (`setter`/`closer`). Gate the `superadmin` option to
     superadmins only.
   - Grep the source for the old strings and every read of the role field:
     ```bash
     grep -rniE "setter|closer|'admin'|\"admin\"|\.role" src
     ```
2. **Authorization checks** — centralize into one helper and use a rank, mirroring
   the rules:
   ```ts
   export const RANK = { superadmin: 4, admin: 3, manager: 2, user: 1 } as const;
   export const atLeast = (role: string, min: keyof typeof RANK) =>
     (RANK[role as keyof typeof RANK] ?? 1) >= RANK[min];
   // gate admin UI:  atLeast(myRole, 'admin')   (was: myRole === 'Admin')
   ```
   Replace every `role === 'Admin'` / `=== 'Setter'` check with `atLeast(...)`
   or a `position === 'closer'` check, as appropriate.
3. **publicProfiles** — on user create AND on any profile/role change, write
   `publicProfiles/{uid} = { displayName, photoURL, role }`. Switch all team
   lists, chat names, and leaderboards to read **publicProfiles**, never a
   collection-wide query of `users/` (the new rules forbid it for non-managers).
4. **Security cleanup (instruction #6)** — remove all writes of `googleAccessToken`
   (and any OAuth token) into `users/`. Find them:
   ```bash
   grep -rniE "accessToken|googleAccessToken|oauth|providerData.*token" src
   ```
   Move tokens server-side (Cloud Function + a restricted, owner-only doc or
   Secret Manager) or drop them if unused. Then delete the stale field from
   existing docs.
5. **Superadmin awareness** — read the `superAdmin` custom claim
   (`getIdTokenResult()`), not just the doc, so the top tier works even before a
   profile read; show superadmin-only controls accordingly.

## Data considerations after the user wipe

- `leads`, `shifts`, `userStats`, `goals`, `chat` may hold `userId` values for
  now-deleted users → **orphaned references**. Decide: reassign to the
  superadmin, archive, or purge. (A short admin script can re-point or delete by
  `userId`.)
- Leaderboards/stats that grouped by Setter/Closer should switch to `position`.

## Rollout order (safe sequence)

1. Land the app code changes above on a branch (no deploy yet).
2. Deploy `canvasspro-firestore.rules` → `firebase deploy --only firestore:rules`.
3. Run `bootstrap-superadmin.mjs --yes-delete-all-users` (creates michael as
   superadmin).
4. Deploy the updated app → `firebase deploy --only hosting`.
5. Sign in as michael (temp password `Knock-q2MvpxfTny_2026`), change password,
   then create the rest of the team with explicit `role` + `position`.

## Done-when checklist

- [ ] No `Setter/Closer/Admin` strings remain as **access** checks (only as `position`).
- [ ] All auth gating goes through `atLeast()` / claim, matching the rules' ranks.
- [ ] `publicProfiles` written on create/update; no collection-wide `users/` reads.
- [ ] No `googleAccessToken` / OAuth tokens written to Firestore; stale fields removed.
- [ ] `firebase.json` `firestore.rules` → `canvasspro-firestore.rules`.
- [ ] superadmin (michael) verified; admins cannot self-promote to superadmin.
