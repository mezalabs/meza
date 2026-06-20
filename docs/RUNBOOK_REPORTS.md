# Reports Runbook

This runbook covers the in-app content reporting system added in
[plan 2026-04-06](plans/2026-04-06-feat-in-app-content-reporting-plan.md).

## Audience

- Platform admins responsible for triaging the platform-queue (DM and
  cross-server reports).
- Server moderators with the `MANAGE_REPORTS` permission, looking for
  guidance on day-to-day report handling.

## Triage SLA

- **Target:** Median time-from-report-to-acknowledgement under 24 hours.
  Apple's App Review Guideline 1.2 expects "timely" responses; community
  practice puts the bar at 24 hours for content removal.
- **Measurement:** `acknowledged_at` is set the first time a moderator opens
  a report in the Reports panel (or via `meza-admin digest-reports`). Median
  is computed from `acknowledged_at - created_at`.
- **High-severity carve-out:** `category=illegal` reports are also surfaced
  in the platform queue regardless of where they originated. Treat them as
  page-now-not-tomorrow and escalate to legal contact (see below).

## Daily digest

Run `meza-admin digest-reports` from a scheduler (Kubernetes CronJob,
systemd timer, GitHub Actions cron) once per day. The output is plain
text suitable for piping into Slack via `curl`, into email via `mail`,
or into PagerDuty via their REST API. Example:

```bash
meza-admin digest-reports | curl -X POST -H 'Content-type: application/json' \
  --data "$(jq -Rsn --arg text "$(cat)" '{text:$text}')" \
  https://hooks.slack.com/services/...
```

We deliberately do **not** ship a built-in webhook integration. Different
operators have different escalation paths and we don't want to own secret
rotation, retry policy, or transport details.

## Mod responsibilities

When a `MANAGE_REPORTS` holder opens a report in the Reports panel:

1. Read the snapshot. The original message may have been deleted; the
   `snapshot_content` field is the source of truth and was captured at
   report-submit time.
2. Decide an action:
   - **Resolve** — the report is valid and you've taken action on the
     reported user (warning, mute, kick, ban, message delete). The
     resolution row is appended to `report_resolutions` for audit.
   - **Dismiss** — the report does not warrant action.
   - **Reopen** — only for previously resolved/dismissed reports that
     need a second look.
3. Optionally add a private note. The note is only visible to other
   `MANAGE_REPORTS` holders for that server.
4. **Never** message the reporter or the reported party about the report.
   Reporter identity is privileged data.

## Reporter identity privacy

Reporter identity is **never** exposed to the reported user. The
redacted system message we publish to the server's mod-log channel
contains zero personally-identifying information (no reporter ID,
no target ID, no category, no message ID). The full record is only
accessible via the `MANAGE_REPORTS`-gated `ListReports` RPC and the
ReportsSection panel.

## Direct DB access

If the Reports UI is unavailable, query the tables directly:

```sql
-- Open reports in the platform queue, oldest first
SELECT id, category, target_user_id, snapshot_author_username, created_at
FROM reports
WHERE server_id IS NULL AND status = 'open'
ORDER BY created_at;

-- Open reports for a specific server
SELECT id, category, snapshot_author_username, snapshot_content, created_at
FROM reports
WHERE server_id = '<server-id>' AND status = 'open'
ORDER BY created_at;

-- Audit trail for a specific report
SELECT moderator_id, action, note, created_at
FROM report_resolutions
WHERE report_id = '<report-id>'
ORDER BY created_at;
```

To resolve a report from the CLI:

```sql
BEGIN;
UPDATE reports
   SET status = 'resolved', acknowledged_at = COALESCE(acknowledged_at, NOW())
 WHERE id = '<report-id>';
INSERT INTO report_resolutions (id, report_id, moderator_id, action, note)
VALUES (
  generate_random_ulid(),  -- or your preferred ULID generator
  '<report-id>',
  '<your-user-id>',
  'resolved',
  'CLI resolution: <reason>'
);
COMMIT;
```

## Legal contact escalation

Reports with `category=illegal` may include:

- Child sexual abuse material (CSAM)
- Credible threats of violence
- Non-consensual intimate imagery
- Doxxing of minors

These have legal reporting obligations that vary by jurisdiction. Escalate
**immediately** to:

- **CSAM in the US:** report to NCMEC CyberTipline at
  https://report.cybertip.org/ within 60 minutes of confirmation.
- **CSAM in the EU:** report to your INHOPE national hotline.
- **Imminent threats:** local law enforcement.
- **All other illegal content:** consult legal counsel before public
  action.

Document every escalation in the `report_resolutions.note` field.

## Snapshot retention

Snapshot fields (`snapshot_content`, `snapshot_attachments`) are kept
for as long as the row exists. The `snapshot_purged_at` column is
reserved for a future cleanup job (90-day retention post-resolution).
Until that job is implemented, do not delete report rows directly —
the audit trail is more valuable than the storage savings.

## Rate limit overrides

Default rate limits:

- 20 reports/hour per reporter (global)
- 5 reports/hour per (reporter, target user) pair

These are enforced via Redis with a fixed-window counter (`INCR + EXPIRE`).
There is no admin RPC to raise them; if a brigading attack requires a
manual override, the supported workaround is to delete the Redis keys
directly (e.g., `redis-cli DEL 'report:rate:global:<user-id>'`). Document
any such intervention in an incident postmortem.

## Future work

- Per-target receiving-reports rate limit (token bucket, ~50/hour) to
  protect against coordinated brigading.
- 90-day snapshot cleanup job.
- Automated CSAM hash matching (PhotoDNA or equivalent).
- In-app appeals flow for reported users.
- Real-time notification fan-out instead of daily digest.

These are tracked in the original plan's "Future considerations" section.
