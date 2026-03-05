import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Test user credentials. Must match users registered in global-setup.ts. */
export const TEST_USERS = {
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
} as const;

export type TestUserName = keyof typeof TEST_USERS;

/** Log in via the auth form UI. */
export async function loginViaUI(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/');

  // Wait for the auth form to render (landing page)
  const signInTab = page.getByRole('button', { name: /sign in/i }).first();
  await expect(signInTab).toBeVisible({ timeout: 15_000 });
  await signInTab.click();

  await page.getByPlaceholder('Email or username').fill(email);
  await page.getByPlaceholder('Password').fill(password);

  // The Sign In submit button (last one to disambiguate from tab)
  await page
    .getByRole('button', { name: /sign in/i })
    .last()
    .click();

  // Race: wait for either auth success or a server error message
  await Promise.race([
    page.waitForFunction(
      () => {
        const raw = localStorage.getItem('meza:user');
        if (!raw) return false;
        try {
          JSON.parse(raw);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    ),
    page
      .locator('[class*="text-error"], [class*="bg-error"]')
      .waitFor({ timeout: 15_000 })
      .then(() => {
        throw new Error('Login failed: server returned an error');
      }),
  ]);
}

/** Register a new user via the auth form UI. Handles the recovery phrase confirmation step. */
export async function registerViaUI(
  page: Page,
  email: string,
  username: string,
  password: string,
): Promise<void> {
  await page.goto('/');

  // Wait for the auth form to render
  const signUpTab = page.getByRole('button', { name: /sign up/i }).first();
  await expect(signUpTab).toBeVisible({ timeout: 15_000 });
  await signUpTab.click();

  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Username').fill(username);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  await page.getByRole('button', { name: /create account/i }).click();

  // After registration, the recovery phrase is shown (auth is deferred).
  // Wait for the recovery phrase screen or an error.
  const recoveryHeading = page.getByText('Recovery Phrase', { exact: true });
  const errorBanner = page.locator(
    '[class*="text-error"], [class*="bg-error"]',
  );

  await Promise.race([
    recoveryHeading.waitFor({ timeout: 30_000 }),
    errorBanner.waitFor({ timeout: 30_000 }).then(() => {
      throw new Error('Registration failed: server returned an error');
    }),
  ]);

  // Confirm the recovery phrase to finalize auth
  await page.getByLabel(/I have saved my recovery phrase/i).check();
  await page.getByRole('button', { name: /continue/i }).click();

  // Wait for auth state in localStorage
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('meza:user');
      if (!raw) return false;
      try {
        JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  );
}
