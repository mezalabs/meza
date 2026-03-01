/**
 * Journey 4: Media & Voice
 *
 * Tests file attachments in chat and voice channel join/leave.
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
const ts = () => `${Date.now()}`;

/** Create a small test text file. */
function createTestTextFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const filePath = path.join(dir, 'test-upload.txt');
  fs.writeFileSync(filePath, `E2E test file content ${Date.now()}`);
  return filePath;
}

test('Journey 4: Media & Voice', async ({ browser }, testInfo) => {
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

  // ---- Chapter: File Attachments ----
  await chapter(alicePage, testInfo, 'File Attachments', async () => {
    await alice.goto(SERVER, 'general');

    const txtPath = createTestTextFile();
    const fileChooserPromise = alicePage.waitForEvent('filechooser');
    await alicePage.getByTitle('Attach files').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(txtPath);

    await alice.composer.fill(`file upload ${ts()}`);
    await alice.composer.press('Enter');

    // Verify file appears in message list
    await expect(
      alice.messageList
        .getByText('test-upload.txt')
        .or(alice.messageList.locator('a[download]')),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ---- Chapter: Voice Channel ----
  await chapter(alicePage, testInfo, 'Voice Channel', async () => {
    await alice.selectServer(SERVER);
    await alice.selectChannel('voice');

    // Alice joins voice
    const aliceJoinBtn = alicePage.getByRole('button', { name: /join voice/i });
    await expect(aliceJoinBtn).toBeVisible({ timeout: 15_000 });
    await aliceJoinBtn.click();
    await expect(alicePage.locator('main').getByText(/connected/i)).toBeVisible(
      { timeout: 15_000 },
    );

    // Bob joins voice
    await bob.goto(SERVER, 'general');
    await bob.selectChannel('voice');
    const bobJoinBtn = bobPage.getByRole('button', { name: /join voice/i });
    await expect(bobJoinBtn).toBeVisible({ timeout: 15_000 });
    await bobJoinBtn.click();
    await expect(bobPage.locator('main').getByText(/connected/i)).toBeVisible({
      timeout: 15_000,
    });

    // Alice leaves voice
    const aliceLeaveBtn = alicePage
      .getByRole('button', { name: /disconnect|leave/i })
      .or(alicePage.getByTitle(/disconnect|leave/i));
    await aliceLeaveBtn.first().click();

    // Bob leaves voice
    const bobLeaveBtn = bobPage
      .getByRole('button', { name: /disconnect|leave/i })
      .or(bobPage.getByTitle(/disconnect|leave/i));
    await bobLeaveBtn.first().click();
  });

  // ---- Chapter: Soundboard ----
  await chapter(alicePage, testInfo, 'Soundboard', async () => {
    await alice.selectServer(SERVER);
    await alicePage.getByLabel('Server settings').click();
    await alicePage.getByRole('button', { name: 'Soundboard' }).click();
    await expect(alicePage.getByText(/soundboard/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  await aliceCtx.close();
  await bobCtx.close();
  reportFailures();
});
