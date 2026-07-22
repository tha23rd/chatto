package core

import (
	"context"
	"fmt"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

type RoleUserSummary struct {
	ID           string
	Login        string
	DisplayName  string
	Deleted      bool
	CustomStatus *corev1.CustomUserStatus
}

type RoleCatalog struct {
	Roles                []RoleWithPermissions
	ViewerCanManageRoles bool
	ViewerCanAssignRoles bool
}

type RoleDetails struct {
	Role                 *RoleWithPermissions
	Users                []RoleUserSummary
	ViewerCanManageRoles bool
	ViewerCanAssignRoles bool
}

type AdminRoleInput struct {
	Name        string
	DisplayName string
	Description string
	Pingable    *bool
	Color       uint32
}

type AdminRoleUpdateInput struct {
	Name        string
	DisplayName *string
	Description *string
	Pingable    *bool
	Color       *uint32
}

func (c *ChattoCore) ListServerRolesForUser(ctx context.Context, actorID string) (*RoleCatalog, error) {
	if actorID == "" {
		return nil, ErrNotAuthenticated
	}
	roles, err := c.ListServerRoles(ctx)
	if err != nil {
		return nil, err
	}
	canManage, err := c.CanManageRoles(ctx, actorID)
	if err != nil {
		return nil, err
	}
	canAssign, err := c.CanAssignRoles(ctx, actorID)
	if err != nil {
		return nil, err
	}
	return &RoleCatalog{
		Roles:                roles,
		ViewerCanManageRoles: canManage,
		ViewerCanAssignRoles: canAssign,
	}, nil
}

func (c *ChattoCore) GetServerRoleDetails(ctx context.Context, actorID, roleName string) (*RoleDetails, error) {
	if actorID == "" {
		return nil, ErrNotAuthenticated
	}
	if roleName == "" {
		return nil, fmt.Errorf("%w: role name is required", ErrInvalidArgument)
	}
	role, err := c.GetServerRole(ctx, roleName)
	if err != nil {
		return nil, err
	}
	canManage, err := c.CanManageRoles(ctx, actorID)
	if err != nil {
		return nil, err
	}
	canAssign, err := c.CanAssignRoles(ctx, actorID)
	if err != nil {
		return nil, err
	}
	details := &RoleDetails{
		Role:                 role,
		ViewerCanManageRoles: canManage,
		ViewerCanAssignRoles: canAssign,
	}
	if canAssign {
		users, err := c.serverRoleUsers(ctx, roleName)
		if err != nil {
			return nil, err
		}
		details.Users = users
	}
	return details, nil
}

func (c *ChattoCore) AdminCreateServerRole(ctx context.Context, actorID string, input AdminRoleInput) (*RoleWithPermissions, error) {
	if err := c.requireCanManageAdminRoles(ctx, actorID); err != nil {
		return nil, err
	}
	pingable := false
	if input.Pingable != nil {
		pingable = *input.Pingable
	}
	return c.CreateServerRoleWithColor(ctx, actorID, input.Name, input.DisplayName, input.Description, pingable, input.Color)
}

func (c *ChattoCore) AdminUpdateServerRole(ctx context.Context, actorID string, input AdminRoleUpdateInput) (*RoleWithPermissions, error) {
	if err := c.requireCanManageAdminRoles(ctx, actorID); err != nil {
		return nil, err
	}
	if input.DisplayName == nil && input.Description == nil && input.Pingable == nil && input.Color == nil {
		return nil, fmt.Errorf("%w: provide at least one role field to update", ErrInvalidArgument)
	}
	if input.Color != nil {
		if err := validateRoleColorAssignment(input.Name, *input.Color); err != nil {
			return nil, err
		}
	}
	role, err := c.GetServerRole(ctx, input.Name)
	if err != nil {
		return nil, err
	}
	displayName := role.DisplayName
	if input.DisplayName != nil {
		displayName = *input.DisplayName
	}
	description := role.Description
	if input.Description != nil {
		description = *input.Description
	}
	if input.DisplayName != nil || input.Description != nil || input.Pingable != nil {
		if input.Pingable != nil {
			role, err = c.UpdateServerRole(ctx, actorID, input.Name, displayName, description, *input.Pingable)
		} else {
			role, err = c.UpdateServerRole(ctx, actorID, input.Name, displayName, description)
		}
		if err != nil {
			return nil, err
		}
	}
	if input.Color != nil {
		return c.UpdateServerRoleColor(ctx, actorID, input.Name, *input.Color)
	}
	return role, nil
}

func (c *ChattoCore) AdminDeleteServerRole(ctx context.Context, actorID, roleName string) error {
	if err := c.requireCanManageAdminRoles(ctx, actorID); err != nil {
		return err
	}
	if roleName == "" {
		return fmt.Errorf("%w: role name is required", ErrInvalidArgument)
	}
	return c.DeleteServerRole(ctx, actorID, roleName)
}

func (c *ChattoCore) AdminReorderServerRoles(ctx context.Context, actorID string, roleNames []string) ([]RoleWithPermissions, error) {
	if err := c.requireCanManageAdminRoles(ctx, actorID); err != nil {
		return nil, err
	}
	if roleNames == nil {
		roleNames = []string{}
	}
	return c.ReorderServerRoles(ctx, actorID, roleNames)
}

func (c *ChattoCore) requireCanManageAdminRoles(ctx context.Context, actorID string) error {
	if actorID == "" {
		return ErrNotAuthenticated
	}
	canManage, err := c.CanManageRoles(ctx, actorID)
	if err != nil {
		return fmt.Errorf("check role.manage: %w", err)
	}
	if !canManage {
		return ErrPermissionDenied
	}
	return nil
}

func (c *ChattoCore) serverRoleUsers(ctx context.Context, roleName string) ([]RoleUserSummary, error) {
	userIDs, err := c.GetRoleUsers(ctx, roleName)
	if err != nil {
		return nil, err
	}
	users := make([]RoleUserSummary, 0, len(userIDs))
	for _, userID := range userIDs {
		user, err := c.GetUser(ctx, userID)
		if err != nil {
			continue
		}
		users = append(users, RoleUserSummary{
			ID:           user.GetId(),
			Login:        user.GetLogin(),
			DisplayName:  user.GetDisplayName(),
			Deleted:      user.GetDeleted(),
			CustomStatus: user.GetCustomStatus(),
		})
	}
	return users, nil
}
