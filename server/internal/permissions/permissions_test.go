package permissions

import "testing"

func TestHas(t *testing.T) {
	tests := []struct {
		name     string
		combined int64
		perm     int64
		want     bool
	}{
		{"has kick", KickMembers, KickMembers, true},
		{"no kick", BanMembers, KickMembers, false},
		{"admin has kick", Administrator, KickMembers, true},
		{"admin has ban", Administrator, BanMembers, true},
		{"admin has manage", Administrator, ManageRoles, true},
		{"combined permissions", KickMembers | ManageRoles, KickMembers, true},
		{"combined missing ban", KickMembers | ManageRoles, BanMembers, false},
		{"zero has nothing", 0, KickMembers, false},
		{"all has everything", AllPermissions, KickMembers, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Has(tt.combined, tt.perm); got != tt.want {
				t.Errorf("Has(%d, %d) = %v, want %v", tt.combined, tt.perm, got, tt.want)
			}
		})
	}
}

func TestCombine(t *testing.T) {
	got := Combine(KickMembers, BanMembers)
	want := KickMembers | BanMembers
	if got != want {
		t.Errorf("Combine(KickMembers, BanMembers) = %d, want %d", got, want)
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name  string
		perms int64
		want  bool
	}{
		{"valid single", KickMembers, true},
		{"valid combined", KickMembers | BanMembers, true},
		{"valid all", AllPermissions, true},
		{"valid zero", 0, true},
		{"valid manage_channels", ManageChannels, true},
		{"valid timeout_members", TimeoutMembers, true},
		{"valid view_audit_log", ViewAuditLog, true},
		{"valid exempt_slow_mode", ExemptSlowMode, true},
		{"valid stream video", StreamVideo, true},
		{"valid manage_soundboard", ManageSoundboard, true},
		{"valid add_reactions", AddReactions, true},
		{"valid view_channel", ViewChannel, true},
		{"valid send_messages", SendMessages, true},
		{"valid connect", Connect, true},
		{"valid mention_everyone", MentionEveryone, true},
		{"valid manage_server", ManageServer, true},
		{"valid create_invite", CreateInvite, true},
		{"valid embed_links", EmbedLinks, true},
		{"valid attach_files", AttachFiles, true},
		{"valid read_message_history", ReadMessageHistory, true},
		{"valid use_external_emojis", UseExternalEmojis, true},
		{"valid speak", Speak, true},
		{"valid mute_members", MuteMembers, true},
		{"valid deafen_members", DeafenMembers, true},
		{"valid move_members", MoveMembers, true},
		{"valid change_nickname", ChangeNickname, true},
		{"valid manage_nicknames", ManageNicknames, true},
		{"valid manage_bots", ManageBots, true},
		{"valid manage_webhooks", ManageWebhooks, true},
		{"invalid unknown bit", 1 << 31, false},
		{"invalid high bit", 1 << 32, false},
		{"mixed valid and invalid", KickMembers | (1 << 31), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Validate(tt.perms); got != tt.want {
				t.Errorf("Validate(%d) = %v, want %v", tt.perms, got, tt.want)
			}
		})
	}
}

