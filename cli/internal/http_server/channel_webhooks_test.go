package http_server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"hmans.de/chatto/internal/core"
)

// TestChannelWebhookEndpoint exercises the unauthenticated inbound webhook route
// end to end, including that the route registers without a gin tree conflict.
func TestChannelWebhookEndpoint(t *testing.T) {
	ts, client, chattoCore := setupTestHTTPServerWithHook(t, func(s *HTTPServer) {
		s.setupWebhookRoutes()
	})
	ctx := testContext(t)

	owner, err := chattoCore.CreateUser(ctx, "system", "hook-owner", "Hook Owner", "password123")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := chattoCore.AssignServerRole(ctx, "system", owner.Id, core.RoleOwner); err != nil {
		t.Fatalf("AssignServerRole: %v", err)
	}
	room, err := chattoCore.CreateRoom(ctx, owner.Id, core.KindChannel, "", "hooks", "Hooks")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	webhook, token, err := chattoCore.CreateWebhook(ctx, owner.Id, room.Id, "CI", nil)
	if err != nil {
		t.Fatalf("CreateWebhook: %v", err)
	}

	post := func(id, tok string, payload any) *http.Response {
		body, _ := json.Marshal(payload)
		resp, err := client.Post(ts.URL+"/webhooks/incoming/"+id+"/"+tok, "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST webhook: %v", err)
		}
		return resp
	}

	// Valid post.
	resp := post(webhook.ID, token, map[string]string{"content": "hello from webhook"})
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("valid post status = %d, body = %s", resp.StatusCode, string(b))
	}
	var okResp map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&okResp)
	resp.Body.Close()
	if okResp["message_id"] == "" {
		t.Fatalf("expected message_id in response, got %#v", okResp)
	}

	// Empty content and no attachments is a bad request.
	resp = post(webhook.ID, token, map[string]string{"content": ""})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty post status = %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	// Wrong token is not found.
	resp = post(webhook.ID, "cht_WHbogus", map[string]string{"content": "nope"})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("bad token status = %d, want 404", resp.StatusCode)
	}
	resp.Body.Close()

	// Disabled webhook is forbidden.
	disabled := true
	if _, err := chattoCore.UpdateWebhook(ctx, owner.Id, webhook.ID, nil, nil, false, &disabled); err != nil {
		t.Fatalf("UpdateWebhook disable: %v", err)
	}
	resp = post(webhook.ID, token, map[string]string{"content": "after disable"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("disabled webhook status = %d, want 403", resp.StatusCode)
	}
	resp.Body.Close()
}
