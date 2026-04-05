package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kelseyhightower/envconfig"

	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/observability"
	"github.com/mezalabs/meza/internal/store"
)

type Config struct {
	PostgresURL          string `envconfig:"POSTGRES_URL" required:"true"`
	InstanceURL          string `envconfig:"INSTANCE_URL" required:"true"`
	FederationEnabled    bool   `envconfig:"FEDERATION_ENABLED" default:"false"`
	OriginURL            string `envconfig:"ORIGIN_URL"`
	RegistrationDisabled bool   `envconfig:"REGISTRATION_DISABLED" default:"false"`
}

func main() {
	logger := observability.NewLogger("info")
	slog.SetDefault(logger)

	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	var cfg Config
	envconfig.MustProcess("MEZA", &cfg)
	cfg.InstanceURL = strings.TrimRight(cfg.InstanceURL, "/")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.PostgresURL)
	if err != nil {
		slog.Error("connect postgres", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	chatStore := store.NewChatStore(pool)
	inviteStore := store.NewInviteStore(pool)
	banStore := store.NewBanStore(pool)

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "create-server":
		cmdCreateServer(ctx, args, pool, chatStore, inviteStore, cfg)
	case "create-invite":
		cmdCreateInvite(ctx, args, inviteStore, cfg)
	case "list-invites":
		cmdListInvites(ctx, args, inviteStore)
	case "revoke-invite":
		cmdRevokeInvite(ctx, args, inviteStore)
	case "list-servers":
		cmdListServers(ctx, chatStore)
	case "list-members":
		cmdListMembers(ctx, args, pool)
	case "ban":
		cmdBan(ctx, args, pool, banStore, chatStore)
	case "unban":
		cmdUnban(ctx, args, banStore)
	case "status":
		cmdStatus(ctx, pool, cfg)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", cmd)
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `meza-admin — spoke server administration tool

Usage: meza-admin <command> [flags]

Commands:
  create-server   Create a server with invite (bootstrap)
  create-invite   Create an invite for an existing server
  list-invites    List invites for a server
  revoke-invite   Revoke an invite
  list-servers    List all servers on this spoke
  list-members    List members of a server
  ban             Ban a user from a server
  unban           Remove a ban
  status          Show spoke federation status

Environment:
  MEZA_POSTGRES_URL   PostgreSQL connection string (required)
  MEZA_INSTANCE_URL   This instance's public URL (required)
`)
}

// cmdCreateServer creates a server owned by the system user, with a default
// channel, @everyone role, and auto-generated invite.
func cmdCreateServer(ctx context.Context, args []string, pool *pgxpool.Pool, chatStore *store.ChatStore, inviteStore *store.InviteStore, cfg Config) {
	fs := flag.NewFlagSet("create-server", flag.ExitOnError)
	name := fs.String("name", "", "server name (required)")
	fs.Parse(args)

	if *name == "" {
		fmt.Fprintln(os.Stderr, "error: --name is required")
		os.Exit(1)
	}
	if len(*name) > 100 {
		fmt.Fprintln(os.Stderr, "error: server name must be 100 characters or fewer")
		os.Exit(1)
	}

	// Use the seeded system user as owner
	server, err := chatStore.CreateServer(ctx, *name, models.SystemUserID, nil, false)
	if err != nil {
		slog.Error("create server", "err", err)
		os.Exit(1)
	}

	// Create an invite (no expiry, unlimited uses)
	invite, err := inviteStore.CreateInvite(ctx, server.ID, models.SystemUserID, 0, nil, nil, nil)
	if err != nil {
		slog.Error("create invite", "err", err)
		os.Exit(1)
	}

	fmt.Printf("Server created: %s\n", server.ID)
	fmt.Printf("Name:           %s\n", server.Name)
	fmt.Printf("Invite:         %s/invite/%s\n", cfg.InstanceURL, invite.Code)
}

