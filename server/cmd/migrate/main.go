package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/gocql/gocql"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kelseyhightower/envconfig"

	"github.com/meza-chat/meza/internal/database"
	"github.com/meza-chat/meza/internal/observability"
	"github.com/meza-chat/meza/migrations"
)

// advisoryLockID is the pg_advisory_lock key used to prevent concurrent migration runs.
// Value: SELECT hashtext('meza_migrations')
const advisoryLockID int64 = 1835293047

type Config struct {
	PostgresURL string `envconfig:"POSTGRES_URL" required:"true"`
	ScyllaHosts string `envconfig:"SCYLLA_HOSTS" required:"true"`
}

type migrationFile struct {
	version uint64
	name    string
	content string
}

func main() {
	statusMode := flag.Bool("status", false, "Show migration status instead of running migrations")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger := observability.NewLogger("info")
	slog.SetDefault(logger)

	var cfg Config
	envconfig.MustProcess("MEZA", &cfg)

	if *statusMode {
		if err := showStatus(ctx, cfg); err != nil {
			slog.Error("failed to show migration status", "err", err)
			os.Exit(1)
		}
		return
	}

	if err := migratePostgres(ctx, cfg.PostgresURL); err != nil {
		slog.Error("PostgreSQL migration failed", "err", err)
		os.Exit(1)
	}

	if err := migrateScylla(ctx, cfg.ScyllaHosts); err != nil {
		slog.Error("ScyllaDB migration failed", "err", err)
		os.Exit(1)
	}

	slog.Info("all migrations completed successfully")
}

