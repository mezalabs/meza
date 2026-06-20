BEGIN;

-- Migration: remove_everyone_from_member_roles
-- The @everyone role (id = server_id) is implicit for all members and should
-- never be stored in member_roles. Clean up any rows that were inserted before
-- the SetMemberRoles handler started filtering it out.
DELETE FROM member_roles WHERE role_id = server_id;

COMMIT;
