import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class ChannelPage {
  readonly page: Page;
  readonly messageList: Locator;
  readonly composer: Locator;
  constructor(page: Page) {
    this.page = page;
    this.messageList = page.locator('[data-testid="message-list"]');
    this.composer = page.getByPlaceholder(/message #|type a message/i);
    this.sendButton = page.getByRole('button', { name: 'Send' });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Navigate to a server by clicking its icon in the sidebar. */
  async selectServer(serverName: string) {
    await this.ensureServersLoaded();
    await this.page
      .getByLabel('Servers')
      .locator(`button[title="${serverName}"]`)
      .first()
      .click();
    // Wait for channel list heading to appear
    await expect(this.page.locator('nav[aria-label="Channels"]')).toBeVisible({
      timeout: 10_000,
    });
    // Ensure channels actually load (retry on API failure)
    await this.ensureChannelsLoaded();
  }

  /** Wait for servers to load, retrying if the API fails. */
  async ensureServersLoaded() {
    const nav = this.page.getByLabel('Servers');
    for (let attempt = 0; attempt < 3; attempt++) {
      const retryBtn = nav.getByRole('button', { name: 'Retry' });
      if (await retryBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await retryBtn.click();
        await this.page.waitForTimeout(1_000);
      } else {
        break;
      }
    }
  }

  /** Wait for channels to load, retrying if the API fails. */
  async ensureChannelsLoaded() {
    const nav = this.page.locator('nav[aria-label="Channels"]');
    const retryBtn = nav.getByRole('button', { name: 'Retry' });
    const anyChannel = nav.locator('[data-channel-type]');

    for (let attempt = 0; attempt < 5; attempt++) {
      // Wait for either a channel to appear or an error Retry button
      const found = await Promise.race([
        anyChannel
          .first()
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => 'channel' as const)
          .catch(() => 'timeout' as const),
        retryBtn
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => 'retry' as const)
          .catch(() => 'timeout' as const),
      ]);

      if (found === 'channel') break;
      if (found === 'retry') {
        await retryBtn.click();
        await this.page.waitForTimeout(1_000);
      } else {
        // Timeout — check once more and break if no retry button
        if (!(await retryBtn.isVisible().catch(() => false))) break;
        await retryBtn.click();
        await this.page.waitForTimeout(1_000);
      }
    }
  }

  /** Navigate to a channel by clicking its entry in the sidebar. */
  async selectChannel(channelName: string) {
    await this.ensureChannelsLoaded();
    const nav = this.page.locator('nav[aria-label="Channels"]');
    // Channel buttons use data-channel-type attribute and contain the channel name as text.
    const channelBtn = nav
      .locator('[data-channel-type]')
      .filter({ hasText: channelName });
    await channelBtn.click({ timeout: 10_000 });
    // Wait for main content to load (composer for text, or voice UI).
    // Use Promise.race because .or() hits strict-mode violations when
    // both the composer and the "Connected" badge are visible at once
    // (e.g. voice channels that also render a text composer).
    await Promise.race([
      expect(this.composer.first()).toBeVisible({ timeout: 10_000 }),
      expect(
        this.page
          .locator('main')
          .getByText(/connected|join voice/i)
          .first(),
      ).toBeVisible({ timeout: 10_000 }),
    ]);
  }

  /** Navigate to a channel in a specific server and wait for it to load. */
  async goto(serverName: string, channelName: string) {
    await this.page.goto('/');
    await expect(
      this.page.getByRole('button', { name: 'Settings', exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await this.selectServer(serverName);
    await this.selectChannel(channelName);
  }

  // ---------------------------------------------------------------------------
  // Sending messages
  // ---------------------------------------------------------------------------

  /** Send a text message via the composer (Enter to send). */
  async sendMessage(text: string) {
    await this.composer.fill(text);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.composer.press('Enter');
      const cleared = await expect(this.composer)
        .toHaveValue('', { timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (cleared) return;
    }
    await expect(this.composer).toHaveValue('', { timeout: 5_000 });
  }

  // ---------------------------------------------------------------------------
  // Message assertions (scoped to message list, NOT composer)
  // ---------------------------------------------------------------------------

  /** Assert a message with the given text is visible in the message list. */
  async expectMessage(text: string) {
    await expect(this.messageList.getByText(text)).toBeVisible({
      timeout: 10_000,
    });
  }

  /** Assert a message is NOT visible in the message list. */
  async expectNoMessage(text: string) {
    await expect(this.messageList.getByText(text)).not.toBeVisible({
      timeout: 10_000,
    });
  }

  /** Return a locator for a message containing the given text (scoped to message list). */
  messageLocator(text: string): Locator {
    return this.messageList.getByText(text);
  }

  // ---------------------------------------------------------------------------
  // Hover actions (scoped to specific message element)
  // ---------------------------------------------------------------------------

  /** Get the message container (div[data-message-id]) for a given text.
   *  Uses .first() to avoid strict mode violations when multiple containers
   *  match (e.g. a reply that references the original message text). */
  private messageContainer(text: string): Locator {
    return this.messageList
      .locator('[data-message-id]')
      .filter({ hasText: text })
      .first();
  }

  /** Hover over a message to reveal action buttons. */
  async hoverMessage(text: string) {
    await this.messageContainer(text).hover();
  }

  /** Click the Reply button on a hovered message. */
  async clickReply(messageText: string) {
    await this.hoverMessage(messageText);
    await this.messageContainer(messageText).getByTitle('Reply').click();
  }

  /** Click the Edit button on a hovered message. */
  async clickEdit(messageText: string) {
    await this.hoverMessage(messageText);
    await this.messageContainer(messageText).getByTitle('Edit').click();
  }

  /** Click the Delete button on a hovered message. */
  async clickDelete(messageText: string) {
    await this.hoverMessage(messageText);
    await this.messageContainer(messageText).getByTitle('Delete').click();
  }

  /** Click the Add Reaction button on a hovered message. */
  async clickAddReaction(messageText: string) {
    await this.hoverMessage(messageText);
    await this.messageContainer(messageText).getByTitle('Add reaction').click();
  }

  // ---------------------------------------------------------------------------
  // Edit flow
  // ---------------------------------------------------------------------------

  /** Edit a message inline: click edit, clear, type new text, save. */
  async editMessage(oldText: string, newText: string) {
    await this.clickEdit(oldText);
    // After clicking edit, the message container has a textarea.
    // Use textarea filter instead of hasText (old text is replaced by new text).
    const editContainer = this.messageList
      .locator('[data-message-id]')
      .filter({ has: this.page.locator('textarea') });
    const editArea = editContainer.locator('textarea');
    await editArea.fill(newText);
    await editContainer.getByRole('button', { name: 'Save' }).click();
  }

  // ---------------------------------------------------------------------------
  // Delete flow
  // ---------------------------------------------------------------------------

  /** Delete a message: click delete, confirm in dialog. */
  async deleteMessage(text: string) {
    await this.clickDelete(text);
    // Confirmation dialog appears — click the Delete button in the dialog
    await this.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete' })
      .click();
  }

  // ---------------------------------------------------------------------------
  // Reply flow
  // ---------------------------------------------------------------------------

  /** Reply to a message. */
  async replyToMessage(messageText: string, replyText: string) {
    await this.clickReply(messageText);
    // Composer placeholder changes to "Type a reply…"
    const replyComposer = this.page.getByPlaceholder(/type a reply/i);
    await expect(replyComposer).toBeVisible();
    await replyComposer.fill(replyText);
    await replyComposer.press('Enter');
    // Wait for composer to clear
    await expect(this.composer).toBeVisible({ timeout: 10_000 });
  }

  // ---------------------------------------------------------------------------
  // Typing indicator
  // ---------------------------------------------------------------------------

  /** Assert the typing indicator is visible. */
  async expectTypingIndicator() {
    await expect(this.page.getByText(/is typing|are typing/i)).toBeVisible({
      timeout: 10_000,
    });
  }

  /** Assert no typing indicator is visible. */
  async expectNoTypingIndicator() {
    await expect(
      this.page.getByText(/is typing|are typing/i),
    ).not.toBeVisible();
  }

  // ---------------------------------------------------------------------------
  // Pinned messages
  // ---------------------------------------------------------------------------

  /** Assert a message has the pinned indicator. */
  async expectPinned(messageText: string) {
    const container = this.messageContainer(messageText);
    await expect(container.getByLabel('Pinned')).toBeVisible();
  }

  // ---------------------------------------------------------------------------
  // E2EE assertions
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // System message assertions
  // ---------------------------------------------------------------------------

  /** Assert a system message with the given text is visible (e.g. "joined the server"). */
  async expectSystemMessage(text: string | RegExp) {
    await expect(this.messageList.getByText(text)).toBeVisible({
      timeout: 10_000,
    });
  }

  /** Assert no raw JSON content like {"t":"..."} is visible in the message list. */
  async expectNoRawJson() {
    await expect(this.messageList.locator('text=/\\{"t":/')).toHaveCount(0, {
      timeout: 5_000,
    });
  }

  /** Wait for encryption to initialize (composer placeholder stops saying "Setting up encryption"). */
  async waitForEncryption() {
    await expect(this.composer).not.toHaveAttribute(
      'placeholder',
      /Setting up encryption/,
      { timeout: 15_000 },
    );
  }
}
