/**
 * Journey 5: Settings & Account
 *
 * Tests user settings, profile editing, server settings, channel management,
 * tiling window manager, session management, and account recovery.
 *
 * Depends on Journey 1 (alice registered, server + channels exist).
 */

import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { AuthPage } from '../pages/AuthPage';
import { ChannelPage } from '../pages/ChannelPage';
import { chapter, createContext, reportFailures, saveAuth } from './helpers';

const SERVER = 'Test Server';
const ts = () => `${Date.now()}`;

test('Journey 5: Settings & Account', async ({ browser }, testInfo) => {
  test.setTimeout(300_000); // Recovery crypto is expensive

  const { context: aliceCtx, page: alicePage } = await createContext(
    browser,
    'alice',
  );

  const alice = new ChannelPage(alicePage);

  await alicePage.goto('/');
  await expect(
    alicePage.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });

  // ---- Chapter: User Settings ----
  await chapter(alicePage, testInfo, 'User Settings', async () => {
    await alicePage
      .getByRole('button', { name: 'Settings', exact: true })
      .click();

    // Verify main sections exist
    await expect(
      alicePage.getByRole('button', { name: 'Account & Profile' }),
    ).toBeVisible();
    await expect(
      alicePage.getByRole('button', { name: 'Appearance' }),
    ).toBeVisible();
    await expect(
      alicePage.getByRole('button', { name: 'Voice & Audio' }),
    ).toBeVisible();

    // Navigate back
    await alice.selectServer(SERVER);
  });

  // ---- Chapter: Profile ----
  await chapter(alicePage, testInfo, 'Profile', async () => {
    await alicePage.getByLabel('View profile').click();
    await expect(
      alicePage.getByRole('button', { name: 'Edit Profile' }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await alicePage
      .getByRole('button', { name: 'Edit Profile' })
      .first()
      .click();

    const displayName = `Alice ${ts()}`;
    await alicePage.locator('#profile-display-name').fill(displayName);
    await alicePage.locator('#profile-bio').fill('E2E test bio');
    await alicePage.getByRole('button', { name: 'Save' }).click();
    await expect(alicePage.locator('main').getByText(displayName)).toBeVisible({
      timeout: 5_000,
    });
  });

  // ---- Chapter: Server Settings ----
  await chapter(alicePage, testInfo, 'Server Settings', async () => {
    await alice.selectServer(SERVER);
    await alicePage.getByLabel('Server settings').click();

    await expect(
      alicePage.getByRole('heading', { name: /Server Settings/i }),
    ).toBeVisible();
    await alicePage.getByRole('button', { name: 'Roles' }).click();
    await expect(
      alicePage.getByText('Admin', { exact: true }).first(),
    ).toBeVisible();

    await alicePage
      .getByLabel('Servers')
      .locator('button[title="Test Server"]')
      .first()
      .click();
  });

  // ---- Chapter: Channel Management ----
  await chapter(alicePage, testInfo, 'Channel Management', async () => {
    const channelNav = alicePage.locator('nav[aria-label="Channels"]');

    // Channel Settings pane via right-click
    await channelNav.getByText('general').first().click({ button: 'right' });
    await alicePage.getByRole('menuitem', { name: 'Channel Settings' }).click();
    await expect(alicePage.locator('#channel-name')).toBeVisible({
      timeout: 5_000,
    });

    // Navigate back to the channel by clicking it in the sidebar
    await channelNav.getByText('general').first().click();

    // Create and delete a temporary channel
    await alicePage.getByLabel('Create text channel').click();
    await alicePage.getByPlaceholder('new-channel').fill('delete-me');
    await alicePage.getByRole('button', { name: 'Create' }).click();
    await expect(alicePage.getByRole('dialog')).not.toBeVisible({
      timeout: 5_000,
    });
    await expect(channelNav.getByText('delete-me').first()).toBeVisible({
      timeout: 5_000,
    });

    // Open channel settings for delete-me, navigate to Danger Zone
    await channelNav.getByText('delete-me').first().click({ button: 'right' });
    await alicePage.getByRole('menuitem', { name: 'Channel Settings' }).click();
    await alicePage.getByRole('button', { name: 'Danger Zone' }).click();
    await alicePage.getByRole('button', { name: 'Delete Channel' }).click();
    // Confirm deletion by typing channel name
    await alicePage.locator('#confirm-delete').fill('delete-me');
    await alicePage.getByRole('button', { name: 'Delete Channel' }).click();
    await expect(channelNav.getByText('delete-me')).not.toBeVisible({
      timeout: 5_000,
    });
  });

  // ---- Chapter: Session Management ----
  await chapter(alicePage, testInfo, 'Session Management', async () => {
    // Alice logs out (open settings then click Log out)
    await alicePage
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await alicePage.getByLabel('Log out').click();

    // After logout, the marketing landing page shows — click through to auth
    const auth = new AuthPage(alicePage);
    await auth.dismissMarketingPage();
    await expect(
      alicePage.getByRole('button', { name: /sign in/i }),
    ).toBeVisible({ timeout: 15_000 });
    await auth.login('e2e_alice@test.local', 'testpass123');
    await expect(
      alicePage.getByRole('button', { name: 'Settings', exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Refresh page → still logged in
    await alicePage.reload();
    await expect(
      alicePage.getByRole('button', { name: 'Settings', exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
  });

  // ---- Chapter: Account Recovery ----
  await chapter(alicePage, testInfo, 'Account Recovery', async () => {
    // Read recovery phrase from file (saved by Journey 1)
    const recoveryPhrase = fs
      .readFileSync('.auth/alice-recovery-phrase.txt', 'utf-8')
      .trim();
    expect(recoveryPhrase.split(' ').length).toBe(12);

    // Log out (open settings then click Log out)
    await alicePage
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await alicePage.getByLabel('Log out').click();

    const auth = new AuthPage(alicePage);
    await auth.dismissMarketingPage();
    await expect(
      alicePage.getByRole('button', { name: /sign in/i }),
    ).toBeVisible({ timeout: 15_000 });

    await auth.switchToRecover();

    // Recover with correct phrase + new password
    const newPassword = 'recovered123';
    await auth.recoverAccount(
      'e2e_alice@test.local',
      recoveryPhrase,
      newPassword,
    );
    await expect(
      alicePage.getByRole('button', { name: 'Settings', exact: true }),
    ).toBeVisible({
      timeout: 60_000,
    });

    // Login with new password after logout (open settings then click Log out)
    await alicePage
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await alicePage.getByLabel('Log out').click();

    const newAuth = new AuthPage(alicePage);
    await newAuth.dismissMarketingPage();
    await expect(
      alicePage.getByRole('button', { name: /sign in/i }),
    ).toBeVisible({ timeout: 15_000 });

    await newAuth.login('e2e_alice@test.local', newPassword);
    await expect(
      alicePage.getByRole('button', { name: 'Settings', exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  // Save updated auth state so later journeys (06, 07) get valid tokens.
  // Session Management and Account Recovery chapters invalidated the
  // original tokens saved by Journey 1.
  await saveAuth(aliceCtx, 'alice');

  await aliceCtx.close();
  reportFailures();
});