func TestResolveEffective(t *testing.T) {
	now := int64(1000000)

	tests := []struct {
		name  string
		input ResolveInput
		want  int64
	}{
		{
			name: "owner bypass returns all permissions",
			input: ResolveInput{
				IsOwner: true,
			},
			want: AllPermissions,
		},
		{
			name: "base is everyone OR role perms",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				RolePerms:     []int64{AddReactions, Connect},
			},
			want: ViewChannel | SendMessages | AddReactions | Connect,
		},
		{
			name: "administrator short-circuits to all",
			input: ResolveInput{
				EveryonePerms: ViewChannel,
				RolePerms:     []int64{Administrator},
			},
			want: AllPermissions,
		},
		{
			name: "everyone alone with admin short-circuits",
			input: ResolveInput{
				EveryonePerms: Administrator | ViewChannel,
			},
			want: AllPermissions,
		},
		{
			name: "active timeout strips to ViewChannel + ReadMessageHistory",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | AddReactions,
				RolePerms:     []int64{ManageMessages},
				TimedOutUntil: now + 3600, // 1 hour from now
			},
			want: ViewChannel | ReadMessageHistory,
		},
		{
			name: "expired timeout does not strip",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				TimedOutUntil: now - 3600, // 1 hour ago
			},
			want: ViewChannel | SendMessages,
		},
		{
			name: "zero timeout means not timed out",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				TimedOutUntil: 0,
			},
			want: ViewChannel | SendMessages,
		},
		{
			name: "admin bypasses timeout",
			input: ResolveInput{
				EveryonePerms: ViewChannel,
				RolePerms:     []int64{Administrator},
				TimedOutUntil: now + 3600,
			},
			want: AllPermissions, // admin short-circuit happens before timeout check
		},
		{
			name: "category role override denies SendMessages",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | AddReactions,
				GroupRoleOverrides: []Override{
					{Deny: SendMessages},
				},
			},
			want: ViewChannel | AddReactions,
		},
		{
			name: "category role override allows Connect",
			input: ResolveInput{
				EveryonePerms: ViewChannel,
				GroupRoleOverrides: []Override{
					{Allow: Connect | Speak},
				},
			},
			want: ViewChannel | Connect | Speak,
		},
		{
			name: "channel role override wins over category",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				GroupRoleOverrides: []Override{
					{Deny: SendMessages}, // category denies
				},
				ChannelRoleOverrides: []Override{
					{Allow: SendMessages}, // channel re-allows
				},
			},
			want: ViewChannel | SendMessages,
		},
		{
			name: "user override wins over role override",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				ChannelRoleOverrides: []Override{
					{Allow: AddReactions},
				},
				ChannelUserOverride: &Override{
					Deny: SendMessages,
				},
			},
			want: ViewChannel | AddReactions, // user deny wins
		},
		{
			name: "channel user override is most specific",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | AddReactions,
				GroupUserOverride: &Override{
					Deny: SendMessages, // category user denies
				},
				ChannelUserOverride: &Override{
					Allow: SendMessages, // channel user re-allows
				},
			},
			want: ViewChannel | SendMessages | AddReactions,
		},
		{
			name: "ViewChannel denied returns 0",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				ChannelRoleOverrides: []Override{
					{Deny: ViewChannel},
				},
			},
			want: 0,
		},
		{
			name: "server-wide bits in override are masked out",
			input: ResolveInput{
				EveryonePerms: ViewChannel,
				ChannelRoleOverrides: []Override{
					{Allow: Administrator | KickMembers | BanMembers | ManageRoles},
				},
			},
			// Administrator, KickMembers, BanMembers, ManageRoles are all server-wide
			// and get masked by ChannelScopedPermissions
			want: ViewChannel,
		},
		{
			name: "channel-scoped bits in override are allowed",
			input: ResolveInput{
				EveryonePerms: ViewChannel,
				ChannelRoleOverrides: []Override{
					{Allow: SendMessages | AddReactions | EmbedLinks | AttachFiles | Speak},
				},
			},
			want: ViewChannel | SendMessages | AddReactions | EmbedLinks | AttachFiles | Speak,
		},
		{
			name: "multiple role overrides aggregate via OR",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				GroupRoleOverrides: []Override{
					{Allow: AddReactions},
					{Allow: Connect},
					{Deny: SendMessages},
				},
			},
			// deny = SendMessages, allow = AddReactions | Connect
			// base & ^deny = ViewChannel, then | allow = ViewChannel | AddReactions | Connect
			want: ViewChannel | AddReactions | Connect,
		},
		{
			name: "no roles just everyone",
			input: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | Connect | Speak,
			},
			want: ViewChannel | SendMessages | Connect | Speak,
		},
		{
			name: "zero permissions with ViewChannel denied",
			input: ResolveInput{
				EveryonePerms: SendMessages, // no ViewChannel
			},
			want: 0, // ViewChannel not set → return 0
		},
		{
			name: "default everyone permissions",
			input: ResolveInput{
				EveryonePerms: DefaultEveryonePermissions,
			},
			want: DefaultEveryonePermissions,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveEffective(tt.input, now)
			if got != tt.want {
				t.Errorf("ResolveEffective() = %d, want %d", got, tt.want)
			}
		})
	}
}

