package connectapi

import (
	"context"

	"connectrpc.com/connect"

	"hmans.de/chatto/internal/core"
	adminv1 "hmans.de/chatto/internal/pb/chatto/admin/v1"
)

// adminWebhookService implements the administrative management surface for
// channel webhooks. Every RPC requires the server.manage permission, enforced
// inside the core methods.
type adminWebhookService struct {
	api *API
}

// CreateWebhook creates a webhook against a room and returns its one-time secret.
func (s *adminWebhookService) CreateWebhook(ctx context.Context, req *connect.Request[adminv1.CreateWebhookRequest]) (*connect.Response[adminv1.CreateWebhookResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	webhook, token, err := s.api.core.CreateWebhook(ctx, caller.UserID, req.Msg.GetRoomId(), req.Msg.GetName(), req.Msg.GetAvatar().GetImage())
	if err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&adminv1.CreateWebhookResponse{
		Webhook: s.api.webhookToProto(ctx, webhook),
		Token:   token,
		Url:     s.api.core.WebhookPostURL(webhook.ID, token),
	}), nil
}

// UpdateWebhook updates a webhook's name, avatar, or disabled state.
func (s *adminWebhookService) UpdateWebhook(ctx context.Context, req *connect.Request[adminv1.UpdateWebhookRequest]) (*connect.Response[adminv1.UpdateWebhookResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	var name *string
	if req.Msg.Name != nil {
		name = req.Msg.Name
	}
	var disabled *bool
	if req.Msg.Disabled != nil {
		disabled = req.Msg.Disabled
	}
	webhook, err := s.api.core.UpdateWebhook(ctx, caller.UserID, req.Msg.GetId(), name, req.Msg.GetAvatar().GetImage(), req.Msg.GetClearAvatar(), disabled)
	if err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&adminv1.UpdateWebhookResponse{
		Webhook: s.api.webhookToProto(ctx, webhook),
	}), nil
}

// DeleteWebhook removes a webhook by ID.
func (s *adminWebhookService) DeleteWebhook(ctx context.Context, req *connect.Request[adminv1.DeleteWebhookRequest]) (*connect.Response[adminv1.DeleteWebhookResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.api.core.DeleteWebhook(ctx, caller.UserID, req.Msg.GetId()); err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&adminv1.DeleteWebhookResponse{}), nil
}

// ListWebhooks returns webhooks for management, optionally filtered to one room.
func (s *adminWebhookService) ListWebhooks(ctx context.Context, req *connect.Request[adminv1.ListWebhooksRequest]) (*connect.Response[adminv1.ListWebhooksResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	webhooks, err := s.api.core.ListWebhooks(ctx, caller.UserID, req.Msg.GetRoomId())
	if err != nil {
		return nil, connectError(err)
	}
	out := make([]*adminv1.Webhook, 0, len(webhooks))
	for _, webhook := range webhooks {
		out = append(out, s.api.webhookToProto(ctx, webhook))
	}
	return connect.NewResponse(&adminv1.ListWebhooksResponse{Webhooks: out}), nil
}

// RegenerateWebhookToken issues a new secret token, invalidating the old URL.
func (s *adminWebhookService) RegenerateWebhookToken(ctx context.Context, req *connect.Request[adminv1.RegenerateWebhookTokenRequest]) (*connect.Response[adminv1.RegenerateWebhookTokenResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	webhook, token, err := s.api.core.RegenerateWebhookToken(ctx, caller.UserID, req.Msg.GetId())
	if err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&adminv1.RegenerateWebhookTokenResponse{
		Webhook: s.api.webhookToProto(ctx, webhook),
		Token:   token,
		Url:     s.api.core.WebhookPostURL(webhook.ID, token),
	}), nil
}

// webhookToProto maps a core webhook to its admin API shape. The avatar URL is
// resolved from the backing webhook user, which owns the avatar asset.
func (a *API) webhookToProto(ctx context.Context, w *core.Webhook) *adminv1.Webhook {
	if w == nil {
		return nil
	}
	out := &adminv1.Webhook{
		Id:          w.ID,
		RoomId:      w.RoomID,
		Name:        w.Name,
		CreatedBy:   w.CreatedBy,
		CreatedAtMs: w.CreatedAtMs,
		Disabled:    w.Disabled,
		UserId:      w.UserID,
	}
	if url, err := a.core.GetUserAvatarURL(ctx, w.UserID, nil, nil, ""); err == nil && url != "" {
		absolute := a.absolutizeAssetURL(ctx, url)
		out.AvatarUrl = &absolute
	}
	return out
}
