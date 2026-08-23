# Calendar Integration — Google Calendar & Microsoft Graph

`domain-calendar` owns OAuth, token lifecycle, and bidirectional sync for
both providers. The appointment engine remains the source of truth for
booking state (`docs/APPOINTMENT_ENGINE.md`); calendar sync is a
*consumer* of engine domain events (outbound direction) and a *producer* of
`calendar_busy_blocks` (inbound direction) — it never writes `appointments`
rows directly, not even on conflict (it flags, it doesn't decide).

## 1. Why one module, two providers

Google Calendar API and Microsoft Graph Calendar API differ in auth flow
shape, webhook mechanics, and delta-sync primitives, but the integration
*shape* is identical: OAuth2 connect → periodic token refresh → push
subscription → webhook-triggered delta fetch → reconcile. `domain-calendar`
defines a single internal `CalendarProvider` interface:

```ts
interface CalendarProvider {
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  createEvent(conn, appointment): Promise<ExternalEventRef>;
  updateEvent(conn, ref, appointment): Promise<void>;
  deleteEvent(conn, ref): Promise<void>;
  createWatch(conn): Promise<WatchHandle>;
  renewWatch(conn, handle): Promise<WatchHandle>;
  fetchDelta(conn): Promise<{ busyBlocks: BusyBlock[]; nextCursor: string }>;
}
```

with `GoogleCalendarProvider` and `MicrosoftGraphProvider` implementations.
Everything else (workers, reconciliation logic, conflict flagging) is
provider-agnostic.

## 2. OAuth connect flow

1. Doctor (or clinic admin on a doctor's behalf) clicks "Connect Google
   Calendar" / "Connect Microsoft 365" in the dashboard.
2. Dashboard calls `POST /doctors/:id/calendar-connections/:provider/start`
   → API generates a signed `state` (tenant id + doctor id + nonce,
   HMAC-signed, short TTL) and returns the provider's OAuth consent URL.
   Scopes requested are the minimum needed: Google
   `calendar.events` (not full `calendar`); Microsoft Graph
   `Calendars.ReadWrite` on the specific mailbox via delegated permissions
   (not application-wide `Calendars.ReadWrite` app permission — v1 uses
   delegated/per-doctor consent, not a tenant-wide admin-consented app, to
   keep blast radius to one doctor's calendar per connection).
3. Provider redirects to `GET /integrations/:provider/callback?code&state`.
   API verifies the `state` signature and TTL, exchanges `code` for tokens,
   encrypts and stores them in `calendar_connections` (`docs/DATABASE.md`
   §4), and immediately creates the push subscription (§4).
4. Connection status starts `ACTIVE`.

## 3. Token storage and refresh

- Access + refresh tokens are envelope-encrypted (KMS data key per row,
  `docs/SECURITY.md` §Secrets) before being written; decrypted only
  in-memory at call time, never logged.
- `calendar-token-refresh` cron job (`ARCHITECTURE.md` §5) scans
  connections with `token_expires_at` within a lookahead window (e.g. 15
  min for Google's ~1h tokens, longer margin for Graph) and refreshes
  proactively — booking/sync operations should essentially never hit an
  expired-token error in the hot path, but also defensively refresh-on-401
  as a fallback.
- Refresh failure (revoked consent, deleted account) after retry exhaustion
  sets `status = NEEDS_REAUTH` and triggers a dashboard notification +
  email to the clinic admin ("Dr. X's Google Calendar connection needs
  attention") — booking continues to function (the engine's own tables
  remain authoritative for double-booking prevention even with a broken
  calendar connection), but availability computation stops subtracting that
  provider's busy blocks until reconnected, which is surfaced as a banner in
  the dashboard, not silently swallowed.

## 4. Inbound sync — webhooks + delta

**Google**: `events.watch()` push notification channel, max TTL ~1 week —
`renewWatch` scheduled well before expiry (e.g. daily renewal job checks
channels expiring within 48h). A notification carries no payload, just "something
changed"; the worker then calls `events.list` with the stored `syncToken`
for an incremental delta, and falls back to a full sync (dropping the token)
if Google returns `410 GONE` (token invalidated — happens after long gaps
or provider-side resets).

**Microsoft Graph**: `/subscriptions` webhook, max TTL **~3 days** for
calendar resources — this is materially shorter than Google's, so the
renewal job runs more frequently for Graph connections (e.g. every 6h,
renewing any subscription within 24h of expiry) to avoid silent
notification gaps. Delta fetched via the stored `deltaLink`
(`calendarView/delta`); an expired/invalid `deltaLink` (`410 Gone` /
`resyncRequired`) triggers a full resync the same way as Google's
`syncToken` invalidation.

Both paths converge on the same reconciliation step:

1. Upsert `calendar_busy_blocks` for the connection from the delta.
2. For each changed/removed external event that maps to an
   `external_calendar_event_id` we previously wrote (i.e. an event *we*
   created for a `CONFIRMED` appointment), check whether the external state
   still matches:
   - Externally deleted or moved to a time that no longer matches the
     appointment → mark `appointments.calendar_sync_status = CONFLICT` and
     emit `AppointmentCalendarConflict` (notification to clinic staff, not
     silently auto-cancelling the patient's appointment — a calendar-side
     change is a signal for a human to reconcile, not authority to mutate
     booking state, since the doctor's assistant could have moved the
     *calendar* event for an unrelated reason).
   - External event unchanged → no-op.
3. For busy blocks with no corresponding appointment (the doctor blocked
   time directly in Google/Outlook for something else), no appointment-side
   action — they simply reduce future computed availability (§`APPOINTMENT_ENGINE.md`
   §7) until the external event goes away.

## 5. Outbound sync

Triggered by `AppointmentConfirmed`, `AppointmentCancelled`,
`AppointmentRescheduled` domain events, consumed by the
`calendar-sync-outbound` queue (`ARCHITECTURE.md` §5), one job per
`(appointment, connection)` pair (a doctor could in principle have both
Google and Microsoft connected simultaneously — v1 UI discourages this but
the data model doesn't forbid it):

- `AppointmentConfirmed` → `createEvent`, store
  `external_calendar_event_id` + provider-returned ETag/`@odata.etag` for
  optimistic-concurrency on later updates.
- `AppointmentCancelled` → `deleteEvent`.
- `AppointmentRescheduled` → `deleteEvent` on the old external event
  (referenced from the old appointment row) + `createEvent` for the new one
  (simpler and more robust across providers than trying to `updateEvent`
  across what might be a different doctor/calendar in edge cases).

Outbound writes carry the appointment's minimal necessary detail only —
patient name/phone and clinic/service label, **not** any clinical note —
consistent with the data-minimization principle applied to WhatsApp
(`docs/WHATSAPP.md` §6): a doctor's calendar is visible to whoever has
calendar access, which may be broader than clinical staff.

## 6. Conflict & failure handling

- Sync failures (transient network/5xx) retry with backoff
  (`ARCHITECTURE.md` §5 table); exhausted retries land the job in a DLQ and
  set `calendar_sync_status = FAILED`, surfaced on the appointment's
  dashboard row so staff know the calendar might be out of sync even though
  the booking itself is fine.
- `CONFLICT` status (§4.2) requires explicit staff acknowledgment in the
  dashboard (a "resolve conflict" action) — the engine does not auto-resolve
  by design, since either side (patient booking vs. doctor's own calendar
  edit) could be the one that's "wrong," and only a human has that context.

## 7. Multi-provider note

A connection is per-doctor, per-provider (`calendar_connections` unique on
`(doctor_id, provider)`). A doctor can connect Google, Microsoft, both, or
neither; "neither" simply means computed availability has no external
busy-block subtraction and booking still works purely off the engine's own
`appointments` table.
