package connectapi

import (
	"context"

	"connectrpc.com/connect"

	"hmans.de/chatto/internal/core"
	adminv1 "hmans.de/chatto/internal/pb/chatto/admin/v1"
	apiv1 "hmans.de/chatto/internal/pb/chatto/api/v1"
)

// soundboardService implements the read side of the server soundboard catalog
// for any authenticated user.
type soundboardService struct {
	api *API
}

// ListSounds returns the full server soundboard catalog.
func (s *soundboardService) ListSounds(ctx context.Context, _ *connect.Request[apiv1.ListSoundsRequest]) (*connect.Response[apiv1.ListSoundsResponse], error) {
	if _, err := requireCaller(ctx); err != nil {
		return nil, err
	}
	return connect.NewResponse(&apiv1.ListSoundsResponse{
		Sounds: s.api.soundsToProto(s.api.core.ListSounds()),
	}), nil
}

// adminSoundboardService implements the administrative management surface for
// the server soundboard catalog. Every mutating RPC requires the
// soundboard.manage (or server.manage) permission, enforced inside the core
// methods.
type adminSoundboardService struct {
	api *API
}

// CreateSound validates an uploaded audio clip and adds a new sound.
func (s *adminSoundboardService) CreateSound(ctx context.Context, req *connect.Request[adminv1.CreateSoundRequest]) (*connect.Response[adminv1.CreateSoundResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	audio := req.Msg.GetAudio()
	sound, err := s.api.core.CreateSound(
		ctx,
		caller.UserID,
		req.Msg.GetName(),
		req.Msg.GetEmoji(),
		req.Msg.GetVolume(),
		audio.GetAudio(),
		audio.GetContentType(),
	)
	if err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&adminv1.CreateSoundResponse{
		Sound: s.api.soundToProto(sound),
	}), nil
}

// DeleteSound removes a sound by ID.
func (s *adminSoundboardService) DeleteSound(ctx context.Context, req *connect.Request[adminv1.DeleteSoundRequest]) (*connect.Response[adminv1.DeleteSoundResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.api.core.DeleteSound(ctx, caller.UserID, req.Msg.GetId()); err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&adminv1.DeleteSoundResponse{}), nil
}

// ListSounds returns the full server soundboard catalog for management.
func (s *adminSoundboardService) ListSounds(ctx context.Context, _ *connect.Request[adminv1.ListSoundsRequest]) (*connect.Response[adminv1.ListSoundsResponse], error) {
	if _, err := requireCaller(ctx); err != nil {
		return nil, err
	}
	return connect.NewResponse(&adminv1.ListSoundsResponse{
		Sounds: s.api.soundsToProto(s.api.core.ListSounds()),
	}), nil
}

// soundToProto maps a core sound to its public API shape.
func (a *API) soundToProto(s *core.Sound) *apiv1.Sound {
	if s == nil {
		return nil
	}
	return &apiv1.Sound{
		Id:          s.ID,
		Name:        s.Name,
		Url:         a.core.SoundURL(s.Asset.GetId()),
		Emoji:       s.Emoji,
		Volume:      s.Volume,
		CreatedBy:   s.CreatedBy,
		CreatedAtMs: s.CreatedAtMs,
		DurationMs:  s.DurationMs,
	}
}

func (a *API) soundsToProto(sounds []*core.Sound) []*apiv1.Sound {
	result := make([]*apiv1.Sound, 0, len(sounds))
	for _, s := range sounds {
		result = append(result, a.soundToProto(s))
	}
	return result
}
