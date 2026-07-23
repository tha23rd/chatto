package core

import (
	"context"
	"errors"
	"testing"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

// setupWebhookTest creates a core with an owner actor and a channel room.
func setupWebhookTest(t *testing.T) (context.Context, *ChattoCore, *corev1.User, *corev1.Room) {
	t.Helper()
	core, _ := setupTestCore(t)
	ctx := testContext(t)

	owner, err := core.CreateUser(ctx, SystemActorID, "webhook-owner", "Webhook Owner", "password123")
	if err != nil {
		t.Fatalf("CreateUser owner: %v", err)
	}
	if err := core.AssignServerRole(ctx, SystemActorID, owner.Id, RoleOwner); err != nil {
		t.Fatalf("AssignServerRole owner: %v", err)
	}
	room, err := core.CreateRoom(ctx, owner.Id, KindChannel, "", "webhooks", "Webhook room")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	return ctx, core, owner, room
}

func TestWebhookLifecycle(t *testing.T) {
	ctx, core, owner, room := setupWebhookTest(t)

	webhook, token, err := core.CreateWebhook(ctx, owner.Id, room.Id, "GitHub", nil)
	if err != nil {
		t.Fatalf("CreateWebhook: %v", err)
	}
	if token == "" {
		t.Fatal("expected a non-empty token")
	}
	if webhook.UserID == "" {
		t.Fatal("expected a backing webhook user")
	}
	if webhook.RoomID != room.Id {
		t.Fatalf("webhook room = %q, want %q", webhook.RoomID, room.Id)
	}

	// The backing user is a WEBHOOK-kind user, excluded from the directory but
	// still resolvable directly (for rendering message authors).
	whUser, err := core.GetUser(ctx, webhook.UserID)
	if err != nil {
		t.Fatalf("GetUser(webhook user): %v", err)
	}
	if whUser.GetKind() != corev1.UserKind_USER_KIND_WEBHOOK {
		t.Fatalf("webhook user kind = %v, want WEBHOOK", whUser.GetKind())
	}
	users, err := core.ListUsers(ctx)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	for _, u := range users {
		if u.GetId() == webhook.UserID {
			t.Fatal("webhook user must not appear in the user directory")
		}
	}
	if _, ok := core.Users.GetByLogin(whUser.GetLogin()); ok {
		t.Fatal("webhook user must not be resolvable by login")
	}

	// Token validation.
	if _, err := core.ValidateWebhookToken(ctx, webhook.ID, token); err != nil {
		t.Fatalf("ValidateWebhookToken(valid): %v", err)
	}
	if _, err := core.ValidateWebhookToken(ctx, webhook.ID, "cht_WHwrong"); !errors.Is(err, ErrWebhookNotFound) {
		t.Fatalf("ValidateWebhookToken(bad token) = %v, want ErrWebhookNotFound", err)
	}

	// Listing and room filtering.
	all, err := core.ListWebhooks(ctx, owner.Id, "")
	if err != nil || len(all) != 1 {
		t.Fatalf("ListWebhooks(all) = %d, %v; want 1", len(all), err)
	}
	inRoom, err := core.ListWebhooks(ctx, owner.Id, room.Id)
	if err != nil || len(inRoom) != 1 {
		t.Fatalf("ListWebhooks(room) = %d, %v; want 1", len(inRoom), err)
	}
	elsewhere, err := core.ListWebhooks(ctx, owner.Id, "Rnonexistent")
	if err != nil || len(elsewhere) != 0 {
		t.Fatalf("ListWebhooks(other room) = %d, %v; want 0", len(elsewhere), err)
	}

	// Post a message as the webhook, with a per-message override.
	event, err := core.PostWebhookMessage(ctx, webhook, "hello from CI", "CI Bot", "https://example.com/a.png", nil)
	if err != nil {
		t.Fatalf("PostWebhookMessage: %v", err)
	}
	body, err := core.GetFullMessageBody(ctx, event.GetId())
	if err != nil {
		t.Fatalf("GetFullMessageBody: %v", err)
	}
	if body.AuthorId != webhook.UserID {
		t.Fatalf("message author = %q, want webhook user %q", body.AuthorId, webhook.UserID)
	}
	if body.Body != "hello from CI" {
		t.Fatalf("message body = %q", body.Body)
	}
	if body.WebhookOverride.GetDisplayName() != "CI Bot" {
		t.Fatalf("override display name = %q, want CI Bot", body.WebhookOverride.GetDisplayName())
	}

	// Token rotation invalidates the old token.
	_, newToken, err := core.RegenerateWebhookToken(ctx, owner.Id, webhook.ID)
	if err != nil {
		t.Fatalf("RegenerateWebhookToken: %v", err)
	}
	if _, err := core.ValidateWebhookToken(ctx, webhook.ID, token); !errors.Is(err, ErrWebhookNotFound) {
		t.Fatalf("old token still valid after rotation: %v", err)
	}
	if _, err := core.ValidateWebhookToken(ctx, webhook.ID, newToken); err != nil {
		t.Fatalf("new token invalid after rotation: %v", err)
	}

	// Disabling rejects posts.
	disabled := true
	if _, err := core.UpdateWebhook(ctx, owner.Id, webhook.ID, nil, nil, false, &disabled); err != nil {
		t.Fatalf("UpdateWebhook disable: %v", err)
	}
	if _, err := core.ValidateWebhookToken(ctx, webhook.ID, newToken); !errors.Is(err, ErrWebhookDisabled) {
		t.Fatalf("disabled webhook validate = %v, want ErrWebhookDisabled", err)
	}

	// Deletion invalidates the token but retains the backing user so past
	// messages keep rendering.
	if err := core.DeleteWebhook(ctx, owner.Id, webhook.ID); err != nil {
		t.Fatalf("DeleteWebhook: %v", err)
	}
	if _, err := core.ValidateWebhookToken(ctx, webhook.ID, newToken); !errors.Is(err, ErrWebhookNotFound) {
		t.Fatalf("deleted webhook validate = %v, want ErrWebhookNotFound", err)
	}
	if _, err := core.GetUser(ctx, webhook.UserID); err != nil {
		t.Fatalf("backing webhook user must survive deletion: %v", err)
	}
}

func TestCreateWebhookRequiresServerManage(t *testing.T) {
	ctx, core, _, room := setupWebhookTest(t)

	stranger, err := core.CreateUser(ctx, SystemActorID, "webhook-stranger", "Stranger", "password123")
	if err != nil {
		t.Fatalf("CreateUser stranger: %v", err)
	}
	if _, _, err := core.CreateWebhook(ctx, stranger.Id, room.Id, "Nope", nil); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("CreateWebhook by non-admin = %v, want ErrPermissionDenied", err)
	}
}
