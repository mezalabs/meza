package permissions

// Permission bitfield constants.
const (
	KickMembers    int64 = 1 << 0
	BanMembers     int64 = 1 << 1
	ManageRoles    int64 = 1 << 2
	Administrator  int64 = 1 << 3
	ManageEmojis   int64 = 1 << 4
	ManageChannels int64 = 1 << 5
	ManageMessages   int64 = 1 << 6
	TimeoutMembers   int64 = 1 << 7
	ViewAuditLog     int64 = 1 << 8
	ExemptSlowMode   int64 = 1 << 9
	StreamVideo      int64 = 1 << 10
	ManageSoundboard int64 = 1 << 11
	AddReactions     int64 = 1 << 12
	ViewChannel      int64 = 1 << 13
	SendMessages     int64 = 1 << 14
	Connect          int64 = 1 << 15 // voice channel connect
	MentionEveryone  int64 = 1 << 16

	// New permissions (bits 17–28).
	ManageServer       int64 = 1 << 17 // server settings without full admin
	CreateInvite       int64 = 1 << 18
	EmbedLinks         int64 = 1 << 19 // controls link preview generation
	AttachFiles        int64 = 1 << 20
	ReadMessageHistory int64 = 1 << 21
	UseExternalEmojis  int64 = 1 << 22
	Speak              int64 = 1 << 23 // voice: separate from Connect
	MuteMembers        int64 = 1 << 24 // voice moderation
	DeafenMembers      int64 = 1 << 25 // voice moderation
	MoveMembers        int64 = 1 << 26 // voice: move users between channels
	ChangeNickname     int64 = 1 << 27 // self nickname
	ManageNicknames    int64 = 1 << 28 // others' nicknames
	ManageWebhooks     int64 = 1 << 29 // create/edit/delete webhooks

	// AllPermissions is the union of all defined permissions.
	AllPermissions = KickMembers | BanMembers | ManageRoles | Administrator |
		ManageEmojis | ManageChannels | ManageMessages | TimeoutMembers |
		ViewAuditLog | ExemptSlowMode | StreamVideo | ManageSoundboard |
		AddReactions | ViewChannel | SendMessages | Connect | MentionEveryone |
		ManageServer | CreateInvite | EmbedLinks | AttachFiles |
		ReadMessageHistory | UseExternalEmojis | Speak | MuteMembers |
		DeafenMembers | MoveMembers | ChangeNickname | ManageNicknames |
		ManageWebhooks

	// ChannelScopedPermissions contains the bits valid in permission overrides.
	// Server-wide permissions (NOT overridable per-channel):
	//   Administrator, ManageServer, ManageRoles, ManageChannels,
	//   KickMembers, BanMembers, TimeoutMembers, ManageNicknames,
	//   ViewAuditLog, ChangeNickname
	ChannelScopedPermissions = ManageMessages | ExemptSlowMode | StreamVideo |
		ManageSoundboard | AddReactions | ViewChannel | SendMessages |
		Connect | MentionEveryone | ManageEmojis | EmbedLinks | AttachFiles |
		ReadMessageHistory | UseExternalEmojis | Speak | MuteMembers |
		DeafenMembers | MoveMembers | ManageWebhooks

	// DefaultEveryonePermissions is the default permission set for the @everyone role.
	DefaultEveryonePermissions = ViewChannel | SendMessages | Connect | Speak |
		AddReactions | ReadMessageHistory | EmbedLinks | AttachFiles |
		UseExternalEmojis | CreateInvite | ChangeNickname
)

// Intentionally excluded Discord permissions (no corresponding Meza feature):
// - SendTTSMessages: no TTS feature
// - UseApplicationCommands: no bot/application framework
// - ManageEvents: no scheduled events
// - ManageThreads/CreatePublicThreads/CreatePrivateThreads/SendMessagesInThreads: no threads
// - UseVAD: not a meaningful restriction
// - PrioritySpeaker: not planned for launch
// - ViewGuildInsights: no analytics
// - RequestToSpeak: no stage channels

// Has returns true if combined has the given permission.
// Administrator grants all permissions.
func Has(combined, perm int64) bool {
	if combined&Administrator != 0 {
		return true
	}
	return combined&perm != 0
}

// Combine returns the bitwise OR of all permissions.
func Combine(perms ...int64) int64 {
	var c int64
	for _, p := range perms {
		c |= p
	}
	return c
}

// Validate rejects unknown bits to prevent future permission injection.
func Validate(perms int64) bool {
	return perms & ^AllPermissions == 0
}

// ValidateChannelScoped rejects bits that are not valid for permission overrides.
func ValidateChannelScoped(perms int64) bool {
	return perms & ^ChannelScopedPermissions == 0
}

// Source describes where a permission bit comes from.
type Source struct {
	Permission int64
	Granted    bool
	SourceType int // maps to PermissionSourceType proto enum values
	SourceName string
}

