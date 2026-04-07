package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mezalabs/meza/internal/models"
)

// ReportStore implements ReportStorer using PostgreSQL.
type ReportStore struct {
	pool *pgxpool.Pool
}

// NewReportStore creates a new ReportStore backed by a pgxpool.Pool.
func NewReportStore(pool *pgxpool.Pool) *ReportStore {
	return &ReportStore{pool: pool}
}

const reportColumns = `id, reporter_id, target_user_id, target_message_id, target_channel_id,
	server_id, snapshot_content, snapshot_author_username, snapshot_author_display_name,
	snapshot_attachments, snapshot_message_edited_at, snapshot_purged_at, category, reason,
	status, claimed_by, claimed_at, acknowledged_at, idempotency_key, created_at`

func scanReport(row pgx.Row) (*models.Report, error) {
	var r models.Report
	if err := row.Scan(
		&r.ID, &r.ReporterID, &r.TargetUserID, &r.TargetMessageID, &r.TargetChannelID,
		&r.ServerID, &r.SnapshotContent, &r.SnapshotAuthorUsername, &r.SnapshotAuthorDisplayName,
		&r.SnapshotAttachments, &r.SnapshotMessageEditedAt, &r.SnapshotPurgedAt, &r.Category, &r.Reason,
		&r.Status, &r.ClaimedBy, &r.ClaimedAt, &r.AcknowledgedAt, &r.IdempotencyKey, &r.CreatedAt,
	); err != nil {
		return nil, err
	}
	return &r, nil
}

// CreateReport inserts a new report row.
// Returns ErrAlreadyExists if the partial-unique guard on
// (reporter_id, target_message_id) WHERE status='open' is hit, OR if the
// idempotency key collides with a prior request from the same reporter.
func (s *ReportStore) CreateReport(ctx context.Context, opts CreateReportOpts) (*models.Report, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	// Normalize empty strings to nil for nullable columns.
	nilIfEmpty := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	attachments := opts.SnapshotAttachments
	if len(attachments) == 0 {
		attachments = []byte("[]")
	}

	row := s.pool.QueryRow(ctx,
		`INSERT INTO reports (
			id, reporter_id, target_user_id, target_message_id, target_channel_id,
			server_id, snapshot_content, snapshot_author_username, snapshot_author_display_name,
			snapshot_attachments, snapshot_message_edited_at, category, reason, idempotency_key
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
		)
		RETURNING `+reportColumns,
		opts.ID,
		nilIfEmpty(opts.ReporterID),
		nilIfEmpty(opts.TargetUserID),
		nilIfEmpty(opts.TargetMessageID),
		nilIfEmpty(opts.TargetChannelID),
		nilIfEmpty(opts.ServerID),
		opts.SnapshotContent,
		opts.SnapshotAuthorUsername,
		opts.SnapshotAuthorDisplayName,
		attachments,
		opts.SnapshotMessageEditedAt,
		opts.Category,
		nilIfEmpty(opts.Reason),
		nilIfEmpty(opts.IdempotencyKey),
	)
	r, err := scanReport(row)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrAlreadyExists
		}
		return nil, fmt.Errorf("insert report: %w", err)
	}
	return r, nil
}

// GetReport fetches a single report by ID.
func (s *ReportStore) GetReport(ctx context.Context, id string) (*models.Report, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	row := s.pool.QueryRow(ctx, `SELECT `+reportColumns+` FROM reports WHERE id = $1`, id)
	r, err := scanReport(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get report: %w", err)
	}
	return r, nil
}

// ListReportsByServer returns reports scoped to a server, optionally filtered
// by status, with cursor-based pagination on (created_at DESC, id DESC).
func (s *ReportStore) ListReportsByServer(ctx context.Context, serverID, status, cursor string, limit int) ([]*models.Report, string, error) {
	return s.listReports(ctx, listReportsParams{
		ServerID:    &serverID,
		Status:      status,
		Cursor:      cursor,
		Limit:       limit,
		PlatformOnly: false,
	})
}

