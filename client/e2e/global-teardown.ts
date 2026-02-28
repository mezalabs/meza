import { test as teardown } from '@playwright/test';

teardown('cleanup', async () => {
  // No-op for now. Test data is left in place for debugging.
  // Reset happens at the start of the next run via global-setup.
});
