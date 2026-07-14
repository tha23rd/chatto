package core

import (
	"context"
	"fmt"
	"io"
	"regexp"
	"strings"

	"hmans.de/chatto/internal/assets"
)

// customEmojiNamePattern constrains custom emoji shortcodes to lowercase
// letters, digits, and underscores, 1-64 characters. This keeps names safe as
// URL path fragments and consistent with the built-in gemoji shortcode style.
var customEmojiNamePattern = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

// validateCustomEmojiName checks that name is a well-formed custom emoji
// shortcode that does not collide with the built-in gemoji vocabulary. The
// caller is expected to have already lowercased and trimmed the name.
func validateCustomEmojiName(name string) error {
	if !customEmojiNamePattern.MatchString(name) {
		return invalidArgument("custom emoji name must be 1-64 characters of lowercase letters, digits, or underscores")
	}
	if IsValidEmojiName(name) {
		return invalidArgument("name collides with a built-in emoji")
	}
	return nil
}

// CreateCustomEmoji processes an uploaded image into a small square WebP,
// uploads it to the server asset store, and records the emoji in the durable
// server catalog. Requires the server.manage permission. Returns the created
// emoji. On failure after the asset upload, the orphaned asset is cleaned up.
func (c *ChattoCore) CreateCustomEmoji(ctx context.Context, actorID, name string, reader io.Reader) (*CustomEmoji, error) {
	if err := c.requireCanManageServer(ctx, actorID); err != nil {
		return nil, err
	}

	name = strings.ToLower(strings.TrimSpace(name))
	if err := validateCustomEmojiName(name); err != nil {
		return nil, err
	}

	webpReader, err := assets.ProcessEmojiImageWithConfig(reader, c.AssetsConfig())
	if err != nil {
		return nil, fmt.Errorf("failed to process emoji image: %w", err)
	}
	webpData, err := io.ReadAll(webpReader)
	if err != nil {
		return nil, fmt.Errorf("failed to read processed emoji: %w", err)
	}

	// Emoji images live in the same server-asset keyspace as logos/banners so
	// they are served and cleaned up through the existing server-asset paths.
	asset, err := c.uploadServerAsset(ctx, webpData, "emoji")
	if err != nil {
		return nil, err
	}

	id := NewCustomEmojiID()
	event := newCustomEmojiCreatedEvent(actorID, id, name, asset)
	if _, err := c.appendCustomEmojiEvent(ctx, event, func() error {
		if c.CustomEmojis.IsCustomEmojiName(name) {
			return invalidArgument("a custom emoji with this name already exists")
		}
		return nil
	}); err != nil {
		// Roll back the orphaned asset upload if the durable append failed.
		c.deleteAsset(ctx, assetStorageFromAsset(asset), "emoji", "server")
		return nil, err
	}

	if emoji, ok := c.CustomEmojis.Get(id); ok {
		return emoji, nil
	}
	// appendCustomEmojiEvent waits for read-your-writes, so this fallback is
	// defensive only.
	return &CustomEmoji{
		ID:          id,
		Name:        name,
		Asset:       asset,
		CreatedBy:   actorID,
		CreatedAtMs: event.GetCreatedAt().AsTime().UnixMilli(),
	}, nil
}

// DeleteCustomEmoji removes a custom emoji from the server catalog and cleans
// up its backing asset. Requires the server.manage permission. Returns
// ErrNotFound when the emoji does not exist.
func (c *ChattoCore) DeleteCustomEmoji(ctx context.Context, actorID, id string) error {
	if err := c.requireCanManageServer(ctx, actorID); err != nil {
		return err
	}

	existing, ok := c.CustomEmojis.Get(id)
	if !ok {
		return fmt.Errorf("custom emoji %s: %w", id, ErrNotFound)
	}

	event := newCustomEmojiDeletedEvent(actorID, id)
	if _, err := c.appendCustomEmojiEvent(ctx, event, func() error {
		if _, ok := c.CustomEmojis.Get(id); !ok {
			return fmt.Errorf("custom emoji %s: %w", id, ErrNotFound)
		}
		return nil
	}); err != nil {
		return err
	}

	if existing.Asset != nil {
		c.deleteAsset(ctx, assetStorageFromAsset(existing.Asset), "emoji", "server")
	}
	c.logger.Info("Deleted custom emoji", "id", id)
	return nil
}

// ListCustomEmojis returns the full server custom emoji catalog, ordered by
// name.
func (c *ChattoCore) ListCustomEmojis() []*CustomEmoji {
	return c.CustomEmojis.List()
}

// CustomEmojiURL builds the public URL that renders a custom emoji's image.
// Emoji assets live in the shared server-asset backends but are served under a
// dedicated /assets/emoji/ path so the public emoji URL namespace stays stable
// and independent of server branding. See FDR-030.
func (c *ChattoCore) CustomEmojiURL(assetID string) string {
	if assetID == "" {
		return ""
	}
	return c.assetURL("/assets/emoji/" + assetID)
}
