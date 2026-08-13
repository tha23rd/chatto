import { resolve } from '$app/paths';
import { m } from '$lib/i18n/messages';

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
  canManageInvites: boolean;
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
      label: m('admin.nav.general'),
      icon: 'iconify icon-[uil--setting]'
    });
  }

  if (server.canAdminViewUsers) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/members', { serverId: serverSegment }),
      label: m('admin.nav.members'),
      icon: 'iconify icon-[uil--users-alt]'
    });
  }

  if (server.canManageInvites) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/invite-links', { serverId: serverSegment }),
      label: m('admin.nav.invitations'),
      icon: 'iconify icon-[uil--envelope-share]'
    });
  }

  if (chrome.canManageRooms) {
    items.push({
      href: resolve('/chat/[serverId]/manage/rooms', { serverId: serverSegment }),
      label: m('admin.nav.rooms'),
      icon: 'iconify icon-[uil--apps]'
    });
  }

  if (chrome.canManageEmoji) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/custom-emoji', { serverId: serverSegment }),
      label: m('server_settings.custom_emoji.nav'),
      icon: 'icon-[uil--smile]'
    });
  }

  if (chrome.canManageSoundboard) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/soundboard', { serverId: serverSegment }),
      label: m('soundboard.nav'),
      icon: 'icon-[uil--music]'
    });
  }

  if (chrome.canManage) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/webhooks', { serverId: serverSegment }),
      label: m('server_settings.webhooks.nav'),
      icon: 'icon-[uil--link-add]'
    });
  }

  if (chrome.canViewAdmin) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/moderation', { serverId: serverSegment }),
      label: m('admin.nav.moderation'),
      icon: 'iconify icon-[uil--ban]'
    });
  }

  if (chrome.canManageRoles) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/permissions', { serverId: serverSegment }),
      label: m('admin.nav.permissions'),
      icon: 'iconify icon-[uil--shield-check]'
    });
  }

  if (chrome.canManage) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/security', { serverId: serverSegment }),
      label: m('admin.nav.security'),
      icon: 'iconify icon-[uil--shield-exclamation]'
    });
  }

  if (server.canAdminViewAudit) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/event-log', { serverId: serverSegment }),
      label: m('admin.nav.event_log'),
      icon: 'iconify icon-[uil--history]'
    });
  }

  if (server.canAdminViewSystem) {
    items.push({
      href: resolve('/chat/[serverId]/manage/server/system', { serverId: serverSegment }),
      label: m('admin.nav.system'),
      icon: 'iconify icon-[uil--server]'
    });
  }

  return items;
}
