package embed

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/mezalabs/meza/gen/meza/v1"
	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/store"
	"github.com/mezalabs/meza/internal/subjects"
)

// Worker processes embed fetch jobs from NATS.
type Worker struct {
	nc             *nats.Conn
	linkPreviewStore store.LinkPreviewStorer
	httpClient     *http.Client
}

// NewWorker creates an embed worker.
func NewWorker(nc *nats.Conn, lps store.LinkPreviewStorer) *Worker {
	return &Worker{
		nc:             nc,
		linkPreviewStore: lps,
		httpClient:     NewSafeClient(),
	}
}

// Start subscribes to the embed fetch queue and processes jobs.
// It returns after subscribing; the subscription runs in the background.
// Call the returned function to drain the subscription.
func (w *Worker) Start() (*nats.Subscription, error) {
	sub, err := w.nc.QueueSubscribe(subjects.EmbedFetch(), "embed-workers", func(msg *nats.Msg) {
		var job v1.EmbedFetchJob
		if err := proto.Unmarshal(msg.Data, &job); err != nil {
			slog.Error("unmarshal embed job", "err", err)
			return
		}
		w.processJob(context.Background(), &job)
	})
	if err != nil {
		return nil, fmt.Errorf("subscribe embed fetch: %w", err)
	}
	slog.Info("embed worker started")
	return sub, nil
}

func (w *Worker) processJob(ctx context.Context, job *v1.EmbedFetchJob) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var urlHashes []string
	var embeds []*v1.LinkEmbed

	for _, rawURL := range job.Urls {
		urlHash := hashURL(rawURL)

		// Check if we already have a non-expired preview.
		existing, err := w.linkPreviewStore.GetLinkPreviewsByHashes(ctx, []string{urlHash})
		if err != nil {
			slog.Error("check existing preview", "err", err, "url", rawURL)
		}
		if lp, ok := existing[urlHash]; ok && lp.ExpiresAt.After(time.Now()) {
			urlHashes = append(urlHashes, urlHash)
			embeds = append(embeds, linkPreviewToProto(lp))
			continue
		}

		// Fetch and parse.
		lp := w.fetchAndParse(ctx, rawURL, urlHash)
		if lp == nil {
			continue
		}

		// Store in Postgres.
		if err := w.linkPreviewStore.UpsertLinkPreview(ctx, lp); err != nil {
			slog.Error("store link preview", "err", err, "url", rawURL)
			continue
		}

		urlHashes = append(urlHashes, urlHash)
		embeds = append(embeds, linkPreviewToProto(lp))
	}

	if len(urlHashes) == 0 {
		return
	}

	// Associate previews with the message.
	if err := w.linkPreviewStore.SetMessageEmbeds(ctx, job.ChannelId, job.MessageId, urlHashes); err != nil {
		slog.Error("set message embeds", "err", err, "channel", job.ChannelId, "message", job.MessageId)
		return
	}

	// Publish EMBEDS_UPDATE event.
	w.publishEmbedsUpdate(job.ChannelId, job.MessageId, embeds)
}

func (w *Worker) fetchAndParse(ctx context.Context, rawURL, urlHash string) *models.LinkPreview {
	resp, err := FetchHTML(ctx, w.httpClient, rawURL)
	if err != nil {
		slog.Debug("fetch URL failed", "url", rawURL, "err", err)
		return nil
	}
	defer resp.Body.Close()

	og, err := ParseOG(resp.Body)
	if err != nil {
		slog.Debug("parse OG failed", "url", rawURL, "err", err)
		return nil
	}

	// Skip if we got nothing useful.
	if og.Title == "" && og.Description == "" {
		return nil
	}

	now := time.Now()
	return &models.LinkPreview{
		URLHash:     urlHash,
		URL:         rawURL,
		Title:       og.Title,
		Description: og.Description,
		SiteName:    og.SiteName,
		OGType:      og.OGType,
		// ImageKey is set later during image proxying (Phase 2).
		FetchedAt: now,
		ExpiresAt: now.Add(24 * time.Hour),
	}
}

func (w *Worker) publishEmbedsUpdate(channelID, messageID string, embeds []*v1.LinkEmbed) {
	event := &v1.Event{
		Id:        models.NewID(),
		Type:      v1.EventType_EVENT_TYPE_EMBEDS_UPDATE,
		Timestamp: timestamppb.Now(),
		Payload: &v1.Event_EmbedsUpdate{
			EmbedsUpdate: &v1.EmbedsUpdateEvent{
				ChannelId: channelID,
				MessageId: messageID,
				Embeds:    embeds,
			},
		},
	}
	data, err := proto.Marshal(event)
	if err != nil {
		slog.Error("marshal embeds update event", "err", err)
		return
	}
	if err := w.nc.Publish(subjects.DeliverChannel(channelID), data); err != nil {
		slog.Error("publish embeds update", "err", err, "channel", channelID)
	}
}

func hashURL(rawURL string) string {
	h := sha256.Sum256([]byte(rawURL))
	return hex.EncodeToString(h[:])
}

func linkPreviewToProto(lp *models.LinkPreview) *v1.LinkEmbed {
	embed := &v1.LinkEmbed{
		Url:         lp.URL,
		Title:       lp.Title,
		Description: lp.Description,
		SiteName:    lp.SiteName,
		OgType:      lp.OGType,
		Domain:      DomainFromURL(lp.URL),
	}
	if lp.ImageKey != "" {
		embed.ImageUrl = "/media/" + lp.ImageKey
		embed.ImageWidth = int32(lp.ImageWidth)
		embed.ImageHeight = int32(lp.ImageHeight)
	}
	if lp.FaviconKey != "" {
		embed.FaviconUrl = "/media/" + lp.FaviconKey
	}
	return embed
}

// LinkPreviewsToProto converts a slice of models to proto embeds (for hydration).
func LinkPreviewsToProto(previews []*models.LinkPreview) []*v1.LinkEmbed {
	embeds := make([]*v1.LinkEmbed, len(previews))
	for i, lp := range previews {
		embeds[i] = linkPreviewToProto(lp)
	}
	return embeds
}
