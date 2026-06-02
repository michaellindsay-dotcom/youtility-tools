# YoutilityKnock ↔ YoutilityCRM integration

Knock exposes a small API so **youtilitycrm.us** can offer "YoutilityKnock" as a
billable add-on, provision companies, and keep leads + appointments in sync.

**Base URL:** `https://youtilityknock.web.app`

**Auth (per company):** every request sends header `x-crm-secret: <secret>`.
The link is configured **per company** — each tenant in the CRM has its own
company login, so each gets its own 4 settings on the Knock company card
(Manage → *YoutilityCRM link*): **enabled · crmCompanyId · webhookUrl · secret**.
`/crm/export` and `/crm/ingest` authenticate with **that company's** secret.

`/crm/provision` runs *before* a company exists, so it authenticates with a
single platform-level **master key** (super-admin console → *YoutilityCRM —
master provisioning key*). Provision mints (or accepts) a per-company
`apiSecret` and returns it — the CRM stores it and uses it for that company
thereafter. The master key is also accepted as a fallback on export/ingest.
Each company's own secret signs Knock's outbound webhooks back to the CRM.

## CRM → Knock

### `POST /crm/provision`  (add-on enabled for a company)
```json
{ "name": "Acme Solar", "crmCompanyId": "crm_123",
  "adminEmail": "owner@acme.com", "adminName": "Pat Owner", "plan": "knock" }
```
→ creates (or reuses) the Knock company, seeds roles/teams, creates the company
admin, and returns a magic sign-in link:
```json
{ "ok": true, "companyId": "...", "adminEmail": "...", "apiSecret": "yk_…",
  "inviteLink": "https://youtilityknock.web.app/app/login?...", "appUrl": ".../app" }
```
`apiSecret` is this company's freshly minted per-company secret — store it and
send it as `x-crm-secret` on subsequent `/crm/export` + `/crm/ingest` calls for
this company. Pass `webhookUrl` (and optionally your own `apiSecret`) in the
provision body to set them up front; otherwise set them later on the company card.

### `GET /crm/export?companyId=...`  (pull everything)
→ `{ company, users, leads, appointments }` — leads include all customer info
(owner name, phone, email, address, status, enrichment, photos), appointments
are the scheduler events.

### `POST /crm/ingest`  (push a lead/customer into Knock)
```json
{ "companyId": "...", "lead": { "crmLeadId": "L-9", "address": "...",
  "ownerName": "...", "phone": "...", "email": "...", "status": "appointment",
  "lat": 40.3, "lng": -111.9, "notes": "..." } }
```
→ upserts by `crmLeadId`, assigns to a company admin, tags `_syncedFrom:"crm"`.

## Knock → CRM (real-time webhook)
Leads and appointments POST to **separate** endpoints (the CRM add-on exposes a
Lead webhook URL and an Appointment webhook URL — set both on the company card):
- `type:"lead"` → **Lead webhook URL**
- `type:"event"` (appointment) → **Appointment webhook URL** (falls back to the
  lead URL if the appointment URL is left blank)

```json
{ "type": "lead" | "event", "companyId": "...", "crmCompanyId": "...",
  "id": "...", "data": { ...full document... } }
```
Dedupe by `id` + `data.updatedAt`. Changes that originated from the CRM
(`_syncedFrom:"crm"`) are **not** echoed back, so there's no loop.

## Schedulers
Appointments/go-backs/follow-ups live in Knock's `events`. They flow to the CRM
via the `event` webhook + the `appointments` array in `/crm/export`; the CRM can
push appointments in via `/crm/ingest` (extend with an event upsert as needed).

## Status / billing
The add-on charge lives in the CRM. On Knock's side a provisioned company is
tagged `addons:["knock"]` + `crmCompanyId`, and Knock's own Stripe/plan tools can
also drive `status` (active/suspended) — which gates the app's features.
