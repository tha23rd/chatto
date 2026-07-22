package core

import (
	"errors"
	"testing"
)

func TestChattoCore_RoleColorResolution(t *testing.T) {
	chatto, _ := setupTestCore(t)
	ctx := testContext(t)
	const userID = "role-color-user"

	custom, err := chatto.CreateServerRoleWithColor(
		ctx,
		SystemActorID,
		"teal-team",
		"Teal Team",
		"",
		false,
		0x008080,
	)
	if err != nil {
		t.Fatalf("CreateServerRoleWithColor: %v", err)
	}
	if custom.Color != 0x008080 {
		t.Fatalf("created role color = %#x, want %#x", custom.Color, uint32(0x008080))
	}

	admin, err := chatto.UpdateServerRoleColor(ctx, SystemActorID, RoleAdmin, 0xFF3366)
	if err != nil {
		t.Fatalf("UpdateServerRoleColor(admin): %v", err)
	}
	if admin.Color != 0xFF3366 {
		t.Fatalf("admin color = %#x, want %#x", admin.Color, uint32(0xFF3366))
	}

	for _, roleName := range []string{"teal-team", RoleAdmin, RoleOwner} {
		if err := chatto.AssignServerRole(ctx, SystemActorID, userID, roleName); err != nil {
			t.Fatalf("AssignServerRole(%s): %v", roleName, err)
		}
	}
	if got := chatto.UserRoleColor(userID); got != 0xFF3366 {
		t.Fatalf("effective role color = %#x, want higher positioned coloured admin %#x", got, uint32(0xFF3366))
	}

	if _, err := chatto.UpdateServerRoleColor(ctx, SystemActorID, RoleAdmin, 0); err != nil {
		t.Fatalf("clear admin color: %v", err)
	}
	if got := chatto.UserRoleColor(userID); got != 0x008080 {
		t.Fatalf("effective role color after clear = %#x, want custom fallback %#x", got, uint32(0x008080))
	}
}

func TestChattoCore_RoleColorValidation(t *testing.T) {
	chatto, _ := setupTestCore(t)
	ctx := testContext(t)

	if _, err := chatto.UpdateServerRoleColor(ctx, SystemActorID, RoleEveryone, 0x123456); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("UpdateServerRoleColor(everyone) error = %v, want ErrInvalidArgument", err)
	}
	if _, err := chatto.UpdateServerRoleColor(ctx, SystemActorID, RoleModerator, MaxRoleColor+1); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("UpdateServerRoleColor(out of range) error = %v, want ErrInvalidArgument", err)
	}
}
