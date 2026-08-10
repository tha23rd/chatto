import { createContext } from 'svelte';

export type MentionRole = {
  name: string;
  /** Display name shown in user-facing role UIs. */
  displayName: string;
  isSystem: boolean;
  position: number;
  pingable: boolean;
  /** Optional 24-bit RGB role colour; undefined means the theme default. */
  color?: number;
};

const [getMentionRolesState, setMentionRolesState] = createContext<() => MentionRole[]>();

export function createMentionRoles(getRoles: () => MentionRole[] = () => []) {
  setMentionRolesState(getRoles);
}

export function getMentionRoles(): MentionRole[] {
  return getMentionRolesState()();
}
