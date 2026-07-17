package core

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

func soundCreatedProjectionEvent(eventID, actorID, id, name string, createdAtMs int64) *corev1.Event {
	return &corev1.Event{
		Id:        eventID,
		ActorId:   actorID,
		CreatedAt: timestamppb.New(time.UnixMilli(createdAtMs)),
		Event: &corev1.Event_SoundboardSoundCreated{
			SoundboardSoundCreated: &corev1.SoundboardSoundCreatedEvent{
				Id:     id,
				Name:   name,
				Emoji:  "🔊",
				Volume: 1,
				Asset:  &corev1.AssetRecord{Id: "A_" + id, ContentType: "audio/mpeg"},
			},
		},
	}
}

func soundDeletedProjectionEvent(eventID, id string) *corev1.Event {
	return &corev1.Event{
		Id: eventID,
		Event: &corev1.Event_SoundboardSoundDeleted{
			SoundboardSoundDeleted: &corev1.SoundboardSoundDeletedEvent{Id: id},
		},
	}
}

func applySoundboardProjectionEvent(t *testing.T, p *SoundboardProjection, event *corev1.Event, seq uint64) {
	t.Helper()
	if err := p.Apply(event, seq); err != nil {
		t.Fatalf("Apply(%q) error: %v", event.GetId(), err)
	}
}

func TestSoundboardProjection_CreateListGet(t *testing.T) {
	p := NewSoundboardProjection()

	applySoundboardProjectionEvent(t, p, soundCreatedProjectionEvent("E1", "U1", "SB1", "airhorn", 100), 1)
	applySoundboardProjectionEvent(t, p, soundCreatedProjectionEvent("E2", "U2", "SB2", "applause", 200), 2)

	if got := p.Count(); got != 2 {
		t.Fatalf("Count() = %d, want 2", got)
	}

	// List is ordered by name: airhorn before applause.
	list := p.List()
	if len(list) != 2 {
		t.Fatalf("List() len = %d, want 2", len(list))
	}
	if list[0].Name != "airhorn" || list[1].Name != "applause" {
		t.Fatalf("List() order = [%q %q], want [airhorn applause]", list[0].Name, list[1].Name)
	}

	// Get by ID, including creator/time carried from the envelope.
	sound, ok := p.Get("SB1")
	if !ok {
		t.Fatal("Get(SB1) not found")
	}
	if sound.Name != "airhorn" || sound.CreatedBy != "U1" || sound.CreatedAtMs != 100 {
		t.Fatalf("Get(SB1) = %+v, want name=airhorn createdBy=U1 createdAtMs=100", sound)
	}
	if sound.Volume != 1 || sound.Emoji != "🔊" {
		t.Fatalf("Get(SB1) volume/emoji = %v/%q, want 1/🔊", sound.Volume, sound.Emoji)
	}
	if sound.Asset.GetId() != "A_SB1" {
		t.Fatalf("Get(SB1).Asset.Id = %q, want A_SB1", sound.Asset.GetId())
	}

	if !p.IsSoundName("applause") {
		t.Fatal("IsSoundName(applause) = false, want true")
	}
	if p.IsSoundName("nope") {
		t.Fatal("IsSoundName(nope) = true, want false")
	}
	if _, ok := p.Get("missing"); ok {
		t.Fatal("Get(missing) = ok, want not found")
	}
}

func TestSoundboardProjection_IsSoundNameCaseInsensitive(t *testing.T) {
	p := NewSoundboardProjection()
	applySoundboardProjectionEvent(t, p, soundCreatedProjectionEvent("E1", "U1", "SB1", "Airhorn", 100), 1)

	for _, q := range []string{"airhorn", "AIRHORN", "  Airhorn  "} {
		if !p.IsSoundName(q) {
			t.Fatalf("IsSoundName(%q) = false, want true", q)
		}
	}
}

func TestSoundboardProjection_Delete(t *testing.T) {
	p := NewSoundboardProjection()
	applySoundboardProjectionEvent(t, p, soundCreatedProjectionEvent("E1", "U1", "SB1", "airhorn", 100), 1)
	applySoundboardProjectionEvent(t, p, soundDeletedProjectionEvent("E2", "SB1"), 2)

	if p.Count() != 0 {
		t.Fatalf("Count() after delete = %d, want 0", p.Count())
	}
	if _, ok := p.Get("SB1"); ok {
		t.Fatal("Get(SB1) after delete = ok, want not found")
	}
	if p.IsSoundName("airhorn") {
		t.Fatal("IsSoundName(airhorn) after delete = true, want false")
	}
}