// ListPlatformReports returns reports with server_id IS NULL (platform queue),
// optionally filtered by status.
func (s *ReportStore) ListPlatformReports(ctx context.Context, status, cursor string, limit int) ([]*models.Report, string, error) {
	return s.listReports(ctx, listReportsParams{
		Status:       status,
		Cursor:       cursor,
		Limit:        limit,
		PlatformOnly: true,
	})
}

// ListReportsByReporter returns reports filed by a single reporter (for
// GDPR/audit export). Always returns all statuses.
func (s *ReportStore) ListReportsByReporter(ctx context.Context, reporterID, cursor string, limit int) ([]*models.Report, string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 50
	}
	args := []any{reporterID, limit + 1}
	where := "WHERE reporter_id = $1"
	if cursor != "" {
		ts, id, err := parseReportCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("parse cursor: %w", err)
		}
		where += " AND (created_at, id) < ($3, $4)"
		args = append(args, ts, id)
	}
	rows, err := s.pool.Query(ctx,
		`SELECT `+reportColumns+` FROM reports `+where+
			` ORDER BY created_at DESC, id DESC LIMIT $2`,
		args...,
	)
	if err != nil {
		return nil, "", fmt.Errorf("query reports by reporter: %w", err)
	}
	defer rows.Close()
	return collectReportsWithCursor(rows, limit)
}

type listReportsParams struct {
	ServerID     *string
	Status       string
	Cursor       string
	Limit        int
	PlatformOnly bool
}

func (s *ReportStore) listReports(ctx context.Context, p listReportsParams) ([]*models.Report, string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	if p.Limit <= 0 || p.Limit > 100 {
		p.Limit = 50
	}

	var (
		conds []string
		args  []any
	)
	idx := 1
	if p.PlatformOnly {
		conds = append(conds, "server_id IS NULL")
	} else if p.ServerID != nil {
		conds = append(conds, fmt.Sprintf("server_id = $%d", idx))
		args = append(args, *p.ServerID)
		idx++
	}
	if p.Status != "" {
		conds = append(conds, fmt.Sprintf("status = $%d", idx))
		args = append(args, p.Status)
		idx++
	}
	if p.Cursor != "" {
		ts, id, err := parseReportCursor(p.Cursor)
		if err != nil {
			return nil, "", fmt.Errorf("parse cursor: %w", err)
		}
		conds = append(conds, fmt.Sprintf("(created_at, id) < ($%d, $%d)", idx, idx+1))
		args = append(args, ts, id)
		idx += 2
	}
	args = append(args, p.Limit+1)
	limitArg := idx

	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	q := fmt.Sprintf(
		`SELECT %s FROM reports %s ORDER BY created_at DESC, id DESC LIMIT $%d`,
		reportColumns, where, limitArg,
	)
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, "", fmt.Errorf("query reports: %w", err)
	}
	defer rows.Close()
	return collectReportsWithCursor(rows, p.Limit)
}

