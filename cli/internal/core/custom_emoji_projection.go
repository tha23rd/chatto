package core

import (
	"sort"
	"strings"

	"google.golang.org/protobuf/proto"

	"hmans.de/chatto/internal/events"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

// CustomEmoji is the projected current-state view of one server custom emoji.
// The creator and creation time are derived from the durable event envelope.
type CustomEmoji struct {
	ID          string
	Name        string
	Asset       *corev1.AssetRecord
	CreatedBy   string
	CreatedAtMs int64
}

// CustomEmojiProjection derives the current server custom-emoji catalog from
// durable custom-emoji aggregate events. Custom emojis are a server-wide
// singleton catalog (mirroring RBAC); state is kept entirely in memory and
// rebuilt from EVT replay.
type CustomEmojiProjection struct {
	events.MemoryProjection
	byID   map[string]*CustomEmoji // emoji ID -> emoji
	byName map[string]string       // lowercased name -> emoji ID
	// assetIndex refcounts every request key (logical ID, NATS key, S3 key) that
	// belongs to a live emoji in the catalog. It is the positive public
	// declaration the unauthenticated asset route needs for emoji images that
	// predate the explicit public/ object namespace, and keeps that check O(1).
	assetIndex  map[string]int
	replayGuard projectionReplayGuard
}

// NewCustomEmojiProjection constructs an empty custom-emoji projection.
func NewCustomEmojiProjection() *CustomEmojiProjection {
	return &CustomEmojiProjection{
		byID:        make(map[string]*CustomEmoji),
		byName:      make(map[string]string),
		assetIndex:  make(map[string]int),
		replayGuard: newProjectionReplayGuard(),
	}
}

// Subjects returns the subject filter this projection consumes.
func (p *CustomEmojiProjection) Subjects() []string {
	return []string{events.CustomEmojiSubjectFilter()}
}

// Apply folds one custom-emoji event into the catalog.
func (p *CustomEmojiProjection) Apply(event *corev1.Event, seq uint64) error {
	if event == nil {
		return nil
	}

	payload := event.GetEvent()
	switch payload.(type) {
	case *corev1.Event_CustomEmojiCreated, *corev1.Event_CustomEmojiDeleted:
	default:
		return nil
	}

	p.Lock()
	defer p.Unlock()

	if p.replayGuard.seenOrMark(event, seq) {
		return nil
	}

	switch e := payload.(type) {
	case *corev1.Event_CustomEmojiCreated:
		p.applyCreated(e.CustomEmojiCreated, event)
	case *corev1.Event_CustomEmojiDeleted:
		p.applyDeleted(e.CustomEmojiDeleted)
	}
	return nil
}

// CompleteStartupReplay releases replay-only idempotency state once the
// projection has caught up at startup.
func (p *CustomEmojiProjection) CompleteStartupReplay() {
	p.Lock()
	defer p.Unlock()
	p.replayGuard.completeReplay()
}

func (p *CustomEmojiProjection) applyCreated(e *corev1.CustomEmojiCreatedEvent, event *corev1.Event) {
	if e == nil || e.GetId() == "" || e.GetName() == "" {
		return
	}
	var createdAtMs int64
	if ts := event.GetCreatedAt(); ts != nil {
		createdAtMs = ts.AsTime().UnixMilli()
	}
	emoji := &CustomEmoji{
		ID:          e.GetId(),
		Name:        e.GetName(),
		Asset:       e.GetAsset(),
		CreatedBy:   event.GetActorId(),
		CreatedAtMs: createdAtMs,
	}
	// Drop any prior declaration for this ID before re-declaring, so a replaced
	// emoji record cannot leak a stale public asset key.
	if existing, ok := p.byID[emoji.ID]; ok {
		p.releaseAssetKeysLocked(existing.Asset)
	}
	p.byID[emoji.ID] = emoji
	p.byName[strings.ToLower(emoji.Name)] = emoji.ID
	for key := range assetRecordKeys(emoji.Asset) {
		p.assetIndex[key]++
	}
}

// releaseAssetKeysLocked drops one refcount per request key of asset. The
// caller must hold the write lock.
func (p *CustomEmojiProjection) releaseAssetKeysLocked(asset *corev1.AssetRecord) {
	for key := range assetRecordKeys(asset) {
		if p.assetIndex[key] <= 1 {
			delete(p.assetIndex, key)
		} else {
			p.assetIndex[key]--
		}
	}
}

func (p *CustomEmojiProjection) applyDeleted(e *corev1.CustomEmojiDeletedEvent) {
	if e == nil || e.GetId() == "" {
		return
	}
	existing, ok := p.byID[e.GetId()]
	if !ok {
		return
	}
	delete(p.byID, existing.ID)
	if p.byName[strings.ToLower(existing.Name)] == existing.ID {
		delete(p.byName, strings.ToLower(existing.Name))
	}
	p.releaseAssetKeysLocked(existing.Asset)
}

// IsPublicEmojiAsset reports whether assetID or a backend key belongs to a live
// custom emoji. Custom emoji images are intentionally public server assets, so
// this is the projection's positive declaration for the unauthenticated
// /assets/emoji route. Deleting an emoji withdraws the declaration.
func (p *CustomEmojiProjection) IsPublicEmojiAsset(assetID string) bool {
	p.RLock()
	defer p.RUnlock()
	return assetID != "" && p.assetIndex[assetID] > 0
}

// List returns all custom emojis in the catalog, ordered by name.
func (p *CustomEmojiProjection) List() []*CustomEmoji {
	p.RLock()
	defer p.RUnlock()
	result := make([]*CustomEmoji, 0, len(p.byID))
	for _, emoji := range p.byID {
		result = append(result, emoji)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name != result[j].Name {
			return result[i].Name < result[j].Name
		}
		return result[i].ID < result[j].ID
	})
	return result
}

