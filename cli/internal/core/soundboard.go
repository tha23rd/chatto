package core

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"google.golang.org/protobuf/proto"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

const (
	// MaxSoundboardSounds caps the number of sounds in a server catalog. There
	// are no paid boost tiers (Chatto is self-hosted), so this is a fixed,
	// generous ceiling that bounds storage and picker size.
	MaxSoundboardSounds = 48

	// MaxSoundClipBytes bounds the stored size of a single sound clip. The
	// envelope is generous so admins can drop in a full-quality source file and
	// trim it down in the UI; the effective playback cost stays low because the
	// clip itself is still limited to a few seconds. Must stay at or below the
	// assets max upload size, which bounds the Connect request that carries the
	// audio (25 MB by default).
	MaxSoundClipBytes = 20 * 1024 * 1024

	// defaultSoundVolume is used when a create request omits a volume.
	defaultSoundVolume = 1.0
)

// soundContentTypeExtensions maps accepted audio MIME types to the file
// extension used for the stored asset. The clip is stored as-is; clients decode
// it for playback, so the set is limited to browser-decodable formats.
var soundContentTypeExtensions = map[string]string{
	"audio/mpeg":  ".mp3",
	"audio/mp3":   ".mp3",
	"audio/ogg":   ".ogg",
	"audio/webm":  ".webm",
	"audio/wav":   ".wav",
	"audio/wave":  ".wav",
	"audio/x-wav": ".wav",
}

// validateSoundName checks that name is a well-formed soundboard sound name.
// The caller is expected to have already trimmed the name.
func validateSoundName(name string) error {
	n := len([]rune(name))
	if n < 1 || n > 64 {
		return invalidArgument("sound name must be 1-64 characters")
	}
	return nil
}

// resolveSoundContentType validates the uploaded content type and returns the
// canonical content type and stored-file extension.
func resolveSoundContentType(contentType string) (string, string, error) {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	// Drop any parameters such as "; codecs=opus".
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	ext, ok := soundContentTypeExtensions[ct]
	if !ok {
		return "", "", invalidArgument("unsupported audio format; use MP3, Ogg, WAV, or WebM")
	}
	return ct, ext, nil
}

func clampSoundVolume(volume float32) float32 {
	if volume <= 0 {
		return defaultSoundVolume
	}
	if volume > 1 {
		return 1
	}
	return volume
}

// CreateSound validates and stores an uploaded audio clip in the server asset
// store and records the sound in the durable server catalog. Requires the
// soundboard.manage or server.manage permission. Returns the created sound. On
// failure after the asset upload, the orphaned asset is cleaned up.
func (c *ChattoCore) CreateSound(ctx context.Context, actorID, name, emoji string, volume float32, audioData []byte, contentType string) (*Sound, error) {
	if err := c.requireCanManageSoundboard(ctx, actorID); err != nil {
		return nil, err
	}

	name = strings.TrimSpace(name)
	if err := validateSoundName(name); err != nil {
		return nil, err
	}
	emoji = strings.TrimSpace(emoji)
	if len([]rune(emoji)) > 64 {
		return nil, invalidArgument("sound emoji must be at most 64 characters")
	}
	if len(audioData) == 0 {
		return nil, invalidArgument("sound clip is empty")
	}
	if len(audioData) > MaxSoundClipBytes {
		return nil, invalidArgument(fmt.Sprintf("sound clip exceeds %d MB limit", MaxSoundClipBytes/(1024*1024)))
	}
	canonicalType, ext, err := resolveSoundContentType(contentType)
	if err != nil {
		return nil, err
	}
	volume = clampSoundVolume(volume)

	if c.soundboard.Projection() != nil && c.soundboard.Projection().Count() >= MaxSoundboardSounds {
		return nil, invalidArgument(fmt.Sprintf("soundboard is full (max %d sounds)", MaxSoundboardSounds))
	}

	asset, err := c.uploadServerSoundAsset(ctx, audioData, canonicalType, ext)
	if err != nil {
		return nil, err
	}

	id := NewSoundboardSoundID()
	event := newSoundboardSoundCreatedEvent(actorID, id, name, asset, emoji, volume, 0)
	if _, err := c.appendSoundboardEvent(ctx, event, func() error {
		if c.soundboard.Projection().IsSoundName(name) {
			return invalidArgument("a sound with this name already exists")
		}
		if c.soundboard.Projection().Count() >= MaxSoundboardSounds {
			return invalidArgument(fmt.Sprintf("soundboard is full (max %d sounds)", MaxSoundboardSounds))
		}
		return nil
	}); err != nil {
		// Roll back the orphaned asset upload if the durable append failed.
		c.deleteAsset(ctx, assetStorageFromAsset(asset), "sound", "server")
		return nil, err
	}

	if sound, ok := c.soundboard.Projection().Get(id); ok {
		return sound, nil
	}
	// appendSoundboardEvent waits for read-your-writes, so this fallback is
	// defensive only.
	return &Sound{
		ID:          id,
		Name:        name,
		Asset:       asset,
		Emoji:       emoji,
		Volume:      volume,
		CreatedBy:   actorID,
		CreatedAtMs: event.GetCreatedAt().AsTime().UnixMilli(),
	}, nil
}

