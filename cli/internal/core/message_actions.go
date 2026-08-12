package core

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/nats-io/nats.go/jetstream"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"hmans.de/chatto/internal/jetstreamutil"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

const (
	messageActionInvocationTTL       = 24 * time.Hour
	messageActionInvocationKeyPrefix = "message_action_invocation."
)

var messageActionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// MessageActionInvokeInput describes one member invoking a visible action.
type MessageActionInvokeInput struct {
	ActorID        string
	RoomID         string
	MessageEventID string
	ActionID       string
	RequestID      string
}

func cloneMessageActions(actions []*corev1.MessageAction) []*corev1.MessageAction {
	if actions == nil {
		return nil
	}
	cloned := make([]*corev1.MessageAction, 0, len(actions))
	for _, action := range actions {
		if action == nil {
			cloned = append(cloned, nil)
			continue
		}
		cloned = append(cloned, proto.Clone(action).(*corev1.MessageAction))
	}
	return cloned
}

func validateMessageActions(actions []*corev1.MessageAction) error {
	if len(actions) > MaxMessageActions {
		return invalidArgument(fmt.Sprintf("actions cannot contain more than %d items", MaxMessageActions))
	}
	seen := make(map[string]struct{}, len(actions))
	for _, action := range actions {
		if action == nil {
			return invalidArgument("actions cannot contain an empty item")
		}
		if len(action.GetId()) > MaxMessageActionIDLength || !messageActionIDPattern.MatchString(action.GetId()) {
			return invalidArgument("action id must contain 1-64 ASCII letters, digits, underscores, or hyphens")
		}
		if _, exists := seen[action.GetId()]; exists {
			return invalidArgument("action ids must be unique within a message")
		}
		seen[action.GetId()] = struct{}{}

		label := action.GetLabel()
		if strings.TrimSpace(label) == "" {
			return invalidArgument("action label is required")
		}
		if len(label) > MaxMessageActionLabelLength {
			return invalidArgument(fmt.Sprintf("action label cannot exceed %d bytes", MaxMessageActionLabelLength))
		}
		for _, char := range label {
			if unicode.IsControl(char) || isZeroWidthChar(char) {
				return invalidArgument("action label contains an invalid character")
			}
		}
		switch action.GetStyle() {
		case corev1.MessageActionStyle_MESSAGE_ACTION_STYLE_UNSPECIFIED,
			corev1.MessageActionStyle_MESSAGE_ACTION_STYLE_PRIMARY,
			corev1.MessageActionStyle_MESSAGE_ACTION_STYLE_SECONDARY,
			corev1.MessageActionStyle_MESSAGE_ACTION_STYLE_SUCCESS,
			corev1.MessageActionStyle_MESSAGE_ACTION_STYLE_DANGER:
		default:
			return invalidArgument("action style is invalid")
		}
	}
	return nil
}

func validateMessageActionRequestID(requestID string) error {
	if len(requestID) < 16 || len(requestID) > 64 || !messageActionIDPattern.MatchString(requestID) {
		return invalidArgument("request_id must contain 16-64 ASCII letters, digits, underscores, or hyphens")
	}
	return nil
}

func messageActionInvocationKey(recipientID, invocationID string) string {
	return messageActionInvocationKeyPrefix + recipientID + "." + invocationID
}

func messageActionInvocationKeyFilter(recipientID string) string {
	return messageActionInvocationKeyPrefix + recipientID + ".*"
}

// InvokeMessageAction validates one action against the current message body and
// creates a private pending invocation for the message author. RequestID is the
// invocation's idempotency key.
func (s *MessageModel) InvokeMessageAction(ctx context.Context, input MessageActionInvokeInput) (*corev1.MessageActionInvocation, error) {
	room, kind, err := s.core.requireRoomMember(ctx, input.ActorID, input.RoomID)
	if err != nil {
		return nil, err
	}
	if room.GetArchived() {
		return nil, ErrRoomArchived
	}
	if strings.TrimSpace(input.MessageEventID) == "" {
		return nil, invalidArgument("message_event_id is required")
	}
	if err := validateMessageActionRequestID(input.RequestID); err != nil {
		return nil, err
	}
	event, err := s.requireMessagePostedEvent(ctx, kind, room.GetId(), input.MessageEventID)
	if err != nil {
		return nil, err
	}
	canonicalEventID := event.GetId()
	if originalID := event.GetMessagePosted().GetEchoOfEventId(); originalID != "" {
		event, err = s.requireMessagePostedEvent(ctx, kind, room.GetId(), originalID)
		if err != nil {
			return nil, err
		}
		canonicalEventID = originalID
	}

	body, err := s.core.GetFullMessageBody(ctx, canonicalEventID)
	if err != nil {
		return nil, err
	}
	if body == nil || body.AuthorId == "" {
		return nil, ErrMessageNotFound
	}
	invocation := &corev1.MessageActionInvocation{
		Id:             input.RequestID,
		RecipientId:    body.AuthorId,
		RoomId:         room.GetId(),
		MessageEventId: canonicalEventID,
		ActionId:       input.ActionID,
		ActorId:        input.ActorID,
	}
	existing, err := s.getMessageActionInvocation(ctx, invocation.GetRecipientId(), invocation.GetId())
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if sameMessageActionInvocation(existing, invocation) {
			return existing, nil
		}
		return nil, ErrMessageActionRequestIDExists
	}

	var selected *corev1.MessageAction
	for _, action := range body.Actions {
		if action.GetId() == input.ActionID {
			selected = action
			break
		}
	}
	if selected == nil {
		return nil, ErrMessageActionNotFound
	}
	if selected.GetDisabled() {
		return nil, ErrMessageActionDisabled
	}

	invocation.CreatedAt = timestamppb.Now()
	data, err := proto.Marshal(invocation)
	if err != nil {
		return nil, fmt.Errorf("marshal message action invocation: %w", err)
	}
	key := messageActionInvocationKey(invocation.GetRecipientId(), invocation.GetId())
	if _, err := s.core.storage.runtimeStateKV.Create(ctx, key, data, jetstream.KeyTTL(messageActionInvocationTTL)); err != nil {
		if !errors.Is(err, jetstream.ErrKeyExists) {
			return nil, fmt.Errorf("store message action invocation: %w", err)
		}
		existing, getErr := s.getMessageActionInvocation(ctx, invocation.GetRecipientId(), invocation.GetId())
		if getErr != nil {
			return nil, getErr
		}
		if existing != nil && sameMessageActionInvocation(existing, invocation) {
			return existing, nil
		}
		return nil, ErrMessageActionRequestIDExists
	}
	return proto.Clone(invocation).(*corev1.MessageActionInvocation), nil
}

