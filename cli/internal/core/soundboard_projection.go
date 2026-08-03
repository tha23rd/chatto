package core

import (
	"sort"
	"strings"

	"google.golang.org/protobuf/proto"

	"hmans.de/chatto/internal/evtstream"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
	"hmans.de/chatto/pkg/events"
)

// Sound is the projected current-state view of one soundboard sound. The
// creator and creation time are derived from the durable event envelope.
type Sound struct {
	ID          string
	Name        string
	Asset       *corev1.AssetRecord
	Emoji       string
	Volume      float32
	DurationMs  int64
	CreatedBy   string
	CreatedAtMs int64
}

// SoundboardProjection derives the current server soundboard catalog from
// durable soundboard aggregate events. Sounds are a server-wide singleton
// catalog (mirroring RBAC and custom emoji); state is kept entirely in memory
// and rebuilt from EVT replay. See FDR-903.
type SoundboardProjection struct {
	events.MemoryProjection
	byID   map[string]*Sound // sound ID -> sound
	byName map[string]string // lowercased name -> sound ID
	// assetIndex refcounts every request key (logical ID, NATS key, S3 key) that
	// belongs to a live sound in the catalog. It is the positive public
	// declaration the unauthenticated /assets/sound route needs, and keeps that
	// check O(1). Deleting a sound withdraws the declaration.
	assetIndex  map[string]int
	replayGuard projectionReplayGuard
}

// NewSoundboardProjection constructs an empty soundboard projection.
func NewSoundboardProjection() *SoundboardProjection {
	return &SoundboardProjection{
		byID:        make(map[string]*Sound),
		byName:      make(map[string]string),
		assetIndex:  make(map[string]int),
		replayGuard: newProjectionReplayGuard(),
	}
}

// Subjects returns the subject filter this projection consumes.
func (p *SoundboardProjection) Subjects() []string {
	return []string{evtstream.SoundboardSubjectFilter()}
}

// Apply folds one soundboard event into the catalog.
func (p *SoundboardProjection) Apply(event *corev1.Event, seq uint64) error {
	if event == nil {
		return nil
	}

	payload := event.GetEvent()
	switch payload.(type) {
	case *corev1.Event_SoundboardSoundCreated, *corev1.Event_SoundboardSoundDeleted:
	default:
		return nil
	}

	p.Lock()
	defer p.Unlock()

	if p.replayGuard.seenOrMark(event, seq) {
		return nil
	}

	switch e := payload.(type) {
	case *corev1.Event_SoundboardSoundCreated:
		p.applyCreated(e.SoundboardSoundCreated, event)
	case *corev1.Event_SoundboardSoundDeleted:
		p.applyDeleted(e.SoundboardSoundDeleted)
	}
	return nil
}

// CompleteStartupReplay releases replay-only idempotency state once the
// projection has caught up at startup.
func (p *SoundboardProjection) CompleteStartupReplay() {
	p.Lock()
	defer p.Unlock()
	p.replayGuard.completeReplay()
}

func (p *SoundboardProjection) applyCreated(e *corev1.SoundboardSoundCreatedEvent, event *corev1.Event) {
	if e == nil || e.GetId() == "" || e.GetName() == "" {
		return
	}
	var createdAtMs int64
	if ts := event.GetCreatedAt(); ts != nil {
		createdAtMs = ts.AsTime().UnixMilli()
	}
	sound := &Sound{
		ID:          e.GetId(),
		Name:        e.GetName(),
		Asset:       e.GetAsset(),
		Emoji:       e.GetEmoji(),
		Volume:      e.GetVolume(),
		DurationMs:  e.GetDurationMs(),
		CreatedBy:   event.GetActorId(),
		CreatedAtMs: createdAtMs,
	}
	// Drop any prior declaration for this ID before re-declaring, so a replaced
	// sound record cannot leak a stale public asset key.
	if existing, ok := p.byID[sound.ID]; ok {
		p.releaseAssetKeysLocked(existing.Asset)
	}
	p.byID[sound.ID] = sound
	p.byName[strings.ToLower(sound.Name)] = sound.ID
	for key := range assetRecordKeys(sound.Asset) {
		p.assetIndex[key]++
	}
}

// releaseAssetKeysLocked drops one refcount per request key of asset. The
// caller must hold the write lock.
func (p *SoundboardProjection) releaseAssetKeysLocked(asset *corev1.AssetRecord) {
	for key := range assetRecordKeys(asset) {
		if p.assetIndex[key] <= 1 {
			delete(p.assetIndex, key)
		} else {
			p.assetIndex[key]--
		}
	}
}

func (p *SoundboardProjection) applyDeleted(e *corev1.SoundboardSoundDeletedEvent) {
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

// IsPublicSoundAsset reports whether assetID or a backend key belongs to a live
// soundboard sound. Sound clips are intentionally public server assets, so this
// is the projection's positive declaration for the unauthenticated
// /assets/sound route. Deleting a sound withdraws the declaration.
func (p *SoundboardProjection) IsPublicSoundAsset(assetID string) bool {
	p.RLock()
	defer p.RUnlock()
	return assetID != "" && p.assetIndex[assetID] > 0
}

// List returns all sounds in the catalog, ordered by name.
func (p *SoundboardProjection) List() []*Sound {
	p.RLock()
	defer p.RUnlock()
	result := make([]*Sound, 0, len(p.byID))
	for _, sound := range p.byID {
		result = append(result, sound)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name != result[j].Name {
			return result[i].Name < result[j].Name
		}
		return result[i].ID < result[j].ID
	})
	return result
}

// Get returns the sound with the given ID.
func (p *SoundboardProjection) Get(id string) (*Sound, bool) {
	p.RLock()
	defer p.RUnlock()
	sound, ok := p.byID[id]
	return sound, ok
}

// IsSoundName reports whether name matches a sound in the catalog
// (case-insensitive).
func (p *SoundboardProjection) IsSoundName(name string) bool {
	p.RLock()
	defer p.RUnlock()
	_, ok := p.byName[strings.ToLower(strings.TrimSpace(name))]
	return ok
}

// Count returns the number of sounds in the catalog.
func (p *SoundboardProjection) Count() int {
	p.RLock()
	defer p.RUnlock()
	return len(p.byID)
}

func (p *SoundboardProjection) adminProjectionEstimate() (int64, int64, []ProjectionAdminMetric) {
	p.RLock()
	defer p.RUnlock()
	var soundBytes int64
	for id, sound := range p.byID {
		soundBytes += projectionMapEntryOverhead + int64(len(id)+len(sound.Name)+len(sound.Emoji))
		if sound.Asset != nil {
			soundBytes += int64(proto.Size(sound.Asset))
		}
		soundBytes += int64(len(sound.CreatedBy)) + 8
	}
	var nameBytes int64
	for name, id := range p.byName {
		nameBytes += projectionMapEntryOverhead + int64(len(name)+len(id))
	}
	retainedEventIDs := p.replayGuard.retainedEventIDs()
	seenBytes := estimateStringSetBytes(retainedEventIDs)
	totalEntries := int64(len(p.byID))
	totalBytes := soundBytes + nameBytes + seenBytes
	return totalEntries, totalBytes, []ProjectionAdminMetric{
		{Name: "sounds", Value: int64(len(p.byID)), Bytes: soundBytes},
		{Name: "name_index", Value: int64(len(p.byName)), Bytes: nameBytes},
		{Name: "seen_event_ids", Value: int64(len(retainedEventIDs)), Bytes: seenBytes},
		{Name: "event_id_compatibility_mode", Value: p.replayGuard.compatibilityValue(), Bytes: 0},
	}
}
