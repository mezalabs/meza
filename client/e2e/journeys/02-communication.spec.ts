/**
 * Journey 2: Communication
 *
 * Tests messaging features: send, edit, delete, reply, reactions,
 * pins, mentions, markdown, typing indicators, search, read state.
 *
 * Depends on Journey 1 (alice and bob registered, server + channels exist).
 */

import { expect, test } from '@playwright/test';
import { ChannelPage } from '../pages/ChannelPage';
import { chapter, createContext, reportFailures } from './helpers';

const SERVER = 'Test Server';
const CHANNEL = 'general';
const ts = () => `${Date.now()}`;

test('Journey 2: Communication', async ({ browser }, testInfo) => {
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

  // Both navigate to Test Server → #general (all channels are E2EE)
  await alice.goto(SERVER, CHANNEL);
  await bob.goto(SERVER, CHANNEL);

  // Wait for E2EE key initialization on the public channel
  await expect(alice.composer).not.toHaveAttribute(
    'placeholder',
    /Setting up encryption/,
    { timeout: 15_000 },
  );
  await expect(bob.composer).not.toHaveAttribute(
    'placeholder',
    /Setting up encryption/,
    { timeout: 15_000 },
  );

  // ---- Chapter: Basic Messaging ----
  const helloMsg = `Hello from alice ${ts()}`;

  await chapter(alicePage, testInfo, 'Basic Messaging', async () => {
    await alice.sendMessage(helloMsg);
    await alice.expectMessage(helloMsg);
    // Bob sees alice's message in real-time
    await bob.expectMessage(helloMsg);
  });

  // ---- Chapter: Edit & Delete ----
  const editMsg = `Edit me ${ts()}`;
  const editedMsg = `Edited ${ts()}`;
  const deleteMsg = `Delete me ${ts()}`;

  await chapter(alicePage, testInfo, 'Edit & Delete', async () => {
    await alice.sendMessage(editMsg);
    await alice.expectMessage(editMsg);

    await alice.editMessage(editMsg, editedMsg);
    await alice.expectMessage(editedMsg);
    // Encrypted edit needs time to propagate + decrypt on Bob's side
    await expect(bob.messageList.getByText(editedMsg)).toBeVisible({
      timeout: 15_000,
    });

    await alice.sendMessage(deleteMsg);
    await alice.expectMessage(deleteMsg);

    await alice.deleteMessage(deleteMsg);
    await alice.expectNoMessage(deleteMsg);
    await bob.expectNoMessage(deleteMsg);
  });

  // ---- Chapter: Replies ----
  const replyMsg = `Reply from bob ${ts()}`;

  await chapter(bobPage, testInfo, 'Replies', async () => {
    await bob.replyToMessage(helloMsg, replyMsg);
    await bob.expectMessage(replyMsg);
    await alice.expectMessage(replyMsg);
  });

  // ---- Chapter: Reactions ----
  await chapter(alicePage, testInfo, 'Reactions', async () => {
    // Alice adds reaction to bob's reply
    await alice.clickAddReaction(replyMsg);
    const picker = alicePage.getByRole('dialog');
    await expect(picker).toBeVisible({ timeout: 5_000 });
    // Click first emoji in picker
    await picker.locator('button').filter({ hasText: '😀' }).click();

    // Bob sees a reaction on the reply
    const replyContainer = bob.messageList
      .locator('[data-message-id]')
      .filter({ hasText: replyMsg })
      .first();
    await expect(
      replyContainer.locator('button').filter({ hasText: '😀' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---- Chapter: Pins ----
  await chapter(alicePage, testInfo, 'Pins', async () => {
    const msgContainer = alice.messageList
      .locator('[data-message-id]')
      .filter({ hasText: helloMsg })
      .first();

    await msgContainer.click({ button: 'right' });
    await alicePage.getByRole('menuitem', { name: 'Pin Message' }).click();

    // Confirm pin if dialog appears
    const confirmBtn = alicePage
      .getByRole('dialog')
      .getByRole('button', { name: /pin/i });
    if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await confirmBtn.click();
    }
  });

  // ---- Chapter: Mentions ----
  await chapter(alicePage, testInfo, 'Mentions', async () => {
    await alice.composer.pressSequentially('@e2e', { delay: 30 });
    const autocomplete = alicePage.locator('.absolute.z-50');
    await expect(autocomplete).toBeVisible({ timeout: 5_000 });

    await autocomplete.getByText('e2e_bob').first().click();
    await alice.composer.press('Enter');
  });

  // ---- Chapter: Markdown ----
  await chapter(alicePage, testInfo, 'Markdown', async () => {
    await alice.sendMessage(`**bold test ${ts()}**`);
    await expect(
      alice.messageList.locator('strong').filter({ hasText: 'bold test' }),
    ).toBeVisible({ timeout: 5_000 });

    await alice.sendMessage(`*italic test ${ts()}*`);
    await expect(
      alice.messageList.locator('em').filter({ hasText: 'italic test' }),
    ).toBeVisible({ timeout: 5_000 });

    const codeText = `code-${ts()}`;
    await alice.sendMessage(`\`${codeText}\``);
    await expect(
      alice.messageList.locator('code').filter({ hasText: codeText }),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ---- Chapter: Typing Indicators ----
  await chapter(alicePage, testInfo, 'Typing Indicators', async () => {
    // Wait for the 3-second typing throttle to expire from prior chapters
    await alicePage.waitForTimeout(3_000);
    await alice.composer.pressSequentially('typing test...', { delay: 30 });
    await bob.expectTypingIndicator();
    await alice.composer.fill('');
  });

  // ---- Chapter: Search ----
  // Search is metadata-only (E2EE — no plaintext on server). Verify the
  // search pane opens, accepts a query, and displays results or the empty state.
  await chapter(alicePage, testInfo, 'Search', async () => {
    await alicePage.getByLabel('Search messages').click();
    const searchInput = alicePage.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible();
    await searchInput.fill('test');
    await searchInput.press('Enter');

    // With E2EE metadata-only search, results show author/timestamp, not content.
    // Verify either results appear or the "No results" message shows.
    await expect(
      alicePage
        .getByText(/click to jump/i)
        .or(alicePage.getByText(/No results found/i))
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---- Chapter: Read State ----
  await chapter(alicePage, testInfo, 'Read State', async () => {
    // Alice navigates to voice channel (away from general)
    await alice.selectChannel('voice');

    // Bob sends a message in general
    await bob.sendMessage(`unread test ${ts()}`);

    // Alice should see unread indicator on general
    const channelNav = alicePage.locator('nav[aria-label="Channels"]');
    await expect(
      channelNav.getByRole('button', { name: /general \d+/ }),
    ).toBeVisible({ timeout: 10_000 });

    // Alice clicks general → unread clears
    await alice.selectChannel('general');
  });

  // ---- Chapter: Emoji Picker ----
  await chapter(alicePage, testInfo, 'Emoji Picker', async () => {
    await alicePage.getByLabel('Insert emoji').click();
    const picker = alicePage.getByRole('dialog');
    await expect(picker).toBeVisible({ timeout: 5_000 });
    await expect(
      picker.getByRole('searchbox', { name: 'Search' }),
    ).toBeVisible();
    await alicePage.keyboard.press('Escape');
  });

  await aliceCtx.close();
  await bobCtx.close();
  reportFailures();
});
