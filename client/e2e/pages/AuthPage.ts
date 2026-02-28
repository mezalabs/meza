import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class AuthPage {
  readonly page: Page;
  readonly signUpTab: Locator;
  readonly signInTab: Locator;
  readonly emailInput: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly confirmPasswordInput: Locator;
  readonly createAccountButton: Locator;
  readonly signInButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.signUpTab = page.getByRole('button', { name: /sign up/i });
    this.signInTab = page.getByRole('button', { name: /sign in/i });
    this.emailInput = page.getByPlaceholder('Email');
    this.usernameInput = page.getByPlaceholder('Username');
    this.passwordInput = page.getByPlaceholder('Password', { exact: true });
    this.confirmPasswordInput = page.getByPlaceholder('Confirm password');
    this.createAccountButton = page.getByRole('button', {
      name: /create account/i,
    });
    this.signInButton = page.getByRole('button', { name: /sign in/i });
  }

  async goto() {
    await this.page.goto('/');
  }

  async switchToSignUp() {
    await this.signUpTab.click();
  }

  async switchToSignIn() {
    await this.signInTab.click();
  }

  /** Fill the registration form and click Create Account (does not handle recovery phrase). */
  async register(email: string, username: string, password: string) {
    await this.switchToSignUp();
    await this.emailInput.fill(email);
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.confirmPasswordInput.fill(password);
    await this.createAccountButton.click();
  }

  /**
   * Full registration flow: fill form, submit, confirm recovery phrase.
   * Returns the 12-word recovery phrase string.
   */
  async registerAndConfirm(
    email: string,
    username: string,
    password: string,
  ): Promise<string> {
    await this.register(email, username, password);
    return this.confirmRecoveryPhrase();
  }

  /** Read the 12 recovery words from the phrase display grid. */
  async getRecoveryPhraseWords(): Promise<string[]> {
    await expect(
      this.page.getByText('Recovery Phrase', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    const wordElements = this.page.locator('.grid .font-mono');
    const words: string[] = [];
    const count = await wordElements.count();
    for (let i = 0; i < count; i++) {
      const text = await wordElements.nth(i).textContent();
      if (text) words.push(text.trim());
    }
    return words;
  }

  /**
   * Check the confirmation checkbox and click Continue on the recovery phrase screen.
   * Returns the phrase as a space-separated string.
   */
  async confirmRecoveryPhrase(): Promise<string> {
    const words = await this.getRecoveryPhraseWords();
    const phrase = words.join(' ');

    await this.page.getByLabel(/I have saved my recovery phrase/i).check();
    await this.page.getByRole('button', { name: /continue/i }).click();

    return phrase;
  }

  async login(email: string, password: string) {
    await this.switchToSignIn();
    await this.emailInput.fill(email);
    await this.page.getByPlaceholder('Password').fill(password);
    // The "Sign In" button inside the login form
    await this.page
      .getByRole('button', { name: /sign in/i })
      .last()
      .click();
  }

  /** Navigate to the account recovery form from the login view. */
  async switchToRecover() {
    await this.switchToSignIn();
    await this.page
      .getByRole('button', { name: /recover with recovery phrase/i })
      .click();
  }

  /** Fill and submit the account recovery form, then confirm the new recovery phrase if shown. */
  async recoverAccount(email: string, phrase: string, newPassword: string) {
    await expect(
      this.page.getByRole('heading', { name: 'Recover Account' }),
    ).toBeVisible({ timeout: 10_000 });

    await this.page.getByPlaceholder('Email').fill(email);
    await this.page
      .getByPlaceholder('Enter your 12-word recovery phrase')
      .fill(phrase);
    await this.page
      .getByPlaceholder('New password', { exact: true })
      .fill(newPassword);
    await this.page.getByPlaceholder('Confirm new password').fill(newPassword);
    await this.page.getByRole('button', { name: /recover account/i }).click();

    // Recovery generates new E2EE keys → confirm the new recovery phrase if shown
    const phraseHeading = this.page.getByText('Recovery Phrase', {
      exact: true,
    });
    const showsPhrase = await phraseHeading
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (showsPhrase) {
      await this.confirmRecoveryPhrase();
    }
  }

  async expectError(text: string) {
    await expect(this.page.getByText(text)).toBeVisible({ timeout: 30_000 });
  }
}
