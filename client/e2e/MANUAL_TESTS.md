# Manual Tests for Persistent E2E Failures

These manual tests help determine whether the 3 remaining E2E failures are caused by
test-side issues or by actual bugs in the app/services.

Run these against a local instance at http://localhost:4080 while logged in as alice.

---

## 1. Mention Autocomplete: User Selection

**E2E test:** `tests/messaging/mentions.spec.ts:20` — "select user from autocomplete"

**What fails:** The autocomplete only shows `@everyone`; no user entries appear.
The `MentionAutocomplete` component uses `member.nickname || member.userId.slice(0, 8)`
as display name. If the member store is empty (members not fetched), no users show.

**Steps:**
1. Navigate to **Test Server > #general**
2. Click the composer (message input)
3. Type `@` (just the @ symbol)
4. **Check:** Does the autocomplete dropdown appear?
5. **Check:** Does it show only `@everyone`, or are there also user entries (bob, charlie)?
6. If only `@everyone` shows, click the "Show members" button in the channel header
7. **Check:** Does the member sidebar load? Are bob/charlie listed?
8. Now clear the composer and type `@` again
9. **Check:** Do user entries now appear in the autocomplete?

**Diagnosis:**
- If the autocomplete never shows users: **Service bug** — the `ListMembers` API isn't
  returning member data, OR members have empty nicknames so they display as ULID prefixes
  (e.g. `01JARQ76`) instead of usernames
- If the member sidebar shows users by username but autocomplete shows ULID prefixes:
  **App bug** — `MentionAutocomplete` should fall back to username, not `userId.slice(0, 8)`
- If users appear in autocomplete after opening the member sidebar:
  **App bug** — members should be fetched when the channel loads, not only when the sidebar opens

---

## 2. Pin Indicator on Messages

**E2E test:** `tests/messaging/pins.spec.ts:8` — "pin and unpin a message via context menu"

**What fails:** After pinning a message, no `[aria-label="Pinned"]` indicator appears on
the message. The test expects a visual pin badge on the message container.

**Steps:**
1. Navigate to **Test Server > #general**
2. Send a new message (e.g., "manual pin test")
3. Right-click the message to open the context menu
4. **Check:** Is there a "Pin Message" option?
5. Click "Pin Message"
6. **Check:** Does any visual indicator appear on the pinned message?
   (Look for a pin icon, a "Pinned" badge, or any aria-label="Pinned" element)
7. Click the "Show pinned messages" button in the channel header bar
8. **Check:** Does the pinned messages panel open and show the pinned message?

**Diagnosis:**
- If "Pin Message" works but no indicator appears on the message: **App bug** — the
  message component doesn't render a pin indicator (needs to be implemented)
- If "Pin Message" isn't in the context menu: **Service bug** — the pin API may not
  be connected, or the context menu doesn't include pin options
- If everything works and there IS a visible pin indicator: **Test bug** — the test's
  `[aria-label="Pinned"]` selector doesn't match the actual DOM structure

---

## 3. Role CRUD: Delete Role (Duplication Bug)

**E2E test:** `tests/roles/role-crud.spec.ts:55` — "delete a role"

**What fails:** After creating a role, the role appears twice in the list (store
duplication). Deleting it removes one copy but the duplicate remains visible.

**Steps:**
1. Navigate to **Test Server > Server Settings > Roles**
2. Click "Create Role"
3. Enter a name like "Manual Test Role" and click "Create"
4. **Check:** Does the role appear once or twice in the role list?
5. If it appears twice, that confirms the duplication bug
6. Click "Delete" on the role, then "Confirm"
7. **Check:** Does the role fully disappear, or does one copy remain?

**Diagnosis:**
- If the role appears twice after creation: **App bug** — the role Zustand store adds
  the role both optimistically (on create click) and from the API response, causing
  duplication. Fix: deduplicate by role ID in the store's `addRole` or `setRoles` action
- If the role appears once and deletes cleanly: **Test timing issue** — the test may be
  racing between optimistic updates and API responses. The `.first()` workarounds in the
  test mitigate this but the root cause is the store duplication
