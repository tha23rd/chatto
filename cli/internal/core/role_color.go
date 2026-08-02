package core

import (
	"context"
	"errors"
	"fmt"

	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

// MaxRoleColor is the largest valid 24-bit RGB role colour.
const MaxRoleColor uint32 = 0xFFFFFF

func validateRoleColor(color uint32) error {
	if color > MaxRoleColor {
		return fmt.Errorf("%w: role color must be a 24-bit RGB value", ErrInvalidArgument)
	}
	return nil
}

func validateRoleColorAssignment(roleName string, color uint32) error {
	if err := validateRoleColor(color); err != nil {
		return err
	}
	if roleName == RoleEveryone {
		return fmt.Errorf("%w: the everyone role cannot have a color", ErrInvalidArgument)
	}
	return nil
}

// UserRoleColor returns the effective member-name colour for a user. As in
// Discord, uncoloured roles are skipped and the highest positioned coloured
// role wins. Zero means clients should use their theme default.
func (p *RBACProjection) UserRoleColor(userID string) uint32 {
	p.RLock()
	defer p.RUnlock()

	var color uint32
	var position int32
	var roleName string
	for assignedRoleName := range p.assignments[userID] {
		role := p.roles[assignedRoleName]
		if role == nil || role.GetColor() == 0 {
			continue
		}
		if color == 0 || role.GetPosition() > position || (role.GetPosition() == position && assignedRoleName < roleName) {
			color = role.GetColor()
			position = role.GetPosition()
			roleName = assignedRoleName
		}
	}
	return color
}

// UserRoleColor returns the effective public member-name colour for a user.
func (c *ChattoCore) UserRoleColor(userID string) uint32 {
	return c.rbacModel.userRoleColor(userID)
}

// UpdateServerRoleColor changes a role's optional 24-bit RGB colour. Built-in
// roles may be coloured, except for the implicit everyone role.
func (c *ChattoCore) UpdateServerRoleColor(ctx context.Context, actorID, name string, color uint32) (*RoleWithPermissions, error) {
	if err := validateRoleColorAssignment(name, color); err != nil {
		return nil, err
	}

	event := newEvent(actorID, &corev1.Event{Event: &corev1.Event_RbacRoleColorChanged{
		RbacRoleColorChanged: &corev1.RbacRoleColorChangedEvent{RoleName: name, Color: color},
	}})
	if _, err := c.appendRBACEvent(ctx, event, func() error {
		existing, ok := c.rbacModel.role(name)
		if !ok {
			return ErrRoleNotFound
		}
		if existing.GetColor() == color {
			return errRBACNoop
		}
		return nil
	}); err != nil && !errors.Is(err, errRBACNoop) {
		return nil, err
	}

	return c.GetServerRole(ctx, name)
}
