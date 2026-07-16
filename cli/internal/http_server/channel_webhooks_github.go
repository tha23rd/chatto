package http_server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/charmbracelet/log"
	"github.com/gin-gonic/gin"
	"hmans.de/chatto/internal/core"
)

const (
	// GitHub payload fields are attacker-influenced and unbounded, while message
	// bodies are capped at core.MaxMessageBodyLength. Truncating each field before
	// assembly keeps a busy push or a novel-length comment from being rejected
	// outright, which would show as a failed delivery in GitHub's webhook log.
	maxGitHubTitleLen     = 200
	maxGitHubBodyLen      = 500
	maxGitHubCommitMsgLen = 120
	maxGitHubCommits      = 10
	// gitHubShortSHALen matches the abbreviated SHA length GitHub's own UI shows.
	gitHubShortSHALen = 7
)

// githubEventFormatters maps an X-GitHub-Event value to a renderer. An event with
// no entry here — including GitHub's "ping" probe sent when a webhook is first
// saved — is acknowledged without posting. A formatter returning "" means "this
// event type is handled, but this particular payload is not worth a message"
// (e.g. a push that carries no commits).
//
// Adding an event should be one entry here plus one test case.
var githubEventFormatters = map[string]func(*githubPayload) string{
	"push":                formatGitHubPush,
	"issues":              formatGitHubIssues,
	"issue_comment":       formatGitHubIssueComment,
	"pull_request":        formatGitHubPullRequest,
	"pull_request_review": formatGitHubPullRequestReview,
	"release":             formatGitHubRelease,
}

// githubPayload is the subset of GitHub's webhook payloads that the formatters
// read. GitHub sends a different shape per event type; the union is decoded
// leniently and each formatter checks the parts it needs. Pointer fields
// distinguish "absent" from "present but empty".
type githubPayload struct {
	Action      string             `json:"action"`
	Ref         string             `json:"ref"`
	Sender      githubUser         `json:"sender"`
	Repository  githubRepo         `json:"repository"`
	Commits     []githubCommit     `json:"commits"`
	Issue       *githubIssue       `json:"issue"`
	PullRequest *githubPullRequest `json:"pull_request"`
	Comment     *githubComment     `json:"comment"`
	Review      *githubReview      `json:"review"`
	Release     *githubRelease     `json:"release"`
}

type githubUser struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

type githubRepo struct {
	FullName string `json:"full_name"`
}

type githubCommit struct {
	ID      string `json:"id"`
	Message string `json:"message"`
	URL     string `json:"url"`
}

type githubIssue struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	HTMLURL string `json:"html_url"`
}

type githubPullRequest struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	HTMLURL string `json:"html_url"`
	Merged  bool   `json:"merged"`
}

type githubComment struct {
	Body    string `json:"body"`
	HTMLURL string `json:"html_url"`
}

type githubReview struct {
	State   string `json:"state"`
	HTMLURL string `json:"html_url"`
}

type githubRelease struct {
	Name    string `json:"name"`
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
}

// handleChannelWebhookGitHub accepts a GitHub webhook delivery and posts it to the
// webhook's room as a markdown message, mirroring Discord's /github endpoint so a
// Chatto webhook URL with "/github" appended can be pasted straight into GitHub's
// webhook settings (Content type: application/json).
//
// Unlike the plain inbound endpoint, an unrenderable-but-well-formed delivery is a
// 204 rather than a 400: GitHub surfaces non-2xx as a failed delivery, and every
// webhook receives event types and a "ping" probe it has no message for.
func (s *HTTPServer) handleChannelWebhookGitHub(c *gin.Context) {
	logger := log.WithPrefix("webhook.github")
	ctx := c.Request.Context()

	webhook, ok := s.authorizeInboundWebhook(c, logger)
	if !ok {
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxWebhookRequestBytes)

	// GitHub identifies the event in a header, not the body, and always sends JSON
	// when the hook is configured with the application/json content type. The
	// form-urlencoded content type is not supported.
	var payload githubPayload
	if err := json.NewDecoder(c.Request.Body).Decode(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON body"})
		return
	}

	eventType := c.GetHeader("X-GitHub-Event")
	formatter, handled := githubEventFormatters[eventType]
	if !handled {
		c.Status(http.StatusNoContent)
		return
	}
	content := formatter(&payload)
	if strings.TrimSpace(content) == "" {
		c.Status(http.StatusNoContent)
		return
	}
	// Backstop: per-field truncation should keep us well inside the limit, but a
	// payload shape we mis-estimated must degrade to a clipped message rather than
	// a failed delivery.
	content = truncateRunes(content, core.MaxMessageBodyLength)

	// With no embed support, the per-message override is what carries provenance:
	// attribute the message to the GitHub actor rather than the webhook's own
	// identity, so a channel of GitHub events reads like the people causing them.
	event, err := s.core.PostWebhookMessage(ctx, webhook, content, payload.Sender.Login, payload.Sender.AvatarURL, nil)
	if err != nil {
		if errors.Is(err, core.ErrMessageTooLong) || errors.Is(err, core.ErrRoomArchived) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		logger.Error("Failed to post GitHub webhook message", "webhook_id", webhook.ID, "event", eventType, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to post message"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message_id": event.GetId()})
}

