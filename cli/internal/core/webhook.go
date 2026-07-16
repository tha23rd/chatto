package core

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nats-io/nats.go/jetstream"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

// webhookKeyPrefix namespaces channel webhook records in the RUNTIME_STATE KV
// bucket. Records are keyed by webhook ID (webhook.{id}); the inbound post URL
// carries the ID, so token validation is a direct get plus a constant-time hash
// compare rather than a separate token-hash index.
const webhookKeyPrefix = "webhook."

// webhookTokenScope is the HMAC domain separator for webhook token hashing.
const webhookTokenScope = "webhook"

// ErrWebhookNotFound is returned when a channel webhook does not exist.
var ErrWebhookNotFound = errors.New("webhook not found")

// ErrWebhookDisabled is returned when an inbound post targets a disabled webhook.
var ErrWebhookDisabled = errors.New("webhook disabled")

// Webhook is a channel webhook: a token-authorized endpoint that posts messages
// into a room under a synthetic, non-human webhook user (FDR-031).
type Webhook struct {
	ID          string
	RoomID      string
	GroupID     string
	Name        string
	CreatedBy   string
	UserID      string
	CreatedAtMs int64
	Disabled    bool
}

// webhookRecord is the JSON value stored in RUNTIME_STATE under webhook.{id}.
// Only the HMAC of the secret token is persisted; the raw token is returned to
// the creator exactly once. The webhook's name and avatar are mirrored onto the
// backing user (UserID), which is the durable author of its messages.
type webhookRecord struct {
	ID        string    `json:"id"`
	RoomID    string    `json:"room_id"`
	GroupID   string    `json:"group_id,omitempty"`
	Name      string    `json:"name"`
	CreatedBy string    `json:"created_by"`
	UserID    string    `json:"user_id"`
	TokenHash string    `json:"token_hash"`
	CreatedAt time.Time `json:"created_at"`
	Disabled  bool      `json:"disabled,omitempty"`
}

func (r *webhookRecord) toWebhook() *Webhook {
	return &Webhook{
		ID:          r.ID,
		RoomID:      r.RoomID,
		GroupID:     r.GroupID,
		Name:        r.Name,
		CreatedBy:   r.CreatedBy,
		UserID:      r.UserID,
		CreatedAtMs: r.CreatedAt.UnixMilli(),
		Disabled:    r.Disabled,
	}
}

func webhookKey(id string) string { return webhookKeyPrefix + id }

func (c *ChattoCore) webhookTokenHash(token string) string {
	return c.runtimeTokenHash(webhookTokenScope, token)
}

// WebhookPostPath is the inbound channel-webhook route prefix. The full URL is
// {base}/webhooks/incoming/{id}/{token}. The nested "incoming" segment keeps the
// route clear of the sibling static /webhooks/livekit endpoint.
const WebhookPostPath = "/webhooks/incoming"

// WebhookPostURL builds the public inbound post URL for a webhook. When the
// server's public base URL is unset (e.g. local development), the returned URL
// is root-relative.
func (c *ChattoCore) WebhookPostURL(id, token string) string {
	return c.AssetBaseURL + WebhookPostPath + "/" + id + "/" + token
}

func (c *ChattoCore) validateWebhookName(name string) (string, error) {
	name = NormalizeDisplayName(name)
	if name == "" {
		return "", invalidArgument("webhook name is required")
	}
	if utf8.RuneCountInString(name) > MaxDisplayNameLength {
		return "", ErrDisplayNameTooLong
	}
	if err := ValidateDisplayName(name); err != nil {
		return "", err
	}
	return name, nil
}

// CreateWebhook mints a synthetic webhook user, optionally sets its avatar, and
// stores a durable webhook record whose secret token is returned once. Requires
// the server.manage permission. The raw token is only ever available here and
// from RegenerateWebhookToken.
func (c *ChattoCore) CreateWebhook(ctx context.Context, actorID, roomID, name string, avatarImage []byte) (*Webhook, string, error) {
	if err := c.requireCanManageServer(ctx, actorID); err != nil {
		return nil, "", err
	}
	name, err := c.validateWebhookName(name)
	if err != nil {
		return nil, "", err
	}

	// The webhook posts into a channel room; verify it exists (and capture its
	// group for record-keeping).
	room, err := c.GetRoom(ctx, KindChannel, roomID)
	if err != nil {
		return nil, "", err
	}

	user, err := c.createWebhookUser(ctx, actorID, name)
	if err != nil {
		return nil, "", err
	}

	if len(avatarImage) > 0 {
		if err := c.setWebhookAvatar(ctx, user.GetId(), avatarImage); err != nil {
			return nil, "", err
		}
	}

	id := NewWebhookID()
	token := NewWebhookToken()
	rec := &webhookRecord{
		ID:        id,
		RoomID:    roomID,
		GroupID:   room.GetGroupId(),
		Name:      name,
		CreatedBy: actorID,
		UserID:    user.GetId(),
		TokenHash: c.webhookTokenHash(token),
		CreatedAt: time.Now(),
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return nil, "", fmt.Errorf("marshal webhook: %w", err)
	}
	if _, err := c.storage.runtimeStateKV.Create(ctx, webhookKey(id), data); err != nil {
		return nil, "", fmt.Errorf("store webhook: %w", err)
	}
	c.logger.Info("Created webhook", "id", id, "room_id", roomID, "user_id", user.GetId())
	return rec.toWebhook(), token, nil
}