// migratePostgres applies all .up.sql migrations idempotently with advisory locking.
func migratePostgres(ctx context.Context, postgresURL string) error {
	pool, err := pgxpool.New(ctx, postgresURL)
	if err != nil {
		return fmt.Errorf("connecting to PostgreSQL: %w", err)
	}
	defer pool.Close()

	// Acquire advisory lock to prevent concurrent migration runs.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquiring connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", advisoryLockID); err != nil {
		return fmt.Errorf("acquiring advisory lock: %w", err)
	}
	defer conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", advisoryLockID) //nolint:errcheck

	// Ensure tracking table exists.
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS meza_migrations (
		version    BIGINT       NOT NULL PRIMARY KEY,
		name       TEXT         NOT NULL,
		applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("creating tracking table: %w", err)
	}

	files, err := readUpMigrations(migrations.PostgresFS, ".")
	if err != nil {
		return err
	}

	// Load already-applied versions so we can skip them.
	applied := map[uint64]bool{}
	rows, err := conn.Query(ctx, "SELECT version FROM meza_migrations")
	if err != nil {
		return fmt.Errorf("reading applied migrations: %w", err)
	}
	for rows.Next() {
		var v uint64
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return fmt.Errorf("scanning applied migration version: %w", err)
		}
		applied[v] = true
	}
	rows.Close()

	for _, f := range files {
		if applied[f.version] {
			continue
		}

		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("beginning transaction for %s: %w", f.name, err)
		}

		if _, err := tx.Exec(ctx, f.content); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return fmt.Errorf("applying migration %d_%s: %w", f.version, f.name, err)
		}

		if _, err := tx.Exec(ctx, `INSERT INTO meza_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, f.version, f.name); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return fmt.Errorf("recording migration %d_%s: %w", f.version, f.name, err)
		}

		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("committing migration %d_%s: %w", f.version, f.name, err)
		}

		slog.Info("applied PostgreSQL migration", "version", f.version, "name", f.name)
	}

	slog.Info("PostgreSQL migrations up to date")
	return nil
}

// migrateScylla applies all .cql migrations idempotently.
func migrateScylla(ctx context.Context, hosts string) error {
	session, err := database.NewScyllaSession(hosts, "")
	if err != nil {
		return fmt.Errorf("connecting to ScyllaDB: %w", err)
	}
	defer session.Close()

	files, err := readCQLMigrations(migrations.ScyllaFS)
	if err != nil {
		return err
	}

	// Apply all migrations first (the initial schema creates the keyspace).
	for _, f := range files {
		for _, stmt := range splitCQL(f.content) {
			if err := session.Query(stmt).Exec(); err != nil {
				if isIdempotentSchemaErr(err) {
					slog.Info("skipping already-applied statement", "file", f.name, "err", err)
					continue
				}
				return fmt.Errorf("executing %s: %w", f.name, err)
			}
		}
		slog.Info("applied CQL migration", "version", f.version, "name", f.name)
	}

	// Bootstrap the tracking table now that the keyspace exists, then record all applied migrations.
	bootstrapCQL := `CREATE TABLE IF NOT EXISTS meza.meza_migrations (
		version    BIGINT,
		name       TEXT,
		applied_at TIMESTAMP,
		PRIMARY KEY (version)
	)`
	if err := session.Query(bootstrapCQL).Exec(); err != nil {
		return fmt.Errorf("creating ScyllaDB tracking table: %w", err)
	}
	for _, f := range files {
		if err := session.Query(`INSERT INTO meza.meza_migrations (version, name, applied_at) VALUES (?, ?, toTimestamp(now()))`,
			f.version, f.name).Exec(); err != nil {
			slog.Warn("failed to record ScyllaDB migration in tracking table", "version", f.version, "name", f.name, "err", err)
		}
	}

	slog.Info("ScyllaDB migrations up to date")
	return nil
}

// showStatus prints migration status for both databases.
// Returns an error if either database is unreachable so the caller can exit non-zero.
func showStatus(ctx context.Context, cfg Config) error {
	var errs []error

	fmt.Println("=== PostgreSQL Migrations ===")
	if err := showPostgresStatus(ctx, cfg.PostgresURL); err != nil {
		fmt.Printf("  (unable to read status: %v)\n", err)
		errs = append(errs, fmt.Errorf("postgres: %w", err))
	}

	fmt.Println()
	fmt.Println("=== ScyllaDB Migrations ===")
	if err := showScyllaStatus(ctx, cfg.ScyllaHosts); err != nil {
		fmt.Printf("  (unable to read status: %v)\n", err)
		errs = append(errs, fmt.Errorf("scylla: %w", err))
	}

	return errors.Join(errs...)
}

func showPostgresStatus(ctx context.Context, postgresURL string) error {
	pool, err := pgxpool.New(ctx, postgresURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	// Check if tracking table exists.
	var exists bool
	err = pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables WHERE table_name = 'meza_migrations'
	)`).Scan(&exists)
	if err != nil {
		return err
	}

	applied := make(map[uint64]time.Time)
	if exists {
		rows, err := pool.Query(ctx, "SELECT version, applied_at FROM meza_migrations ORDER BY version")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v uint64
			var at time.Time
			if err := rows.Scan(&v, &at); err != nil {
				return err
			}
			applied[v] = at
		}
	}

	files, err := readUpMigrations(migrations.PostgresFS, ".")
	if err != nil {
		return err
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(w, "  VERSION\tNAME\tSTATUS\tAPPLIED AT\n")
	for _, f := range files {
		if at, ok := applied[f.version]; ok {
			fmt.Fprintf(w, "  %d\t%s\tapplied\t%s\n", f.version, f.name, at.Format(time.RFC3339))
		} else {
			fmt.Fprintf(w, "  %d\t%s\tpending\t-\n", f.version, f.name)
		}
	}
	w.Flush()
	return nil
}

func showScyllaStatus(ctx context.Context, hosts string) error {
	session, err := database.NewScyllaSession(hosts, "")
	if err != nil {
		return err
	}
	defer session.Close()

	applied := make(map[uint64]time.Time)
	iter := session.Query("SELECT version, applied_at FROM meza.meza_migrations").Iter()
	var v uint64
	var at time.Time
	for iter.Scan(&v, &at) {
		applied[v] = at
	}
	if err := iter.Close(); err != nil {
		// Table may not exist yet — that's fine, just show all as pending.
		applied = make(map[uint64]time.Time)
	}

	files, err := readCQLMigrations(migrations.ScyllaFS)
	if err != nil {
		return err
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(w, "  VERSION\tNAME\tSTATUS\tAPPLIED AT\n")
	for _, f := range files {
		if at, ok := applied[f.version]; ok {
			fmt.Fprintf(w, "  %d\t%s\tapplied\t%s\n", f.version, f.name, at.Format(time.RFC3339))
		} else {
			fmt.Fprintf(w, "  %d\t%s\tpending\t-\n", f.version, f.name)
		}
	}
	w.Flush()
	return nil
}

// readUpMigrations reads .up.sql files from a filesystem, sorted by numeric version.
func readUpMigrations(fsys fs.FS, dir string) ([]migrationFile, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("reading migration directory: %w", err)
	}

	var files []migrationFile
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".up.sql") {
			continue
		}
		version, name, err := parseMigrationFile(e.Name(), ".up.sql")
		if err != nil {
			return nil, err
		}
		path := e.Name()
		if dir != "." {
			path = dir + "/" + path
		}
		data, err := fs.ReadFile(fsys, path)
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", e.Name(), err)
		}
		files = append(files, migrationFile{version: version, name: name, content: string(data)})
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].version < files[j].version
	})
	if err := checkDuplicateVersions(files); err != nil {
		return nil, err
	}
	return files, nil
}