func collectReportsWithCursor(rows pgx.Rows, limit int) ([]*models.Report, string, error) {
	var out []*models.Report
	for rows.Next() {
		r, err := scanReport(rows)
		if err != nil {
			return nil, "", fmt.Errorf("scan report: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("iterate reports: %w", err)
	}
	var nextCursor string
	if len(out) > limit {
		nextCursor = encodeReportCursor(out[limit-1].CreatedAt, out[limit-1].ID)
		out = out[:limit]
	}
	return out, nextCursor, nil
}

// ResolveReport atomically locks the report row, validates the transition,
// updates status, and appends an audit row. Returns ErrNotFound if the report
// does not exist. Returns a wrapped error containing "already" when the
// requested transition is invalid (caller maps to CodeFailedPrecondition).
func (s *ReportStore) ResolveReport(ctx context.Context, reportID, moderatorID, action, note string) (*models.Report, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin resolve tx: %w", err)
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx,
		`SELECT `+reportColumns+` FROM reports WHERE id = $1 FOR UPDATE`,
		reportID,
	)
	r, err := scanReport(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("lock report: %w", err)
	}

	// Validate the requested transition.
	var newStatus string
	switch action {
	case models.ReportActionResolved:
		if r.Status != models.ReportStatusOpen {
			return nil, fmt.Errorf("report already %s", r.Status)
		}
		newStatus = models.ReportStatusResolved
	case models.ReportActionDismissed:
		if r.Status != models.ReportStatusOpen {
			return nil, fmt.Errorf("report already %s", r.Status)
		}
		newStatus = models.ReportStatusDismissed
	case models.ReportActionReopen:
		if r.Status == models.ReportStatusOpen {
			return nil, fmt.Errorf("report already open")
		}
		newStatus = models.ReportStatusOpen
	default:
		return nil, fmt.Errorf("unknown action: %s", action)
	}

	// Update the report row.
	row = tx.QueryRow(ctx,
		`UPDATE reports
		 SET status = $2,
		     claimed_by = NULL,
		     claimed_at = NULL,
		     acknowledged_at = COALESCE(acknowledged_at, NOW())
		 WHERE id = $1
		 RETURNING `+reportColumns,
		reportID, newStatus,
	)
	r, err = scanReport(row)
	if err != nil {
		// Reopen of a row with a still-open duplicate guard would 23505 here.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrAlreadyExists
		}
		return nil, fmt.Errorf("update report status: %w", err)
	}

	// Append the audit row.
	var notePtr any
	if note != "" {
		notePtr = note
	}
	resolutionID := models.NewID()
	if _, err := tx.Exec(ctx,
		`INSERT INTO report_resolutions (id, report_id, moderator_id, action, note)
		 VALUES ($1, $2, $3, $4, $5)`,
		resolutionID, reportID, moderatorID, action, notePtr,
	); err != nil {
		return nil, fmt.Errorf("insert report resolution: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit resolve tx: %w", err)
	}
	return r, nil
}

// AcknowledgeReport sets acknowledged_at to NOW() if currently NULL.
// This is the SLA-tracking signal — first time a mod looks at a report.
func (s *ReportStore) AcknowledgeReport(ctx context.Context, reportID, moderatorID string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`UPDATE reports
		 SET acknowledged_at = NOW(), claimed_by = $2, claimed_at = NOW()
		 WHERE id = $1 AND acknowledged_at IS NULL`,
		reportID, moderatorID,
	)
	if err != nil {
		return fmt.Errorf("acknowledge report: %w", err)
	}
	return nil
}

// ListResolutions returns the append-only audit trail for a single report.
func (s *ReportStore) ListResolutions(ctx context.Context, reportID string) ([]*models.ReportResolution, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()

	rows, err := s.pool.Query(ctx,
		`SELECT id, report_id, moderator_id, action, note, created_at
		 FROM report_resolutions
		 WHERE report_id = $1
		 ORDER BY created_at`,
		reportID,
	)
	if err != nil {
		return nil, fmt.Errorf("query resolutions: %w", err)
	}
	defer rows.Close()

	var out []*models.ReportResolution
	for rows.Next() {
		var r models.ReportResolution
		if err := rows.Scan(&r.ID, &r.ReportID, &r.ModeratorID, &r.Action, &r.Note, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan resolution: %w", err)
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// Cursor helpers — RFC3339Nano timestamp + ULID joined by '|'.
func encodeReportCursor(ts time.Time, id string) string {
	return ts.UTC().Format(time.RFC3339Nano) + "|" + id
}

func parseReportCursor(c string) (time.Time, string, error) {
	parts := strings.SplitN(c, "|", 2)
	if len(parts) != 2 {
		return time.Time{}, "", errors.New("invalid cursor format")
	}
	ts, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, "", fmt.Errorf("invalid cursor timestamp: %w", err)
	}
	return ts, parts[1], nil
}
