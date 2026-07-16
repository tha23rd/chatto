package connectapi

import (
	"context"

	apiv1 "hmans.de/chatto/internal/pb/chatto/api/v1"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

type userService struct {
	api *API
}

func (s *userService) userSummary(ctx context.Context, user *corev1.User, avatar *apiv1.ImageTransformOptions) (*apiv1.User, error) {
	presence, err := s.api.core.GetUserPresence(ctx, user.GetId())
	if err != nil {
		return nil, connectError(err)
	}
	summary := &apiv1.User{
		Id:             user.GetId(),
		Login:          user.GetLogin(),
		DisplayName:    user.GetDisplayName(),
		Deleted:        user.GetDeleted(),
		PresenceStatus: corePresenceStatusToAPI(presence),
		CustomStatus:   coreCustomStatusToAPI(user.GetCustomStatus()),
		Kind:           coreUserKindToAPI(user.GetKind()),
	}
	avatarURL, err := s.userAvatarURL(ctx, user.GetId(), avatar)
	if err != nil {
		return nil, err
	}
	if avatarURL != "" {
		summary.AvatarUrl = stringPtr(s.api.absolutizeAssetURL(ctx, avatarURL))
	}
	return summary, nil
}

// coreUserKindToAPI maps the durable user kind to its public API enum.
func coreUserKindToAPI(kind corev1.UserKind) apiv1.UserKind {
	switch kind {
	case corev1.UserKind_USER_KIND_WEBHOOK:
		return apiv1.UserKind_USER_KIND_WEBHOOK
	case corev1.UserKind_USER_KIND_HUMAN:
		return apiv1.UserKind_USER_KIND_HUMAN
	default:
		return apiv1.UserKind_USER_KIND_UNSPECIFIED
	}
}

func (s *userService) userAvatarURL(ctx context.Context, userID string, avatar *apiv1.ImageTransformOptions) (string, error) {
	if avatar == nil {
		url, err := s.api.core.GetUserAvatarURL(ctx, userID, nil, nil, "")
		if err != nil {
			return "", connectError(err)
		}
		return url, nil
	}

	width, height := int(avatar.GetWidth()), int(avatar.GetHeight())
	fit := "cover"
	if avatar.GetFit() == apiv1.ImageFitMode_IMAGE_FIT_MODE_CONTAIN {
		fit = "contain"
	}
	url, err := s.api.core.GetUserAvatarURL(ctx, userID, &width, &height, fit)
	if err != nil {
		return "", connectError(err)
	}
	return url, nil
}
