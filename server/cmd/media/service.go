package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/meza-chat/meza/gen/meza/v1"
	"github.com/meza-chat/meza/internal/auth"
	"github.com/meza-chat/meza/internal/imaging"
	"github.com/meza-chat/meza/internal/models"
	"github.com/meza-chat/meza/internal/s3"
	"github.com/meza-chat/meza/internal/store"
)

const (
	maxPendingUploads  = 10
	presignExpiry      = 15 * time.Minute
	uploadExpiry       = 2 * time.Hour // time before cleanup considers a pending upload orphaned
	downloadExpiry     = 1 * time.Hour
	processingTimeout  = 2 * time.Minute
	maxFileSize        = 50 * 1024 * 1024 // 50 MB
	cleanupInterval    = 5 * time.Minute
	cleanupBatchSize   = 100
)

const maxSoundboardFileSize = 2 * 1024 * 1024 // 2 MB

// imageProcessingSem limits concurrent image processing to prevent OOM from
// govips C memory allocations that bypass Go's GC.
var imageProcessingSem = make(chan struct{}, 4)

// allowedContentTypes is the set of content types accepted for upload.
var allowedContentTypes = map[string]bool{
	// Images
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
	// Video
	"video/mp4":  true,
	"video/webm": true,
	// Documents & files
	"application/pdf": true,
	"application/zip": true,
	"text/plain":      true,
	"audio/mpeg":      true,
	"audio/ogg":       true,
	"audio/wav":       true,
}

// isInlineContentType returns true for content types that are safe to render
// inline in the browser (images and videos). All other types use
// Content-Disposition: attachment to force a download.
func isInlineContentType(contentType string) bool {
	return strings.HasPrefix(contentType, "image/") || strings.HasPrefix(contentType, "video/")
}

// allowedAudioBaseTypes maps MIME base types (without parameters like ;codecs=opus)
// to acceptance. Includes all known browser-reported variants per format:
//   MP3: audio/mpeg (Firefox/Safari), audio/mp3 (Chrome/Edge — Chromium bug #227004)
//   OGG: audio/ogg (Chrome), video/ogg (Firefox — bug #1240259), application/ogg (generic)
//   WAV: audio/wav (Chrome), audio/x-wav (Linux), audio/wave (IE), audio/vnd.wave (Safari)
//   WebM: audio/webm (all), video/webm (some OS MIME databases)
var allowedAudioBaseTypes = map[string]bool{
	"audio/mpeg":        true,
	"audio/mp3":         true,
	"audio/ogg":         true,
	"video/ogg":         true,
	"application/ogg":   true,
	"audio/wav":         true,
	"audio/x-wav":       true,
	"audio/wave":        true,
	"audio/vnd.wave":    true,
	"audio/webm":        true,
	"video/webm":        true,
}

// isAllowedAudioType checks if a content type (possibly with parameters like
// ";codecs=opus") matches an allowed audio base type.
func isAllowedAudioType(contentType string) bool {
	base, _, _ := strings.Cut(contentType, ";")
	return allowedAudioBaseTypes[strings.TrimSpace(base)]
}

// detectAudioType uses magic byte signatures to identify audio formats.
// Returns the MIME type and true if recognized, or ("", false) otherwise.
func detectAudioType(data []byte) (string, bool) {
	if len(data) < 12 {
		return "", false
	}
	// MP3: ID3v2 header
	if data[0] == 'I' && data[1] == 'D' && data[2] == '3' {
		return "audio/mpeg", true
	}
	// MP3: MPEG sync word
	if data[0] == 0xFF && (data[1]&0xE0) == 0xE0 {
		return "audio/mpeg", true
	}
	// OGG: "OggS" magic
	if data[0] == 'O' && data[1] == 'g' && data[2] == 'g' && data[3] == 'S' {
		return "audio/ogg", true
	}
	// WAV: "RIFF....WAVE"
	if data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F' &&
		data[8] == 'W' && data[9] == 'A' && data[10] == 'V' && data[11] == 'E' {
		return "audio/wav", true
	}
	// WebM/Matroska: EBML header
	if data[0] == 0x1A && data[1] == 0x45 && data[2] == 0xDF && data[3] == 0xA3 {
		return "audio/webm", true
	}
	return "", false
}

