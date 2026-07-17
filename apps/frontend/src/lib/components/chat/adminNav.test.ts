import { describe, expect, it } from 'vitest';
import { getAdminNavItems, type AdminNavChromePermissions, type AdminNavServerPermissions } from './adminNav';

function chrome(overrides: Partial<AdminNavChromePermissions> = {}): AdminNavChromePermissions {
  return {
    canViewAdmin: false,
    canManage: false,
    canManageEmoji: false,
    canManageSoundboard: false,
    canManageRooms: false,
    canManageRoles: false,
    canAssignRoles: false,
    canManageUserAccounts: false,
    canManageUserPermissions: false,
    ...overrides
  };
}

function server(overrides: Partial<AdminNavServerPermissions> = {}): AdminNavServerPermissions {
  return {
    canViewAdmin: false,
    canAdminViewUsers: false,
    canAdminViewRoles: false,
    canAdminViewAudit: false,
    canAdminViewSystem: false,
    ...overrides
  };
}

describe('getAdminNavItems', () => {
  it('shows Members for admin user viewers', () => {
    const items = getAdminNavItems({
      serverSegment: 'local',
      chrome: chrome({ canViewAdmin: true }),
      server: server({ canAdminViewUsers: true })
    });

    expect(items.some((item) => item.label === 'Members')).toBe(true);
  });

  it('hides Members for role assignment without admin user view', () => {
    const items = getAdminNavItems({
      serverSegment: 'local',
      chrome: chrome({ canViewAdmin: true, canAssignRoles: true }),
      server: server()
    });

    expect(items.some((item) => item.label === 'Members')).toBe(false);
  });

  it('hides Permissions without role management', () => {
    const items = getAdminNavItems({
      serverSegment: 'local',
      chrome: chrome({ canViewAdmin: true, canAssignRoles: true }),
      server: server({ canAdminViewRoles: true })
    });

    expect(items.some((item) => item.label === 'Permissions')).toBe(false);
  });

  it('shows Permissions for role managers', () => {
    const items = getAdminNavItems({
      serverSegment: 'local',
      chrome: chrome({ canViewAdmin: true, canManageRoles: true }),
      server: server()
    });

    expect(items.some((item) => item.label === 'Permissions')).toBe(true);
  });

  it('shows only Custom Emoji for emoji managers with no other admin access', () => {
    // An emoji-only role holds neither canViewAdmin nor server management, yet
    // must still get the Custom Emoji entry (and nothing else).
    const items = getAdminNavItems({
      serverSegment: 'local',
      chrome: chrome({ canViewAdmin: false, canManageEmoji: true, canManage: false }),
      server: server()
    });

    expect(items.map((item) => item.label)).toEqual(['Custom Emoji']);
  });

  it('hides Custom Emoji without emoji management', () => {
    const items = getAdminNavItems({
      serverSegment: 'local',
      chrome: chrome({ canViewAdmin: true, canManage: false, canManageEmoji: false }),
      server: server()
    });

    expect(items.some((item) => item.label === 'Custom Emoji')).toBe(false);
  });

  it('shows only Soundboard for soundboard managers with no other admin access', () => {
    const items = getAdminNavItems({
      serverSegment: 'local',
      chrome: chrome({ canViewAdmin: false, canManageSoundboard: true, canManage: false }),
      server: server()
    });

    expect(items.map((item) => item.label)).toEqual(['Soundboard']);
  });

  it('hides Soundboard without soundboard management', () => {
    const items = getAdminNavItems({
      serverSegment: 'local',
      chrome: chrome({ canViewAdmin: true, canManage: false, canManageSoundboard: false }),
      server: server()
    });

    expect(items.some((item) => item.label === 'Soundboard')).toBe(false);
  });
});
