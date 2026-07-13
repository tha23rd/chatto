import { describe, expect, it } from 'vitest';
import { getEmojiDisplayName, searchCustomEmojis } from './emoji';

describe('searchCustomEmojis', () => {
  const emojis = [
    { name: 'pepeperfect', url: 'u1' },
    { name: 'pepega', url: 'u2' },
    { name: 'kekw', url: 'u3' }
  ];

  it('returns nothing for a blank query', () => {
    expect(searchCustomEmojis(emojis, '')).toEqual([]);
    expect(searchCustomEmojis(emojis, '   ')).toEqual([]);
  });

  it('matches by prefix and substring, case-insensitively', () => {
    const names = searchCustomEmojis(emojis, 'PEP').map((e) => e.name);
    expect(names).toContain('pepeperfect');
    expect(names).toContain('pepega');
    expect(names).not.toContain('kekw');
  });

  it('ranks an exact name match first and carries the image url', () => {
    const results = searchCustomEmojis(emojis, 'pepega');
    expect(results[0].name).toBe('pepega');
    expect(results[0].url).toBe('u2');
  });

  it('honors the result limit', () => {
    expect(searchCustomEmojis(emojis, 'pep', 1)).toHaveLength(1);
  });
});

describe('getEmojiDisplayName', () => {
  it('formats known reaction shortcodes as readable names', () => {
    expect(getEmojiDisplayName('thumbsup')).toBe('Thumbs up');
    expect(getEmojiDisplayName('woman_health_worker')).toBe('Woman Health Worker');
  });

  it('formats unicode emoji as readable names', () => {
    expect(getEmojiDisplayName('🚀')).toBe('Rocket');
    expect(getEmojiDisplayName('❤️')).toBe('Heart');
  });

  it('falls back to a readable version of unknown names', () => {
    expect(getEmojiDisplayName('custom-party')).toBe('Custom Party');
  });
});