type mediaService struct {
	store   store.MediaStorer
	access  store.MediaAccessChecker
	s3      *s3.Client // internal operations (PutObject, GetObject, etc.)
	s3Public *s3.Client // presigned URL generation (client-facing)
}

func newMediaService(st store.MediaStorer, ac store.MediaAccessChecker, s3Client, s3Public *s3.Client) *mediaService {
	return &mediaService{store: st, access: ac, s3: s3Client, s3Public: s3Public}
}

func purposeToString(p v1.UploadPurpose) string {
	switch p {
	case v1.UploadPurpose_UPLOAD_PURPOSE_PROFILE_AVATAR:
		return "profile_avatar"
	case v1.UploadPurpose_UPLOAD_PURPOSE_PROFILE_BANNER:
		return "profile_banner"
	case v1.UploadPurpose_UPLOAD_PURPOSE_SERVER_ICON:
		return "server_icon"
	case v1.UploadPurpose_UPLOAD_PURPOSE_SERVER_EMOJI:
		return "server_emoji"
	case v1.UploadPurpose_UPLOAD_PURPOSE_SOUNDBOARD:
		return "soundboard"
	default:
		return "chat_attachment"
	}
}

// detectedTypeAliases maps http.DetectContentType output to our canonical types.
var detectedTypeAliases = map[string]string{
	"application/ogg": "audio/ogg",
}

func normalizeDetectedType(detected string) string {
	// Strip parameters (e.g. "text/plain; charset=utf-8" -> "text/plain")
	if idx := strings.IndexByte(detected, ';'); idx != -1 {
		detected = strings.TrimSpace(detected[:idx])
	}
	if mapped, ok := detectedTypeAliases[detected]; ok {
		return mapped
	}
	return detected
}

// sanitizeFilename strips path components and null bytes from a user-supplied
// filename, preventing path traversal in S3 object keys and header injection
// in Content-Disposition headers.
func sanitizeFilename(name string) string {
	// Take only the base name (strips directory components like ../ or /).
	name = filepath.Base(name)
	// filepath.Base returns "." for empty input.
	if name == "." || name == "" {
		return "upload"
	}
	// Strip null bytes and control characters.
	var b strings.Builder
	for _, r := range name {
		if r > 31 && r != 127 && r != '"' && r != '\\' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "upload"
	}
	return b.String()
}

