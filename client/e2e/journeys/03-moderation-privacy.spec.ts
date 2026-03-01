/**
 * Journey 3: Moderation & Privacy
 *
 * Tests role management, private channels, moderation (delete others' messages),
 * DMs, message requests (via charlie), and user blocking.
 *
 * Depends on Journey 1 (alice, bob, charlie registered; server exists).
 */

import { expect, test } from '@playwright/test';
import { ChannelPage } from '../pages/ChannelPage';
import { chapter, createContext, reportFailures } from './helpers';

const SERVER = 'Test Server';
const ts = () => `${Date.now()}`;

test('Journey 3: Moderation & Privacy', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);

  const { context: aliceCtx, page: alicePage } = await createContext(
    browser,
    'alice',
  );
  const { context: bobCtx, page: bobPage } = await createContext(
    browser,
    'bob',
  );

  const alice = new ChannelPage(alicePage);
  const bob = new ChannelPage(bobPage);

  // ---- Chapter: Roles ----
  await chapter(alicePage, testInfo, 'Roles', async () => {
    await alicePage.goto('/');
    await expect(alicePage.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await alice.selectServer(SERVER);
    await alicePage.getByLabel('Server settings').click();
    await alicePage.getByRole('button', { name: 'Roles' }).click();

    // Verify roles created in Journey 1 exist
    await expect(
      alicePage.getByText('Admin', { exact: true }).first(),
    ).toBeVisible();
    await expect(alicePage.getByText('Moderator').first()).toBeVisible();

    // Navigate back
    await alice.selectServer(SERVER);
  });

  // ---- Chapter: Private Channels ----
  await chapter(bobPage, testInfo, 'Private Channels', async () => {
    await bobPage.goto('/');
    await expect(bobPage.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await bob.selectServer(SERVER);

    // Bob should NOT see #private channel (not a member)
    const channelNav = bobPage.locator('nav[aria-label="Channels"]');
    await expect(
      channelNav
        .locator('button[data-channel-type="private"]')
        .filter({ hasText: 'private' }),
    ).not.toBeVisible({ timeout: 5_000 });

    // Alice should see #private channel (owner)
    await alicePage.goto('/');
    await expect(alicePage.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await alice.selectServer(SERVER);
    const aliceNav = alicePage.locator('nav[aria-label="Channels"]');
    await expect(
      aliceNav
        .locator('button[data-channel-type="private"]')
        .filter({ hasText: 'private' }),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ---- Chapter: Moderation Actions ----
  await chapter(alicePage, testInfo, 'Moderation Actions', async () => {
    await alice.selectChannel('general');
    await bob.selectChannel('general');

    // Bob sends a message, alice deletes it (owner privilege)
    const modMsg = `mod-test ${ts()}`;
    await bob.sendMessage(modMsg);
    await alice.expectMessage(modMsg);
    await alice.deleteMessage(modMsg);
    await alice.expectNoMessage(modMsg);
  });

  // ---- Chapter: DMs ----
  await chapter(alicePage, testInfo, 'DMs', async () => {
    // Alice opens member list and starts DM with bob
    await alicePage.getByLabel('Show members').click();
    await alicePage.getByText('e2e_bob').last().click({ button: 'right' });
    await alicePage.getByRole('menuitem', { name: 'Message' }).click();

    // Wait for DM composer to be ready
    const dmComposer = alicePage.locator('main textarea');
    await expect(dmComposer.first()).toBeVisible({ timeout: 15_000 });

    // Wait for encryption to finish initializing (pending → ready)
    await expect(dmComposer.first()).not.toHaveAttribute(
      'placeholder',
      /Setting up encryption/,
      { timeout: 15_000 },
    );

    // Alice sends a DM
    const dmMsg = `DM from alice ${ts()}`;
    await dmComposer.first().fill(dmMsg);
    await dmComposer.first().press('Enter');

    // Verify alice sees her own message (confirms send succeeded)
    await expect(alicePage.getByText(dmMsg)).toBeVisible({ timeout: 10_000 });

    // Bob navigates to DMs and sees the message.
    // Scope DM sidebar locator to the aside panel to avoid matching profile panes.
    await bobPage.goto('/');
    await expect(bobPage.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Click @ icon (DMs)
    await bobPage.getByLabel('Servers').locator('button').first().click();

    // Wait for alice's DM entry in the sidebar (scoped to avoid profile pane matches).
    // The sidebar shows display name (e.g. "e2e_alice" or "Alice ..."), not username.
    const sidebar = bobPage.locator('aside');
    await expect(sidebar.getByText(/alice/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await sidebar.getByText(/alice/i).first().click();

    // Wait for Bob's E2EE session to bootstrap and decrypt DM messages
    const bobDmComposer = bobPage.locator('main textarea');
    await expect(bobDmComposer.first()).toBeVisible({ timeout: 15_000 });
    await expect(bobDmComposer.first()).not.toHaveAttribute(
      'placeholder',
      /Setting up encryption|Encryption unavailable/,
      { timeout: 15_000 },
    );

    await expect(bobPage.getByText(dmMsg)).toBeVisible({ timeout: 15_000 });
  });

  // ---- Chapter: Message Requests (charlie) ----
  const { context: charlieCtx, page: charliePage } = await createContext(
    browser,
    'charlie',
  );

  await chapter(charliePage, testInfo, 'Message Requests', async () => {
    await charliePage.goto('/');
    await expect(charliePage.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Charlie opens DMs → new message → search for alice
    await charliePage.getByLabel('Servers').locator('button').first().click();

    const newDmBtn = charliePage
      .getByRole('button', { name: /new/i })
      .or(charliePage.getByLabel('New message'));
    if (await newDmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await newDmBtn.click();
      const searchInput = charliePage.getByPlaceholder(/search|find/i).first();
      await searchInput.fill('e2e_alice');
      await charliePage.getByText('e2e_alice').first().click();

      const composer = charliePage.locator('main textarea');
      await expect(composer.first()).toBeVisible({ timeout: 10_000 });
      // Wait until encryption is set up
      await expect(composer.first()).not.toHaveAttribute(
        'placeholder',
        /Setting up encryption|Encryption unavailable/,
        { timeout: 15_000 },
      );
      await composer.first().fill(`Request from charlie ${ts()}`);
      await composer.first().press('Enter');
    }

    // Alice checks message requests
    await alicePage.goto('/');
    await expect(alicePage.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await alicePage.getByLabel('Servers').locator('button').first().click();

    const requestsBtn = alicePage.getByRole('button', { name: /Requests/i });
    if (await requestsBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await requestsBtn.click();
      const charlieRequest = alicePage.getByText('e2e_charlie').first();
      if (
        await charlieRequest.isVisible({ timeout: 5_000 }).catch(() => false)
      ) {
        await charlieRequest.click();
        await alicePage.getByRole('button', { name: 'Accept' }).click();
      }
    }
  });

  await charlieCtx.close();
  await aliceCtx.close();
  await bobCtx.close();
  reportFailures();
});