func formatGitHubPush(p *githubPayload) string {
	// Branch deletes and tag pushes arrive as "push" with no commits; there is
	// nothing useful to say about them yet.
	if len(p.Commits) == 0 {
		return ""
	}
	branch := strings.TrimPrefix(p.Ref, "refs/heads/")

	var b strings.Builder
	fmt.Fprintf(&b, "**%s** — %s to `%s`", p.Repository.FullName, pluralize(len(p.Commits), "new commit", "new commits"), branch)

	shown := p.Commits
	if len(shown) > maxGitHubCommits {
		shown = shown[:maxGitHubCommits]
	}
	for _, commit := range shown {
		msg := truncateRunes(firstLine(commit.Message), maxGitHubCommitMsgLen)
		fmt.Fprintf(&b, "\n- [`%s`](%s) %s", shortSHA(commit.ID), commit.URL, msg)
	}
	if remaining := len(p.Commits) - len(shown); remaining > 0 {
		fmt.Fprintf(&b, "\n- …and %s", pluralize(remaining, "more commit", "more commits"))
	}
	return b.String()
}

func formatGitHubIssues(p *githubPayload) string {
	if p.Issue == nil {
		return ""
	}
	switch p.Action {
	case "opened", "closed", "reopened":
	default:
		return ""
	}
	return fmt.Sprintf("**Issue %s** in %s\n[#%d %s](%s)",
		p.Action, p.Repository.FullName, p.Issue.Number, truncateRunes(p.Issue.Title, maxGitHubTitleLen), p.Issue.HTMLURL)
}

func formatGitHubIssueComment(p *githubPayload) string {
	if p.Issue == nil || p.Comment == nil || p.Action != "created" {
		return ""
	}
	// GitHub sends issue_comment for pull requests too; the payload's issue block
	// is populated either way, so the wording stays neutral.
	body := truncateRunes(strings.TrimSpace(p.Comment.Body), maxGitHubBodyLen)
	out := fmt.Sprintf("**Comment** on [#%d %s](%s)",
		p.Issue.Number, truncateRunes(p.Issue.Title, maxGitHubTitleLen), p.Comment.HTMLURL)
	if body != "" {
		out += "\n" + body
	}
	return out
}

func formatGitHubPullRequest(p *githubPayload) string {
	if p.PullRequest == nil {
		return ""
	}
	var action string
	switch p.Action {
	case "opened", "reopened", "ready_for_review":
		action = p.Action
	case "closed":
		// "closed" covers both merged and abandoned; the distinction is the whole
		// point of the notification.
		action = "closed"
		if p.PullRequest.Merged {
			action = "merged"
		}
	default:
		return ""
	}
	return fmt.Sprintf("**Pull request %s** in %s\n[#%d %s](%s)",
		action, p.Repository.FullName, p.PullRequest.Number,
		truncateRunes(p.PullRequest.Title, maxGitHubTitleLen), p.PullRequest.HTMLURL)
}

func formatGitHubPullRequestReview(p *githubPayload) string {
	if p.PullRequest == nil || p.Review == nil || p.Action != "submitted" {
		return ""
	}
	// A "commented" review with no state worth announcing is noise; approvals and
	// change requests are the signal.
	var state string
	switch strings.ToLower(p.Review.State) {
	case "approved":
		state = "approved"
	case "changes_requested":
		state = "changes requested"
	default:
		return ""
	}
	return fmt.Sprintf("**Review: %s** in %s\n[#%d %s](%s)",
		state, p.Repository.FullName, p.PullRequest.Number,
		truncateRunes(p.PullRequest.Title, maxGitHubTitleLen), p.PullRequest.HTMLURL)
}

func formatGitHubRelease(p *githubPayload) string {
	if p.Release == nil || p.Action != "published" {
		return ""
	}
	// Releases may have no name; the tag is always present and is what people cite.
	name := strings.TrimSpace(p.Release.Name)
	if name == "" {
		name = p.Release.TagName
	}
	return fmt.Sprintf("**Release published** in %s\n[%s](%s)",
		p.Repository.FullName, truncateRunes(name, maxGitHubTitleLen), p.Release.HTMLURL)
}

// truncateRunes clips s to at most max runes, marking elision with an ellipsis.
// It counts runes rather than bytes so multi-byte text is never split mid-rune;
// callers guarding a byte limit should leave headroom.
func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max == 1 {
		return "…"
	}
	return string(runes[:max-1]) + "…"
}

// firstLine returns the first line of s, which for a commit message is its subject.
func firstLine(s string) string {
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		s = s[:idx]
	}
	return strings.TrimSpace(s)
}

// shortSHA abbreviates a commit SHA the way GitHub's UI does, tolerating input
// shorter than the abbreviation length.
func shortSHA(sha string) string {
	if len(sha) <= gitHubShortSHALen {
		return sha
	}
	return sha[:gitHubShortSHALen]
}

func pluralize(n int, singular, plural string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, singular)
	}
	return fmt.Sprintf("%d %s", n, plural)
}