// Get returns the custom emoji with the given ID.
func (p *CustomEmojiProjection) Get(id string) (*CustomEmoji, bool) {
	p.RLock()
	defer p.RUnlock()
	emoji, ok := p.byID[id]
	return emoji, ok
}

// ByName returns the custom emoji with the given shortcode name
// (case-insensitive).
func (p *CustomEmojiProjection) ByName(name string) (*CustomEmoji, bool) {
	p.RLock()
	defer p.RUnlock()
	id, ok := p.byName[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return nil, false
	}
	emoji, ok := p.byID[id]
	return emoji, ok
}

// IsCustomEmojiName reports whether name matches a custom emoji in the catalog
// (case-insensitive).
func (p *CustomEmojiProjection) IsCustomEmojiName(name string) bool {
	_, ok := p.ByName(name)
	return ok
}

// Count returns the number of custom emojis in the catalog.
func (p *CustomEmojiProjection) Count() int {
	p.RLock()
	defer p.RUnlock()
	return len(p.byID)
}

func (p *CustomEmojiProjection) adminProjectionEstimate() (int64, int64, []ProjectionAdminMetric) {
	p.RLock()
	defer p.RUnlock()
	var emojiBytes int64
	for id, emoji := range p.byID {
		emojiBytes += projectionMapEntryOverhead + int64(len(id)+len(emoji.Name))
		if emoji.Asset != nil {
			emojiBytes += int64(proto.Size(emoji.Asset))
		}
		emojiBytes += int64(len(emoji.CreatedBy)) + 8
	}
	var nameBytes int64
	for name, id := range p.byName {
		nameBytes += projectionMapEntryOverhead + int64(len(name)+len(id))
	}
	retainedEventIDs := p.replayGuard.retainedEventIDs()
	seenBytes := estimateStringSetBytes(retainedEventIDs)
	totalEntries := int64(len(p.byID))
	totalBytes := emojiBytes + nameBytes + seenBytes
	return totalEntries, totalBytes, []ProjectionAdminMetric{
		{Name: "custom_emojis", Value: int64(len(p.byID)), Bytes: emojiBytes},
		{Name: "name_index", Value: int64(len(p.byName)), Bytes: nameBytes},
		{Name: "seen_event_ids", Value: int64(len(retainedEventIDs)), Bytes: seenBytes},
		{Name: "event_id_compatibility_mode", Value: p.replayGuard.compatibilityValue(), Bytes: 0},
	}
}
