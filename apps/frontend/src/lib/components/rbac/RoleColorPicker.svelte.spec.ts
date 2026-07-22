import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { q } from '$lib/test-utils';
import RoleColorPicker from './RoleColorPicker.svelte';

describe('RoleColorPicker', () => {
  it('shows the configured role colour and reports changes', async () => {
    const onchange = vi.fn();
    const { container } = render(RoleColorPicker, { props: { color: 0x123456, onchange } });
    const input = q(container, '[data-testid="role-color-input"]') as HTMLInputElement;
    expect(input.value).toBe('#123456');

    input.value = '#abcdef';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onchange).toHaveBeenCalledWith(0xabcdef);
  });

  it('can restore the theme default', async () => {
    const onchange = vi.fn();
    const { container } = render(RoleColorPicker, { props: { color: 0x123456, onchange } });

    (q(container, 'button') as HTMLButtonElement).click();

    expect(onchange).toHaveBeenCalledWith(0);
  });
});
