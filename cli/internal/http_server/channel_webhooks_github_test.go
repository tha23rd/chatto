package http_server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"hmans.de/chatto/internal/core"
)

// TestGitHubEventFormatters pins the rendered markdown for each supported event,
// and asserts that events/actions we deliberately ignore render nothing so the
// endpoint can acknowledge them without posting.
func TestGitHubEventFormatters(t *testing.T) {
	tests := []struct {
		name    string
		event   string
		payload string
		want    string
	}{
		{
			name:  "push renders repo, branch and commit list",
			event: "push",
			payload: `{
				"ref": "refs/heads/main",
				"repository": {"full_name": "tha23rd/chatto"},
				"commits": [
					{"id": "abc1234def5678", "message": "fix the thing\n\nlonger body", "url": "https://github.com/c/1"},
					{"id": "9876543210fed", "message": "tidy up", "url": "https://github.com/c/2"}
				]
			}`,
			want: "**tha23rd/chatto** — 2 new commits to `main`\n" +
				"- [`abc1234`](https://github.com/c/1) fix the thing\n" +
				"- [`9876543`](https://github.com/c/2) tidy up",
		},
		{
			name:    "push with a single commit is singular",
			event:   "push",
			payload: `{"ref":"refs/heads/dev","repository":{"full_name":"a/b"},"commits":[{"id":"aaaaaaabbb","message":"one","url":"u"}]}`,
			want:    "**a/b** — 1 new commit to `dev`\n- [`aaaaaaa`](u) one",
		},
		{
			name:    "push with no commits renders nothing",
			event:   "push",
			payload: `{"ref":"refs/tags/v1.0.0","repository":{"full_name":"a/b"},"commits":[]}`,
			want:    "",
		},
		{
			name:    "issue opened",
			event:   "issues",
			payload: `{"action":"opened","repository":{"full_name":"a/b"},"issue":{"number":42,"title":"Broken","html_url":"https://gh/i/42"}}`,
			want:    "**Issue opened** in a/b\n[#42 Broken](https://gh/i/42)",
		},
		{
			name:    "issue action we ignore renders nothing",
			event:   "issues",
			payload: `{"action":"labeled","repository":{"full_name":"a/b"},"issue":{"number":42,"title":"Broken","html_url":"u"}}`,
			want:    "",
		},
		{
			name:    "issue comment created",
			event:   "issue_comment",
			payload: `{"action":"created","repository":{"full_name":"a/b"},"issue":{"number":7,"title":"Q"},"comment":{"body":"  a reply  ","html_url":"https://gh/c/7"}}`,
			want:    "**Comment** on [#7 Q](https://gh/c/7)\na reply",
		},
		{
			name:    "issue comment with empty body omits the body line",
			event:   "issue_comment",
			payload: `{"action":"created","repository":{"full_name":"a/b"},"issue":{"number":7,"title":"Q"},"comment":{"body":"","html_url":"https://gh/c/7"}}`,
			want:    "**Comment** on [#7 Q](https://gh/c/7)",
		},
		{
			name:    "issue comment deleted renders nothing",
			event:   "issue_comment",
			payload: `{"action":"deleted","repository":{"full_name":"a/b"},"issue":{"number":7,"title":"Q"},"comment":{"body":"x","html_url":"u"}}`,
			want:    "",
		},
		{
			name:    "pull request opened",
			event:   "pull_request",
			payload: `{"action":"opened","repository":{"full_name":"a/b"},"pull_request":{"number":9,"title":"Add feature","html_url":"https://gh/p/9"}}`,
			want:    "**Pull request opened** in a/b\n[#9 Add feature](https://gh/p/9)",
		},
		{
			name:    "pull request closed unmerged says closed",
			event:   "pull_request",
			payload: `{"action":"closed","repository":{"full_name":"a/b"},"pull_request":{"number":9,"title":"T","html_url":"u","merged":false}}`,
			want:    "**Pull request closed** in a/b\n[#9 T](u)",
		},
		{
			name:    "pull request closed and merged says merged",
			event:   "pull_request",
			payload: `{"action":"closed","repository":{"full_name":"a/b"},"pull_request":{"number":9,"title":"T","html_url":"u","merged":true}}`,
			want:    "**Pull request merged** in a/b\n[#9 T](u)",
		},
		{
			name:    "pull request synchronize renders nothing",
			event:   "pull_request",
			payload: `{"action":"synchronize","repository":{"full_name":"a/b"},"pull_request":{"number":9,"title":"T","html_url":"u"}}`,
			want:    "",
		},
		{
			name:    "review approved",
			event:   "pull_request_review",
			payload: `{"action":"submitted","repository":{"full_name":"a/b"},"pull_request":{"number":9,"title":"T","html_url":"u"},"review":{"state":"approved"}}`,
			want:    "**Review: approved** in a/b\n[#9 T](u)",
		},
		{
			name:    "review changes requested",
			event:   "pull_request_review",
			payload: `{"action":"submitted","repository":{"full_name":"a/b"},"pull_request":{"number":9,"title":"T","html_url":"u"},"review":{"state":"changes_requested"}}`,
			want:    "**Review: changes requested** in a/b\n[#9 T](u)",
		},
		{
			name:    "review commented renders nothing",
			event:   "pull_request_review",
			payload: `{"action":"submitted","repository":{"full_name":"a/b"},"pull_request":{"number":9,"title":"T","html_url":"u"},"review":{"state":"commented"}}`,
			want:    "",
		},
		{
			name:    "release published",
			event:   "release",
			payload: `{"action":"published","repository":{"full_name":"a/b"},"release":{"name":"v1.2.0 — Fancy","tag_name":"v1.2.0","html_url":"https://gh/r/1"}}`,
			want:    "**Release published** in a/b\n[v1.2.0 — Fancy](https://gh/r/1)",
		},
		{
			name:    "release without a name falls back to the tag",
			event:   "release",
			payload: `{"action":"published","repository":{"full_name":"a/b"},"release":{"name":"","tag_name":"v1.2.0","html_url":"https://gh/r/1"}}`,
			want:    "**Release published** in a/b\n[v1.2.0](https://gh/r/1)",
		},
		{
			name:    "release drafted renders nothing",
			event:   "release",
			payload: `{"action":"created","repository":{"full_name":"a/b"},"release":{"tag_name":"v1","html_url":"u"}}`,
			want:    "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			formatter, ok := githubEventFormatters[tc.event]
			if !ok {
				t.Fatalf("no formatter registered for event %q", tc.event)
			}
			var payload githubPayload
			if err := json.Unmarshal([]byte(tc.payload), &payload); err != nil {
				t.Fatalf("unmarshal fixture: %v", err)
			}
			if got := formatter(&payload); got != tc.want {
				t.Errorf("formatter output mismatch\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}

// TestGitHubFormatterMissingBlocks asserts each formatter tolerates a payload whose
// event-specific block is absent, rather than panicking on a nil dereference. GitHub
// payload shapes vary by event and action, and a panic here is reachable by anyone
// holding the URL.
func TestGitHubFormatterMissingBlocks(t *testing.T) {
	for event, formatter := range githubEventFormatters {
		t.Run(event, func(t *testing.T) {
			// Action is set to the one each formatter accepts, so the nil block is
			// what stops it rather than an early action check.
			for _, action := range []string{"", "opened", "created", "closed", "submitted", "published"} {
				payload := githubPayload{Action: action}
				if got := formatter(&payload); got != "" {
					t.Errorf("action %q: expected empty output for empty payload, got %q", action, got)
				}
			}
		})
	}
}

// TestGitHubPushTruncation asserts a burst push degrades to a capped, clipped
// message that stays inside the message body limit instead of being rejected.
func TestGitHubPushTruncation(t *testing.T) {
	commits := make([]map[string]string, 0, 250)
	longMessage := strings.Repeat("very long commit subject ", 40)
	for i := 0; i < 250; i++ {
		commits = append(commits, map[string]string{
			"id":      fmt.Sprintf("%040d", i),
			"message": longMessage,
			"url":     "https://github.com/tha23rd/chatto/commit/" + fmt.Sprintf("%040d", i),
		})
	}
	body, err := json.Marshal(map[string]any{
		"ref":        "refs/heads/main",
		"repository": map[string]string{"full_name": "tha23rd/chatto"},
		"commits":    commits,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var payload githubPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := formatGitHubPush(&payload)

	if len(got) > core.MaxMessageBodyLength {
		t.Errorf("rendered push is %d bytes, over the %d limit", len(got), core.MaxMessageBodyLength)
	}
	if lines := strings.Count(got, "\n- "); lines != maxGitHubCommits+1 {
		t.Errorf("expected %d commit lines plus an overflow line, got %d", maxGitHubCommits, lines)
	}
	if !strings.Contains(got, "…and 240 more commits") {
		t.Errorf("expected an overflow note naming the dropped commits, got:\n%s", got)
	}
	if !strings.Contains(got, "250 new commits") {
		t.Errorf("expected the true commit count in the header, got:\n%s", got)
	}
}

func TestTruncateRunes(t *testing.T) {
	tests := []struct {
		in   string
		max  int
		want string
	}{
		{"short", 10, "short"},
		{"exact", 5, "exact"},
		{"truncate me", 5, "trun…"},
		{"", 5, ""},
		{"anything", 0, ""},
		{"x", 1, "x"},
		{"xy", 1, "…"},
		// Multi-byte input must not be split mid-rune.
		{"日本語テキスト", 3, "日本…"},
		{"🎉🎉🎉🎉", 2, "🎉…"},
	}
	for _, tc := range tests {
		if got := truncateRunes(tc.in, tc.max); got != tc.want {
			t.Errorf("truncateRunes(%q, %d) = %q, want %q", tc.in, tc.max, got, tc.want)
		}
	}
}

// TestChannelWebhookGitHubEndpoint exercises the /github suffix route, including
// that it registers without a gin tree conflict alongside the plain inbound route.
func TestChannelWebhookGitHubEndpoint(t *testing.T) {
	ts, client, chattoCore := setupTestHTTPServerWithHook(t, func(s *HTTPServer) {
		s.setupWebhookRoutes()
	})
	ctx := testContext(t)

	owner, err := chattoCore.CreateUser(ctx, "system", "gh-hook-owner", "Hook Owner", "password123")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := chattoCore.AssignServerRole(ctx, "system", owner.Id, core.RoleOwner); err != nil {
		t.Fatalf("AssignServerRole: %v", err)
	}
	room, err := chattoCore.CreateRoom(ctx, owner.Id, core.KindChannel, "", "gh-hooks", "GitHub Hooks")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	webhook, token, err := chattoCore.CreateWebhook(ctx, owner.Id, room.Id, "GitHub", nil)
	if err != nil {
		t.Fatalf("CreateWebhook: %v", err)
	}

	post := func(id, tok, event, rawBody string) *http.Response {
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/webhooks/incoming/"+id+"/"+tok+"/github", bytes.NewReader([]byte(rawBody)))
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set("Content-Type", "application/json")
		if event != "" {
			req.Header.Set("X-GitHub-Event", event)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("POST github webhook: %v", err)
		}
		return resp
	}

	pushBody := `{"ref":"refs/heads/main","repository":{"full_name":"tha23rd/chatto"},"sender":{"login":"octocat","avatar_url":"https://avatars.example/u/1"},"commits":[{"id":"abc1234def","message":"ship it","url":"https://gh/c/1"}]}`

	// A renderable delivery posts a message.
	resp := post(webhook.ID, token, "push", pushBody)
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("push status = %d, want 200, body = %s", resp.StatusCode, string(b))
	}
	var okResp map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&okResp)
	resp.Body.Close()
	if okResp["message_id"] == "" {
		t.Fatalf("expected message_id in response, got %#v", okResp)
	}

	// GitHub's setup probe must succeed, or the webhook shows as failing on save.
	resp = post(webhook.ID, token, "ping", `{"zen":"Non-blocking is better than blocking.","hook_id":1}`)
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("ping status = %d, want 204", resp.StatusCode)
	}
	resp.Body.Close()

	// An event we do not format is acknowledged, not rejected.
	resp = post(webhook.ID, token, "star", `{"action":"created","repository":{"full_name":"a/b"}}`)
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("unhandled event status = %d, want 204", resp.StatusCode)
	}
	resp.Body.Close()

	// A handled event whose payload renders nothing is also acknowledged.
	resp = post(webhook.ID, token, "push", `{"ref":"refs/tags/v1","repository":{"full_name":"a/b"},"commits":[]}`)
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("empty push status = %d, want 204", resp.StatusCode)
	}
	resp.Body.Close()

	// A missing event header is treated as unhandled rather than an error.
	resp = post(webhook.ID, token, "", `{}`)
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("missing event header status = %d, want 204", resp.StatusCode)
	}
	resp.Body.Close()

	// Malformed JSON is the one client error the route reports.
	resp = post(webhook.ID, token, "push", `{not json`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("malformed JSON status = %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	// Authorization is inherited from the shared inbound path; assert it applies
	// on this route too.
	resp = post(webhook.ID, "cht_WHbogus", "push", pushBody)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("bad token status = %d, want 404", resp.StatusCode)
	}
	resp.Body.Close()

	disabled := true
	if _, err := chattoCore.UpdateWebhook(ctx, owner.Id, webhook.ID, nil, nil, false, &disabled); err != nil {
		t.Fatalf("UpdateWebhook disable: %v", err)
	}
	resp = post(webhook.ID, token, "push", pushBody)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("disabled webhook status = %d, want 403", resp.StatusCode)
	}
	resp.Body.Close()
}
