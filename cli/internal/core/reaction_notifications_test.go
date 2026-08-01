package core

import (
	"context"
	"testing"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

// reactionNotificationFixture builds a channel with an author and a reactor who
// are both members, plus one message posted by the author.
type reactionNotificationFixture struct {
	core    *ChattoCore
	ctx     context.Context
	roomID  string
	author  *corev1.User
	reactor *corev1.User
	eventID string
}

func setupReactionNotificationFixture(t *testing.T) reactionNotificationFixture {
	t.Helper()

	core, _ := setupTestCore(t)
	ctx := testContext(t)

	author, err := core.CreateUser(ctx, "system", "author", "Author", "password123")
	if err != nil {
		t.Fatalf("CreateUser(author) failed: %v", err)
	}
	reactor, err := core.CreateUser(ctx, "system", "reactor", "Reactor", "password123")
	if err != nil {
		t.Fatalf("CreateUser(reactor) failed: %v", err)
	}

	room, err := core.CreateRoom(ctx, author.Id, KindChannel, "", "reactions", "Reactions")
	if err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}
	if _, err := core.JoinRoom(ctx, author.Id, KindChannel, author.Id, room.Id); err != nil {
		t.Fatalf("JoinRoom(author) failed: %v", err)
	}
	if _, err := core.JoinRoom(ctx, reactor.Id, KindChannel, reactor.Id, room.Id); err != nil {
		t.Fatalf("JoinRoom(reactor) failed: %v", err)
	}

	event, err := core.PostMessage(ctx, KindChannel, room.Id, author.Id, "Hello world", nil, "", "", nil, false)
	if err != nil {
		t.Fatalf("PostMessage failed: %v", err)
	}

	return reactionNotificationFixture{
		core:    core,
		ctx:     ctx,
		roomID:  room.Id,
		author:  author,
		reactor: reactor,
		eventID: event.Id,
	}
}

func (f reactionNotificationFixture) authorNotifications(t *testing.T) []*corev1.Notification {
	t.Helper()
	notifications, err := f.core.GetNotifications(f.ctx, f.author.Id)
	if err != nil {
		t.Fatalf("GetNotifications failed: %v", err)
	}
	return notifications
}

func TestReactionNotification_NotifiesMessageAuthor(t *testing.T) {
	f := setupReactionNotificationFixture(t)

	if _, err := f.core.ReactionModel().addReaction(f.ctx, KindChannel, f.roomID, f.eventID, "thumbsup", f.reactor.Id); err != nil {
		t.Fatalf("addReaction failed: %v", err)
	}

	notifications := f.authorNotifications(t)
	if len(notifications) != 1 {
		t.Fatalf("Expected 1 notification, got %d", len(notifications))
	}

	notification := notifications[0]
	if notification.GetActorId() != f.reactor.Id {
		t.Errorf("Expected actor %q, got %q", f.reactor.Id, notification.GetActorId())
	}
	reaction := notification.GetReaction()
	if reaction == nil {
		t.Fatalf("Expected a reaction payload, got %T", notification.GetNotification())
	}
	if reaction.GetRoomId() != f.roomID {
		t.Errorf("Expected room %q, got %q", f.roomID, reaction.GetRoomId())
	}
	if reaction.GetEventId() != f.eventID {
		t.Errorf("Expected event %q, got %q", f.eventID, reaction.GetEventId())
	}
	if reaction.GetEmoji() != "thumbsup" {
		t.Errorf("Expected emoji %q, got %q", "thumbsup", reaction.GetEmoji())
	}
	if reaction.GetInThread() != "" {
		t.Errorf("Expected no thread root, got %q", reaction.GetInThread())
	}
	if reaction.GetReactionCount() != 1 {
		t.Errorf("Expected reaction count 1, got %d", reaction.GetReactionCount())
	}
}

func TestReactionNotification_SkipsSelfReaction(t *testing.T) {
	f := setupReactionNotificationFixture(t)

	if _, err := f.core.ReactionModel().addReaction(f.ctx, KindChannel, f.roomID, f.eventID, "thumbsup", f.author.Id); err != nil {
		t.Fatalf("addReaction failed: %v", err)
	}

	if notifications := f.authorNotifications(t); len(notifications) != 0 {
		t.Fatalf("Expected no notification for a self-reaction, got %d", len(notifications))
	}
}