// countDefinedBits returns the number of set bits in AllPermissions.
func countDefinedBits() int {
	count := 0
	for bit := int64(1); bit <= AllPermissions; bit <<= 1 {
		if AllPermissions&bit != 0 {
			count++
		}
	}
	return count
}

// findSource returns the Source entry for a specific permission bit, or nil.
func findSource(sources []Source, perm int64) *Source {
	for i := range sources {
		if sources[i].Permission == perm {
			return &sources[i]
		}
	}
	return nil
}

func TestAttributeSources(t *testing.T) {
	now := int64(1000000)
	totalBits := countDefinedBits() // 29

	t.Run("owner_bypass_all_granted_from_Server_Owner", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				IsOwner:       true,
				EveryonePerms: ViewChannel,
			},
			EveryoneName: "@everyone",
		}, now)

		if len(sources) != totalBits {
			t.Fatalf("source count = %d, want %d", len(sources), totalBits)
		}
		for _, src := range sources {
			if !src.Granted {
				t.Errorf("permission %d should be granted for owner", src.Permission)
			}
			if src.SourceType != SourceOwner {
				t.Errorf("permission %d source type = %d, want %d (SourceOwner)", src.Permission, src.SourceType, SourceOwner)
			}
			if src.SourceName != "Server Owner" {
				t.Errorf("permission %d source name = %q, want %q", src.Permission, src.SourceName, "Server Owner")
			}
		}
	})

	t.Run("administrator_short_circuit_all_granted", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel,
				RolePerms:     []int64{Administrator},
			},
			EveryoneName: "@everyone",
			RoleNames:    []string{"Admin"},
		}, now)

		if len(sources) != totalBits {
			t.Fatalf("source count = %d, want %d", len(sources), totalBits)
		}
		for _, src := range sources {
			if !src.Granted {
				t.Errorf("permission %d should be granted for administrator", src.Permission)
			}
			if src.SourceType != SourceAdministrator {
				t.Errorf("permission %d source type = %d, want %d (SourceAdministrator)", src.Permission, src.SourceType, SourceAdministrator)
			}
			if src.SourceName != "Administrator" {
				t.Errorf("permission %d source name = %q, want %q", src.Permission, src.SourceName, "Administrator")
			}
		}
	})

	t.Run("administrator_from_everyone_also_short_circuits", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: Administrator | ViewChannel,
			},
			EveryoneName: "@everyone",
		}, now)

		if len(sources) != totalBits {
			t.Fatalf("source count = %d, want %d", len(sources), totalBits)
		}
		for _, src := range sources {
			if !src.Granted {
				t.Errorf("permission %d should be granted", src.Permission)
			}
			if src.SourceType != SourceAdministrator {
				t.Errorf("permission %d source type = %d, want SourceAdministrator", src.Permission, src.SourceType)
			}
		}
	})

	t.Run("base_role_attribution_everyone_grants_a_bit", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, ViewChannel)
		if src == nil {
			t.Fatal("ViewChannel source not found")
		}
		if !src.Granted {
			t.Error("ViewChannel should be granted")
		}
		if src.SourceType != SourceBaseRole {
			t.Errorf("ViewChannel source type = %d, want %d (SourceBaseRole)", src.SourceType, SourceBaseRole)
		}
		if src.SourceName != "@everyone" {
			t.Errorf("ViewChannel source name = %q, want %q", src.SourceName, "@everyone")
		}

		src = findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if !src.Granted {
			t.Error("SendMessages should be granted")
		}
		if src.SourceName != "@everyone" {
			t.Errorf("SendMessages source name = %q, want %q", src.SourceName, "@everyone")
		}
	})

	t.Run("role_grants_a_bit_that_everyone_does_not", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				RolePerms:     []int64{ManageMessages | KickMembers},
			},
			EveryoneName: "@everyone",
			RoleNames:    []string{"Moderator"},
		}, now)

		// ManageMessages comes from "Moderator" role, not @everyone.
		src := findSource(sources, ManageMessages)
		if src == nil {
			t.Fatal("ManageMessages source not found")
		}
		if !src.Granted {
			t.Error("ManageMessages should be granted")
		}
		if src.SourceType != SourceBaseRole {
			t.Errorf("ManageMessages source type = %d, want SourceBaseRole", src.SourceType)
		}
		if src.SourceName != "Moderator" {
			t.Errorf("ManageMessages source name = %q, want %q", src.SourceName, "Moderator")
		}

		// ViewChannel still comes from @everyone.
		src = findSource(sources, ViewChannel)
		if src == nil {
			t.Fatal("ViewChannel source not found")
		}
		if src.SourceName != "@everyone" {
			t.Errorf("ViewChannel source name = %q, want %q", src.SourceName, "@everyone")
		}
	})

	t.Run("permission_denied_not_in_any_role", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
			},
			EveryoneName: "@everyone",
		}, now)

		// KickMembers is not granted by anyone.
		src := findSource(sources, KickMembers)
		if src == nil {
			t.Fatal("KickMembers source not found")
		}
		if src.Granted {
			t.Error("KickMembers should not be granted")
		}
		if src.SourceType != SourceBaseRole {
			t.Errorf("KickMembers source type = %d, want SourceBaseRole", src.SourceType)
		}
		if src.SourceName != "@everyone" {
			t.Errorf("KickMembers source name = %q, want %q", src.SourceName, "@everyone")
		}
	})

	t.Run("timeout_strips_permissions", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | AddReactions | ManageMessages,
				RolePerms:     []int64{KickMembers},
				TimedOutUntil: now + 3600, // timed out for 1 hour
			},
			EveryoneName: "@everyone",
			RoleNames:    []string{"Mod"},
		}, now)

		if len(sources) != totalBits {
			t.Fatalf("source count = %d, want %d", len(sources), totalBits)
		}

		for _, src := range sources {
			shouldGrant := src.Permission == ViewChannel || src.Permission == ReadMessageHistory
			if src.Granted != shouldGrant {
				t.Errorf("permission %d: granted = %v, want %v (timed out)", src.Permission, src.Granted, shouldGrant)
			}
			if src.SourceName != "Timed Out" {
				t.Errorf("permission %d source name = %q, want %q", src.Permission, src.SourceName, "Timed Out")
			}
		}
	})

	t.Run("expired_timeout_does_not_strip", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				TimedOutUntil: now - 3600, // expired 1 hour ago
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if !src.Granted {
			t.Error("SendMessages should be granted (timeout expired)")
		}
	})

	t.Run("channel_override_deny_overrides_base_grant", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | AddReactions,
				ChannelRoleOverrides: []Override{
					{Deny: SendMessages},
				},
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if src.Granted {
			t.Error("SendMessages should be denied by channel override")
		}
		if src.SourceType != SourceChannelOverride {
			t.Errorf("SendMessages source type = %d, want %d (SourceChannelOverride)", src.SourceType, SourceChannelOverride)
		}
		if src.SourceName != "Channel Override" {
			t.Errorf("SendMessages source name = %q, want %q", src.SourceName, "Channel Override")
		}

		// ViewChannel should still be granted from base.
		src = findSource(sources, ViewChannel)
		if src == nil {
			t.Fatal("ViewChannel source not found")
		}
		if !src.Granted {
			t.Error("ViewChannel should still be granted")
		}
	})

	t.Run("channel_override_allow_overrides_base_deny", func(t *testing.T) {
		// Base does not grant Connect; channel override allows it.
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				ChannelRoleOverrides: []Override{
					{Allow: Connect | Speak},
				},
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, Connect)
		if src == nil {
			t.Fatal("Connect source not found")
		}
		if !src.Granted {
			t.Error("Connect should be granted by channel override")
		}
		if src.SourceType != SourceChannelOverride {
			t.Errorf("Connect source type = %d, want %d (SourceChannelOverride)", src.SourceType, SourceChannelOverride)
		}
		if src.SourceName != "Channel Override" {
			t.Errorf("Connect source name = %q, want %q", src.SourceName, "Channel Override")
		}
	})

	t.Run("category_override_attribution", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				GroupRoleOverrides: []Override{
					{Deny: SendMessages},
				},
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if src.Granted {
			t.Error("SendMessages should be denied by category override")
		}
		if src.SourceType != SourceCategoryOverride {
			t.Errorf("SendMessages source type = %d, want %d (SourceCategoryOverride)", src.SourceType, SourceCategoryOverride)
		}
		if src.SourceName != "Category Override" {
			t.Errorf("SendMessages source name = %q, want %q", src.SourceName, "Category Override")
		}
	})

	t.Run("channel_override_overrides_category_override", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				GroupRoleOverrides: []Override{
					{Deny: SendMessages}, // category denies
				},
				ChannelRoleOverrides: []Override{
					{Allow: SendMessages}, // channel re-allows
				},
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if !src.Granted {
			t.Error("SendMessages should be granted (channel override wins over category)")
		}
		if src.SourceType != SourceChannelOverride {
			t.Errorf("SendMessages source type = %d, want SourceChannelOverride", src.SourceType)
		}
	})

	t.Run("user_override_takes_precedence_over_role_override", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				ChannelRoleOverrides: []Override{
					{Allow: AddReactions},
				},
				ChannelUserOverride: &Override{
					Deny: SendMessages,
				},
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if src.Granted {
			t.Error("SendMessages should be denied by user override")
		}
		if src.SourceType != SourceUserOverride {
			t.Errorf("SendMessages source type = %d, want %d (SourceUserOverride)", src.SourceType, SourceUserOverride)
		}
		if src.SourceName != "Channel User Override" {
			t.Errorf("SendMessages source name = %q, want %q", src.SourceName, "Channel User Override")
		}

		// AddReactions should still be granted from channel role override.
		src = findSource(sources, AddReactions)
		if src == nil {
			t.Fatal("AddReactions source not found")
		}
		if !src.Granted {
			t.Error("AddReactions should be granted from channel override")
		}
	})

	t.Run("channel_user_override_wins_over_category_user_override", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | AddReactions,
				GroupUserOverride: &Override{
					Deny: SendMessages, // category user denies
				},
				ChannelUserOverride: &Override{
					Allow: SendMessages, // channel user re-allows
				},
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if !src.Granted {
			t.Error("SendMessages should be granted (channel user override wins)")
		}
		if src.SourceType != SourceUserOverride {
			t.Errorf("SendMessages source type = %d, want SourceUserOverride", src.SourceType)
		}
		if src.SourceName != "Channel User Override" {
			t.Errorf("SendMessages source name = %q, want %q", src.SourceName, "Channel User Override")
		}
	})

	t.Run("category_user_override_attribution", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages,
				GroupUserOverride: &Override{
					Deny: SendMessages,
				},
			},
			EveryoneName: "@everyone",
		}, now)

		src := findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if src.Granted {
			t.Error("SendMessages should be denied by category user override")
		}
		if src.SourceType != SourceUserOverride {
			t.Errorf("SendMessages source type = %d, want SourceUserOverride", src.SourceType)
		}
		if src.SourceName != "Category User Override" {
			t.Errorf("SendMessages source name = %q, want %q", src.SourceName, "Category User Override")
		}
	})

	t.Run("ViewChannel_denied_all_denied", func(t *testing.T) {
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | AddReactions,
				ChannelRoleOverrides: []Override{
					{Deny: ViewChannel},
				},
			},
			EveryoneName: "@everyone",
		}, now)

		if len(sources) != totalBits {
			t.Fatalf("source count = %d, want %d", len(sources), totalBits)
		}
		for _, src := range sources {
			if src.Granted {
				t.Errorf("permission %d should be denied when ViewChannel is denied", src.Permission)
			}
		}

		// ViewChannel itself should be attributed to the channel override.
		src := findSource(sources, ViewChannel)
		if src == nil {
			t.Fatal("ViewChannel source not found")
		}
		if src.SourceType != SourceChannelOverride {
			t.Errorf("ViewChannel source type = %d, want SourceChannelOverride", src.SourceType)
		}
	})

	t.Run("ViewChannel_never_granted_in_base_all_denied", func(t *testing.T) {
		// @everyone does not have ViewChannel; everything should be denied.
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: SendMessages, // no ViewChannel
			},
			EveryoneName: "@everyone",
		}, now)

		for _, src := range sources {
			if src.Granted {
				t.Errorf("permission %d should be denied when ViewChannel is not granted", src.Permission)
			}
		}
	})

	t.Run("multiple_roles_first_match_wins", func(t *testing.T) {
		// When multiple roles grant the same bit, the first role in the list is credited.
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel,
				RolePerms:     []int64{KickMembers | BanMembers, KickMembers | ManageMessages},
			},
			EveryoneName: "@everyone",
			RoleNames:    []string{"Admin", "Moderator"},
		}, now)

		// KickMembers appears in both roles — first role ("Admin") should be credited.
		src := findSource(sources, KickMembers)
		if src == nil {
			t.Fatal("KickMembers source not found")
		}
		if src.SourceName != "Admin" {
			t.Errorf("KickMembers source name = %q, want %q (first role)", src.SourceName, "Admin")
		}

		// ManageMessages only in second role ("Moderator").
		src = findSource(sources, ManageMessages)
		if src == nil {
			t.Fatal("ManageMessages source not found")
		}
		if src.SourceName != "Moderator" {
			t.Errorf("ManageMessages source name = %q, want %q", src.SourceName, "Moderator")
		}
	})

	t.Run("role_name_fallback_when_names_missing", func(t *testing.T) {
		// When RoleNames is shorter than RolePerms, the fallback name is "Role".
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel,
				RolePerms:     []int64{KickMembers, BanMembers},
			},
			EveryoneName: "@everyone",
			RoleNames:    []string{"Named"}, // only 1 name for 2 roles
		}, now)

		// KickMembers from first role — has a name.
		src := findSource(sources, KickMembers)
		if src == nil {
			t.Fatal("KickMembers source not found")
		}
		if src.SourceName != "Named" {
			t.Errorf("KickMembers source name = %q, want %q", src.SourceName, "Named")
		}

		// BanMembers from second role — no name, falls back to "Role".
		src = findSource(sources, BanMembers)
		if src == nil {
			t.Fatal("BanMembers source not found")
		}
		if src.SourceName != "Role" {
			t.Errorf("BanMembers source name = %q, want %q (fallback)", src.SourceName, "Role")
		}
	})

	t.Run("server_wide_bits_in_channel_override_masked", func(t *testing.T) {
		// Channel overrides cannot grant server-wide permissions.
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel,
				ChannelRoleOverrides: []Override{
					{Allow: Administrator | KickMembers | BanMembers},
				},
			},
			EveryoneName: "@everyone",
		}, now)

		// Administrator should not be granted from channel override (masked).
		src := findSource(sources, Administrator)
		if src == nil {
			t.Fatal("Administrator source not found")
		}
		if src.Granted {
			t.Error("Administrator should not be grantable via channel override")
		}

		// KickMembers should not be granted from channel override (masked).
		src = findSource(sources, KickMembers)
		if src == nil {
			t.Fatal("KickMembers source not found")
		}
		if src.Granted {
			t.Error("KickMembers should not be grantable via channel override")
		}
	})

	t.Run("full_resolution_chain", func(t *testing.T) {
		// Complex scenario: base grants ViewChannel+SendMessages+AddReactions,
		// role grants ManageMessages, category denies SendMessages,
		// channel re-allows SendMessages, user override denies AddReactions.
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel | SendMessages | AddReactions,
				RolePerms:     []int64{ManageMessages},
				GroupRoleOverrides: []Override{
					{Deny: SendMessages},
				},
				ChannelRoleOverrides: []Override{
					{Allow: SendMessages},
				},
				ChannelUserOverride: &Override{
					Deny: AddReactions,
				},
			},
			EveryoneName: "@everyone",
			RoleNames:    []string{"Mod"},
		}, now)

		// ViewChannel: base (@everyone), granted.
		src := findSource(sources, ViewChannel)
		if src == nil {
			t.Fatal("ViewChannel source not found")
		}
		if !src.Granted || src.SourceType != SourceBaseRole || src.SourceName != "@everyone" {
			t.Errorf("ViewChannel: granted=%v, type=%d, name=%q; want granted, SourceBaseRole, @everyone",
				src.Granted, src.SourceType, src.SourceName)
		}

		// SendMessages: channel override wins (re-allows after category deny).
		src = findSource(sources, SendMessages)
		if src == nil {
			t.Fatal("SendMessages source not found")
		}
		if !src.Granted || src.SourceType != SourceChannelOverride {
			t.Errorf("SendMessages: granted=%v, type=%d; want granted, SourceChannelOverride",
				src.Granted, src.SourceType)
		}

		// AddReactions: user override denies.
		src = findSource(sources, AddReactions)
		if src == nil {
			t.Fatal("AddReactions source not found")
		}
		if src.Granted || src.SourceType != SourceUserOverride {
			t.Errorf("AddReactions: granted=%v, type=%d; want denied, SourceUserOverride",
				src.Granted, src.SourceType)
		}

		// ManageMessages: from role "Mod".
		src = findSource(sources, ManageMessages)
		if src == nil {
			t.Fatal("ManageMessages source not found")
		}
		if !src.Granted || src.SourceName != "Mod" {
			t.Errorf("ManageMessages: granted=%v, name=%q; want granted, Mod",
				src.Granted, src.SourceName)
		}
	})

	t.Run("returns_source_for_every_defined_bit", func(t *testing.T) {
		// Even a minimal input should return one source per defined permission bit.
		sources := AttributeSources(AttributeSourcesInput{
			ResolveInput: ResolveInput{
				EveryonePerms: ViewChannel,
			},
			EveryoneName: "@everyone",
		}, now)

		if len(sources) != totalBits {
			t.Errorf("source count = %d, want %d", len(sources), totalBits)
		}

		// Verify each defined bit has exactly one source.
		seen := make(map[int64]bool)
		for _, src := range sources {
			if seen[src.Permission] {
				t.Errorf("duplicate source for permission %d", src.Permission)
			}
			seen[src.Permission] = true
		}
		for bit := int64(1); bit <= AllPermissions; bit <<= 1 {
			if AllPermissions&bit != 0 && !seen[bit] {
				t.Errorf("missing source for permission %d", bit)
			}
		}
	})

	t.Run("consistency_with_ResolveEffective", func(t *testing.T) {
		// The granted bits from AttributeSources should match ResolveEffective.
		inputs := []struct {
			name  string
			input ResolveInput
		}{
			{
				name: "basic base perms",
				input: ResolveInput{
					EveryonePerms: ViewChannel | SendMessages | AddReactions,
					RolePerms:     []int64{KickMembers},
				},
			},
			{
				name: "channel override deny",
				input: ResolveInput{
					EveryonePerms: ViewChannel | SendMessages,
					ChannelRoleOverrides: []Override{
						{Deny: SendMessages},
					},
				},
			},
			{
				name: "user override allow",
				input: ResolveInput{
					EveryonePerms: ViewChannel,
					ChannelUserOverride: &Override{
						Allow: SendMessages | AddReactions,
					},
				},
			},
			{
				name: "ViewChannel denied",
				input: ResolveInput{
					EveryonePerms: ViewChannel | SendMessages,
					ChannelRoleOverrides: []Override{
						{Deny: ViewChannel},
					},
				},
			},
		}

		for _, tc := range inputs {
			t.Run(tc.name, func(t *testing.T) {
				effective := ResolveEffective(tc.input, now)
				sources := AttributeSources(AttributeSourcesInput{
					ResolveInput: tc.input,
					EveryoneName: "@everyone",
				}, now)

				// Reconstruct effective from sources.
				var reconstructed int64
				for _, src := range sources {
					if src.Granted {
						reconstructed |= src.Permission
					}
				}

				if reconstructed != effective {
					t.Errorf("reconstructed=%d, ResolveEffective=%d", reconstructed, effective)
				}
			})
		}
	})
}

func TestDefaultEveryonePermissions(t *testing.T) {
	// Verify DefaultEveryonePermissions includes ViewChannel (required for any access).
	if DefaultEveryonePermissions&ViewChannel == 0 {
		t.Error("DefaultEveryonePermissions must include ViewChannel")
	}
	// Verify it's a subset of AllPermissions.
	if !Validate(DefaultEveryonePermissions) {
		t.Error("DefaultEveryonePermissions contains invalid bits")
	}
}