// Source type constants matching the proto enum PermissionSourceType.
const (
	SourceBaseRole         = 1
	SourceRoleOverride     = 2
	SourceCategoryOverride = 3
	SourceChannelOverride  = 4
	SourceUserOverride     = 5
	SourceAdministrator    = 6
	SourceOwner            = 7
)

// AttributeSourcesInput extends ResolveInput with name information for source attribution.
type AttributeSourcesInput struct {
	ResolveInput
	EveryoneName string   // usually "@everyone"
	RoleNames    []string // parallel to RolePerms
}

// AttributeSources walks the same resolution logic as ResolveEffective but records
// the source of each permission bit. Call this after ResolveEffective when you need
// to explain WHY each permission is allowed or denied.
func AttributeSources(input AttributeSourcesInput, nowUnix int64) []Source {
	var sources []Source

	// Owner bypass — all permissions come from ownership.
	if input.IsOwner {
		for bit := int64(1); bit <= AllPermissions; bit <<= 1 {
			if AllPermissions&bit != 0 {
				sources = append(sources, Source{Permission: bit, Granted: true, SourceType: SourceOwner, SourceName: "Server Owner"})
			}
		}
		return sources
	}

	// Compute base permissions.
	base := input.EveryonePerms
	for _, rp := range input.RolePerms {
		base |= rp
	}

	// Administrator short-circuit.
	if base&Administrator != 0 {
		for bit := int64(1); bit <= AllPermissions; bit <<= 1 {
			if AllPermissions&bit != 0 {
				sources = append(sources, Source{Permission: bit, Granted: true, SourceType: SourceAdministrator, SourceName: "Administrator"})
			}
		}
		return sources
	}

	// Track which role(s) grant each bit at the base level.
	effective := base

	// For each defined permission bit, record the base source.
	bitSources := make(map[int64]Source)
	for bit := int64(1); bit <= AllPermissions; bit <<= 1 {
		if AllPermissions&bit == 0 {
			continue
		}
		// Check @everyone first.
		if input.EveryonePerms&bit != 0 {
			bitSources[bit] = Source{Permission: bit, Granted: true, SourceType: SourceBaseRole, SourceName: input.EveryoneName}
			continue
		}
		// Check each assigned role.
		granted := false
		for i, rp := range input.RolePerms {
			if rp&bit != 0 {
				name := "Role"
				if i < len(input.RoleNames) {
					name = input.RoleNames[i]
				}
				bitSources[bit] = Source{Permission: bit, Granted: true, SourceType: SourceBaseRole, SourceName: name}
				granted = true
				break
			}
		}
		if !granted {
			bitSources[bit] = Source{Permission: bit, Granted: false, SourceType: SourceBaseRole, SourceName: input.EveryoneName}
		}
	}

	// Timeout strip — if timed out, only ViewChannel + ReadMessageHistory.
	if input.TimedOutUntil > 0 && nowUnix < input.TimedOutUntil {
		for bit := int64(1); bit <= AllPermissions; bit <<= 1 {
			if AllPermissions&bit == 0 {
				continue
			}
			granted := bit == ViewChannel || bit == ReadMessageHistory
			sources = append(sources, Source{Permission: bit, Granted: granted, SourceType: SourceBaseRole, SourceName: "Timed Out"})
		}
		return sources
	}

	// Apply category role overrides.
	for _, ovr := range input.GroupRoleOverrides {
		allow := ovr.Allow & ChannelScopedPermissions
		deny := ovr.Deny & ChannelScopedPermissions
		for bit := int64(1); bit <= ChannelScopedPermissions; bit <<= 1 {
			if deny&bit != 0 {
				effective &= ^bit
				bitSources[bit] = Source{Permission: bit, Granted: false, SourceType: SourceCategoryOverride, SourceName: "Category Override"}
			}
			if allow&bit != 0 {
				effective |= bit
				bitSources[bit] = Source{Permission: bit, Granted: true, SourceType: SourceCategoryOverride, SourceName: "Category Override"}
			}
		}
	}

	// Apply channel role overrides.
	for _, ovr := range input.ChannelRoleOverrides {
		allow := ovr.Allow & ChannelScopedPermissions
		deny := ovr.Deny & ChannelScopedPermissions
		for bit := int64(1); bit <= ChannelScopedPermissions; bit <<= 1 {
			if deny&bit != 0 {
				effective &= ^bit
				bitSources[bit] = Source{Permission: bit, Granted: false, SourceType: SourceChannelOverride, SourceName: "Channel Override"}
			}
			if allow&bit != 0 {
				effective |= bit
				bitSources[bit] = Source{Permission: bit, Granted: true, SourceType: SourceChannelOverride, SourceName: "Channel Override"}
			}
		}
	}

	// Apply category user override.
	if input.GroupUserOverride != nil {
		allow := input.GroupUserOverride.Allow & ChannelScopedPermissions
		deny := input.GroupUserOverride.Deny & ChannelScopedPermissions
		for bit := int64(1); bit <= ChannelScopedPermissions; bit <<= 1 {
			if deny&bit != 0 {
				effective &= ^bit
				bitSources[bit] = Source{Permission: bit, Granted: false, SourceType: SourceUserOverride, SourceName: "Category User Override"}
			}
			if allow&bit != 0 {
				effective |= bit
				bitSources[bit] = Source{Permission: bit, Granted: true, SourceType: SourceUserOverride, SourceName: "Category User Override"}
			}
		}
	}

	// Apply channel user override.
	if input.ChannelUserOverride != nil {
		allow := input.ChannelUserOverride.Allow & ChannelScopedPermissions
		deny := input.ChannelUserOverride.Deny & ChannelScopedPermissions
		for bit := int64(1); bit <= ChannelScopedPermissions; bit <<= 1 {
			if deny&bit != 0 {
				effective &= ^bit
				bitSources[bit] = Source{Permission: bit, Granted: false, SourceType: SourceUserOverride, SourceName: "Channel User Override"}
			}
			if allow&bit != 0 {
				effective |= bit
				bitSources[bit] = Source{Permission: bit, Granted: true, SourceType: SourceUserOverride, SourceName: "Channel User Override"}
			}
		}
	}

	// ViewChannel denied → all denied.
	if effective&ViewChannel == 0 {
		for bit := int64(1); bit <= AllPermissions; bit <<= 1 {
			if AllPermissions&bit == 0 {
				continue
			}
			src := bitSources[bit]
			src.Granted = false
			sources = append(sources, src)
		}
		return sources
	}

	// Collect final sources.
	for bit := int64(1); bit <= AllPermissions; bit <<= 1 {
		if AllPermissions&bit == 0 {
			continue
		}
		if src, ok := bitSources[bit]; ok {
			sources = append(sources, src)
		}
	}

	return sources
}

