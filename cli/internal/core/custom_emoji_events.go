package core

import (
	"context"
	"errors"
	"fmt"
	"time"

	"hmans.de/chatto/internal/events"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

const maxCustomEmojiMutationRetries = 5

func newCustomEmojiCreatedEvent(actorID, id, name string, asset *corev1.AssetRecord) *corev1.Event {
	return newEvent(actorID, &corev1.Event{Event: &corev1.Event_CustomEmojiCreated{
		CustomEmojiCreated: &corev1.CustomEmojiCreatedEvent{
			Id:    id,
			Name:  name,
			Asset: asset,
		},
	}})
}

func newCustomEmojiDeletedEvent(actorID, id string) *corev1.Event {
	return newEvent(actorID, &corev1.Event{Event: &corev1.Event_CustomEmojiDeleted{
		CustomEmojiDeleted: &corev1.CustomEmojiDeletedEvent{Id: id},
	}})
}

// appendCustomEmojiEvent appends a custom-emoji event under the singleton
// custom-emoji aggregate using per-filter optimistic concurrency control,
// mirroring appendRBACEvent. The check callback runs against a
// read-your-writes-consistent projection before each append attempt so
// invariants (such as unique names) can reject the mutation, and is retried on
// OCC conflict.
func (c *ChattoCore) appendCustomEmojiEvent(ctx context.Context, event *corev1.Event, check func() error) (uint64, error) {
	filter := events.CustomEmojiSubjectFilter()

	for attempt := 0; attempt < maxCustomEmojiMutationRetries; attempt++ {
		filterSeq, err := c.EventPublisher.LastSubjectSeq(ctx, filter)
		if err != nil {
			return 0, fmt.Errorf("read custom emoji OCC filter seq: %w", err)
		}
		if err := c.waitForCustomEmojiProjection(ctx, events.SubjectPosition(filter, filterSeq)); err != nil {
			return 0, err
		}
		if check != nil {
			if err := check(); err != nil {
				return 0, err
			}
		}
		subject := events.CustomEmojiAggregate().SubjectFor(event)

		seq, err := c.EventPublisher.AppendAtFilter(ctx, subject, event, filter, filterSeq)
		if err == nil {
			if err := c.waitForCustomEmojiProjection(ctx, events.SubjectPosition(subject, seq)); err != nil {
				return 0, err
			}
			return seq, nil
		}
		if !errors.Is(err, events.ErrConflict) {
			return 0, err
		}

		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(time.Duration(1<<attempt) * time.Millisecond):
		}
	}
	return 0, fmt.Errorf("custom emoji OCC retry exhausted after %d attempts: %w", maxCustomEmojiMutationRetries, events.ErrConflict)
}

func (c *ChattoCore) waitForCustomEmojiProjection(ctx context.Context, pos events.StreamPosition) error {
	return waitForPositionAll(ctx, pos, waitForProjection("Custom Emojis", c.CustomEmojisProjector))
}
