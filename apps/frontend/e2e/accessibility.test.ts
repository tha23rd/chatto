import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './setup';
import {
  createAndLoginTestUser,
  loginAsAdmin,
  verifyAdminEmail
} from './fixtures/testUser';
import * as routes from './routes';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoAccessibilityViolations(page: Page, state: string): Promise<void> {
  await page.evaluate(async () => {
    const finiteAnimations = document.getAnimations().filter((animation) => {
      const endTime = animation.effect?.getComputedTiming().endTime;
      return typeof endTime === 'number' && Number.isFinite(endTime);
    });
    await Promise.all(finiteAnimations.map((animation) => animation.finished.catch(() => undefined)));
  });

  const { violations } = await new AxeBuilder({ page }).withTags(wcagTags).analyze();

  expect(
    violations,
    `${state} has accessibility violations:\n${violations
      .map(
        ({ id, impact, help, nodes }) =>
          `- ${impact ?? 'unknown'} ${id}: ${help}\n${nodes
            .map((node) => `  ${node.target.join(' ')}: ${node.failureSummary ?? node.html}`)
            .join('\n')}`
      )
      .join('\n')}`
  ).toEqual([]);
}

test.describe('Route accessibility', () => {
  test('public authentication routes meet WCAG A and AA rules', async ({ page }) => {
    for (const [state, route, heading] of [
      ['login', routes.login, /sign in/i],
      ['registration', routes.register, /create.*account|register/i],
      ['forgot password', routes.forgotPassword, /forgot.*password|reset.*password/i]
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectNoAccessibilityViolations(page, state);
    }
  });

  test('desktop chat and account settings meet WCAG A and AA rules', async ({ page, chatPage }) => {
    await createAndLoginTestUser(page);
    await chatPage.goto();
    const roomPage = await chatPage.enterRoom('general');
    await expect(roomPage.messageInput).toBeVisible();
    await expectNoAccessibilityViolations(page, 'desktop room');

    await page.goto(routes.settingsAccount);
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page, 'account settings');

    await page.goto(routes.settingsNotifications);
    await expect(page.getByRole('heading', { name: /notifications/i })).toBeVisible();
    await expectNoAccessibilityViolations(page, 'notification settings');
  });

  test('mobile chat navigation meets WCAG A and AA rules', async ({ page, chatPage }) => {
    await createAndLoginTestUser(page);
    await chatPage.goto();
    const roomPage = await chatPage.enterRoom('general');
    await expect(roomPage.messageInput).toBeVisible();
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.getByRole('button', { name: /toggle sidebar/i })).toBeVisible();
    await expectNoAccessibilityViolations(page, 'mobile room');

    await page.getByRole('button', { name: /toggle sidebar/i }).click();
    await expect(chatPage.roomList).toBeVisible();
    await expectNoAccessibilityViolations(page, 'mobile room with navigation open');
  });

  test('server administration and its room dialog meet WCAG A and AA rules', async ({
    page,
    chatPage
  }) => {
    const admin = await loginAsAdmin(page);
    await verifyAdminEmail(page, admin.id!);
    await page.goto(routes.serverAdminGeneral);
    await expect(page.getByRole('heading', { level: 1, name: 'General', exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page, 'server administration');

    await chatPage.openCreateRoomModal();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAccessibilityViolations(page, 'create room dialog');
  });
});

/**
 * The scans above run under Chromium's default `prefers-color-scheme: light`, so
 * they only ever exercise the light palette. Light and dark are deliberately not
 * luminance mirrors of one another (see the theme blocks in app.css), which means
 * a light-mode pass says nothing about dark-mode contrast — a dark-only
 * regression is invisible to every other check in the suite.
 *
 * Contrast does not vary with viewport, so this covers the representative
 * unauthenticated, authenticated, admin and dialog surfaces rather than
 * duplicating the mobile scans.
 */
test.describe('Route accessibility (dark theme)', () => {
  test.use({ colorScheme: 'dark' });

  // Guards against this whole block silently degrading into a second light-mode
  // run if theme resolution ever stops following prefers-color-scheme.
  async function expectDarkThemeApplied(page: Page, state: string): Promise<void> {
    expect(
      await page.evaluate(() => document.documentElement.dataset.theme),
      `${state} should be scanned with the dark theme applied`
    ).toBe('dark');
  }

  test('public authentication routes meet WCAG A and AA rules in dark mode', async ({ page }) => {
    for (const [state, route, heading] of [
      ['login', routes.login, /sign in/i],
      ['registration', routes.register, /create.*account|register/i]
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectDarkThemeApplied(page, state);
      await expectNoAccessibilityViolations(page, `${state} (dark)`);
    }
  });

  test('desktop chat and account settings meet WCAG A and AA rules in dark mode', async ({
    page,
    chatPage
  }) => {
    await createAndLoginTestUser(page);
    await chatPage.goto();
    const roomPage = await chatPage.enterRoom('general');
    await expect(roomPage.messageInput).toBeVisible();
    await expectDarkThemeApplied(page, 'desktop room');
    await expectNoAccessibilityViolations(page, 'desktop room (dark)');

    await page.goto(routes.settingsAccount);
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page, 'account settings (dark)');

    await page.goto(routes.settingsNotifications);
    await expect(page.getByRole('heading', { name: /notifications/i })).toBeVisible();
    await expectNoAccessibilityViolations(page, 'notification settings (dark)');
  });

  test('server administration and its room dialog meet WCAG A and AA rules in dark mode', async ({
    page,
    chatPage
  }) => {
    const admin = await loginAsAdmin(page);
    await verifyAdminEmail(page, admin.id!);
    await page.goto(routes.serverAdminGeneral);
    await expect(
      page.getByRole('heading', { level: 1, name: 'General', exact: true })
    ).toBeVisible();
    await expectDarkThemeApplied(page, 'server administration');
    await expectNoAccessibilityViolations(page, 'server administration (dark)');

    await chatPage.openCreateRoomModal();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAccessibilityViolations(page, 'create room dialog (dark)');
  });
});