func (s *mediaService) CreateUpload(ctx context.Context, req *connect.Request[v1.CreateUploadRequest]) (*connect.Response[v1.CreateUploadResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	r := req.Msg
	if r.Filename == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("filename is required"))
	}
	r.Filename = sanitizeFilename(r.Filename)

	isChatAttachment := r.Purpose == v1.UploadPurpose_UPLOAD_PURPOSE_CHAT_ATTACHMENT
	isSoundboard := r.Purpose == v1.UploadPurpose_UPLOAD_PURPOSE_SOUNDBOARD
	if isSoundboard {
		if !isAllowedAudioType(r.ContentType) {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("unsupported audio type; allowed formats: mp3, ogg, wav, webm"))
		}
	} else if isChatAttachment {
		// Chat attachments are always encrypted client-side: content_type is
		// application/octet-stream and the real MIME type is in original_content_type.
		// Skip content-type validation — the server sees opaque ciphertext.
	} else {
		if !allowedContentTypes[r.ContentType] {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("unsupported content type"))
		}
	}

	sizeLimit := int64(maxFileSize)
	if isSoundboard {
		sizeLimit = maxSoundboardFileSize
	}
	if r.SizeBytes <= 0 || r.SizeBytes > sizeLimit {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("size_bytes must be between 1 and %d", sizeLimit))
	}

	// Enforce per-user pending upload cap.
	count, err := s.store.CountPendingByUploader(ctx, userID)
	if err != nil {
		slog.Error("counting pending uploads", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if count >= maxPendingUploads {
		return nil, connect.NewError(connect.CodeResourceExhausted, errors.New("too many pending uploads"))
	}

	purpose := purposeToString(r.Purpose)
	attachmentID := models.NewID()
	objectKey := fmt.Sprintf("uploads/%s/%s/%s", userID, attachmentID, r.Filename)

	// For encrypted chat attachments, pre-generate the thumbnail S3 key.
	var thumbnailKey string
	if isChatAttachment {
		thumbnailKey = fmt.Sprintf("uploads/%s/%s/thumb.enc", userID, attachmentID)
	}

	now := time.Now()
	expiresAt := now.Add(uploadExpiry)
	attachment := &models.Attachment{
		ID:                  attachmentID,
		UploaderID:          userID,
		UploadPurpose:       purpose,
		ObjectKey:           objectKey,
		ThumbnailKey:        thumbnailKey,
		Filename:            r.Filename,
		ContentType:         r.ContentType,
		OriginalContentType: r.OriginalContentType,
		SizeBytes:           r.SizeBytes,
		Status:              models.AttachmentStatusPending,
		CreatedAt:           now,
		UpdatedAt:           now,
		ExpiresAt:           &expiresAt,
	}

	attachment, err = s.store.CreateAttachment(ctx, attachment)
	if err != nil {
		slog.Error("creating attachment", "err", err, "user", userID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	uploadURL, err := s.s3Public.GeneratePresignedPUT(ctx, objectKey, r.ContentType, presignExpiry)
	if err != nil {
		slog.Error("generating presigned PUT", "err", err, "key", objectKey)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	resp := &v1.CreateUploadResponse{
		UploadId:  attachment.ID,
		UploadUrl: uploadURL,
	}

	// Generate a second presigned PUT URL for the encrypted thumbnail.
	if isChatAttachment && thumbnailKey != "" {
		thumbURL, err := s.s3Public.GeneratePresignedPUT(ctx, thumbnailKey, "application/octet-stream", presignExpiry)
		if err != nil {
			slog.Error("generating thumbnail presigned PUT", "err", err, "key", thumbnailKey)
			// Non-fatal: attachment can still be created without thumbnail.
		} else {
			resp.ThumbnailUploadUrl = thumbURL
		}
	}

	return connect.NewResponse(resp), nil
}

func (s *mediaService) CompleteUpload(ctx context.Context, req *connect.Request[v1.CompleteUploadRequest]) (*connect.Response[v1.CompleteUploadResponse], error) {
	// Cap total processing time to prevent hung goroutines from malformed images.
	ctx, cancel := context.WithTimeout(ctx, processingTimeout)
	defer cancel()

	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.UploadId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("upload_id is required"))
	}

	// Atomically transition pending -> processing (prevents double-complete).
	attachment, err := s.store.TransitionToProcessing(ctx, req.Msg.UploadId, userID)
	if err != nil {
		slog.Error("transitioning to processing", "err", err, "upload", req.Msg.UploadId)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if attachment == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("upload not found or already completed"))
	}

	var actualSize int64
	var detectedType string
	var thumbnailKey string
	var microThumbnailData string
	var width, height int

	if attachment.UploadPurpose == "chat_attachment" && len(req.Msg.EncryptedKey) > 0 {
		// Encrypted chat attachment: server is a dumb blob store.
		// Skip all content inspection — the bytes are opaque ciphertext.
		objectSize, sErr := s.s3.StatObject(ctx, attachment.ObjectKey)
		if sErr != nil {
			slog.Error("stat encrypted object", "err", sErr, "key", attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("file not found in storage"))
		}
		if objectSize > maxFileSize+1024 { // Allow small overhead for AES-GCM nonce + tag
			slog.Warn("encrypted upload exceeds max size", "size", objectSize, "max", maxFileSize, "upload", attachment.ID)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("uploaded file size %d exceeds maximum", objectSize))
		}
		actualSize = objectSize
		// Use the original content type stored at creation time.
		detectedType = attachment.OriginalContentType
		if detectedType == "" {
			detectedType = attachment.ContentType
		}
		// Trust client-provided dimensions.
		width = int(req.Msg.Width)
		height = int(req.Msg.Height)
		// Thumbnail key was pre-generated at CreateUpload time.
		// Verify the client actually uploaded a thumbnail before claiming it exists.
		if attachment.ThumbnailKey != "" {
			if _, sErr := s.s3.StatObject(ctx, attachment.ThumbnailKey); sErr == nil {
				thumbnailKey = attachment.ThumbnailKey
			}
		}
	} else if attachment.UploadPurpose == "soundboard" {
		// Soundboard audio path: download full file, enforce 2MB limit, magic byte detection.
		imageData, err := s.s3.GetObject(ctx, attachment.ObjectKey)
		if err != nil {
			slog.Error("downloading object", "err", err, "key", attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("file not found in storage"))
		}

		actualSize = int64(len(imageData))
		if actualSize > maxSoundboardFileSize {
			slog.Warn("uploaded file exceeds max size", "size", actualSize, "max", int64(maxSoundboardFileSize), "upload", attachment.ID)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("uploaded file size %d exceeds maximum %d", actualSize, maxSoundboardFileSize))
		}

		audioType, ok := detectAudioType(imageData)
		if !ok || !allowedAudioBaseTypes[audioType] {
			slog.Warn("rejected upload: not a recognized audio format", "upload", attachment.ID)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("file content does not match an allowed audio type"))
		}
		detectedType = audioType
	} else if strings.HasPrefix(attachment.ContentType, "image/") {
		// Acquire image processing semaphore to limit concurrent govips operations.
		select {
		case imageProcessingSem <- struct{}{}:
			defer func() { <-imageProcessingSem }()
		case <-ctx.Done():
			return nil, connect.NewError(connect.CodeDeadlineExceeded, errors.New("image processing queue full"))
		}

		// Image path: download full file, validate, process with govips.
		imageData, err := s.s3.GetObject(ctx, attachment.ObjectKey)
		if err != nil {
			slog.Error("downloading object", "err", err, "key", attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("file not found in storage"))
		}

		actualSize = int64(len(imageData))
		if actualSize > maxFileSize {
			slog.Warn("uploaded file exceeds max size", "size", actualSize, "max", maxFileSize, "upload", attachment.ID)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("uploaded file size %d exceeds maximum %d", actualSize, maxFileSize))
		}

		detectedType = normalizeDetectedType(http.DetectContentType(imageData))
		if !allowedContentTypes[detectedType] {
			slog.Warn("rejected upload: content type mismatch", "declared", attachment.ContentType, "detected", detectedType, "upload", attachment.ID)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("file content does not match an allowed type"))
		}

		// Process image (resize + thumbnail).
		result, err := imaging.Process(imageData, attachment.UploadPurpose)
		if err != nil {
			slog.Error("processing image", "err", err, "upload", attachment.ID)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("image processing failed"))
		}

		if result != nil {
			width = result.Width
			height = result.Height

			if result.Thumbnail != nil {
				thumbnailKey = strings.TrimSuffix(attachment.ObjectKey, "/"+attachment.Filename) + "/thumb.webp"
				if err := s.s3.PutObject(ctx, thumbnailKey, result.Thumbnail, "image/webp"); err != nil {
					slog.Error("uploading thumbnail", "err", err, "key", thumbnailKey)
					thumbnailKey = ""
				}
			}

			if result.MicroThumbnail != nil {
				microThumbnailData = base64.StdEncoding.EncodeToString(result.MicroThumbnail)
			}
		}
	} else {
		// Non-image path: fetch only first 512 bytes for magic-byte validation.
		header, err := s.s3.GetObjectRange(ctx, attachment.ObjectKey, 0, 512)
		if err != nil {
			slog.Error("downloading object header", "err", err, "key", attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("file not found in storage"))
		}

		detectedType = normalizeDetectedType(http.DetectContentType(header))
		if !allowedContentTypes[detectedType] {
			slog.Warn("rejected upload: content type mismatch", "declared", attachment.ContentType, "detected", detectedType, "upload", attachment.ID)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("file content does not match an allowed type"))
		}

		// Verify actual object size matches declared size.
		objectSize, sErr := s.s3.StatObject(ctx, attachment.ObjectKey)
		if sErr != nil {
			slog.Error("stat object for size check", "err", sErr, "key", attachment.ObjectKey)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if objectSize > maxFileSize {
			slog.Warn("uploaded file exceeds max size", "size", objectSize, "max", maxFileSize, "upload", attachment.ID)
			_ = s.s3.DeleteObject(ctx, attachment.ObjectKey)
			_ = s.store.DeleteAttachment(ctx, attachment.ID)
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("uploaded file size %d exceeds maximum %d", objectSize, maxFileSize))
		}
		actualSize = objectSize
	}

	if err := s.store.UpdateAttachmentCompleted(ctx, attachment.ID, actualSize, detectedType, width, height, thumbnailKey, microThumbnailData, req.Msg.EncryptedKey); err != nil {
		slog.Error("marking attachment completed", "err", err, "upload", attachment.ID)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Generate download URL.
	downloadURL, err := s.s3Public.GeneratePresignedGET(ctx, attachment.ObjectKey, attachment.Filename, downloadExpiry, isInlineContentType(detectedType))
	if err != nil {
		slog.Error("generating download URL", "err", err, "key", attachment.ObjectKey)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	var microThumbBytes []byte
	if microThumbnailData != "" {
		microThumbBytes, _ = base64.StdEncoding.DecodeString(microThumbnailData)
	}

	return connect.NewResponse(&v1.CompleteUploadResponse{
		AttachmentId:   attachment.ID,
		Url:            downloadURL,
		HasThumbnail:   thumbnailKey != "",
		Width:          int32(width),
		Height:         int32(height),
		MicroThumbnail: microThumbBytes,
	}), nil
}

func (s *mediaService) GetDownloadURL(ctx context.Context, req *connect.Request[v1.GetDownloadURLRequest]) (*connect.Response[v1.GetDownloadURLResponse], error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
	}

	if req.Msg.AttachmentId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("attachment_id is required"))
	}

	attachment, err := s.store.GetAttachment(ctx, req.Msg.AttachmentId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("attachment not found"))
	}
	if attachment.Status != models.AttachmentStatusCompleted {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("attachment is not ready"))
	}

	if err := s.access.CheckAttachmentAccess(ctx, attachment, userID); err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("attachment not found"))
	}

	objectKey := attachment.ObjectKey
	filename := attachment.Filename
	if req.Msg.Thumbnail && attachment.ThumbnailKey != "" {
		objectKey = attachment.ThumbnailKey
		filename = "thumb.webp"
	}

	downloadURL, err := s.s3Public.GeneratePresignedGET(ctx, objectKey, filename, downloadExpiry, isInlineContentType(attachment.ContentType))
	if err != nil {
		slog.Error("generating download URL", "err", err, "key", objectKey)
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	return connect.NewResponse(&v1.GetDownloadURLResponse{
		Url: downloadURL,
	}), nil
}