func sameMessageActionInvocation(left, right *corev1.MessageActionInvocation) bool {
	return left.GetId() == right.GetId() &&
		left.GetRecipientId() == right.GetRecipientId() &&
		left.GetRoomId() == right.GetRoomId() &&
		left.GetMessageEventId() == right.GetMessageEventId() &&
		left.GetActionId() == right.GetActionId() &&
		left.GetActorId() == right.GetActorId()
}

func (s *MessageModel) getMessageActionInvocation(ctx context.Context, recipientID, invocationID string) (*corev1.MessageActionInvocation, error) {
	entry, err := s.core.storage.runtimeStateKV.Get(ctx, messageActionInvocationKey(recipientID, invocationID))
	if err != nil {
		if errors.Is(err, jetstream.ErrKeyNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("get message action invocation: %w", err)
	}
	var invocation corev1.MessageActionInvocation
	if err := proto.Unmarshal(entry.Value(), &invocation); err != nil {
		return nil, fmt.Errorf("unmarshal message action invocation: %w", err)
	}
	return &invocation, nil
}

// ListMessageActionInvocations returns the caller's pending invocations oldest
// first. The caller is the recipient because only message authors consume their
// own inbox.
func (s *MessageModel) ListMessageActionInvocations(ctx context.Context, actorID string) ([]*corev1.MessageActionInvocation, error) {
	if err := requireAuthenticatedActor(actorID); err != nil {
		return nil, err
	}
	lister, err := s.core.storage.runtimeStateKV.ListKeysFiltered(ctx, messageActionInvocationKeyFilter(actorID))
	if err != nil {
		if errors.Is(err, jetstream.ErrNoKeysFound) {
			return []*corev1.MessageActionInvocation{}, nil
		}
		return nil, fmt.Errorf("list message action invocation keys: %w", err)
	}
	invocations := make([]*corev1.MessageActionInvocation, 0)
	for key := range lister.Keys() {
		entry, err := s.core.storage.runtimeStateKV.Get(ctx, key)
		if err != nil {
			if errors.Is(err, jetstream.ErrKeyNotFound) {
				continue
			}
			return nil, fmt.Errorf("get message action invocation: %w", err)
		}
		var invocation corev1.MessageActionInvocation
		if err := proto.Unmarshal(entry.Value(), &invocation); err != nil {
			s.core.logger.Warn("Failed to unmarshal message action invocation", "key", key, "error", err)
			continue
		}
		if invocation.GetRecipientId() != actorID {
			s.core.logger.Warn("Skipped message action invocation with mismatched recipient", "key", key)
			continue
		}
		invocations = append(invocations, &invocation)
	}
	sort.Slice(invocations, func(i, j int) bool {
		left, right := invocations[i], invocations[j]
		if left.GetCreatedAt().AsTime().Equal(right.GetCreatedAt().AsTime()) {
			return left.GetId() < right.GetId()
		}
		return left.GetCreatedAt().AsTime().Before(right.GetCreatedAt().AsTime())
	})
	return invocations, nil
}

// AcknowledgeMessageActionInvocation removes one pending invocation owned by
// the caller. Unknown and concurrently acknowledged IDs are idempotent success.
func (s *MessageModel) AcknowledgeMessageActionInvocation(ctx context.Context, actorID, invocationID string) error {
	if err := requireAuthenticatedActor(actorID); err != nil {
		return err
	}
	if err := validateMessageActionRequestID(invocationID); err != nil {
		return err
	}
	key := messageActionInvocationKey(actorID, invocationID)
	for attempt := 0; attempt < 2; attempt++ {
		entry, err := s.core.storage.runtimeStateKV.Get(ctx, key)
		if errors.Is(err, jetstream.ErrKeyNotFound) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("get message action invocation before acknowledgement: %w", err)
		}
		err = s.core.storage.runtimeStateKV.Delete(ctx, key, jetstream.LastRevision(entry.Revision()))
		if errors.Is(err, jetstream.ErrKeyNotFound) {
			return nil
		}
		if jetstreamutil.IsSequenceConflict(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("delete message action invocation: %w", err)
		}
		return nil
	}
	return errors.New("acknowledge message action invocation after concurrent changes")
}
