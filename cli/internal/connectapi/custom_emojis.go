package connectapi

import (
	"bytes"
	"context"

	"connectrpc.com/connect"

	"hmans.de/chatto/internal/core"
	adminv1 "hmans.de/chatto/internal/pb/chatto/admin/v1"
	apiv1 "hmans.de/chatto/internal/pb/chatto/api/v1"
)

// customEmojiService implements the read side of the server custom emoji
// catalog for any authenticated user.
type customEmojiService struct {
	api *API
}

// ListCustomEmojis returns the full server custom emoji catalog.
func (s *customEmojiService) ListCustomEmojis(ctx context.Context, _ *connect.Request[apiv1.ListCustomEmojisRequest]) (*connect.Response[apiv1.ListCustomEmojisResponse], error) {
	if _, err := requireCaller(ctx); err != nil {
		return nil, err
	}
	return connect.NewResponse(&apiv1.ListCustomEmojisResponse{
		Emojis: s.api.customEmojisToProto(s.api.core.ListCustomEmojis()),
	}), nil
}

// adminCustomEmojiService implements the administrative management surface for
// the server custom emoji catalog. Every RPC requires the server.manage
// permission, enforced inside the core methods.
type adminCustomEmojiService struct {
	api *API
}

// CreateCustomEmoji processes an uploaded image and adds a new custom emoji.
func (s *adminCustomEmojiService) CreateCustomEmoji(ctx context.Context, req *connect.Request[adminv1.CreateCustomEmojiRequest]) (*connect.Response[adminv1.CreateCustomEmojiResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	reader := bytes.NewReader(req.Msg.GetImage().GetImage())
	emoji, err := s.api.core.CreateCustomEmoji(ctx, caller.UserID, req.Msg.GetName(), reader)
	if err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&adminv1.CreateCustomEmojiResponse{
		Emoji: s.api.customEmojiToProto(emoji),
	}), nil
}

// DeleteCustomEmoji removes a custom emoji by ID.
func (s *adminCustomEmojiService) DeleteCustomEmoji(ctx context.Context, req *connect.Request[adminv1.DeleteCustomEmojiRequest]) (*connect.Response[adminv1.DeleteCustomEmojiResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.api.core.DeleteCustomEmoji(ctx, caller.UserID, req.Msg.GetId()); err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&adminv1.DeleteCustomEmojiResponse{}), nil
}

// ListCustomEmojis returns the full server custom emoji catalog for management.
func (s *adminCustomEmojiService) ListCustomEmojis(ctx context.Context, _ *connect.Request[adminv1.ListCustomEmojisRequest]) (*connect.Response[adminv1.ListCustomEmojisResponse], error) {
	if _, err := requireCaller(ctx); err != nil {
		return nil, err
	}
	return connect.NewResponse(&adminv1.ListCustomEmojisResponse{
		Emojis: s.api.customEmojisToProto(s.api.core.ListCustomEmojis()),
	}), nil
}

// customEmojiToProto maps a core custom emoji to its public API shape.
func (a *API) customEmojiToProto(e *core.CustomEmoji) *apiv1.CustomEmoji {
	if e == nil {
		return nil
	}
	return &apiv1.CustomEmoji{
		Id:          e.ID,
		Name:        e.Name,
		Url:         a.core.CustomEmojiURL(e.Asset.GetId()),
		CreatedBy:   e.CreatedBy,
		CreatedAtMs: e.CreatedAtMs,
	}
}

func (a *API) customEmojisToProto(emojis []*core.CustomEmoji) []*apiv1.CustomEmoji {
	result := make([]*apiv1.CustomEmoji, 0, len(emojis))
	for _, e := range emojis {
		result = append(result, a.customEmojiToProto(e))
	}
	return result
}