// mediaRedirectHandler serves GET /media/{id} and /media/{id}/thumb as a
// 302 redirect to a fresh presigned URL. This provides stable URLs for
// avatars, banners, etc.
func mediaRedirectHandler(st store.MediaStorer, ac store.MediaAccessChecker, s3Public *s3.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Parse path: /media/{id} or /media/{id}/thumb
		path := strings.TrimPrefix(r.URL.Path, "/media/")
		if path == "" {
			http.NotFound(w, r)
			return
		}

		var attachmentID string
		var wantThumb bool
		if strings.HasSuffix(path, "/thumb") {
			attachmentID = strings.TrimSuffix(path, "/thumb")
			wantThumb = true
		} else {
			attachmentID = path
		}

		attachment, err := st.GetAttachment(r.Context(), attachmentID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if attachment.Status != models.AttachmentStatusCompleted {
			http.Error(w, "attachment not ready", http.StatusNotFound)
			return
		}

		// Verify the authenticated user has access to this attachment.
		userID, ok := auth.UserIDFromContext(r.Context())
		if !ok {
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		if err := ac.CheckAttachmentAccess(r.Context(), attachment, userID); err != nil {
			http.NotFound(w, r)
			return
		}

		objectKey := attachment.ObjectKey
		filename := attachment.Filename
		if wantThumb && attachment.ThumbnailKey != "" {
			objectKey = attachment.ThumbnailKey
			filename = "thumb.webp"
		}

		downloadURL, err := s3Public.GeneratePresignedGET(r.Context(), objectKey, filename, downloadExpiry, isInlineContentType(attachment.ContentType))
		if err != nil {
			slog.Error("generating redirect URL", "err", err, "key", objectKey)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Cache-Control", "private, max-age=600")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.Redirect(w, r, downloadURL, http.StatusFound)
	}
}


// startCleanup runs a background goroutine that periodically removes orphaned
// uploads (pending/processing with expired expires_at).
func startCleanup(ctx context.Context, st store.MediaStorer, s3Client *s3.Client) {
	ticker := time.NewTicker(cleanupInterval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cleanupOrphans(ctx, st, s3Client)
			}
		}
	}()
}

