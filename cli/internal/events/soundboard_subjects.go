package events

// Soundboard aggregate segments. Soundboard sounds are a server-wide catalog
// modeled as a singleton aggregate keyed by a stable sentinel ID, mirroring the
// RBAC and custom-emoji aggregates (ADR-034 singleton convention). Stable
// identifiers; once written, never renamed.
const (
	// AggregateSoundboard is the aggregate type segment for the server
	// soundboard catalog.
	AggregateSoundboard = "soundboard"

	// SoundboardServerID is the singleton aggregate ID for the server-wide
	// soundboard catalog.
	SoundboardServerID = "server"
)

// Soundboard event-type tokens. NATS-idiomatic snake_case; the trailing segment
// of every soundboard event subject. Stable once written.
const (
	EventSoundboardSoundCreated = "soundboard_sound_created"
	EventSoundboardSoundDeleted = "soundboard_sound_deleted"
)

// SoundboardAggregate is the typed constructor for the singleton server
// soundboard catalog aggregate. All soundboard lifecycle events publish under
// SoundboardAggregate().
func SoundboardAggregate() Aggregate {
	return Aggregate{Type: AggregateSoundboard, ID: SoundboardServerID}
}

// SoundboardSubjectFilter returns the wildcard filter matching every event of
// the soundboard aggregate.
// Pattern: evt.soundboard.>
func SoundboardSubjectFilter() string { return SubjectRoot + AggregateSoundboard + ".>" }

// ParseSoundboardSubject extracts the singleton aggregate ID from a
// soundboard-aggregate event subject. Accepts durable and republished live
// forms.
func ParseSoundboardSubject(subject string) (aggregateID string, ok bool) {
	return parseAggregateSubject(subject, AggregateSoundboard)
}
