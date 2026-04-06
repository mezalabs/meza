BEGIN;

-- Rollback: remove_everyone_from_member_roles
-- Intentionally a no-op. The forward migration deletes rows where role_id =
-- server_id — these are stale entries from before SetMemberRoles filtered the
-- implicit @everyone role out of its input. They were never supposed to exist,
-- so there is nothing meaningful to restore.

COMMIT;
