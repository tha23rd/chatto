package core

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

func customEmojiCreatedProjectionEvent(eventID, actorID, id, name string, createdAtMs int64) *corev1.Event {
	return &corev1.Event{
		Id:        eventID,
		ActorId:   actorID,
		CreatedAt: timestamppb.New(time.UnixMilli(createdAtMs)),
		Event: &corev1.Event_CustomEmojiCreated{
			CustomEmojiCreated: &corev1.CustomEmojiCreatedEvent{
				Id:    id,
				Name:  name,
				Asset: &corev1.AssetRecord{Id: "A_" + id, ContentType: "image/webp"},
			},
		},
	}
}

func customEmojiDeletedProjectionEvent(eventID, id string) *corev1.Event {
	return &corev1.Event{
		Id: eventID,
		Event: &corev1.Event_CustomEmojiDeleted{
			CustomEmojiDeleted: &corev1.CustomEmojiDeletedEvent{Id: id},
		},
	}
}

func applyCustomEmojiProjectionEvent(t *testing.T, p *CustomEmojiProjection, event *corev1.Event, seq uint64) {
	t.Helper()
	if err := p.Apply(event, seq); err != nil {
		t.Fatalf("Apply(%q) error: %v", event.GetId(), err)
	}
}

func TestCustomEmojiProjection_CreateListGetByName(t *testing.T) {
	p := NewCustomEmojiProjection()

	applyCustomEmojiProjectionEvent(t, p, customEmojiCreatedProjectionEvent("E1", "U1", "CE1", "partyparrot", 100), 1)
	applyCustomEmojiProjectionEvent(t, p, customEmojiCreatedProjectionEvent("E2", "U2", "CE2", "blobwave", 200), 2)

	if got := p.Count(); got != 2 {
		t.Fatalf("Count() = %d, want 2", got)
	}

	// List is ordered by name: blobwave before partyparrot.
	list := p.List()
	if len(list) != 2 {
		t.Fatalf("List() len = %d, want 2", len(list))
	}
	if list[0].Name != "blobwave" || list[1].Name != "partyparrot" {
		t.Fatalf("List() order = [%q %q], want [blobwave partyparrot]", list[0].Name, list[1].Name)
	}

	// Get by ID, including creator/time carried from the envelope.
	emoji, ok := p.Get("CE1")
	if !ok {
		t.Fatal("Get(CE1) not found")
	}
	if emoji.Name != "partyparrot" || emoji.CreatedBy != "U1" || emoji.CreatedAtMs != 100 {
		t.Fatalf("Get(CE1) = %+v, want name=partyparrot createdBy=U1 createdAtMs=100", emoji)
	}
	if emoji.Asset.GetId() != "A_CE1" {
		t.Fatalf("Get(CE1).Asset.Id = %q, want A_CE1", emoji.Asset.GetId())
	}

	// ByName / IsCustomEmojiName hit and miss.
	if _, ok := p.ByName("blobwave"); !ok {
		t.Fatal("ByName(blobwave) not found")
	}
	if p.IsCustomEmojiName("nope") {
		t.Fatal("IsCustomEmojiName(nope) = true, want false")
	}
	if _, ok := p.Get("missing"); ok {
		t.Fatal("Get(missing) = ok, want not found")
	}
}

func TestCustomEmojiProjection_ByNameCaseInsensitive(t *testing.T) {
	p := NewCustomEmojiProjection()
	applyCustomEmojiProjectionEvent(t, p, customEmojiCreatedProjectionEvent("E1", "U1", "CE1", "partyparrot", 100), 1)

	for _, q := range []string{"partyparrot", "PartyParrot", "  PARTYPARROT  "} {
		if !p.IsCustomEmojiName(q) {
			t.Fatalf("IsCustomEmojiName(%q) = false, want true", q)
		}
	}
}

func TestCustomEmojiProjection_Delete(t *testing.T) {
	p := NewCustomEmojiProjection()
	applyCustomEmojiProjectionEvent(t, p, customEmojiCreatedProjectionEvent("E1", "U1", "CE1", "partyparrot", 100), 1)
	applyCustomEmojiProjectionEvent(t, p, customEmojiDeletedProjectionEvent("E2", "CE1"), 2)

	if p.Count() != 0 {
		t.Fatalf("Count() after delete = %d, want 0", p.Count())
	}
	if _, ok := p.Get("CE1"); ok {
		t.Fatal("Get(CE1) after delete = ok, want not found")
	}
	if p.IsCustomEmojiName("partyparrot") {
		t.Fatal("IsCustomEmojiName(partyparrot) after delete = true, want false")
	}
}

func TestCustomEmojiProjection_IgnoresDuplicateEventID(t *testing.T) {
	p := NewCustomEmojiProjection()

	// During replay, re-applying the same event ID must be idempotent: a create
	// followed by a delete carrying the SAME event ID leaves the create intact.
	applyCustomEmojiProjectionEvent(t, p, customEmojiCreatedProjectionEvent("E1", "U1", "CE1", "partyparrot", 100), 1)
	applyCustomEmojiProjectionEvent(t, p, customEmojiDeletedProjectionEvent("E1", "CE1"), 1)

	if _, ok := p.Get("CE1"); !ok {
		t.Fatal("duplicate event id should have been ignored, emoji missing")
	}
}

// Custom emoji images are served over an unauthenticated public route, and the
// public asset classifier fails closed unless a projection positively declares
// the asset. Emoji uploaded before the explicit public/ object namespace carry a
// flat key and no visibility marker, so this index is their only declaration.
func TestCustomEmojiProjection_PublicEmojiAssetIndexTracksLifecycle(t *testing.T) {
	p := NewCustomEmojiProjection()

	created := &corev1.Event{
		Id:        "E1",
		ActorId:   "U1",
		CreatedAt: timestamppb.New(time.UnixMilli(1)),
		Event: &corev1.Event_CustomEmojiCreated{
			CustomEmojiCreated: &corev1.CustomEmojiCreatedEvent{
				Id:   "emoji1",
				Name: "partyparrot",
				Asset: &corev1.AssetRecord{
					Id:          "A_emoji1",
					ContentType: "image/webp",
					Storage:     &corev1.AssetRecord_Nats{Nats: &corev1.NATSAsset{Key: "legacy-flat-emoji-key"}},
				},
			},
		},
	}

	applyCustomEmojiProjectionEvent(t, p, created, 1)

	// Both the logical asset ID and the backing NATS key are valid request keys.
	if !p.IsPublicEmojiAsset("A_emoji1") {
		t.Fatal("IsPublicEmojiAsset(logical ID) = false, want true")
	}
	if !p.IsPublicEmojiAsset("legacy-flat-emoji-key") {
		t.Fatal("IsPublicEmojiAsset(NATS key) = false, want true")
	}

	// Unrelated and empty keys must never be declared public.
	if p.IsPublicEmojiAsset("A_other") {
		t.Fatal("IsPublicEmojiAsset(unknown) = true, want false")
	}
	if p.IsPublicEmojiAsset("") {
		t.Fatal("IsPublicEmojiAsset(empty) = true, want false")
	}

	// Deleting the emoji withdraws the declaration so the route fails closed.
	applyCustomEmojiProjectionEvent(t, p, customEmojiDeletedProjectionEvent("E2", "emoji1"), 2)
	if p.IsPublicEmojiAsset("A_emoji1") {
		t.Fatal("IsPublicEmojiAsset(logical ID) after delete = true, want false")
	}
	if p.IsPublicEmojiAsset("legacy-flat-emoji-key") {
		t.Fatal("IsPublicEmojiAsset(NATS key) after delete = true, want false")
	}
}
