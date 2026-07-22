/** Discovery capability for additive role colour fields and mutations. */
export const ROLE_COLORS_CAPABILITY = 'chatto.role-colors.v1';

export const MAX_ROLE_COLOR = 0xffffff;
export const DEFAULT_ROLE_COLOR_INPUT = '#5865f2';

/** Convert a protobuf 24-bit RGB integer to a CSS colour. Zero means unset. */
export function roleColorToCSS(color: number | null | undefined): string | undefined {
  if (!Number.isInteger(color) || !color || color < 0 || color > MAX_ROLE_COLOR) return undefined;
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Convert a role colour to the value expected by a native colour input. */
export function roleColorToInputValue(color: number | null | undefined): string {
  return roleColorToCSS(color) ?? DEFAULT_ROLE_COLOR_INPUT;
}

/** Convert a native colour input value to the protobuf 24-bit RGB integer. */
export function roleColorFromInputValue(value: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return 0;
  return Number.parseInt(value.slice(1), 16);
}
