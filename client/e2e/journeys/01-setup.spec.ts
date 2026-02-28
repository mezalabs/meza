/**
 * Journey 1: Setup
 *
 * Creates the shared world that all other journeys depend on:
 * - Registers alice, bob, charlie
 * - Alice creates a server with channels and roles
 * - Alice invites bob, who joins
 * - Charlie remains serverless (for message request testing)
 */

import { expect, test } from '@playwright/test';
import { AuthPage } from '../pages/AuthPage';
import {
  chapter,
  createContext,
  reportFailures,
  saveAuth,
  softStep,
} from './helpers';

const TEST_USERS = {
  alice: {
    email: 'e2e_alice@test.local',
    username: 'e2e_alice',
    password: 'testpass123',
  },
  bob: {
    email: 'e2e_bob@test.local',
    username: 'e2e_bob',
    password: 'testpass123',
  },
  charlie: {
    email: 'e2e_charlie@test.local',
    username: 'e2e_charlie',
    password: 'testpass123',
  },
};

// Shared across chapters within this journey
let aliceRecoveryPhrase = '';
let inviteCode = '';

test('Journey 1: Setup', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);

  // ---- Chapter: Alice Registration ----
  const { context: aliceCtx, page: alicePage } = await createContext(
    browser,
    'alice',
  );
  const auth = new AuthPage(alicePage);

  await chapter(alicePage, testInfo, 'Alice Registration', async () => {
    await auth.goto();
    await expect(
      alicePage.getByRole('button', { name: /sign up/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Edge case: invalid email
    await softStep(
      alicePage,
      testInfo,
      'Registration with invalid email',
      async () => {
        await auth.register(
          'not-an-email',
          'e2e_test',
          TEST_USERS.alice.password,
        );
        await auth.expectError('valid email');
      },
    );

    // Edge case: short password
    await softStep(
      alicePage,
      testInfo,
      'Registration with short password',
      async () => {
        await auth.goto();
        await auth.register(TEST_USERS.alice.email, 'e2e_test', 'short');
        await auth.expectError('8 characters');
      },
    );

    // Edge case: mismatched passwords
    await softStep(
      alicePage,
      testInfo,
      'Registration with mismatched passwords',
      async () => {
        await auth.goto();
        await auth.switchToSignUp();
        await auth.emailInput.fill(TEST_USERS.alice.email);
        await auth.usernameInput.fill('e2e_test');
        await auth.passwordInput.fill('testpass123');
        await auth.confirmPasswordInput.fill('different123');
        await auth.createAccountButton.click();
        await auth.expectError('match');
      },
    );

    // Successful registration
    await auth.goto();
    aliceRecoveryPhrase = await auth.registerAndConfirm(
      TEST_USERS.alice.email,
      TEST_USERS.alice.username,
      TEST_USERS.alice.password,
    );
    expect(aliceRecoveryPhrase.split(' ').length).toBe(12);

    // Verify alice is in the app shell
    await expect(alicePage.getByLabel('Log out')).toBeVisible({
      timeout: 15_000,
    });

    // Save auth state for other journeys
    await saveAuth(aliceCtx, 'alice');
  });

  // ---- Chapter: Server Creation ----
  await chapter(alicePage, testInfo, 'Server Creation', async () => {
    await alicePage.getByLabel('Create server').click();
    await alicePage.getByRole('button', { name: /Start from Scratch/ }).click();
    await alicePage.getByLabel('Server name').fill('Test Server');
    await alicePage.getByRole('button', { name: 'Next' }).click();
    await alicePage.getByRole('button', { name: 'Next' }).click(); // Keep default channels
    await alicePage.getByRole('button', { name: 'Skip' }).click(); // Skip onboarding → creates server

    // Wizard auto-navigates to the server's default channel after creation.
    // If the invite step renders first, dismiss it; otherwise just verify the server loaded.
    const inviteHeading = alicePage.getByText('Your server is ready!');
    if (await inviteHeading.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await alicePage.getByRole('button', { name: 'Done' }).click();
    }

    // Verify server in sidebar
    await expect(
      alicePage
        .getByLabel('Servers')
        .locator('button[title="Test Server"]')
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    // Verify default #general channel
    await expect(
      alicePage.locator('nav[aria-label="Channels"]').getByText('general'),
    ).toBeVisible({ timeout: 15_000 });

    // Verify alice can access server settings (owner)
    await alicePage.getByLabel('Server settings').click();
    await expect(
      alicePage.getByRole('heading', { name: /Server Settings/i }),
    ).toBeVisible();
    // Close settings by navigating back to server
    await alicePage
      .getByLabel('Servers')
      .locator('button[title="Test Server"]')
      .first()
      .click();
  });

  // ---- Chapter: Channel & Role Setup ----
  await chapter(alicePage, testInfo, 'Channel & Role Setup', async () => {
    // Create voice channel
    await alicePage.getByLabel('Create text channel').click();
    await expect(alicePage.getByRole('dialog')).toBeVisible();
    await alicePage.getByPlaceholder('new-channel').fill('voice');
    await alicePage.getByRole('dialog').getByText('Voice').click();
    await alicePage.getByRole('button', { name: 'Create' }).click();
    await expect(alicePage.getByRole('dialog')).not.toBeVisible({
      timeout: 5_000,
    });

    // Create private channel
    await alicePage.getByLabel('Create text channel').click();
    await expect(alicePage.getByRole('dialog')).toBeVisible();
    await alicePage.getByPlaceholder('new-channel').fill('private');
    // Toggle private — click the label text since the checkbox is sr-only
    const privateLabel = alicePage
      .getByRole('dialog')
      .getByText('Private Channel');
    if (await privateLabel.isVisible().catch(() => false)) {
      await privateLabel.click();
    }
    await alicePage.getByRole('button', { name: 'Create' }).click();
    await expect(alicePage.getByRole('dialog')).not.toBeVisible({
      timeout: 5_000,
    });

    // Navigate to server settings → roles
    await alicePage.getByLabel('Server settings').click();
    await alicePage.getByRole('button', { name: 'Roles' }).click();

    // Create Admin role
    await alicePage.getByRole('button', { name: 'Create Role' }).click();
    await alicePage.getByPlaceholder('Role name').fill('Admin');
    await alicePage
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(
      alicePage.getByText('Admin', { exact: true }).first(),
    ).toBeVisible();

    // Create Moderator role
    await alicePage.getByRole('button', { name: 'Create Role' }).click();
    await alicePage.getByPlaceholder('Role name').fill('Moderator');
    await alicePage
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(alicePage.getByText('Moderator').first()).toBeVisible();

    // Navigate back to server
    await alicePage
      .getByLabel('Servers')
      .locator('button[title="Test Server"]')
      .first()
      .click();
  });

  // ---- Chapter: Invite Bob ----
  await chapter(alicePage, testInfo, 'Invite Bob', async () => {
    // Generate invite link
    await alicePage.getByLabel('Invite people').click();
    await expect(alicePage.getByText('Share this invite link')).toBeVisible({
      timeout: 10_000,
    });

    // Extract invite code
    const inviteText = await alicePage.locator('.font-mono').textContent();
    inviteCode = inviteText?.split('/').pop()?.trim() ?? '';
    expect(inviteCode.length).toBeGreaterThan(0);

    await alicePage.getByRole('button', { name: 'Done' }).click();

    // Register bob in a new context
    const { context: bobCtx, page: bobPage } = await createContext(
      browser,
      'bob',
    );
    const bobAuth = new AuthPage(bobPage);
    await bobAuth.goto();
    await bobAuth.registerAndConfirm(
      TEST_USERS.bob.email,
      TEST_USERS.bob.username,
      TEST_USERS.bob.password,
    );
    await expect(bobPage.getByLabel('Log out')).toBeVisible({
      timeout: 15_000,
    });
    await saveAuth(bobCtx, 'bob');

    // Bob joins server via invite code
    await bobPage.getByLabel('Join server').click();
    await expect(
      bobPage.getByRole('heading', { name: 'Join a Server' }),
    ).toBeVisible();
    await bobPage.getByLabel('Invite Code').fill(inviteCode);
    await bobPage.getByRole('button', { name: 'Preview' }).click();
    await expect(bobPage.getByText('Test Server')).toBeVisible({
      timeout: 10_000,
    });
    await bobPage.getByRole('button', { name: 'Join Server' }).click();

    // Verify bob sees the server
    await expect(
      bobPage
        .getByLabel('Servers')
        .locator('button[title="Test Server"]')
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    await bobCtx.close();

    // Verify alice sees bob in member list
    await alicePage.getByLabel('Show members').click();
    await expect(alicePage.getByText('e2e_bob')).toBeVisible({
      timeout: 10_000,
    });
  });

  // ---- Chapter: Register Charlie ----
  await chapter(alicePage, testInfo, 'Register Charlie', async () => {
    const { context: charlieCtx, page: charliePage } = await createContext(
      browser,
      'charlie',
    );
    const charlieAuth = new AuthPage(charliePage);
    await charlieAuth.goto();
    await charlieAuth.registerAndConfirm(
      TEST_USERS.charlie.email,
      TEST_USERS.charlie.username,
      TEST_USERS.charlie.password,
    );
    await expect(charliePage.getByLabel('Log out')).toBeVisible({
      timeout: 15_000,
    });
    await saveAuth(charlieCtx, 'charlie');
    await charlieCtx.close();
  });

  // Save recovery phrase for Journey 5
  await testInfo.attach('alice-recovery-phrase', {
    contentType: 'text/plain',
    body: aliceRecoveryPhrase,
  });

  // Write recovery phrase to a file so Journey 5 can access it
  const fs = await import('node:fs');
  fs.mkdirSync('.auth', { recursive: true });
  fs.writeFileSync('.auth/alice-recovery-phrase.txt', aliceRecoveryPhrase);

  await aliceCtx.close();
  reportFailures();
});