func TestReactionNotification_SkipsMutedRoom(t *testing.T) {
	f := setupReactionNotificationFixture(t)

	if err := f.core.SetRoomNotificationLevel(f.ctx, f.author.Id, f.roomID, corev1.NotificationLevel_NOTIFICATION_LEVEL_MUTED); err != nil {
		t.Fatalf("SetRoomNotificationLevel failed: %v", err)
	}

	if _, err := f.core.ReactionModel().addReaction(f.ctx, KindChannel, f.roomID, f.eventID, "thumbsup", f.reactor.Id); err != nil {
		t.Fatalf("addReaction failed: %v", err)
	}

	if notifications := f.authorNotifications(t); len(notifications) != 0 {
		t.Fatalf("Expected no notification in a muted room, got %d", len(notifications))
	}
}

func TestReactionNotification_CollapsesRepeatedReactionsOnOneMessage(t *testing.T) {
	f := setupReactionNotificationFixture(t)

	third, err := f.core.CreateUser(f.ctx, "system", "third", "Third", "password123")
	if err != nil {
		t.Fatalf("CreateUser(third) failed: %v", err)
	}
	if _, err := f.core.JoinRoom(f.ctx, third.Id, KindChannel, third.Id, f.roomID); err != nil {
		t.Fatalf("JoinRoom(third) failed: %v", err)
	}

	if _, err := f.core.ReactionModel().addReaction(f.ctx, KindChannel, f.roomID, f.eventID, "thumbsup", f.reactor.Id); err != nil {
		t.Fatalf("addReaction(reactor) failed: %v", err)
	}
	firstID := f.authorNotifications(t)[0].GetId()

	if _, err := f.core.ReactionModel().addReaction(f.ctx, KindChannel, f.roomID, f.eventID, "heart", third.Id); err != nil {
		t.Fatalf("addReaction(third) failed: %v", err)
	}

	notifications := f.authorNotifications(t)
	if len(notifications) != 1 {
		t.Fatalf("Expected reactions on one message to collapse into 1 notification, got %d", len(notifications))
	}

	notification := notifications[0]
	if notification.GetId() != firstID {
		t.Errorf("Expected the collapsed notification to keep ID %q, got %q", firstID, notification.GetId())
	}
	if notification.GetActorId() != third.Id {
		t.Errorf("Expected the newest reactor %q as actor, got %q", third.Id, notification.GetActorId())
	}
	reaction := notification.GetReaction()
	if reaction.GetEmoji() != "heart" {
		t.Errorf("Expected the newest emoji %q, got %q", "heart", reaction.GetEmoji())
	}
	if reaction.GetReactionCount() != 2 {
		t.Errorf("Expected reaction count 2, got %d", reaction.GetReactionCount())
	}
}

func TestReactionNotification_SeparateMessagesDoNotCollapse(t *testing.T) {
	f := setupReactionNotificationFixture(t)

	second, err := f.core.PostMessage(f.ctx, KindChannel, f.roomID, f.author.Id, "Second message", nil, "", "", nil, false)
	if err != nil {
		t.Fatalf("PostMessage failed: %v", err)
	}

	if _, err := f.core.ReactionModel().addReaction(f.ctx, KindChannel, f.roomID, f.eventID, "thumbsup", f.reactor.Id); err != nil {
		t.Fatalf("addReaction(first) failed: %v", err)
	}
	if _, err := f.core.ReactionModel().addReaction(f.ctx, KindChannel, f.roomID, second.Id, "thumbsup", f.reactor.Id); err != nil {
		t.Fatalf("addReaction(second) failed: %v", err)
	}

	if notifications := f.authorNotifications(t); len(notifications) != 2 {
		t.Fatalf("Expected 2 notifications for 2 reacted-to messages, got %d", len(notifications))
	}
}

func TestReactionNotification_RecordsThreadRoot(t *testing.T) {
	f := setupReactionNotificationFixture(t)

	reply, err := f.core.PostMessage(f.ctx, KindChannel, f.roomID, f.author.Id, "Thread reply", nil, f.eventID, f.eventID, nil, false)
	if err != nil {
		t.Fatalf("PostMessage(reply) failed: %v", err)
	}

	if _, err := f.core.ReactionModel().addReaction(f.ctx, KindChannel, f.roomID, reply.Id, "thumbsup", f.reactor.Id); err != nil {
		t.Fatalf("addReaction failed: %v", err)
	}

	notifications := f.authorNotifications(t)
	if len(notifications) != 1 {
		t.Fatalf("Expected 1 notification, got %d", len(notifications))
	}
	if got := notifications[0].GetReaction().GetInThread(); got != f.eventID {
		t.Errorf("Expected thread root %q, got %q", f.eventID, got)
	}
}
