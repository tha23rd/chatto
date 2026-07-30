/**
 * Receiver-side coverage for live custom-emoji catalog propagation.
 *
 * A client used to list the catalog once, so an emoji uploaded and immediately
 * used in a message rendered as an unresolved shortcode until that client
 * reloaded. These tests keep a second user's page connected throughout the
 * upload, message, and delete lifecycle.
 */

import { expect, type Page } from '@playwright/test';
import { test } from './setup';
import * as routes from './routes';
import { TIMEOUTS } from './constants';
import { grantPermission, loginAsAdmin } from './fixtures/testUser';
import { withServerUser } from './fixtures/serverUser';
import {
  connectPost,
  getIdsFromUrlViaConnect,
  postMessageViaConnect
} from './fixtures/connectHelpers';

interface CreateCustomEmojiResponse {
  emoji?: { id?: string; name?: string; url?: string };
}

const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function createCustomEmojiViaConnect(page: Page, name: string): Promise<string> {
  const data = await connectPost<CreateCustomEmojiResponse>(
    page,
    'chatto.admin.v1.AdminCustomEmojiService/CreateCustomEmoji',
    {
      name,
      image: {
        image: TRANSPARENT_PNG_BASE64,
        filename: 'emoji.png',
        contentType: 'image/png'
      }
    }
  );
  expect(data.emoji?.name).toBe(name);
  expect(data.emoji?.url).toBeTruthy();
  expect(data.emoji?.id, 'CreateCustomEmoji returned no emoji id').toBeTruthy();
  return data.emoji?.id as string;
}

async function deleteCustomEmojiViaConnect(page: Page, id: string): Promise<void> {
  await connectPost(page, 'chatto.admin.v1.AdminCustomEmojiService/DeleteCustomEmoji', { id });
}

test.describe('Custom emoji live propagation', () => {
  test('a connected receiver renders an emoji uploaded and used without reloading', async ({
    page,
    browser,
    serverURL
  }) => {
    await loginAsAdmin(page);
    // The management page is used to prove the receiver completed its initial
    // empty catalog read before the admin upload.
    await grantPermission(page, 'everyone', 'emoji.manage');

    const emojiName = `liveparrot_${Date.now()}`;
    const messagePrefix = `Live emoji ${Date.now()}`;

    await withServerUser(browser, serverURL, async (receiver) => {
      const pageErrors: string[] = [];
      receiver.page.on('pageerror', (error) => pageErrors.push(error.message));
      const consoleErrors: string[] = [];
      receiver.page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });

      await receiver.page.goto(routes.serverAdmin('custom-emoji'));
      await expect(receiver.page.getByText('No custom emojis yet')).toBeVisible({
        timeout: TIMEOUTS.REALTIME_EVENT
      });

      const emojiId = await createCustomEmojiViaConnect(page, emojiName);
      await expect(receiver.page.getByText(emojiName)).toBeVisible({
        timeout: TIMEOUTS.REALTIME_EVENT
      });

      await receiver.chatPage.goto();
      await receiver.chatPage.enterRoom('general');
      const { roomId } = await getIdsFromUrlViaConnect(receiver.page);
      await postMessageViaConnect(page, roomId, `${messagePrefix} :${emojiName}:`);

      const message = receiver.page.locator('[role="article"]', { hasText: messagePrefix });
      const image = message.locator(`img.custom-emoji[alt=":${emojiName}:"]`);
      await expect(message).toBeVisible({ timeout: TIMEOUTS.REALTIME_EVENT });
      await expect(image).toBeVisible({ timeout: TIMEOUTS.REALTIME_EVENT });

      await deleteCustomEmojiViaConnect(page, emojiId);
      await expect(image).toBeHidden({ timeout: TIMEOUTS.REALTIME_EVENT });
      await expect(message).toContainText(`:${emojiName}:`, {
        timeout: TIMEOUTS.REALTIME_EVENT
      });

      expect(pageErrors, `receiver page errors: ${pageErrors.join(', ')}`).toEqual([]);
      expect(consoleErrors, `receiver console errors: ${consoleErrors.join(', ')}`).toEqual([]);
    });
  });
});
