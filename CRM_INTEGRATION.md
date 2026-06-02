# YoutilityKnock ↔ YoutilityCRM integration

Knock exposes a small API so **youtilitycrm.us** can offer "YoutilityKnock" as a
billable add-on, provision companies, and keep leads + appointments in sync.

**Base URL:** `https://youtilityknock.web.app`
**Auth:** every request sends header `x-crm-secret: <shared secret>`.
Set the secret + your webhook URL in the Knock super-admin console
(*YoutilityCRM integration* card). The same secret signs Knock's outbound
webhooks back to the CRM.

## CRM → Knock

### `POST /crm/provision`  (add-on enabled for a company)
```json
{ "name": "Acme Solar", "crmCompanyId": "crm_123",
  "adminEmail": "owner@acme.com", "adminName": "Pat Owner", "plan": "knock" }
```
→ creates (or reuses) the Knock company, seeds roles/teams, creates the company
admin, and returns a magic sign-in link:
```json
{ "ok": true, "companyId": "...", "adminEmail": "...",
  "inviteLink": "https://youtilityknock.web.app/app/login?...", "appUrl": ".../app" }
```

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
Knock POSTs to your configured webhook URL whenever a lead or appointment
changes (for CRM-linked companies):
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