// cmdCreateInvite creates an invite for an existing server.
func cmdCreateInvite(ctx context.Context, args []string, inviteStore *store.InviteStore, cfg Config) {
	fs := flag.NewFlagSet("create-invite", flag.ExitOnError)
	serverID := fs.String("server-id", "", "server ID (required)")
	maxUses := fs.Int("max-uses", 0, "max uses (0 = unlimited)")
	maxAge := fs.Int("max-age-seconds", 0, "max age in seconds (0 = never expires)")
	fs.Parse(args)

	if *serverID == "" {
		fmt.Fprintln(os.Stderr, "error: --server-id is required")
		os.Exit(1)
	}

	var expiresAt *time.Time
	if *maxAge > 0 {
		t := time.Now().Add(time.Duration(*maxAge) * time.Second)
		expiresAt = &t
	}

	invite, err := inviteStore.CreateInvite(ctx, *serverID, models.SystemUserID, *maxUses, expiresAt, nil, nil)
	if err != nil {
		slog.Error("create invite", "err", err)
		os.Exit(1)
	}

	fmt.Printf("Invite: %s/invite/%s\n", cfg.InstanceURL, invite.Code)
	if *maxUses > 0 {
		fmt.Printf("Max uses: %d\n", *maxUses)
	}
	if expiresAt != nil {
		fmt.Printf("Expires: %s\n", expiresAt.Format(time.RFC3339))
	}
}

