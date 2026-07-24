package connectapi

import (
	"context"

	"hmans.de/chatto/internal/core"
	apiv1 "hmans.de/chatto/internal/pb/chatto/api/v1"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

type userService struct {
	api *API
}

func userSummary(ctx context.Context, api *API, user *corev1.User, avatar *apiv1.ImageTransformOptions) (*apiv1.User, error) {
	presence, err := api.core.GetUserPresence(ctx, user.GetId())
	if err != nil {
		return nil, connectError(err)
	}
	return userSummaryWithPresence(ctx, api, user, avatar, presence)
}

func requiredUserSummary(ctx context.Context, api *API, user *corev1.User) (*apiv1.User, error) {
	if user == nil {
		return nil, connectError(core.ErrNotFound)
	}
	return userSummary(ctx, api, user, nil)
}

func userSummaryWithPresence(ctx context.Context, api *API, user *corev1.User, avatar *apiv1.ImageTransformOptions, presence string) (*apiv1.User, error) {
	summary := &apiv1.User{
		Id:             user.GetId(),
		Login:          user.GetLogin(),
		DisplayName:    user.GetDisplayName(),
		Deleted:        user.GetDeleted(),
		PresenceStatus: corePresenceStatusToAPI(presence),
		CustomStatus:   coreCustomStatusToAPI(user.GetCustomStatus()),
		Kind:           coreUserKindToAPI(user.GetKind()),
		RoleColor:      publicUserRoleColor(api.core, user.GetId()),
	}
	avatarURL, err := userAvatarURL(ctx, api, user.GetId(), avatar)
	if err != nil {
		return nil, err
	}
	if avatarURL != "" {
		summary.AvatarUrl = stringPtr(api.absolutizeAssetURL(ctx, avatarURL))
	}
	return summary, nil
}

func publicUserRoleColor(c *core.ChattoCore, userID string) *uint32 {
	color := c.UserRoleColor(userID)
	if color == 0 {
		return nil
	}
	return &color
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

func userAvatarURL(ctx context.Context, api *API, userID string, avatar *apiv1.ImageTransformOptions) (string, error) {
	if avatar == nil {
		url, err := api.core.GetUserAvatarURL(ctx, userID, nil, nil, "")
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
	url, err := api.core.GetUserAvatarURL(ctx, userID, &width, &height, fit)
	if err != nil {
		return "", connectError(err)
	}
	return url, nil
}