// createWebhookUser mints a passwordless synthetic user of kind WEBHOOK. Its
// login is random and non-guessable; webhook users are excluded from the member
// directory, login resolution, and the user limit.
func (c *ChattoCore) createWebhookUser(ctx context.Context, actorID, displayName string) (*corev1.User, error) {
	login := "webhook-" + strings.ToLower(newID(""))
	return c.CreateUser(ctx, actorID, login, displayName, "", WithUserKind(corev1.UserKind_USER_KIND_WEBHOOK))
}

func (c *ChattoCore) setWebhookAvatar(ctx context.Context, userID string, image []byte) error {
	asset, err := c.UploadUserAvatar(ctx, userID, bytes.NewReader(image))
	if err != nil {
		return err
	}
	return c.SetUserAvatar(ctx, userID, asset)
}

func (c *ChattoCore) getWebhookRecord(ctx context.Context, id string) (*webhookRecord, uint64, error) {
	entry, err := c.storage.runtimeStateKV.Get(ctx, webhookKey(id))
	if err != nil {
		if errors.Is(err, jetstream.ErrKeyNotFound) {
			return nil, 0, fmt.Errorf("webhook %s: %w", id, ErrWebhookNotFound)
		}
		return nil, 0, fmt.Errorf("load webhook: %w", err)
	}
	var rec webhookRecord
	if err := json.Unmarshal(entry.Value(), &rec); err != nil {
		return nil, 0, fmt.Errorf("decode webhook: %w", err)
	}
	return &rec, entry.Revision(), nil
}

// GetWebhook returns a single webhook. Requires the server.manage permission.
func (c *ChattoCore) GetWebhook(ctx context.Context, actorID, id string) (*Webhook, error) {
	if err := c.requireCanManageServer(ctx, actorID); err != nil {
		return nil, err
	}
	rec, _, err := c.getWebhookRecord(ctx, id)
	if err != nil {
		return nil, err
	}
	return rec.toWebhook(), nil
}

// ListWebhooks returns all webhooks, optionally filtered to one room, ordered by
// creation time. Requires the server.manage permission.
func (c *ChattoCore) ListWebhooks(ctx context.Context, actorID, roomID string) ([]*Webhook, error) {
	if err := c.requireCanManageServer(ctx, actorID); err != nil {
		return nil, err
	}
	lister, err := c.storage.runtimeStateKV.ListKeysFiltered(ctx, webhookKeyPrefix+"*")
	if err != nil {
		if errors.Is(err, jetstream.ErrNoKeysFound) {
			return []*Webhook{}, nil
		}
		return nil, fmt.Errorf("list webhooks: %w", err)
	}
	var records []*webhookRecord
	for key := range lister.Keys() {
		entry, err := c.storage.runtimeStateKV.Get(ctx, key)
		if err != nil {
			if errors.Is(err, jetstream.ErrKeyNotFound) || errors.Is(err, jetstream.ErrKeyDeleted) {
				continue
			}
			return nil, fmt.Errorf("load webhook for listing: %w", err)
		}
		var rec webhookRecord
		if err := json.Unmarshal(entry.Value(), &rec); err != nil {
			c.logger.Warn("Skipping malformed webhook record", "webhook_key", key, "error", err)
			continue
		}
		if roomID != "" && rec.RoomID != roomID {
			continue
		}
		records = append(records, &rec)
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].CreatedAt.Before(records[j].CreatedAt)
	})
	webhooks := make([]*Webhook, 0, len(records))
	for _, rec := range records {
		webhooks = append(webhooks, rec.toWebhook())
	}
	return webhooks, nil
}

