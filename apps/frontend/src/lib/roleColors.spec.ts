import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_COLOR_INPUT,
  MAX_ROLE_COLOR,
  roleColorFromInputValue,
  roleColorToCSS,
  roleColorToInputValue
} from './roleColors';

describe('role colours', () => {
  it('formats 24-bit RGB values with leading zeroes', () => {
    expect(roleColorToCSS(0x00aaff)).toBe('#00aaff');
    expect(roleColorToCSS(MAX_ROLE_COLOR)).toBe('#ffffff');
  });

  it('treats zero and invalid values as the theme default', () => {
    expect(roleColorToCSS(0)).toBeUndefined();
    expect(roleColorToCSS(MAX_ROLE_COLOR + 1)).toBeUndefined();
    expect(roleColorToCSS(1.5)).toBeUndefined();
    expect(roleColorToInputValue(0)).toBe(DEFAULT_ROLE_COLOR_INPUT);
  });

  it('parses native colour input values', () => {
    expect(roleColorFromInputValue('#12AbEf')).toBe(0x12abef);
    expect(roleColorFromInputValue('12abef')).toBe(0);
  });
});
