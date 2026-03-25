/**
 * Journey 7: Offline Key Distribution
 *
 * Tests that keys are distributed when the inviter was offline during join
 * and comes back online. Validates the reconnect redistribution path.
 *
 * Scenario:
 * 1. Alice creates a server, sends a message, creates an invite
 * 2. Alice goes offline (gateway disconnect)
 * 3. Bob joins via the invite code
 * 4. Bob opens the channel — sees "You're almost there" (no keys)
 * 5. Alice comes back online (page reload)
 * 6. Bob's keys arrive — composer appears, messages decrypt
 *
 * Depends on Journey 1 (alice and bob registered with saved auth).
 */

import { expect, test } from '@playwright/test';
import { ChannelPage } from '../pages/ChannelPage';
import { chapter, createContext, reportFailures } from './helpers';

const ts = () => `${Date.now()}`;

test('Journey 7: Offline Key Distribution', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];

  // ---- Chapter 1: Alice creates a fresh server ----
  const { context: aliceCtx, page: alicePage } = await createContext(
    browser,
    'alice',
  );
  alicePage.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[E2EE]'))
      consoleErrors.push(`[alice] ${msg.text()}`);
  });

  let inviteCode = '';
  const serverName = `Offline Test ${ts()}`;

  await chapter(
    alicePage,
    testInfo,
    'Alice creates server and sends message',
    async () => {
      await alicePage.goto('/');
      await expect(
        alicePage.getByRole('button', { name: 'Settings', exact: true }),
      ).toBeVisible({ timeout: 15_000 });

      // Create server
      await alicePage.getByLabel('Create server').click();
      await alicePage
        .getByRole('button', { name: /Start from Scratch/ })
        .click();
      await alicePage.getByLabel('Server name').fill(serverName);
      await alicePage.getByRole('button', { name: 'Next' }).click();
      await alicePage.getByRole('button', { name: 'Next' }).click();
      await alicePage.getByRole('button', { name: 'Skip' }).click();

      // Dismiss invite modal if shown
      const inviteHeading = alicePage.getByText('Your server is ready!');
      if (
        await inviteHeading.isVisible({ timeout: 3_000 }).catch(() => false)
      ) {
        await alicePage.getByRole('button', { name: 'Done' }).click();
      }

      // Navigate to general channel using ChannelPage helpers (handles channel load retries)
      const alice = new ChannelPage(alicePage);
      await alice.selectServer(serverName);
      await alice.selectChannel('general');

      // Send a test message
      const msg = `Alice says hello ${ts()}`;
      await alice.sendMessage(msg);
      await alice.expectMessage(msg);

      // Create invite and extract code
      await alicePage.getByLabel('Invite people').click();
      await expect(alicePage.getByText('Share this invite link')).toBeVisible({
        timeout: 10_000,
      });
      const inviteText = await alicePage.locator('.font-mono').textContent();
      // Extract just the 8-char code (strip URL and fragment)
      const match = inviteText?.match(/\/invite\/([a-z0-9]{8})/i);
      inviteCode = match?.[1]?.toLowerCase() ?? '';
      expect(inviteCode.length).toBeGreaterThan(0);
      await alicePage.getByRole('button', { name: 'Done' }).click();
    },
  );

  // ---- Chapter 2: Alice goes offline ----
  await chapter(alicePage, testInfo, 'Alice goes offline', async () => {
    // Simulate going offline by disconnecting the gateway WebSocket.
    // We do this by setting the browser to offline mode.
    await alicePage.context().setOffline(true);
  });

  // ---- Chapter 3: Bob joins while Alice is offline ----
  const { context: bobCtx, page: bobPage } = await createContext(
    browser,
    'bob',
  );
  bobPage.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[E2EE]'))
      consoleErrors.push(`[bob] ${msg.text()}`);
  });

  await chapter(
    bobPage,
    testInfo,
    'Bob joins server while Alice is offline',
    async () => {
      await bobPage.goto('/');
      await expect(
        bobPage.getByRole('button', { name: 'Settings', exact: true }),
      ).toBeVisible({ timeout: 15_000 });

      // Join via invite code
      await bobPage.getByLabel('Join server').click();
      await expect(
        bobPage.getByRole('heading', { name: 'Join a Server' }),
      ).toBeVisible();
      await bobPage.getByLabel('Invite Code').fill(inviteCode);
      await bobPage.getByRole('button', { name: 'Preview' }).click();
      await expect(bobPage.getByText(serverName)).toBeVisible({
        timeout: 10_000,
      });
      await bobPage.getByRole('button', { name: 'Join Server' }).click();

      // Navigate to general channel
      const bobChannel = new ChannelPage(bobPage);
      await bobChannel.selectServer(serverName);
      // Click channel but DON'T use selectChannel (it expects a composer).
      // Bob has no keys yet so the composer won't appear.
      await bobChannel.ensureChannelsLoaded();
      await bobPage
        .locator('nav[aria-label="Channels"]')
        .locator('[data-channel-type]')
        .filter({ hasText: 'general' })
        .click({ timeout: 10_000 });

      // Bob should see the "You're almost there" status bar instead of the composer
      await expect(bobPage.getByText("You're almost there!")).toBeVisible({
        timeout: 15_000,
      });

      // Composer should NOT be visible (no keys yet)
      const composer = bobPage.getByRole('textbox', { name: /message #/i });
      await expect(composer).not.toBeVisible({ timeout: 5_000 });
    },
  );

  // ---- Chapter 4: Alice comes back online — keys distributed ----
  await chapter(
    bobPage,
    testInfo,
    'Alice reconnects and keys arrive for Bob',
    async () => {
      // Bring Alice back online
      await alicePage.context().setOffline(false);

      // Wait for Alice's gateway to reconnect and redistribute keys.
      // Cooldown is 5s, so keys should arrive quickly after reconnect.
      const composer = bobPage.getByRole('textbox', { name: /message #/i });
      await expect(composer).toBeVisible({ timeout: 15_000 });

      // The "You're almost there" bar should be gone
      await expect(bobPage.getByText("You're almost there!")).not.toBeVisible();

      // Bob should now be able to read Alice's message
      const bob = new ChannelPage(bobPage);
      await bob.expectMessage('Alice says hello');

      // Bob should be able to send a message
      const bobMsg = `Bob can send ${ts()}`;
      await bob.sendMessage(bobMsg);
      await bob.expectMessage(bobMsg);
    },
  );

  // Cleanup
  await aliceCtx.close();
  await bobCtx.close();

  // Report errors
  if (consoleErrors.length > 0) {
    await testInfo.attach('E2EE console errors', {
      contentType: 'text/plain',
      body: consoleErrors.join('\n'),
    });
  }

  reportFailures();
});
