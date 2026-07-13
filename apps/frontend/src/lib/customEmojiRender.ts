/**
 * Post-render pass that replaces `:shortcode:` references to known custom
 * emojis with their `<img>` in already-rendered message HTML.
 *
 * This is a reviewed markdown post-processing step (like `wrapValidMentions`):
 * markdown-it runs first with HTML and images disabled, then this walks the
 * resulting DOM text nodes and swaps only shortcodes that resolve to a real
 * server custom emoji. Unknown `:words:` are left as plain text, and text
 * inside code/preformatted/link elements is never touched. Image attributes
 * are set via the DOM (not string concatenation), and the shortcode grammar is
 * constrained to the backend's `[a-z0-9_]` name charset, so no user input
 * reaches markup unescaped.
 */

import { parseTrustedMarkdownHtml } from '$lib/security/trustedHtml';
import type { CustomEmojiLike } from '$lib/emoji';

/**
 * Elements whose text content must not be rewritten: code/preformatted content
 * (shortcodes there are literal) and anchors (avoid rewriting link text).
 */
const EXCLUDED_ELEMENTS = ['PRE', 'CODE', 'A'];

/**
 * Fresh regex per call to avoid persistent `lastIndex` state. Matches the
 * backend custom-emoji name grammar (`[a-z0-9_]{1,64}`) wrapped in colons.
 */
function createShortcodeRegex(): RegExp {
  return /:([a-z0-9_]{1,64}):/g;
}

function isInsideExcludedElement(node: Node): boolean {
  let current: Node | null = node.parentNode;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    if (EXCLUDED_ELEMENTS.includes((current as Element).tagName)) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Replace `:name:` shortcodes that resolve to a known custom emoji with an
 * inline `<img class="custom-emoji">`. Returns the HTML unchanged when there is
 * nothing to do.
 *
 * @param html - Rendered (and mention-wrapped) message HTML.
 * @param resolve - Looks up a custom emoji by shortcode name, or `undefined`.
 */
export function wrapCustomEmojis(
  html: string,
  resolve: (name: string) => CustomEmojiLike | undefined
): string {
  // Quick skip: a shortcode needs at least one colon.
  if (!html || !html.includes(':')) return html;

  const doc = parseTrustedMarkdownHtml(html);

  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!isInsideExcludedElement(node)) textNodes.push(node);
  }

  const regex = createShortcodeRegex();
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    if (!text.includes(':')) continue;

    const fragments: (string | Element)[] = [];
    let lastIndex = 0;
    let replaced = false;
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      const emoji = resolve(match[1]);
      if (!emoji) continue; // Unknown shortcode: leave as literal text.

      if (match.index > lastIndex) {
        fragments.push(text.slice(lastIndex, match.index));
      }

      const img = doc.createElement('img');
      img.className = 'custom-emoji';
      img.setAttribute('src', emoji.url);
      img.setAttribute('alt', `:${emoji.name}:`);
      img.setAttribute('title', `:${emoji.name}:`);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('draggable', 'false');
      fragments.push(img);

      lastIndex = match.index + match[0].length;
      replaced = true;
    }

    if (!replaced) continue;

    if (lastIndex < text.length) {
      fragments.push(text.slice(lastIndex));
    }

    const parent = textNode.parentNode;
    if (parent) {
      for (const fragment of fragments) {
        parent.insertBefore(
          typeof fragment === 'string' ? doc.createTextNode(fragment) : fragment,
          textNode
        );
      }
      parent.removeChild(textNode);
    }
  }

  return doc.body.innerHTML;
}
