/**
 * E2E tests for live soundboard catalog propagation, from the receiver's side.
 *
 * The bug these cover: the soundboard catalog was read once per client through
 * `SoundboardService.ListSounds` and had no live channel, so an admin's upload
 * or deletion stayed invisible to everyone already connected until they
 * reloaded. Durable `evt.soundboard.server.*` facts existed but were dropped by
 * the live-delivery prefilter before decode, and no projection operation
 * carried the catalog.
 *
 * The catalog now rides inside authenticated server state, so a catalog change
 * emits one `server_state_upsert` that every connected client applies through
 * the normal projection reducer.
 *
 * Scope limit: the in-call soundboard panel cannot be exercised here. Its button
 * is gated on `voiceCallState.isInCall(roomId)`, which requires a real LiveKit
 * WebRTC connection that CI does not have (see the header of
 * voice-call.spec.ts). These tests therefore assert convergence on the other
 * surface that renders the same shared store — the server-admin soundboard
 * list — which exercises the identical path end to end: live EVT fanout ->
 * realtime projection -> client reducer -> shared soundboard store -> DOM.
 * A member already joined to a voice call seeing the clip appear remains a
 * manual check on a real build.
 */

import { expect, type Page } from '@playwright/test';
import { test } from './setup';
import * as routes from './routes';
import { TIMEOUTS } from './constants';
import { grantPermission, loginAsAdmin } from './fixtures/testUser';
import { withServerUser } from './fixtures/serverUser';
import { connectPost } from './fixtures/connectHelpers';

interface CreateSoundResponse {
  sound?: { id?: string; name?: string };
}

interface ListSoundsResponse {
  sounds?: Array<{ id?: string; name?: string }>;
}

// A few bytes are enough: the server validates size and content type but never
// decodes the clip, so no real WAV payload is needed.
const FAKE_CLIP_BASE64 = Buffer.from('RIFF----WAVEfmt fake-clip-bytes').toString('base64');

async function createSoundViaConnect(page: Page, name: string, emoji: string): Promise<string> {
  const data = await connectPost<CreateSoundResponse>(
    page,
    'chatto.admin.v1.AdminSoundboardService/CreateSound',
    {
      name,
      emoji,
      volume: 1,
      audio: {
        audio: FAKE_CLIP_BASE64,
        filename: 'clip.wav',
        contentType: 'audio/wav'
      }
    }
  );
  const id = data.sound?.id;
  expect(data.sound?.name).toBe(name);
  expect(id, 'CreateSound returned no sound id').toBeTruthy();
  return id as string;
}

async function deleteSoundViaConnect(page: Page, id: string): Promise<void> {
  await connectPost(page, 'chatto.admin.v1.AdminSoundboardService/DeleteSound', { id });
}

async function listSoundNamesViaConnect(page: Page): Promise<string[]> {
  const data = await connectPost<ListSoundsResponse>(
    page,
    'chatto.api.v1.SoundboardService/ListSounds',
    {}
  );
  return (data.sounds ?? []).map((sound) => sound.name ?? '');
}

test.describe('Soundboard live propagation', () => {
  test('a receiver already viewing the soundboard gains an uploaded clip without reloading', async ({
    page,
    browser,
    serverURL
  }) => {
    await loginAsAdmin(page);
    // The receiver needs to be able to read the soundboard admin surface. Any
    // authenticated member may read the catalog itself; only the settings view
    // is permission-gated.
    await grantPermission(page, 'everyone', 'soundboard.manage');

    // The catalog starts empty, which is the case the old `sounds.length > 0`
    // button gate hid: the receiver has to go from "nothing" to "one clip".
    expect(await listSoundNamesViaConnect(page)).toEqual([]);

    const clipName = `airhorn-${Date.now()}`;

    await withServerUser(browser, serverURL, async (receiver) => {
      const pageErrors: string[] = [];
      receiver.page.on('pageerror', (error) => pageErrors.push(error.message));
      const consoleErrors: string[] = [];
      receiver.page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });

      await receiver.page.goto(routes.serverAdmin('soundboard'));
      // Empty state proves the receiver's first read completed before the
      // upload, so a later row can only have arrived over the live stream.
      await expect(receiver.page.getByText('No sounds yet. Upload one above.')).toBeVisible({
        timeout: TIMEOUTS.REALTIME_EVENT
      });

      const soundId = await createSoundViaConnect(page, clipName, '📣');

      // No reload and no navigation between the upload and this assertion.
      await expect(receiver.page.getByText(clipName)).toBeVisible({
        timeout: TIMEOUTS.REALTIME_EVENT
      });

      // Deleting the last clip must converge to empty on the receiver too,
      // which is why a present-but-empty catalog is authoritative.
      await deleteSoundViaConnect(page, soundId);
      await expect(receiver.page.getByText(clipName)).toBeHidden({
        timeout: TIMEOUTS.REALTIME_EVENT
      });
      await expect(receiver.page.getByText('No sounds yet. Upload one above.')).toBeVisible({
        timeout: TIMEOUTS.REALTIME_EVENT
      });

      expect(pageErrors, `receiver page errors: ${pageErrors.join(', ')}`).toEqual([]);
      expect(consoleErrors, `receiver console errors: ${consoleErrors.join(', ')}`).toEqual([]);
    });
  });

  test('a second uploaded clip also reaches the receiver live', async ({
    page,
    browser,
    serverURL
  }) => {
    await loginAsAdmin(page);
    await grantPermission(page, 'everyone', 'soundboard.manage');

    const first = `wow-${Date.now()}`;
    const second = `tada-${Date.now()}`;
    await createSoundViaConnect(page, first, '😮');

    await withServerUser(browser, serverURL, async (receiver) => {
      const pageErrors: string[] = [];
      receiver.page.on('pageerror', (error) => pageErrors.push(error.message));

      await receiver.page.goto(routes.serverAdmin('soundboard'));
      // The clip uploaded before the receiver connected arrives through its
      // initial read; the next one can only arrive live.
      await expect(receiver.page.getByText(first)).toBeVisible({ timeout: TIMEOUTS.REALTIME_EVENT });

      await createSoundViaConnect(page, second, '🎉');

      await expect(receiver.page.getByText(second)).toBeVisible({ timeout: TIMEOUTS.REALTIME_EVENT });
      // A full-catalog replacement must not drop the clip already on screen.
      await expect(receiver.page.getByText(first)).toBeVisible();

      expect(pageErrors, `receiver page errors: ${pageErrors.join(', ')}`).toEqual([]);
    });
  });
});
