package http_server

import (
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/log"
	"github.com/gin-gonic/gin"
	"hmans.de/chatto/internal/core"
)

const (
	// maxWebhookAttachments bounds how many files one inbound post may carry.
	maxWebhookAttachments = 10
	// maxWebhookRequestBytes caps the whole inbound request body (content plus
	// any multipart file parts) to bound resource use on an unauthenticated path.
	maxWebhookRequestBytes = 25 << 20 // 25 MiB
	// webhookRateWindow / webhookRateLimit define a per-webhook fixed-window
	// rate limit. Best-effort and per-replica: it mitigates abuse, it is not a
	// cross-replica correctness invariant.
	webhookRateWindow = 10 * time.Second
	webhookRateLimit  = 30
)

// channelWebhookLimiter is a process-local, per-webhook fixed-window rate
// limiter for the unauthenticated inbound webhook endpoint.
var channelWebhookLimiter = &webhookRateLimiter{windows: map[string]*rateWindow{}}

type rateWindow struct {
	start time.Time
	count int
}

type webhookRateLimiter struct {
	mu      sync.Mutex
	windows map[string]*rateWindow
}

// allow reports whether a request for id is permitted at time now, advancing the
// window counter. It also prunes stale windows opportunistically.
func (l *webhookRateLimiter) allow(id string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, w := range l.windows {
		if now.Sub(w.start) >= webhookRateWindow {
			delete(l.windows, key)
		}
	}
	w := l.windows[id]
	if w == nil {
		l.windows[id] = &rateWindow{start: now, count: 1}
		return true
	}
	if w.count >= webhookRateLimit {
		return false
	}
	w.count++
	return true
}

// webhookPayload is the JSON body (or multipart payload_json field) accepted by
// the inbound endpoint. It mirrors the Discord incoming-webhook shape.
type webhookPayload struct {
	Content   string `json:"content"`
	Username  string `json:"username"`
	AvatarURL string `json:"avatar_url"`
}

// authorizeInboundWebhook validates the URL token and applies the per-webhook rate
// limit, writing the error response itself. It reports ok=false when the caller
// should stop. Shared by every inbound webhook route (plain and /github) so their
// authorization and abuse controls cannot drift apart.
func (s *HTTPServer) authorizeInboundWebhook(c *gin.Context, logger *log.Logger) (*core.Webhook, bool) {
	ctx := c.Request.Context()

	webhookID := c.Param("webhookId")
	token := c.Param("token")

	webhook, err := s.core.ValidateWebhookToken(ctx, webhookID, token)
	if err != nil {
		switch {
		case errors.Is(err, core.ErrWebhookDisabled):
			c.JSON(http.StatusForbidden, gin.H{"error": "webhook disabled"})
		case errors.Is(err, core.ErrWebhookNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "webhook not found"})
		default:
			logger.Error("Failed to validate webhook token", "webhook_id", webhookID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		}
		return nil, false
	}

	if !channelWebhookLimiter.allow(webhook.ID, time.Now()) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "rate limited"})
		return nil, false
	}

	return webhook, true
}

// handleChannelWebhook accepts an inbound channel-webhook post. Authorization is
// the webhook token in the URL; no user session is involved (FDR-902).
func (s *HTTPServer) handleChannelWebhook(c *gin.Context) {
	logger := log.WithPrefix("webhook.channel")
	ctx := c.Request.Context()

	webhook, ok := s.authorizeInboundWebhook(c, logger)
	if !ok {
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxWebhookRequestBytes)

	payload, assetIDs, err := s.parseWebhookRequest(c, webhook)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if strings.TrimSpace(payload.Content) == "" && len(assetIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "message must have content or attachments"})
		return
	}

	event, err := s.core.PostWebhookMessage(ctx, webhook, payload.Content, payload.Username, payload.AvatarURL, assetIDs)
	if err != nil {
		if errors.Is(err, core.ErrMessageTooLong) || errors.Is(err, core.ErrRoomArchived) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		logger.Error("Failed to post webhook message", "webhook_id", webhook.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to post message"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message_id": event.GetId()})
}

// parseWebhookRequest reads the content/override payload and, for multipart
// requests, uploads file parts as attachments authored by the webhook user.
func (s *HTTPServer) parseWebhookRequest(c *gin.Context, webhook *core.Webhook) (webhookPayload, []string, error) {
	var payload webhookPayload

	contentType := c.ContentType()
	if !strings.HasPrefix(contentType, "multipart/form-data") {
		if err := json.NewDecoder(c.Request.Body).Decode(&payload); err != nil {
			return payload, nil, errors.New("invalid JSON body")
		}
		return payload, nil, nil
	}

	form, err := c.MultipartForm()
	if err != nil {
		return payload, nil, errors.New("invalid multipart form")
	}
	if raw := c.PostForm("payload_json"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return payload, nil, errors.New("invalid payload_json")
		}
	} else {
		payload.Content = c.PostForm("content")
		payload.Username = c.PostForm("username")
		payload.AvatarURL = c.PostForm("avatar_url")
	}

	var files []*multipart.FileHeader
	for _, headers := range form.File {
		files = append(files, headers...)
	}
	if len(files) > maxWebhookAttachments {
		return payload, nil, errors.New("too many attachments")
	}

	ctx := c.Request.Context()
	assetIDs := make([]string, 0, len(files))
	for _, fh := range files {
		file, err := fh.Open()
		if err != nil {
			return payload, nil, errors.New("failed to read attachment")
		}
		attachment, err := s.core.UploadAttachment(ctx, webhook.UserID, webhook.RoomID, fh.Filename, fh.Header.Get("Content-Type"), file)
		_ = file.Close()
		if err != nil {
			return payload, nil, errors.New("failed to upload attachment")
		}
		assetIDs = append(assetIDs, attachment.GetId())
	}
	return payload, assetIDs, nil
}