// readCQLMigrations reads .cql files from the ScyllaFS, sorted by numeric version.
func readCQLMigrations(fsys fs.FS) ([]migrationFile, error) {
	entries, err := fs.ReadDir(fsys, "scylla")
	if err != nil {
		return nil, fmt.Errorf("reading CQL migration directory: %w", err)
	}

	var files []migrationFile
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".cql") {
			continue
		}
		version, name, err := parseMigrationFile(e.Name(), ".cql")
		if err != nil {
			return nil, err
		}
		data, err := fs.ReadFile(fsys, "scylla/"+e.Name())
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", e.Name(), err)
		}
		files = append(files, migrationFile{version: version, name: name, content: string(data)})
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].version < files[j].version
	})
	if err := checkDuplicateVersions(files); err != nil {
		return nil, err
	}
	return files, nil
}

// parseMigrationFile extracts the numeric version and name from a migration filename.
// Example: "1740000000_add_feature.up.sql" -> version=1740000000, name="add_feature"
func parseMigrationFile(filename, suffix string) (uint64, string, error) {
	base := strings.TrimSuffix(filename, suffix)
	idx := strings.Index(base, "_")
	if idx < 0 {
		return 0, "", fmt.Errorf("invalid migration filename (no underscore): %s", filename)
	}

	version, err := strconv.ParseUint(base[:idx], 10, 64)
	if err != nil {
		return 0, "", fmt.Errorf("invalid migration version in %s: %w", filename, err)
	}

	name := base[idx+1:]
	if name == "" {
		return 0, "", fmt.Errorf("invalid migration filename (empty name): %s", filename)
	}

	return version, name, nil
}

// checkDuplicateVersions returns an error if two migration files share the same numeric version.
// Files must be sorted by version before calling.
func checkDuplicateVersions(files []migrationFile) error {
	for i := 1; i < len(files); i++ {
		if files[i].version == files[i-1].version {
			return fmt.Errorf("duplicate migration version %d: %s and %s", files[i].version, files[i-1].name, files[i].name)
		}
	}
	return nil
}

// isIdempotentSchemaErr returns true if a CQL error indicates the DDL
// statement has already been applied — either a CREATE replay (object already
// exists) or a DROP replay (column/table not found). This lets the migration
// runner safely replay non-idempotent DDL.
func isIdempotentSchemaErr(err error) bool {
	if err == nil {
		return false
	}
	// Prefer typed gocql error code (0x2400 AlreadyExists).
	var alreadyExists *gocql.RequestErrAlreadyExists
	if errors.As(err, &alreadyExists) {
		return true
	}
	// Fall back to string matching for drivers that don't return typed errors.
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "already exist") ||
		strings.Contains(msg, "conflicts with an existing column") ||
		strings.Contains(msg, "was not found in table") ||
		strings.Contains(msg, "was not found in column")
}

// splitCQL splits CQL content on semicolons, stripping comments.
// Handles -- and // line comments. Does not handle semicolons inside string literals.
func splitCQL(content string) []string {
	var statements []string
	for _, stmt := range strings.Split(content, ";") {
		var lines []string
		for _, line := range strings.Split(stmt, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "--") || strings.HasPrefix(trimmed, "//") {
				continue
			}
			lines = append(lines, line)
		}
		clean := strings.TrimSpace(strings.Join(lines, "\n"))
		if clean != "" {
			statements = append(statements, clean)
		}
	}
	return statements
}
