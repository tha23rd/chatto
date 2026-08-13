import type { DirectoryMember } from '$lib/api-client/memberDirectory';
import type { RoomMember } from './members.svelte';

/**
 * Maps a public directory row to a room member, filtering the virtual
 * `everyone` role. Shared by the paged directory fallback (room members
 * store) and the realtime projection path (server store) so member role
 * names reach the profile popover on every surface.
 *
 * Own module on purpose: server-scope code reuses it without pulling the
 * room members store's API client into its chunk.
 */
export function memberFromDirectory(member: DirectoryMember): RoomMember {
  return {
    id: member.id,
    login: member.login,
    displayName: member.displayName,
    deleted: member.deleted,
    avatarUrl: member.avatarUrl,
    roleColor: member.roleColor,
    // The directory includes the virtual `everyone` role for permission-model
    // parity; UI surfaces show only explicit roles.
    roles: member.roles.filter((roleName) => roleName !== 'everyone'),
    customStatus: member.customStatus,
    presenceStatus: member.presenceStatus
  };
}
