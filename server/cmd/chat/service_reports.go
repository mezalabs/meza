package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"golang.org/x/text/unicode/norm"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/auth"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/permissions"
	"github.com/mezalabs/meza/internal/store"
)

func reasonString(r *string) string {
	if r == nil {
		return ""
	}
	return *r
}

// truncateRunes returns s truncated to at most maxRunes Unicode code points.
// Used for fields with rune-counted DB CHECK constraints (vs Go's byte slicing).
func truncateRunes(s string, maxRunes int) string {
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	count := 0
	for i := range s {
		if count == maxRunes {
			return s[:i]
		}
		count++
	}
	return s
}

// reportRateLimitScript matches the pattern in system_messages.go:62 — INCR a
// counter and set the TTL only on first increment, so the window is anchored
// to the first request rather than reset by every call.
const reportRateLimitScript = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`

const (
	reportGlobalLimitPerHour = 20
	reportPairLimitPerHour   = 5
	reportRateWindowSeconds  = 3600
)

// reportNotificationContent is the redacted body posted to a server's mod-log
// channel when a report is filed. Intentionally contains zero PII — no
// reporter ID, no target ID, no category, no message ID. Mods click through
// to the Reports panel for details. Renders as a banner via MESSAGE_TYPE_REPORT_FILED.
type reportNotificationContent struct {
	Message string `json:"message"`
}

// ReportMessage handles user-initiated reports against a chat message.
func (s *chatService) ReportMessage(ctx context.Context, req *connect.Request[v1.ReportMessageRequest]) (*connect.Response[v1.ReportMessageResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.MessageId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("message_id is required"))
	}
	category, err := categoryFromProto(req.Msg.Category)
	if err != nil {
		return nil, err
	}
	reason, err := sanitizeReason(req.Msg.Reason)
	if err != nil {
		return nil, err
	}

	// Resolve the message author and snapshot fields. We need to find the
	// channel before the snapshot read because Scylla messages are partitioned
	// by channel and we don't have the channel ID in the request. Rate
	// limiting happens after target resolution so we charge exactly once per
	// validated submission, with both the global and pair counters.
	channelID, err := s.findChannelForMessage(ctx, userID, req.Msg.MessageId)
	if err != nil {
		return nil, err
	}

	// Verify the reporter can read this channel — otherwise reporting becomes
	// an enumeration channel for snapshots from private channels.
	channel, isMember, err := s.chatStore.GetChannelAndCheckMembership(ctx, channelID, userID)
	if err != nil {
		slog.Error("report: channel access check", "err", err, "channel", channelID, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if channel == nil || !isMember {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("channel not found"))
	}

	msg, msgFetchErr := s.messageStore.GetMessage(ctx, channelID, req.Msg.MessageId)
	if msgFetchErr != nil && !errors.Is(msgFetchErr, store.ErrNotFound) {
		slog.Warn("report: message fetch failed, persisting placeholder", "err", msgFetchErr, "channel", channelID, "msg", req.Msg.MessageId)
	}

	// Build snapshot fields. If the message is gone (deleted, retention,
	// truly missing) we still accept the report with a placeholder.
	var (
		snapshotContent  = "[message no longer available]"
		authorUsername   = ""
		authorDisplay    = ""
		authorID         = ""
		editedAt         *time.Time
		attachments      = []byte("[]")
	)
	if msg != nil && !msg.Deleted {
		// Encrypted (E2EE) messages contain ciphertext bytes that may include
		// NULs and invalid UTF-8 — Postgres TEXT rejects both. Store a sentinel
		// instead so the rest of the report flow still works for E2EE channels.
		if msg.KeyVersion > 0 {
			snapshotContent = "[encrypted message]"
		} else {
			snapshotContent = truncateRunes(strings.ToValidUTF8(string(msg.EncryptedContent), ""), 8000)
		}
		authorID = msg.AuthorID
		if !msg.EditedAt.IsZero() {
			t := msg.EditedAt
			editedAt = &t
		}
		// Capture attachments as JSON metadata array of attachment IDs.
		if len(msg.AttachmentIDs) > 0 {
			if b, mErr := json.Marshal(msg.AttachmentIDs); mErr == nil {
				attachments = b
			}
		}
	}

	// Resolve the target user identity. Webhook-authored messages don't have
	// a users row; route to the webhook owner instead.
	targetUserID := authorID
	if targetUserID != "" && msg != nil && msg.Type == uint32(v1.MessageType_MESSAGE_TYPE_WEBHOOK) {
		webhook, whErr := s.webhookStore.GetWebhook(ctx, msg.AuthorID)
		if whErr == nil && webhook != nil {
			targetUserID = webhook.CreatedBy
			authorUsername = webhook.Name
			authorDisplay = webhook.Name
		}
	} else if targetUserID != "" && s.authStore != nil {
		if author, aErr := s.authStore.GetUserByID(ctx, targetUserID); aErr == nil && author != nil {
			authorUsername = author.Username
			authorDisplay = author.DisplayName
			if authorDisplay == "" {
				authorDisplay = author.Username
			}
		}
	}
	if targetUserID == "" {
		// Couldn't resolve target — fall back to the reporter as a sentinel,
		// which fails the self-report guard below. This is a degraded but
		// safe path for the rare case of a tombstoned message author.
		return nil, connect.NewError(connect.CodeNotFound, errors.New("target message not found"))
	}

	// Self-report and system-user guards (mirror service_block.go:29-34).
	if targetUserID == userID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot report yourself"))
	}
	if targetUserID == models.SystemUserID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot report system user"))
	}

	// Rate limit AFTER input validation so failed submissions don't burn the
	// reporter's budget. Charges global + pair counters exactly once.
	if err := s.checkReportRateLimits(ctx, userID, targetUserID); err != nil {
		return nil, err
	}

	// Determine routing: server scope vs platform queue.
	serverID := s.routeReport(ctx, userID, targetUserID, channel.ServerID, category)

	report, err := s.reportStore.CreateReport(ctx, store.CreateReportOpts{
		ID:                        models.NewID(),
		ReporterID:                userID,
		TargetUserID:              targetUserID,
		TargetMessageID:           req.Msg.MessageId,
		TargetChannelID:           channelID,
		ServerID:                  serverID,
		SnapshotContent:           snapshotContent,
		SnapshotAuthorUsername:    authorUsername,
		SnapshotAuthorDisplayName: authorDisplay,
		SnapshotAttachments:       attachments,
		SnapshotMessageEditedAt:   editedAt,
		Category:                  category,
		Reason:                    reasonString(reason),
	})
	if err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("you have already reported this message"))
		}
		slog.Error("report: create", "err", err, "reporter", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Best-effort mod-log notification (server context only, never platform).
	s.notifyServerOfReport(ctx, serverID)

	return connect.NewResponse(&v1.ReportMessageResponse{Report: reportToProto(report)}), nil
}

// ReportUser handles a user-initiated report directly against a user (e.g.,
// from the profile sheet) without a specific message context.
func (s *chatService) ReportUser(ctx context.Context, req *connect.Request[v1.ReportUserRequest]) (*connect.Response[v1.ReportUserResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("user_id is required"))
	}
	if req.Msg.UserId == userID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot report yourself"))
	}
	if req.Msg.UserId == models.SystemUserID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cannot report system user"))
	}
	category, err := categoryFromProto(req.Msg.Category)
	if err != nil {
		return nil, err
	}
	reason, err := sanitizeReason(req.Msg.Reason)
	if err != nil {
		return nil, err
	}

	// If a server context was supplied, the reporter must actually be in it.
	// Silently downgrading to platform queue would let bad actors flood the
	// platform admin queue with arbitrary user reports.
	if req.Msg.ServerId != "" {
		isMember, mErr := s.chatStore.IsMember(ctx, userID, req.Msg.ServerId)
		if mErr != nil {
			slog.Error("report user: server membership check", "err", mErr, "user", userID, "server", req.Msg.ServerId)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if !isMember {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("not a member of that server"))
		}
	}

	if err := s.checkReportRateLimits(ctx, userID, req.Msg.UserId); err != nil {
		return nil, err
	}

	// Capture the target user's display info for snapshot.
	authorUsername, authorDisplay := "", ""
	if s.authStore != nil {
		if u, uErr := s.authStore.GetUserByID(ctx, req.Msg.UserId); uErr == nil && u != nil {
			authorUsername = u.Username
			authorDisplay = u.DisplayName
			if authorDisplay == "" {
				authorDisplay = u.Username
			}
		}
	}

	serverID := s.routeReport(ctx, userID, req.Msg.UserId, req.Msg.ServerId, category)

	report, err := s.reportStore.CreateReport(ctx, store.CreateReportOpts{
		ID:                        models.NewID(),
		ReporterID:                userID,
		TargetUserID:              req.Msg.UserId,
		ServerID:                  serverID,
		SnapshotContent:           "",
		SnapshotAuthorUsername:    authorUsername,
		SnapshotAuthorDisplayName: authorDisplay,
		Category:                  category,
		Reason:                    reasonString(reason),
		IdempotencyKey:            req.Msg.IdempotencyKey,
	})
	if err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("you have already filed this report"))
		}
		slog.Error("report: create user", "err", err, "reporter", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	s.notifyServerOfReport(ctx, serverID)

	return connect.NewResponse(&v1.ReportUserResponse{Report: reportToProto(report)}), nil
}

// ListReports returns reports filtered by server scope and status. The caller
// must hold MANAGE_REPORTS in the requested server, or be a global Administrator
// for the platform queue (server_id == "").
func (s *chatService) ListReports(ctx context.Context, req *connect.Request[v1.ListReportsRequest]) (*connect.Response[v1.ListReportsResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}

	limit := int(req.Msg.Limit)
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	statusStr := statusFromProto(req.Msg.Status)

	var (
		reports    []*models.Report
		nextCursor string
		err        error
	)
	if req.Msg.ServerId == "" {
		// Platform queue: requires global Administrator.
		if !s.isPlatformAdministrator(ctx, userID) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("platform administrator required"))
		}
		reports, nextCursor, err = s.reportStore.ListPlatformReports(ctx, statusStr, req.Msg.Cursor, limit)
	} else {
		if err := s.requireMembership(ctx, userID, req.Msg.ServerId); err != nil {
			return nil, err
		}
		if _, _, _, pErr := s.requirePermission(ctx, userID, req.Msg.ServerId, permissions.ManageReports); pErr != nil {
			return nil, pErr
		}
		reports, nextCursor, err = s.reportStore.ListReportsByServer(ctx, req.Msg.ServerId, statusStr, req.Msg.Cursor, limit)
	}
	if err != nil {
		slog.Error("list reports", "err", err, "user", userID, "server", req.Msg.ServerId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	out := make([]*v1.Report, 0, len(reports))
	for _, r := range reports {
		out = append(out, reportToProto(r))
	}
	return connect.NewResponse(&v1.ListReportsResponse{Reports: out, NextCursor: nextCursor}), nil
}

// ResolveReport applies an action (resolve, dismiss, reopen) to a report.
func (s *chatService) ResolveReport(ctx context.Context, req *connect.Request[v1.ResolveReportRequest]) (*connect.Response[v1.ResolveReportResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user"))
	}
	if req.Msg.ReportId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("report_id is required"))
	}
	action, err := actionFromProto(req.Msg.Action)
	if err != nil {
		return nil, err
	}

	// Sanitize the optional note.
	var notePtr string
	if req.Msg.Note != "" {
		s, sErr := sanitizeReason(req.Msg.Note)
		if sErr != nil {
			return nil, sErr
		}
		if s != nil {
			notePtr = *s
		}
	}

	// Authorization: load the report and check that the caller can act on it.
	report, err := s.reportStore.GetReport(ctx, req.Msg.ReportId)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("report not found"))
		}
		slog.Error("resolve report: get", "err", err, "report", req.Msg.ReportId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if report.ServerID == nil {
		if !s.isPlatformAdministrator(ctx, userID) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("platform administrator required"))
		}
	} else {
		if err := s.requireMembership(ctx, userID, *report.ServerID); err != nil {
			return nil, err
		}
		if _, _, _, pErr := s.requirePermission(ctx, userID, *report.ServerID, permissions.ManageReports); pErr != nil {
			return nil, pErr
		}
	}

	updated, err := s.reportStore.ResolveReport(ctx, req.Msg.ReportId, userID, action, notePtr)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("report not found"))
		}
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("an open report already exists for this message"))
		}
		if errors.Is(err, store.ErrInvalidTransition) {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("report is not in a state that supports this action"))
		}
		slog.Error("resolve report", "err", err, "report", req.Msg.ReportId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	return connect.NewResponse(&v1.ResolveReportResponse{Report: reportToProto(updated)}), nil
}

// --- helpers ---

// checkReportRateLimits enforces a per-reporter global limit and (if target
// is set) a per-(reporter, target) pair limit. Mirrors the Lua INCR+EXPIRE-on-
// first pattern from system_messages.go and fails open on Redis errors.
func (s *chatService) checkReportRateLimits(ctx context.Context, reporterID, targetID string) error {
	if s.rdb == nil {
		return nil
	}
	keys := []struct {
		key   string
		limit int64
	}{
		{fmt.Sprintf("report:rate:global:%s", reporterID), reportGlobalLimitPerHour},
	}
	if targetID != "" {
		keys = append(keys, struct {
			key   string
			limit int64
		}{fmt.Sprintf("report:rate:pair:%s:%s", reporterID, targetID), reportPairLimitPerHour})
	}
	for _, k := range keys {
		count, err := s.rdb.Eval(ctx, reportRateLimitScript, []string{k.key}, reportRateWindowSeconds).Int64()
		if err != nil {
			slog.Warn("report rate limit check failed, allowing", "key", k.key, "err", err)
			continue
		}
		if count > k.limit {
			return connect.NewError(connect.CodeResourceExhausted, errors.New("too many reports; please try again later"))
		}
	}
	return nil
}

// findChannelForMessage walks the user's accessible channels to locate the
// channel that hosts the given message. Reports always come from a context
// where the user is currently looking at a channel, so we limit the search to
// channels they're a member of.
func (s *chatService) findChannelForMessage(ctx context.Context, userID, messageID string) (string, error) {
	channelIDs, err := s.chatStore.GetUserChannels(ctx, userID)
	if err != nil {
		slog.Error("report: get user channels", "err", err, "user", userID)
		return "", connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	for _, chID := range channelIDs {
		msg, mErr := s.messageStore.GetMessage(ctx, chID, messageID)
		if mErr == nil && msg != nil {
			return chID, nil
		}
	}
	return "", connect.NewError(connect.CodeNotFound, errors.New("message not found"))
}

// routeReport applies the routing rules: ILLEGAL category always to platform
// queue; reports against MANAGE_REPORTS holders bypass server queue; otherwise
// use the supplied server context if both reporter and target belong to it.
// Returns the routing server_id (empty string means platform queue).
func (s *chatService) routeReport(ctx context.Context, reporterID, targetUserID, serverID, category string) string {
	if category == models.ReportCategoryIllegal {
		return ""
	}
	if serverID == "" {
		return ""
	}
	// Both must be members of the server. The reporter is checked elsewhere
	// for ReportMessage (channel access guarantees membership), but for
	// ReportUser we may receive a server_id the reporter is not in — silently
	// downgrading to platform queue would let bad actors flood the platform
	// admin queue with arbitrary user reports, so we treat that as an error
	// at the call site instead. Here we only verify target membership.
	targetIsMember, err := s.chatStore.IsMember(ctx, targetUserID, serverID)
	if err != nil || !targetIsMember {
		return ""
	}
	// Carve-out: reports against MANAGE_REPORTS holders bypass server queue
	// to prevent mod-on-mod retaliation.
	if s.hasPermission(ctx, targetUserID, serverID, permissions.ManageReports) {
		return ""
	}
	return serverID
}

// notifyServerOfReport publishes a redacted system message to the server's
// configured mod-log channel, if one exists. Bypasses publishServerSystemMessage
// because that helper falls back to the default text channel and would leak
// reports into a public general channel.
func (s *chatService) notifyServerOfReport(ctx context.Context, serverID string) {
	if serverID == "" {
		return
	}
	cfg := s.getSystemMessageConfigCached(ctx, serverID)
	if cfg == nil || cfg.ModLogChannelID == nil || *cfg.ModLogChannelID == "" {
		return // no mod-log configured — fail silent, panel is source of truth
	}
	body := reportNotificationContent{
		Message: "A new report was filed. Open the Reports panel to review.",
	}
	if err := s.publishSystemMessage(ctx, *cfg.ModLogChannelID, uint32(v1.MessageType_MESSAGE_TYPE_REPORT_FILED), body); err != nil {
		slog.Warn("report: mod-log publish failed", "server", serverID, "err", err)
	}
}

// isPlatformAdministrator returns true if the user holds Administrator on at
// least one server they own. Meza has no global "platform admin" concept, so
// we approximate with "server owner of any server" via a presence check.
// In production this should be tightened to a dedicated platform_admins table
// or similar; for v1 we treat any user owning at least one server as eligible
// to view the platform queue. Documented in RUNBOOK_REPORTS.md.
func (s *chatService) isPlatformAdministrator(ctx context.Context, userID string) bool {
	servers, err := s.chatStore.ListAllServers(ctx)
	if err != nil {
		slog.Warn("platform admin check failed", "err", err, "user", userID)
		return false
	}
	for _, srv := range servers {
		if srv.OwnerID == userID {
			return true
		}
	}
	return false
}

// sanitizeReason strips control characters, bidi overrides, and zero-width
// characters; NFC-normalizes; and enforces a 1–1000 rune length bound.
// Returns nil for empty input (the reason field is optional).
func sanitizeReason(raw string) (*string, error) {
	if raw == "" {
		return nil, nil
	}
	// First normalize, then strip dangerous codepoints.
	normalized := norm.NFC.String(raw)
	var b strings.Builder
	b.Grow(len(normalized))
	for _, r := range normalized {
		// Control characters (C0/C1) except common whitespace.
		if r < 0x20 && r != '\n' && r != '\t' {
			continue
		}
		if r == 0x7F {
			continue
		}
		if r >= 0x80 && r <= 0x9F {
			continue
		}
		// Bidi overrides.
		if (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) {
			continue
		}
		// Zero-width characters.
		if r == 0x200B || r == 0x200C || r == 0x200D || r == 0xFEFF {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(out) > 1000 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("reason exceeds 1000 characters"))
	}
	return &out, nil
}

func categoryFromProto(c v1.ReportCategory) (string, error) {
	switch c {
	case v1.ReportCategory_REPORT_CATEGORY_SPAM:
		return models.ReportCategorySpam, nil
	case v1.ReportCategory_REPORT_CATEGORY_HARASSMENT:
		return models.ReportCategoryHarassment, nil
	case v1.ReportCategory_REPORT_CATEGORY_HATE:
		return models.ReportCategoryHate, nil
	case v1.ReportCategory_REPORT_CATEGORY_SEXUAL:
		return models.ReportCategorySexual, nil
	case v1.ReportCategory_REPORT_CATEGORY_VIOLENCE:
		return models.ReportCategoryViolence, nil
	case v1.ReportCategory_REPORT_CATEGORY_SELF_HARM:
		return models.ReportCategorySelfHarm, nil
	case v1.ReportCategory_REPORT_CATEGORY_ILLEGAL:
		return models.ReportCategoryIllegal, nil
	case v1.ReportCategory_REPORT_CATEGORY_OTHER:
		return models.ReportCategoryOther, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, errors.New("invalid category"))
	}
}

func categoryToProto(c string) v1.ReportCategory {
	switch c {
	case models.ReportCategorySpam:
		return v1.ReportCategory_REPORT_CATEGORY_SPAM
	case models.ReportCategoryHarassment:
		return v1.ReportCategory_REPORT_CATEGORY_HARASSMENT
	case models.ReportCategoryHate:
		return v1.ReportCategory_REPORT_CATEGORY_HATE
	case models.ReportCategorySexual:
		return v1.ReportCategory_REPORT_CATEGORY_SEXUAL
	case models.ReportCategoryViolence:
		return v1.ReportCategory_REPORT_CATEGORY_VIOLENCE
	case models.ReportCategorySelfHarm:
		return v1.ReportCategory_REPORT_CATEGORY_SELF_HARM
	case models.ReportCategoryIllegal:
		return v1.ReportCategory_REPORT_CATEGORY_ILLEGAL
	case models.ReportCategoryOther:
		return v1.ReportCategory_REPORT_CATEGORY_OTHER
	}
	return v1.ReportCategory_REPORT_CATEGORY_UNSPECIFIED
}

func statusFromProto(st v1.ReportStatus) string {
	switch st {
	case v1.ReportStatus_REPORT_STATUS_OPEN:
		return models.ReportStatusOpen
	case v1.ReportStatus_REPORT_STATUS_RESOLVED:
		return models.ReportStatusResolved
	case v1.ReportStatus_REPORT_STATUS_DISMISSED:
		return models.ReportStatusDismissed
	}
	return ""
}

func statusToProto(s string) v1.ReportStatus {
	switch s {
	case models.ReportStatusOpen:
		return v1.ReportStatus_REPORT_STATUS_OPEN
	case models.ReportStatusResolved:
		return v1.ReportStatus_REPORT_STATUS_RESOLVED
	case models.ReportStatusDismissed:
		return v1.ReportStatus_REPORT_STATUS_DISMISSED
	}
	return v1.ReportStatus_REPORT_STATUS_UNSPECIFIED
}

func actionFromProto(a v1.ResolveAction) (string, error) {
	switch a {
	case v1.ResolveAction_RESOLVE_ACTION_RESOLVE:
		return models.ReportActionResolved, nil
	case v1.ResolveAction_RESOLVE_ACTION_DISMISS:
		return models.ReportActionDismissed, nil
	case v1.ResolveAction_RESOLVE_ACTION_REOPEN:
		return models.ReportActionReopen, nil
	}
	return "", connect.NewError(connect.CodeInvalidArgument, errors.New("invalid action"))
}

func reportToProto(r *models.Report) *v1.Report {
	if r == nil {
		return nil
	}
	out := &v1.Report{
		Id:                        r.ID,
		SnapshotContent:           r.SnapshotContent,
		SnapshotAuthorUsername:    r.SnapshotAuthorUsername,
		SnapshotAuthorDisplayName: r.SnapshotAuthorDisplayName,
		Category:                  categoryToProto(r.Category),
		Status:                    statusToProto(r.Status),
		CreatedAt:                 timestamppb.New(r.CreatedAt),
	}
	if r.ReporterID != nil {
		out.ReporterId = *r.ReporterID
	}
	if r.TargetUserID != nil {
		out.TargetUserId = *r.TargetUserID
	}
	if r.TargetMessageID != nil {
		out.TargetMessageId = *r.TargetMessageID
	}
	if r.TargetChannelID != nil {
		out.TargetChannelId = *r.TargetChannelID
	}
	if r.ServerID != nil {
		out.ServerId = *r.ServerID
	}
	if r.Reason != nil {
		out.Reason = *r.Reason
	}
	if r.AcknowledgedAt != nil {
		out.AcknowledgedAt = timestamppb.New(*r.AcknowledgedAt)
	}
	return out
}
