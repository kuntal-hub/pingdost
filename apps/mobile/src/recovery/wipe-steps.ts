// The order of wiping this phone (`wipe.ts` supplies the real steps). Pure, so it is
// unit-tested without the native modules.

export interface WipeSteps {
  /** Closes the encrypted database and drops the crypto context. */
  resetCrypto(): Promise<void>;
  deleteDatabase(): Promise<void>;
  /** Attachment files and backup files. */
  deleteFiles(): Promise<void>;
  /** Database key, pickle key, account identity key, recovery phrase. */
  deleteSecrets(): Promise<void>;
  /** Scheduled reminders (the monthly backup reminder) and notifications on screen. */
  clearNotifications(): Promise<void>;
  /** Forgets the session; the app then shows the welcome screen. */
  logout(): Promise<void>;
}

/** Runs every step; a failing cleanup step does not stop the ones after it. */
export async function runWipe(steps: WipeSteps): Promise<void> {
  await steps.resetCrypto();
  await steps.deleteDatabase().catch(() => undefined);
  await steps.deleteFiles().catch(() => undefined);
  await steps.deleteSecrets().catch(() => undefined);
  await steps.clearNotifications().catch(() => undefined);
  await steps.logout();
}
