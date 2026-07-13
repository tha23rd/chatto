import { describe, it, expect } from 'vitest';
import { wrapCustomEmojis } from './customEmojiRender';
import type { CustomEmojiLike } from './emoji';

const catalog: Record<string, CustomEmojiLike> = {
  monkachrist: { name: 'monkachrist', url: 'https://ex.test/assets/emoji/monka' },
  pepeperfect: { name: 'pepeperfect', url: 'https://ex.test/assets/emoji/pepe' }
};
const resolve = (name: string): CustomEmojiLike | undefined => catalog[name.toLowerCase()];

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}
function imgs(html: string): HTMLImageElement[] {
  return [...parse(html).querySelectorAll('img.custom-emoji')] as HTMLImageElement[];
}

describe('wrapCustomEmojis', () => {
  it('replaces a known shortcode with an <img>, preserving surrounding text', () => {
    const out = wrapCustomEmojis('<p>hi :monkachrist: there</p>', resolve);
    const found = imgs(out);
    expect(found).toHaveLength(1);
    expect(found[0].getAttribute('src')).toBe('https://ex.test/assets/emoji/monka');
    expect(found[0].getAttribute('alt')).toBe(':monkachrist:');
    expect(parse(out).body.textContent).toBe('hi  there');
  });

  it('leaves an unknown shortcode as literal text', () => {
    const out = wrapCustomEmojis('<p>:notareal: emoji</p>', resolve);
    expect(imgs(out)).toHaveLength(0);
    expect(out).toContain(':notareal:');
  });

  it('renders multiple and adjacent shortcodes', () => {
    const out = wrapCustomEmojis('<p>:monkachrist::pepeperfect: :monkachrist:</p>', resolve);
    expect(imgs(out).map((i) => i.getAttribute('src'))).toEqual([
      'https://ex.test/assets/emoji/monka',
      'https://ex.test/assets/emoji/pepe',
      'https://ex.test/assets/emoji/monka'
    ]);
  });

  it('does not rewrite shortcodes inside code, pre, or links', () => {
    expect(imgs(wrapCustomEmojis('<p><code>:monkachrist:</code></p>', resolve))).toHaveLength(0);
    expect(imgs(wrapCustomEmojis('<pre>:monkachrist:</pre>', resolve))).toHaveLength(0);
    expect(
      imgs(wrapCustomEmojis('<p><a href="https://x.test">:monkachrist:</a></p>', resolve))
    ).toHaveLength(0);
  });

  it('is a no-op when there is no colon', () => {
    const html = '<p>nothing to do here</p>';
    expect(wrapCustomEmojis(html, resolve)).toBe(html);
  });

  it('matches shortcode names case-insensitively via the resolver', () => {
    // The grammar only matches lowercase; the resolver lowercases, so a
    // lowercased shortcode still resolves against a mixed-case catalog entry.
    const out = wrapCustomEmojis('<p>:monkachrist:</p>', (n) =>
      n === 'monkachrist' ? { name: 'MonkaChrist', url: 'u' } : undefined
    );
    expect(imgs(out)[0].getAttribute('alt')).toBe(':MonkaChrist:');
  });
});