// DeleteSound removes a sound from the server catalog and cleans up its backing
// asset. Requires the soundboard.manage or server.manage permission. Returns
// ErrNotFound when the sound does not exist.
func (c *ChattoCore) DeleteSound(ctx context.Context, actorID, id string) error {
	if err := c.requireCanManageSoundboard(ctx, actorID); err != nil {
		return err
	}

	existing, ok := c.soundboard.Projection().Get(id)
	if !ok {
		return fmt.Errorf("sound %s: %w", id, ErrNotFound)
	}

	event := newSoundboardSoundDeletedEvent(actorID, id)
	if _, err := c.appendSoundboardEvent(ctx, event, func() error {
		if _, ok := c.soundboard.Projection().Get(id); !ok {
			return fmt.Errorf("sound %s: %w", id, ErrNotFound)
		}
		return nil
	}); err != nil {
		return err
	}

	if existing.Asset != nil {
		c.deleteAsset(ctx, assetStorageFromAsset(existing.Asset), "sound", "server")
	}
	c.logger.Info("Deleted soundboard sound", "id", id)
	return nil
}

// ListSounds returns the full server soundboard catalog, ordered by name.
func (c *ChattoCore) ListSounds() []*Sound {
	if c.soundboard.Projection() == nil {
		return nil
	}
	return c.soundboard.Projection().List()
}

// SoundURL builds the public URL that serves a sound clip's audio bytes. Sound
// assets live in the shared server-asset backends but are served under a
// dedicated /assets/sound/ path so the public sound URL namespace stays stable
// and independent of server branding. See FDR-903.
func (c *ChattoCore) SoundURL(assetID string) string {
	if assetID == "" {
		return ""
	}
	return c.assetURL("/assets/sound/" + assetID)
}

// uploadServerSoundAsset routes raw audio bytes to NATS or S3 based on
// configuration and returns the resulting asset reference. Mirrors
// uploadServerAsset but preserves the audio content type instead of forcing
// image/webp.
func (c *ChattoCore) uploadServerSoundAsset(ctx context.Context, data []byte, contentType, ext string) (*corev1.AssetRecord, error) {
	assetID := NewAssetID()
	asset := &corev1.AssetRecord{
		Id:          assetID,
		Filename:    "sound" + ext,
		ContentType: contentType,
		Size:        int64(len(data)),
	}

	if c.ShouldUseS3() {
		s3Key := S3KeyServerAsset(assetID)
		if _, err := c.s3Client.PutObjectFromBytes(ctx, s3Key, data, contentType); err != nil {
			return nil, fmt.Errorf("failed to upload sound to S3: %w", err)
		}
		c.logger.Info("Uploaded soundboard sound to S3", "asset_id", assetID, "size", len(data))
		asset.Storage = &corev1.AssetRecord_S3{S3: &corev1.S3Asset{
			Key:    assetID,
			Bucket: proto.String(c.s3Client.Bucket()),
		}}
		return asset, nil
	}

	headers := nats.Header{}
	headers.Set("Content-Type", contentType)
	objectKey := PublicServerAssetObjectKey(assetID)
	meta := jetstream.ObjectMeta{
		Name:    objectKey,
		Headers: headers,
	}
	info, err := c.storage.serverAssets.Put(ctx, meta, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failed to upload sound: %w", err)
	}
	c.logger.Info("Uploaded soundboard sound", "asset_id", assetID, "size", info.Size)
	asset.Size = int64(info.Size)
	asset.Storage = &corev1.AssetRecord_Nats{Nats: &corev1.NATSAsset{Key: objectKey}}
	return asset, nil
}