// UpdateWebhook changes a webhook's name, avatar, or disabled state. Unset
// pointer fields are left unchanged. Requires the server.manage permission.
func (c *ChattoCore) UpdateWebhook(ctx context.Context, actorID, id string, name *string, avatarImage []byte, clearAvatar bool, disabled *bool) (*Webhook, error) {
	if err := c.requireCanManageServer(ctx, actorID); err != nil {
		return nil, err
	}
	rec, revision, err := c.getWebhookRecord(ctx, id)
	if err != nil {
		return nil, err
	}

	if name != nil {
		normalized, err := c.validateWebhookName(*name)
		if err != nil {
			return nil, err
		}
		if normalized != rec.Name {
			if _, err := c.UpdateUserDisplayName(ctx, rec.UserID, normalized); err != nil {
				return nil, err
			}
			rec.Name = normalized
		}
	}

	if len(avatarImage) > 0 {
		if err := c.setWebhookAvatar(ctx, rec.UserID, avatarImage); err != nil {
			return nil, err
		}
	} else if clearAvatar {
		if err := c.DeleteUserAvatar(ctx, rec.UserID); err != nil {
			return nil, err
		}
	}

	if disabled != nil {
		rec.Disabled = *disabled
	}

	data, err := json.Marshal(rec)
	if err != nil {
		return nil, fmt.Errorf("marshal webhook: %w", err)
	}
	if _, err := c.storage.runtimeStateKV.Update(ctx, webhookKey(id), data, revision); err != nil {
		return nil, fmt.Errorf("update webhook: %w", err)
	}
	c.logger.Info("Updated webhook", "id", id)
	return rec.toWebhook(), nil
}

// RegenerateWebhookToken issues a new secret token for a webhook, invalidating
// the previous one, and returns the raw token once. Requires the server.manage
// permission.
func (c *ChattoCore) RegenerateWebhookToken(ctx context.Context, actorID, id string) (*Webhook, string, error) {
	if err := c.requireCanManageServer(ctx, actorID); err != nil {
		return nil, "", err
	}
	rec, revision, err := c.getWebhookRecord(ctx, id)
	if err != nil {
		return nil, "", err
	}
	token := NewWebhookToken()
	rec.TokenHash = c.webhookTokenHash(token)
	data, err := json.Marshal(rec)
	if err != nil {
		return nil, "", fmt.Errorf("marshal webhook: %w", err)
	}
	if _, err := c.storage.runtimeStateKV.Update(ctx, webhookKey(id), data, revision); err != nil {
		return nil, "", fmt.Errorf("rotate webhook token: %w", err)
	}
	c.logger.Info("Regenerated webhook token", "id", id)
	return rec.toWebhook(), token, nil
}

// DeleteWebhook removes a webhook's record, immediately invalidating its token
// and removing it from management listings. The backing webhook user is
// intentionally retained so previously posted messages keep rendering their
// webhook identity. Requires the server.manage permission.
func (c *ChattoCore) DeleteWebhook(ctx context.Context, actorID, id string) error {
	if err := c.requireCanManageServer(ctx, actorID); err != nil {
		return err
	}
	if _, _, err := c.getWebhookRecord(ctx, id); err != nil {
		return err
	}
	if err := c.storage.runtimeStateKV.Delete(ctx, webhookKey(id)); err != nil {
		return fmt.Errorf("delete webhook: %w", err)
	}
	c.logger.Info("Deleted webhook", "id", id)
	return nil
}

// ValidateWebhookToken authorizes an inbound webhook post. It looks up the
// webhook by ID (from the URL) and constant-time compares the presented token's
// hash. No user permission is checked: possessing a valid token is the
// authorization. Returns ErrWebhookNotFound for unknown IDs or mismatched
// tokens, and ErrWebhookDisabled for a disabled webhook.
func (c *ChattoCore) ValidateWebhookToken(ctx context.Context, id, token string) (*Webhook, error) {
	if id == "" || token == "" {
		return nil, ErrWebhookNotFound
	}
	rec, _, err := c.getWebhookRecord(ctx, id)
	if err != nil {
		return nil, err
	}
	presented := c.webhookTokenHash(token)
	if subtle.ConstantTimeCompare([]byte(presented), []byte(rec.TokenHash)) != 1 {
		return nil, ErrWebhookNotFound
	}
	if rec.Disabled {
		return nil, ErrWebhookDisabled
	}
	return rec.toWebhook(), nil
}

// PostWebhookMessage posts a message into the webhook's room authored by the
// webhook's synthetic user. Optional per-message overrides replace the webhook's
// default name/avatar for this message only. The caller is expected to have
// already validated the token via ValidateWebhookToken.
func (c *ChattoCore) PostWebhookMessage(ctx context.Context, webhook *Webhook, content, overrideName, overrideAvatarURL string, assetIDs []string) (*corev1.Event, error) {
	if webhook == nil {
		return nil, ErrWebhookNotFound
	}
	var opts []PostMessageOption
	if overrideName != "" || overrideAvatarURL != "" {
		opts = append(opts, WithWebhookOverride(overrideName, overrideAvatarURL))
	}
	return c.PostMessage(ctx, KindChannel, webhook.RoomID, webhook.UserID, content, assetIDs, "", "", nil, false, opts...)
}