// cmdListInvites lists invites for a server.
func cmdListInvites(ctx context.Context, args []string, inviteStore *store.InviteStore) {
	fs := flag.NewFlagSet("list-invites", flag.ExitOnError)
	serverID := fs.String("server-id", "", "server ID (required)")
	fs.Parse(args)

	if *serverID == "" {
		fmt.Fprintln(os.Stderr, "error: --server-id is required")
		os.Exit(1)
	}

	invites, err := inviteStore.ListInvites(ctx, *serverID)
	if err != nil {
		slog.Error("list invites", "err", err)
		os.Exit(1)
	}

	if len(invites) == 0 {
		fmt.Println("No invites found.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "CODE\tUSES\tMAX\tSTATUS\tCREATED")
	for _, inv := range invites {
		status := "active"
		if inv.Revoked {
			status = "revoked"
		} else if inv.ExpiresAt != nil && inv.ExpiresAt.Before(time.Now()) {
			status = "expired"
		} else if inv.MaxUses > 0 && inv.UseCount >= inv.MaxUses {
			status = "maxed"
		}
		maxStr := "unlimited"
		if inv.MaxUses > 0 {
			maxStr = fmt.Sprintf("%d", inv.MaxUses)
		}
		fmt.Fprintf(w, "%s\t%d\t%s\t%s\t%s\n",
			inv.Code, inv.UseCount, maxStr, status,
			inv.CreatedAt.Format("2006-01-02 15:04"))
	}
	w.Flush()
}

// cmdRevokeInvite revokes an invite by code.
func cmdRevokeInvite(ctx context.Context, args []string, inviteStore *store.InviteStore) {
	fs := flag.NewFlagSet("revoke-invite", flag.ExitOnError)
	code := fs.String("code", "", "invite code (required)")
	fs.Parse(args)

	if *code == "" {
		fmt.Fprintln(os.Stderr, "error: --code is required")
		os.Exit(1)
	}

	// Verify invite exists
	inv, err := inviteStore.GetInvite(ctx, *code)
	if err != nil || inv == nil {
		fmt.Fprintf(os.Stderr, "error: invite %q not found\n", *code)
		os.Exit(1)
	}
	if inv.Revoked {
		fmt.Println("Invite already revoked.")
		return
	}

	if err := inviteStore.RevokeInvite(ctx, *code); err != nil {
		slog.Error("revoke invite", "err", err)
		os.Exit(1)
	}

	fmt.Printf("Invite %s revoked.\n", *code)
}

// cmdListServers lists all servers on this spoke.
func cmdListServers(ctx context.Context, chatStore *store.ChatStore) {
	servers, err := chatStore.ListAllServers(ctx)
	if err != nil {
		slog.Error("list servers", "err", err)
		os.Exit(1)
	}

	if len(servers) == 0 {
		fmt.Println("No servers found.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tNAME\tCREATED")
	for _, s := range servers {
		fmt.Fprintf(w, "%s\t%s\t%s\n", s.ID, s.Name, s.CreatedAt.Format("2006-01-02 15:04"))
	}
	w.Flush()
}

// cmdListMembers lists members of a server with federated user details.
func cmdListMembers(ctx context.Context, args []string, pool *pgxpool.Pool) {
	fs := flag.NewFlagSet("list-members", flag.ExitOnError)
	serverID := fs.String("server-id", "", "server ID (required)")
	fs.Parse(args)

	if *serverID == "" {
		fmt.Fprintln(os.Stderr, "error: --server-id is required")
		os.Exit(1)
	}

	rows, err := pool.Query(ctx,
		`SELECT m.user_id, u.username, u.display_name, u.is_federated, u.home_server, m.joined_at
		 FROM members m JOIN users u ON u.id = m.user_id
		 WHERE m.server_id = $1
		 ORDER BY m.joined_at`, *serverID)
	if err != nil {
		slog.Error("list members", "err", err)
		os.Exit(1)
	}
	defer rows.Close()

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "USER_ID\tUSERNAME\tDISPLAY_NAME\tFEDERATED\tHOME_SERVER\tJOINED")
	count := 0
	for rows.Next() {
		var userID, username, displayName string
		var isFederated bool
		var homeServer *string
		var joinedAt time.Time
		if err := rows.Scan(&userID, &username, &displayName, &isFederated, &homeServer, &joinedAt); err != nil {
			slog.Error("scan member", "err", err)
			os.Exit(1)
		}
		hs := "-"
		if homeServer != nil {
			hs = *homeServer
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%v\t%s\t%s\n",
			userID, username, displayName, isFederated, hs,
			joinedAt.Format("2006-01-02 15:04"))
		count++
	}
	w.Flush()
	if count == 0 {
		fmt.Println("No members found.")
	}
}

// cmdBan bans a user from a server and cleans up membership.
func cmdBan(ctx context.Context, args []string, pool *pgxpool.Pool, banStore *store.BanStore, chatStore *store.ChatStore) {
	fs := flag.NewFlagSet("ban", flag.ExitOnError)
	serverID := fs.String("server-id", "", "server ID (required)")
	userID := fs.String("user-id", "", "user ID to ban (required)")
	reason := fs.String("reason", "", "ban reason")
	fs.Parse(args)

	if *serverID == "" || *userID == "" {
		fmt.Fprintln(os.Stderr, "error: --server-id and --user-id are required")
		os.Exit(1)
	}

	ban := &models.Ban{
		ServerID:  *serverID,
		UserID:    *userID,
		Reason:    *reason,
		BannedBy:  nil, // admin CLI — no user attribution
		CreatedAt: time.Now(),
	}
	if _, err := banStore.CreateBan(ctx, ban); err != nil {
		slog.Error("create ban", "err", err)
		os.Exit(1)
	}

	// Remove membership
	if err := chatStore.RemoveMember(ctx, *userID, *serverID); err != nil {
		slog.Warn("remove member (may not have been a member)", "err", err)
	}

	// Clean up channel members
	if err := chatStore.RemoveChannelMembersForServer(ctx, *userID, *serverID); err != nil {
		slog.Warn("remove channel members", "err", err)
	}

	fmt.Printf("Banned user %s from server %s.\n", *userID, *serverID)
}

// cmdUnban removes a ban.
func cmdUnban(ctx context.Context, args []string, banStore *store.BanStore) {
	fs := flag.NewFlagSet("unban", flag.ExitOnError)
	serverID := fs.String("server-id", "", "server ID (required)")
	userID := fs.String("user-id", "", "user ID to unban (required)")
	fs.Parse(args)

	if *serverID == "" || *userID == "" {
		fmt.Fprintln(os.Stderr, "error: --server-id and --user-id are required")
		os.Exit(1)
	}

	if err := banStore.DeleteBan(ctx, *serverID, *userID); err != nil {
		slog.Error("delete ban", "err", err)
		os.Exit(1)
	}

	fmt.Printf("Unbanned user %s from server %s.\n", *userID, *serverID)
}

// cmdStatus shows spoke federation status.
func cmdStatus(ctx context.Context, pool *pgxpool.Pool, cfg Config) {
	fmt.Printf("Instance:  %s\n", cfg.InstanceURL)

	if err := pool.Ping(ctx); err != nil {
		fmt.Printf("Database:  ERROR (%v)\n", err)
	} else {
		fmt.Printf("Database:  connected\n")
	}

	var serverCount, memberCount int
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM servers`).Scan(&serverCount)
	pool.QueryRow(ctx, `SELECT COUNT(*) FROM members WHERE user_id != $1`, models.SystemUserID).Scan(&memberCount)
	fmt.Printf("Servers:   %d\n", serverCount)
	fmt.Printf("Members:   %d\n", memberCount)

	fmt.Printf("\nFederation:\n")
	fmt.Printf("  Enabled:        %v\n", cfg.FederationEnabled)
	originURL := cfg.OriginURL
	if originURL == "" {
		originURL = "(not set)"
	}
	fmt.Printf("  Origin:         %s\n", originURL)
	if cfg.RegistrationDisabled {
		fmt.Printf("  Registration:   disabled (spoke mode)\n")
	} else {
		fmt.Printf("  Registration:   enabled\n")
	}
}