func TestSoundboardProjection_IgnoresDuplicateEventID(t *testing.T) {
	p := NewSoundboardProjection()

	// During replay, re-applying the same event ID must be idempotent: a create
	// followed by a delete carrying the SAME event ID leaves the create intact.
	applySoundboardProjectionEvent(t, p, soundCreatedProjectionEvent("E1", "U1", "SB1", "airhorn", 100), 1)
	applySoundboardProjectionEvent(t, p, soundDeletedProjectionEvent("E1", "SB1"), 1)

	if _, ok := p.Get("SB1"); !ok {
		t.Fatal("duplicate event id should have been ignored, sound missing")
	}
}

// Sound clips are served over an unauthenticated public route, and the public
// asset classifier fails closed unless a projection positively declares the
// asset. This index is that declaration.
func TestSoundboardProjection_PublicSoundAssetIndexTracksLifecycle(t *testing.T) {
	p := NewSoundboardProjection()

	created := &corev1.Event{
		Id:        "E1",
		ActorId:   "U1",
		CreatedAt: timestamppb.New(time.UnixMilli(1)),
		Event: &corev1.Event_SoundboardSoundCreated{
			SoundboardSoundCreated: &corev1.SoundboardSoundCreatedEvent{
				Id:     "sound1",
				Name:   "airhorn",
				Volume: 1,
				Asset: &corev1.AssetRecord{
					Id:          "A_sound1",
					ContentType: "audio/mpeg",
					Storage:     &corev1.AssetRecord_Nats{Nats: &corev1.NATSAsset{Key: "public/A_sound1"}},
				},
			},
		},
	}

	applySoundboardProjectionEvent(t, p, created, 1)

	// Both the logical asset ID and the backing NATS key are valid request keys.
	if !p.IsPublicSoundAsset("A_sound1") {
		t.Fatal("IsPublicSoundAsset(logical ID) = false, want true")
	}
	if !p.IsPublicSoundAsset("public/A_sound1") {
		t.Fatal("IsPublicSoundAsset(NATS key) = false, want true")
	}

	// Unrelated and empty keys must never be declared public.
	if p.IsPublicSoundAsset("A_other") {
		t.Fatal("IsPublicSoundAsset(unknown) = true, want false")
	}
	if p.IsPublicSoundAsset("") {
		t.Fatal("IsPublicSoundAsset(empty) = true, want false")
	}

	// Deleting the sound withdraws the declaration so the route fails closed.
	applySoundboardProjectionEvent(t, p, soundDeletedProjectionEvent("E2", "sound1"), 2)
	if p.IsPublicSoundAsset("A_sound1") {
		t.Fatal("IsPublicSoundAsset(logical ID) after delete = true, want false")
	}
	if p.IsPublicSoundAsset("public/A_sound1") {
		t.Fatal("IsPublicSoundAsset(NATS key) after delete = true, want false")
	}
}

func TestResolveSoundContentType(t *testing.T) {
	cases := map[string]string{
		"audio/mpeg":             ".mp3",
		"audio/ogg":              ".ogg",
		"audio/webm":             ".webm",
		"audio/wav":              ".wav",
		"audio/mpeg; codecs=mp3": ".mp3",
		"  AUDIO/MPEG  ":         ".mp3",
	}
	for ct, wantExt := range cases {
		_, ext, err := resolveSoundContentType(ct)
		if err != nil {
			t.Fatalf("resolveSoundContentType(%q) error: %v", ct, err)
		}
		if ext != wantExt {
			t.Fatalf("resolveSoundContentType(%q) ext = %q, want %q", ct, ext, wantExt)
		}
	}
	if _, _, err := resolveSoundContentType("video/mp4"); err == nil {
		t.Fatal("resolveSoundContentType(video/mp4) = nil error, want rejection")
	}
}

func TestClampSoundVolume(t *testing.T) {
	cases := map[float32]float32{0: 1, -1: 1, 0.5: 0.5, 1: 1, 2: 1}
	for in, want := range cases {
		if got := clampSoundVolume(in); got != want {
			t.Fatalf("clampSoundVolume(%v) = %v, want %v", in, got, want)
		}
	}
}
