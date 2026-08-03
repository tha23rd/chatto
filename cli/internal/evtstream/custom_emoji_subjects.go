package evtstream

// Custom emoji aggregate segments. Custom emojis are a server-wide catalog
// modeled as a singleton aggregate keyed by a stable sentinel ID, mirroring
// the RBAC server aggregate (ADR-034 singleton convention). Stable
// identifiers; once written, never renamed.
const (
	// AggregateCustomEmoji is the aggregate type segment for the server
	// custom-emoji catalog.
	AggregateCustomEmoji = "custom_emoji"

	// CustomEmojiServerID is the singleton aggregate ID for the server-wide
	// custom-emoji catalog.
	CustomEmojiServerID = "server"
)

// Custom-emoji event-type tokens. NATS-idiomatic snake_case; the trailing
// segment of every custom-emoji event subject. Stable once written.
const (
	EventCustomEmojiCreated = "custom_emoji_created"
	EventCustomEmojiDeleted = "custom_emoji_deleted"
)

// CustomEmojiAggregate is the typed constructor for the singleton server
// custom-emoji catalog aggregate. All custom-emoji lifecycle events publish
// under CustomEmojiAggregate().
func CustomEmojiAggregate() Aggregate {
	return Aggregate{Type: AggregateCustomEmoji, ID: CustomEmojiServerID}
}

// CustomEmojiSubjectFilter returns the wildcard filter matching every event of
// the custom-emoji aggregate.
// Pattern: evt.custom_emoji.>
func CustomEmojiSubjectFilter() string { return SubjectRoot + AggregateCustomEmoji + ".>" }

// ParseCustomEmojiSubject extracts the singleton aggregate ID from a
// custom-emoji event subject. Accepts durable and republished live forms.
func ParseCustomEmojiSubject(subject string) (aggregateID string, ok bool) {
	return parseAggregateSubject(subject, AggregateCustomEmoji)
}