// unlinkedGracePeriod is how long a completed attachment can remain unlinked
// (not referenced by any message) before cleanup considers it abandoned.
const unlinkedGracePeriod = 24 * time.Hour

func cleanupOrphans(ctx context.Context, st store.MediaStorer, s3Client *s3.Client) {
	orphans, err := st.FindOrphanedUploads(ctx, time.Now(), cleanupBatchSize)
	if err != nil {
		slog.Error("finding orphaned uploads", "err", err)
		return
	}

	// Also find completed chat attachments that were never linked to a message.
	unlinked, err := st.FindUnlinkedAttachments(ctx, time.Now().Add(-unlinkedGracePeriod), cleanupBatchSize)
	if err != nil {
		slog.Error("finding unlinked attachments", "err", err)
	} else {
		orphans = append(orphans, unlinked...)
	}

	for _, a := range orphans {
		if a.ObjectKey != "" {
			if err := s3Client.DeleteObject(ctx, a.ObjectKey); err != nil {
				slog.Error("deleting orphan object", "err", err, "key", a.ObjectKey)
			}
			// Also try to delete the derived thumbnail key deterministically.
			// If the server crashed between uploading a thumbnail and persisting
			// thumbnail_key in Postgres, only this derived path will catch the leak.
			derivedThumbKey := strings.TrimSuffix(a.ObjectKey, "/"+filepath.Base(a.ObjectKey)) + "/thumb.webp"
			if derivedThumbKey != a.ThumbnailKey {
				_ = s3Client.DeleteObject(ctx, derivedThumbKey)
			}
		}
		if a.ThumbnailKey != "" {
			if err := s3Client.DeleteObject(ctx, a.ThumbnailKey); err != nil {
				slog.Error("deleting orphan thumbnail", "err", err, "key", a.ThumbnailKey)
			}
		}
		if err := st.DeleteAttachment(ctx, a.ID); err != nil {
			slog.Error("deleting orphan record", "err", err, "id", a.ID)
		}
	}

	if len(orphans) > 0 {
		slog.Info("cleaned up orphaned uploads", "count", len(orphans))
	}
}