// Override represents an allow/deny permission pair for a channel or category override.
type Override struct {
	Allow int64
	Deny  int64
}

// ResolveInput contains all data needed to compute effective permissions.
type ResolveInput struct {
	EveryonePerms int64   // @everyone role permissions
	RolePerms     []int64 // permissions from each assigned role
	IsOwner       bool    // server owner bypass
	TimedOutUntil int64   // unix timestamp; 0 means not timed out

	// Channel-level overrides (leave empty for server-level checks).
	GroupRoleOverrides   []Override // category overrides for member's roles
	ChannelRoleOverrides []Override // channel overrides for member's roles
	GroupUserOverride    *Override  // category override for this specific user
	ChannelUserOverride  *Override  // channel override for this specific user
}

// ResolveEffective computes effective permissions following Discord's resolution algorithm:
//  1. Owner bypass → AllPermissions
//  2. Base = @everyone | all role perms
//  3. Administrator short-circuit → AllPermissions
//  4. Timeout strip → ViewChannel | ReadMessageHistory only
//  5. Apply category role overrides (aggregated)
//  6. Apply channel role overrides (aggregated, more specific wins)
//  7. Apply category user override
//  8. Apply channel user override (most specific, wins over everything)
//  9. ViewChannel denied → 0
func ResolveEffective(input ResolveInput, nowUnix int64) int64 {
	// 1. Owner bypass.
	if input.IsOwner {
		return AllPermissions
	}

	// 2. Base = @everyone | all role perms.
	base := input.EveryonePerms
	for _, rp := range input.RolePerms {
		base |= rp
	}

	// 3. Administrator short-circuit.
	if base&Administrator != 0 {
		return AllPermissions
	}

	// 4. Timeout strip — timed-out users get only ViewChannel + ReadMessageHistory.
	if input.TimedOutUntil > 0 && nowUnix < input.TimedOutUntil {
		return ViewChannel | ReadMessageHistory
	}

	// 5. Apply category role overrides (aggregate all roles).
	var groupAllow, groupDeny int64
	for _, ovr := range input.GroupRoleOverrides {
		groupAllow |= (ovr.Allow & ChannelScopedPermissions)
		groupDeny |= (ovr.Deny & ChannelScopedPermissions)
	}
	base = (base & ^groupDeny) | groupAllow

	// 6. Apply channel role overrides.
	var chAllow, chDeny int64
	for _, ovr := range input.ChannelRoleOverrides {
		chAllow |= (ovr.Allow & ChannelScopedPermissions)
		chDeny |= (ovr.Deny & ChannelScopedPermissions)
	}
	base = (base & ^chDeny) | chAllow

	// 7. Apply category user override (if any).
	if input.GroupUserOverride != nil {
		allow := input.GroupUserOverride.Allow & ChannelScopedPermissions
		deny := input.GroupUserOverride.Deny & ChannelScopedPermissions
		base = (base & ^deny) | allow
	}

	// 8. Apply channel user override (most specific, wins over everything).
	if input.ChannelUserOverride != nil {
		allow := input.ChannelUserOverride.Allow & ChannelScopedPermissions
		deny := input.ChannelUserOverride.Deny & ChannelScopedPermissions
		base = (base & ^deny) | allow
	}

	// 9. ViewChannel denied → no permissions in this channel.
	if base&ViewChannel == 0 {
		return 0
	}

	return base
}
