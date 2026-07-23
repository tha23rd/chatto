import { resolve } from '$app/paths';
import * as m from '$lib/i18n/messages';

export type AdminNavChromePermissions = {
  canViewAdmin: boolean;
  canManage: boolean;
  canManageEmoji: boolean;
  canManageSoundboard: boolean;
  canManageRooms: boolean;
  canManageRoles: boolean;
  canAssignRoles: boolean;
  canManageUserAccounts: boolean;
  canManageUserPermissions: boolean;
};

export type AdminNavServerPermissions = {
  canViewAdmin: boolean;
  canAdminViewUsers: boolean;
  canAdminViewRoles: boolean;
  canAdminViewAudit: boolean;
  canAdminViewSystem: boolean;
};

export type AdminNavItem = {
  href: string;
  label: string;
  icon: string;
};

export function getAdminNavItems({
  serverSegment,
  chrome,
  server
}: {
  serverSegment: string;
  chrome: AdminNavChromePermissions | null;
  server: AdminNavServerPermissions;
}): AdminNavItem[] {
  if (!chrome) return [];
  // Emoji/soundboard managers may hold no other admin capability, so admit them
  // here too; the per-item guards below still limit them to their entry.
  if (
    !chrome.canViewAdmin &&
    !server.canViewAdmin &&
    !chrome.canManageEmoji &&
    !chrome.canManageSoundboard
  )
    return [];

  const items: AdminNavItem[] = [];

  if (chrome.canManage) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/general', { serverId: serverSegment }),
      label: m['admin.nav.general'](),
      icon: 'iconify uil--setting'
    });
  }

  if (server.canAdminViewUsers) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/members', { serverId: serverSegment }),
      label: m['admin.nav.members'](),
      icon: 'iconify uil--users-alt'
    });
  }

  if (chrome.canManageRooms) {
    items.push({
      href: resolve('/chat/[serverId]/manage/rooms', { serverId: serverSegment }),
      label: m['admin.nav.rooms'](),
      icon: 'iconify uil--apps'
    });
  }

  if (chrome.canManageEmoji) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/custom-emoji', { serverId: serverSegment }),
      label: m['server_settings.custom_emoji.nav'](),
      icon: 'iconify uil--smile'
    });
  }

  if (chrome.canManageSoundboard) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/soundboard', { serverId: serverSegment }),
      label: m['soundboard.nav'](),
      icon: 'iconify uil--music'
    });
  }

  if (chrome.canManage) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/webhooks', { serverId: serverSegment }),
      label: m['server_settings.webhooks.nav'](),
      icon: 'iconify uil--link-add'
    });
  }

  if (chrome.canViewAdmin) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/moderation', { serverId: serverSegment }),
      label: m['admin.nav.moderation'](),
      icon: 'iconify uil--ban'
    });
  }

  if (chrome.canManageRoles) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/permissions', { serverId: serverSegment }),
      label: m['admin.nav.permissions'](),
      icon: 'iconify uil--shield-check'
    });
  }

  if (chrome.canManage) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/security', { serverId: serverSegment }),
      label: m['admin.nav.security'](),
      icon: 'iconify uil--shield-exclamation'
    });
  }

  if (server.canAdminViewAudit) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/event-log', { serverId: serverSegment }),
      label: m['admin.nav.event_log'](),
      icon: 'iconify uil--history'
    });
  }

  if (server.canAdminViewSystem) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/system', { serverId: serverSegment }),
      label: m['admin.nav.system'](),
      icon: 'iconify uil--server'
    });
  }

  return items;
}
