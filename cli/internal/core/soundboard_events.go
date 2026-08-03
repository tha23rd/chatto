package core

import (
	"context"
	"errors"
	"fmt"
	"time"

	"hmans.de/chatto/internal/evtstream"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
	"hmans.de/chatto/pkg/events"
)

const maxSoundboardMutationRetries = 5

func newSoundboardSoundCreatedEvent(actorID, id, name string, asset *corev1.AssetRecord, emoji string, volume float32, durationMs int64) *corev1.Event {
	return newEvent(actorID, &corev1.Event{Event: &corev1.Event_SoundboardSoundCreated{
		SoundboardSoundCreated: &corev1.SoundboardSoundCreatedEvent{
			Id:         id,
			Name:       name,
			Asset:      asset,
			Emoji:      emoji,
			Volume:     volume,
			DurationMs: durationMs,
		},
	}})
}

func newSoundboardSoundDeletedEvent(actorID, id string) *corev1.Event {
	return newEvent(actorID, &corev1.Event{Event: &corev1.Event_SoundboardSoundDeleted{
		SoundboardSoundDeleted: &corev1.SoundboardSoundDeletedEvent{Id: id},
	}})
}

// appendSoundboardEvent appends a soundboard event under the singleton
// soundboard aggregate using per-filter optimistic concurrency control,
// mirroring appendCustomEmojiEvent. The check callback runs against a
// read-your-writes-consistent projection before each append attempt so
// invariants (such as unique names and the catalog cap) can reject the
// mutation, and is retried on OCC conflict.
func (c *ChattoCore) appendSoundboardEvent(ctx context.Context, event *corev1.Event, check func() error) (uint64, error) {
	filter := evtstream.SoundboardSubjectFilter()

	for attempt := 0; attempt < maxSoundboardMutationRetries; attempt++ {
		filterSeq, err := c.EventPublisher.LastSubjectSeq(ctx, filter)
		if err != nil {
			return 0, fmt.Errorf("read soundboard OCC filter seq: %w", err)
		}
		if err := c.waitForSoundboardProjection(ctx, events.SubjectPosition(filter, filterSeq)); err != nil {
			return 0, err
		}
		if check != nil {
			if err := check(); err != nil {
				return 0, err
			}
		}
		subject := evtstream.SoundboardAggregate().SubjectFor(event)

		seq, err := c.EventPublisher.AppendAtFilter(ctx, subject, event, filter, filterSeq)
		if err == nil {
			if err := c.waitForSoundboardProjection(ctx, events.SubjectPosition(subject, seq)); err != nil {
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
	return 0, fmt.Errorf("soundboard OCC retry exhausted after %d attempts: %w", maxSoundboardMutationRetries, events.ErrConflict)
}

func (c *ChattoCore) waitForSoundboardProjection(ctx context.Context, pos events.StreamPosition) error {
	return waitForPositionAll(ctx, pos, waitForProjection("Soundboard", c.soundboard.Projector()))
}
