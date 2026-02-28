import type { Page } from '@playwright/test';

/** Wait for the WebSocket gateway connection to be established. */
export async function waitForGatewayConnection(
  page: Page,
  timeout = 10_000,
): Promise<void> {
  await page.waitForEvent('websocket', {
    predicate: (ws) => ws.url().includes('/ws'),
    timeout,
  });
}

/** Wait for a message with the given text to appear in the channel view. */
export async function waitForMessage(
  page: Page,
  text: string,
  timeout = 5_000,
): Promise<void> {
  await page.getByText(text).waitFor({ state: 'visible', timeout });
}

/** Wait for a typing indicator showing the given username. */
export async function waitForTypingIndicator(
  page: Page,
  username: string,
  timeout = 5_000,
): Promise<void> {
  await page
    .getByText(new RegExp(`${username}.*typing`, 'i'))
    .waitFor({ state: 'visible', timeout });
}

/** Wait for a presence status change for a user. */
export async function waitForPresenceChange(
  page: Page,
  username: string,
  _status: 'online' | 'offline' | 'idle' | 'dnd',
  timeout = 10_000,
): Promise<void> {
  // Presence indicators vary by UI — wait for the username's status badge
  await page
    .locator(`[data-testid="presence-${username}"]`)
    .waitFor({ state: 'visible', timeout });
}
