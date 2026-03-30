/**
 * Journey 2: Communication
 *
 * Tests messaging features: send, edit, delete, reply, reactions,
 * pins, mentions, markdown, typing indicators, search, read state.
 *
 * Depends on Journey 1 (alice and bob registered, server + channels exist).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  await alice.waitForEncryption();
  await bob.waitForEncryption();

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

  // ---- Chapter: Custom Emoji Reactions ----
  const customEmojiMsg = `Custom emoji test ${ts()}`;

  await chapter(
    alicePage,
    testInfo,
    'Custom Emoji Reactions',
    async () => {
      // Step 1: Create a small test PNG for the custom emoji upload
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-emoji-'));
      const emojiPath = path.join(tmpDir, 'testemoji.png');
      // 1x1 red PNG (smallest valid PNG)
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      );
      fs.writeFileSync(emojiPath, pngBytes);

      // Step 2: Alice opens server settings → Emojis and uploads a custom emoji
      await alicePage.getByLabel('Server settings').click();
      const settingsNav = alicePage.locator(
        'nav[aria-label="Server settings sections"]',
      );
      await settingsNav.getByText('Emojis').click();
      await expect(
        alicePage.getByRole('heading', { name: 'Custom Emojis' }),
      ).toBeVisible({ timeout: 5_000 });

      const fileChooserPromise = alicePage.waitForEvent('filechooser');
      await alicePage.getByRole('button', { name: 'Upload Emoji' }).click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(emojiPath);

      // Wait for the emoji to appear in the list (name derived from filename: "testemoji")
      await expect(alicePage.getByText(':testemoji:')).toBeVisible({
        timeout: 10_000,
      });

      // Step 3: Navigate back to #general
      // Small wait so the debounced emoji cache write (1s) persists the new emoji
      await alicePage.waitForTimeout(1_500);
      await alice.goto(SERVER, CHANNEL);
      await alice.waitForEncryption();

      // Step 4: Alice sends a message and reacts with the custom emoji
      await alice.sendMessage(customEmojiMsg);
      await alice.expectMessage(customEmojiMsg);
      await bob.expectMessage(customEmojiMsg);

      await alice.clickAddReaction(customEmojiMsg);
      // The emoji picker is rendered inside a Popover, which Radix gives role="dialog"
      const picker = alicePage.getByRole('dialog');
      await expect(picker).toBeVisible({ timeout: 5_000 });

      // Search for the custom emoji — wait for a gridcell containing an <img>
      // (custom emojis render as <img>, unicode emojis render as <span>)
      const searchBox = picker.getByRole('searchbox', { name: 'Search' });
      await expect(searchBox).toBeVisible({ timeout: 5_000 });
      await searchBox.fill('testemoji');
      // Wait for the debounced search to filter and show custom emoji results
      const customEmojiBtn = picker.locator(
        'button[role="gridcell"]:has(img)',
      );
      await expect(customEmojiBtn.first()).toBeVisible({ timeout: 10_000 });
      await customEmojiBtn.first().click();

      // Step 5: Verify Alice sees a reaction pill on the message
      const aliceMsgContainer = alice.messageList
        .locator('[data-message-id]')
        .filter({ hasText: customEmojiMsg })
        .first();
      // The reaction pill contains either an <img> (custom emoji rendered) or
      // a <span> with :testemoji: text (fallback). We first wait for any
      // reaction pill to appear, then assert it contains an image.
      const aliceReactionPill = aliceMsgContainer.locator(
        'button:has(span)',
      ).filter({ hasText: /1/ });
      await expect(aliceReactionPill.first()).toBeVisible({ timeout: 15_000 });
      // Assert the pill renders an image, not :name: text fallback
      await expect(
        aliceMsgContainer.locator('img[alt=":testemoji:"]'),
      ).toBeVisible({ timeout: 5_000 });

      // Step 6: Verify Bob sees the custom emoji reaction as an image (the core fix)
      const bobMsgContainer = bob.messageList
        .locator('[data-message-id]')
        .filter({ hasText: customEmojiMsg })
        .first();
      const bobReactionPill = bobMsgContainer.locator(
        'button:has(span)',
      ).filter({ hasText: /1/ });
      await expect(bobReactionPill.first()).toBeVisible({ timeout: 15_000 });
      await expect(
        bobMsgContainer.locator('img[alt=":testemoji:"]'),
      ).toBeVisible({ timeout: 5_000 });

      // Step 7: Bob clicks the reaction pill to pile-on
      await bobMsgContainer
        .locator('button:has(img[alt=":testemoji:"])')
        .click();

      // Reaction count should update to 2
      await expect(
        bobMsgContainer.locator('button:has(img[alt=":testemoji:"])'),
      ).toContainText('2', { timeout: 10_000 });

      // Clean up temp file
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  );

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
    const boldTs = ts();
    await alice.composer.pressSequentially(`**bold test ${boldTs}**`, {
      delay: 10,
    });
    await alice.composer.press('Enter');
    await expect(
      alice.messageList.locator('strong').filter({ hasText: 'bold test' }),
    ).toBeVisible({ timeout: 10_000 });

    const italicTs = ts();
    await alice.composer.pressSequentially(`*italic test ${italicTs}*`, {
      delay: 10,
    });
    await alice.composer.press('Enter');
    await expect(
      alice.messageList.locator('em').filter({ hasText: 'italic test' }),
    ).toBeVisible({ timeout: 10_000 });

    const codeText = `code-${ts()}`;
    await alice.composer.pressSequentially(`\`${codeText}\``, { delay: 10 });
    await alice.composer.press('Enter');
    await expect(
      alice.messageList.locator('code').filter({ hasText: codeText }),
    ).toBeVisible({ timeout: 10_000 });
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
    // Desktop Chrome device in Playwright has a Linux user-agent, so mod+k
    // resolves to Ctrl+K (not Cmd+K). Use Control explicitly.
    await alicePage.keyboard.press('Control+k');
    const searchInput = alicePage.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill('test');
    await searchInput.press('Enter');

    // With E2EE, results are decrypted client-side and show actual content.
    // Verify either a result row (with #channel tag) appears or the empty state.
    await expect(
      alicePage
        .getByText('#general')
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
