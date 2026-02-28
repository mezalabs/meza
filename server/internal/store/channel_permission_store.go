package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/meza-chat/meza/internal/permissions"
)

// ChannelPermissionStore implements ChannelPermissionChecker using the full
// permissions.ResolveEffective algorithm. It queries the same Postgres tables
// used by the chat service (servers, members, roles, permission_overrides)
// to avoid divergence from the canonical permission resolution.
type ChannelPermissionStore struct {
	pool *pgxpool.Pool
}

func NewChannelPermissionStore(pool *pgxpool.Pool) *ChannelPermissionStore {
	return &ChannelPermissionStore{pool: pool}
}

// HasViewChannel returns true if the user has ViewChannel permission for the
// given channel. It performs the full resolution algorithm including owner
// bypass, administrator short-circuit, role permissions, category/channel
// role overrides, and user-level overrides. Fails closed: any query error
// returns false.
func (s *ChannelPermissionStore) HasViewChannel(ctx context.Context, userID, channelID string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// 1. Get channel metadata + server owner in a single query.
	var serverID string
	var channelGroupID *string
	var ownerID string
	err := s.pool.QueryRow(ctx,
		`SELECT c.server_id, c.channel_group_id, s.owner_id
		 FROM channels c
		 JOIN servers s ON s.id = c.server_id
		 WHERE c.id = $1`,
		channelID,
	).Scan(&serverID, &channelGroupID, &ownerID)
	if err != nil {
		if err == pgx.ErrNoRows {
			// DM channels don't have a row in channels -- check channel_members.
			return s.isDMParticipant(ctx, channelID, userID)
		}
		return false, fmt.Errorf("lookup channel server: %w", err)
	}

	// Owner bypass -- all permissions.
	if ownerID == userID {
		return true, nil
	}

	// 2. Get member record (role IDs via member_roles join + timed_out_until)
	//    and @everyone role permissions in a single query.
	var roleIDs []string
	var timedOutUntil *time.Time
	var everyonePerms int64
	err = s.pool.QueryRow(ctx,
		`SELECT COALESCE(ARRAY_AGG(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}'),
		        m.timed_out_until,
		        COALESCE((SELECT permissions FROM roles WHERE id = $2), 0)
		 FROM members m
		 LEFT JOIN member_roles mr ON mr.user_id = m.user_id AND mr.server_id = m.server_id
		 WHERE m.user_id = $1 AND m.server_id = $2
		 GROUP BY m.user_id, m.server_id, m.timed_out_until`,
		userID, serverID,
	).Scan(&roleIDs, &timedOutUntil, &everyonePerms)
	if err != nil {
		if err == pgx.ErrNoRows {
			return false, nil // Not a server member -- no access.
		}
		return false, fmt.Errorf("lookup member: %w", err)
	}

	// 3. Get permissions for the member's assigned roles.
	var rolePerms []int64
	if len(roleIDs) > 0 {
		rows, err := s.pool.Query(ctx,
			`SELECT permissions FROM roles WHERE id = ANY($1) AND server_id = $2`,
			roleIDs, serverID,
		)
		if err != nil {
			return false, fmt.Errorf("lookup role permissions: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var p int64
			if err := rows.Scan(&p); err != nil {
				return false, fmt.Errorf("scan role permission: %w", err)
			}
			rolePerms = append(rolePerms, p)
		}
		if err := rows.Err(); err != nil {
			return false, fmt.Errorf("iterate role permissions: %w", err)
		}
	}

	// 4. Build ResolveInput.
	var timedOutUnix int64
	if timedOutUntil != nil {
		timedOutUnix = timedOutUntil.Unix()
	}

	input := permissions.ResolveInput{
		EveryonePerms: everyonePerms,
		RolePerms:     rolePerms,
		IsOwner:       false, // Already handled above.
		TimedOutUntil: timedOutUnix,
	}

	// 5. Get all role overrides for the channel and its category
	//    in a single query, matching the chat service's resolvePermissions.
	allRoleIDs := append([]string{serverID}, roleIDs...)
	overrides, err := s.getAllOverrides(ctx, channelID, channelGroupID, allRoleIDs, userID)
	if err != nil {
		return false, fmt.Errorf("lookup overrides: %w", err)
	}
	input.GroupRoleOverrides = overrides.GroupRoleOverrides
	input.ChannelRoleOverrides = overrides.ChannelRoleOverrides
	input.GroupUserOverride = overrides.GroupUserOverride
	input.ChannelUserOverride = overrides.ChannelUserOverride

	// 6. Resolve.
	effective := permissions.ResolveEffective(input, time.Now().Unix())
	return permissions.Has(effective, permissions.ViewChannel), nil
}

type resolvedOverrides struct {
	GroupRoleOverrides   []permissions.Override
	ChannelRoleOverrides []permissions.Override
	GroupUserOverride    *permissions.Override
	ChannelUserOverride  *permissions.Override
}

// getAllOverrides fetches role overrides and user overrides from
// permission_overrides for the channel and its channel_group (category)
// in a single query.
func (s *ChannelPermissionStore) getAllOverrides(ctx context.Context, channelID string, channelGroupID *string, roleIDs []string, userID string) (*resolvedOverrides, error) {
	result := &resolvedOverrides{}

	rows, err := s.pool.Query(ctx,
		`SELECT
		   CASE WHEN po.channel_group_id IS NOT NULL THEN 'group' ELSE 'channel' END AS scope,
		   CASE WHEN po.role_id IS NOT NULL THEN 'role' ELSE 'user' END AS kind,
		   po.allow, po.deny
		 FROM permission_overrides po
		 WHERE (
		     po.channel_id = $1
		     OR po.channel_group_id = $3
		   )
		   AND (
		     po.role_id = ANY($2)
		     OR po.user_id = $4
		   )`,
		channelID, roleIDs, channelGroupID, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("get overrides: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var scope, kind string
		var allow, deny int64
		if err := rows.Scan(&scope, &kind, &allow, &deny); err != nil {
			return nil, fmt.Errorf("scan override: %w", err)
		}

		ovr := permissions.Override{Allow: allow, Deny: deny}
		if kind == "role" {
			if scope == "group" {
				result.GroupRoleOverrides = append(result.GroupRoleOverrides, ovr)
			} else {
				result.ChannelRoleOverrides = append(result.ChannelRoleOverrides, ovr)
			}
		} else {
			if scope == "group" {
				result.GroupUserOverride = &ovr
			} else {
				result.ChannelUserOverride = &ovr
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate overrides: %w", err)
	}

	return result, nil
}

// MemberPublicKey holds a user ID and their optional signing public key.
type MemberPublicKey struct {
	UserID           string
	SigningPublicKey []byte // nil if no key registered
}

// ListMembersWithViewChannel returns paginated members who have ViewChannel
// permission on the given channel, along with their signing public keys.
// cursor is the last user_id from the previous page (empty for first page).
// limit is capped at 1000.
func (s *ChannelPermissionStore) ListMembersWithViewChannel(ctx context.Context, channelID, cursor string, limit int) ([]MemberPublicKey, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	if limit <= 0 || limit > 1000 {
		limit = 1000
	}

	// 1. Get channel metadata + server owner.
	var serverID string
	var channelGroupID *string
	var ownerID string
	err := s.pool.QueryRow(ctx,
		`SELECT c.server_id, c.channel_group_id, s.owner_id
		 FROM channels c
		 JOIN servers s ON s.id = c.server_id
		 WHERE c.id = $1`,
		channelID,
	).Scan(&serverID, &channelGroupID, &ownerID)
	if err != nil {
		if err == pgx.ErrNoRows {
			// DM channel: return channel_members with public keys.
			return s.listDMParticipantKeys(ctx, channelID)
		}
		return nil, fmt.Errorf("lookup channel server: %w", err)
	}

	// 2. Get @everyone permissions.
	var everyonePerms int64
	err = s.pool.QueryRow(ctx,
		`SELECT COALESCE(permissions, 0) FROM roles WHERE id = $1`,
		serverID,
	).Scan(&everyonePerms)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("lookup everyone perms: %w", err)
	}

	// 3. Get ALL roles and their permissions for this server (for lookup).
	rolePermsMap := make(map[string]int64)
	rows, err := s.pool.Query(ctx,
		`SELECT id, permissions FROM roles WHERE server_id = $1 AND id != $1`,
		serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("lookup server roles: %w", err)
	}
	for rows.Next() {
		var id string
		var p int64
		if err := rows.Scan(&id, &p); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan role: %w", err)
		}
		rolePermsMap[id] = p
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate roles: %w", err)
	}

	// 4. Get ALL overrides (role + user) for this channel and its category.
	//    Role overrides are matched per-member by role ID.
	//    User overrides are matched per-member by user ID.
	type roleOverride struct {
		RoleID string
		Scope  string // "group" or "channel"
		Allow  int64
		Deny   int64
	}
	type userOverride struct {
		Scope string // "group" or "channel"
		Allow int64
		Deny  int64
	}
	var allRoleOverrides []roleOverride
	userOverridesMap := make(map[string][]userOverride) // user_id -> overrides
	rows, err = s.pool.Query(ctx,
		`SELECT po.role_id, po.user_id,
		        CASE WHEN po.channel_group_id IS NOT NULL THEN 'group' ELSE 'channel' END AS scope,
		        po.allow, po.deny
		 FROM permission_overrides po
		 WHERE po.channel_id = $1 OR po.channel_group_id = $2`,
		channelID, channelGroupID,
	)
	if err != nil {
		return nil, fmt.Errorf("lookup overrides: %w", err)
	}
	for rows.Next() {
		var roleID, userID *string
		var scope string
		var allow, deny int64
		if err := rows.Scan(&roleID, &userID, &scope, &allow, &deny); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan override: %w", err)
		}
		if roleID != nil {
			allRoleOverrides = append(allRoleOverrides, roleOverride{
				RoleID: *roleID, Scope: scope, Allow: allow, Deny: deny,
			})
		} else if userID != nil {
			userOverridesMap[*userID] = append(userOverridesMap[*userID], userOverride{
				Scope: scope, Allow: allow, Deny: deny,
			})
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate overrides: %w", err)
	}

	// Fast path: public channel with no overrides — all members have ViewChannel.
	// When there are no role/user overrides and @everyone already grants ViewChannel,
	// every member (including timed-out ones, who retain ViewChannel) passes the
	// permission check. Skip the expensive per-member ResolveEffective loop and
	// run a simple paginated query instead. This avoids O(M * O) in-memory
	// filtering that would timeout for large servers (125k+ members).
	if len(allRoleOverrides) == 0 && len(userOverridesMap) == 0 && permissions.Has(everyonePerms, permissions.ViewChannel) {
		rows, err = s.pool.Query(ctx,
			`SELECT m.user_id, u.signing_public_key
			 FROM members m
			 JOIN users u ON u.id = m.user_id
			 WHERE m.server_id = $1 AND ($2 = '' OR m.user_id > $2)
			 ORDER BY m.user_id ASC
			 LIMIT $3`,
			serverID, cursor, limit,
		)
		if err != nil {
			return nil, fmt.Errorf("list members fast path: %w", err)
		}
		defer rows.Close()

		var result []MemberPublicKey
		for rows.Next() {
			var mk MemberPublicKey
			if err := rows.Scan(&mk.UserID, &mk.SigningPublicKey); err != nil {
				return nil, fmt.Errorf("scan member fast path: %w", err)
			}
			result = append(result, mk)
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("iterate members fast path: %w", err)
		}
		return result, nil
	}

	// 5. Get paginated members with their roles and public keys.
	//    We fetch more than `limit` to account for members who won't pass ViewChannel.
	//    Process in batches until we have enough results.
	var result []MemberPublicKey
	currentCursor := cursor
	nowUnix := time.Now().Unix()

	for len(result) < limit {
		// Fetch a batch of members (3x limit to reduce round-trips).
		fetchSize := limit * 3
		if fetchSize > 3000 {
			fetchSize = 3000
		}

		rows, err = s.pool.Query(ctx,
			`SELECT m.user_id, m.timed_out_until, u.signing_public_key,
			        COALESCE(ARRAY_AGG(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')
			 FROM members m
			 JOIN users u ON u.id = m.user_id
			 LEFT JOIN member_roles mr ON mr.user_id = m.user_id AND mr.server_id = m.server_id
			 WHERE m.server_id = $1 AND ($2 = '' OR m.user_id > $2)
			 GROUP BY m.user_id, m.timed_out_until, u.signing_public_key
			 ORDER BY m.user_id ASC
			 LIMIT $3`,
			serverID, currentCursor, fetchSize,
		)
		if err != nil {
			return nil, fmt.Errorf("list members: %w", err)
		}

		rowCount := 0
		for rows.Next() {
			rowCount++
			var userID string
			var timedOutUntil *time.Time
			var pubKey []byte
			var memberRoleIDs []string
			if err := rows.Scan(&userID, &timedOutUntil, &pubKey, &memberRoleIDs); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan member: %w", err)
			}
			currentCursor = userID

			// Owner always has ViewChannel.
			if userID == ownerID {
				result = append(result, MemberPublicKey{UserID: userID, SigningPublicKey: pubKey})
				if len(result) >= limit {
					break
				}
				continue
			}

			// Build role permissions for this member.
			var rolePerms []int64
			for _, rid := range memberRoleIDs {
				if p, ok := rolePermsMap[rid]; ok {
					rolePerms = append(rolePerms, p)
				}
			}

			// Build overrides for this member's roles.
			memberRoleSet := make(map[string]bool, len(memberRoleIDs)+1)
			memberRoleSet[serverID] = true // @everyone
			for _, rid := range memberRoleIDs {
				memberRoleSet[rid] = true
			}

			var groupOverrides, channelOverrides []permissions.Override
			for _, ro := range allRoleOverrides {
				if !memberRoleSet[ro.RoleID] {
					continue
				}
				ovr := permissions.Override{Allow: ro.Allow, Deny: ro.Deny}
				if ro.Scope == "group" {
					groupOverrides = append(groupOverrides, ovr)
				} else {
					channelOverrides = append(channelOverrides, ovr)
				}
			}

			// Look up user-level overrides for this specific member.
			var groupUserOverride, channelUserOverride *permissions.Override
			if uovrs, ok := userOverridesMap[userID]; ok {
				for i := range uovrs {
					ovr := permissions.Override{Allow: uovrs[i].Allow, Deny: uovrs[i].Deny}
					if uovrs[i].Scope == "group" {
						groupUserOverride = &ovr
					} else {
						channelUserOverride = &ovr
					}
				}
			}

			var timedOutUnix int64
			if timedOutUntil != nil {
				timedOutUnix = timedOutUntil.Unix()
			}

			input := permissions.ResolveInput{
				EveryonePerms:        everyonePerms,
				RolePerms:            rolePerms,
				TimedOutUntil:        timedOutUnix,
				GroupRoleOverrides:   groupOverrides,
				ChannelRoleOverrides: channelOverrides,
				GroupUserOverride:    groupUserOverride,
				ChannelUserOverride:  channelUserOverride,
			}

			effective := permissions.ResolveEffective(input, nowUnix)
			if permissions.Has(effective, permissions.ViewChannel) {
				result = append(result, MemberPublicKey{UserID: userID, SigningPublicKey: pubKey})
				if len(result) >= limit {
					break
				}
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("iterate members: %w", err)
		}

		// If we fetched fewer rows than fetchSize, no more members exist.
		if rowCount < fetchSize {
			break
		}
	}

	return result, nil
}

// listDMParticipantKeys returns DM channel members with their public keys.
func (s *ChannelPermissionStore) listDMParticipantKeys(ctx context.Context, channelID string) ([]MemberPublicKey, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT cm.user_id, u.signing_public_key
		 FROM channel_members cm
		 JOIN users u ON u.id = cm.user_id
		 WHERE cm.channel_id = $1
		 ORDER BY cm.user_id ASC`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("list DM participant keys: %w", err)
	}
	defer rows.Close()

	var result []MemberPublicKey
	for rows.Next() {
		var mk MemberPublicKey
		if err := rows.Scan(&mk.UserID, &mk.SigningPublicKey); err != nil {
			return nil, fmt.Errorf("scan DM participant: %w", err)
		}
		result = append(result, mk)
	}
	return result, rows.Err()
}

// isDMParticipant checks if the user is a member of a DM channel.
func (s *ChannelPermissionStore) isDMParticipant(ctx context.Context, channelID, userID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check dm participation: %w", err)
	}
	return exists, nil
}
