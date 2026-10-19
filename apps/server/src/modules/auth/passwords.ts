/**
 * Argon2id password hashing (REQ §6.1, ARCHITECTURE A2) with `@node-rs/argon2`. Parameters
 * come from config; a hash made with older parameters is upgraded at the next login.
 */
import { randomBytes } from 'node:crypto';

import { hash, parseOptions, verify, type Algorithm, type Options } from '@node-rs/argon2';

/** `Algorithm.Argon2id` (an ambient const enum, so it cannot be referenced directly). */
const ARGON2ID = 2 as Algorithm;

export interface PasswordParams {
  memoryKib: number;
  iterations: number;
  parallelism: number;
}

export class PasswordHasher {
  readonly #options: Options;
  #dummy: Promise<string> | undefined;

  constructor(params: PasswordParams) {
    this.#options = {
      algorithm: ARGON2ID,
      memoryCost: params.memoryKib,
      timeCost: params.iterations,
      parallelism: params.parallelism,
    };
  }

  hash(password: string): Promise<string> {
    return hash(password, this.#options);
  }

  /** False for a wrong password or an unparseable hash; never throws. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real verification when there is no account (or no password),
   * so response times do not reveal which usernames exist.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.#dummy ??= this.hash(randomBytes(32).toString('base64'));
    await this.verify(await this.#dummy, password);
    return false;
  }

  /** Whether `passwordHash` was made with other parameters than the configured ones. */
  needsRehash(passwordHash: string): boolean {
    try {
      const current = parseOptions(passwordHash);
      return (
        current.algorithm !== ARGON2ID ||
        current.memoryCost !== this.#options.memoryCost ||
        current.timeCost !== this.#options.timeCost ||
        current.parallelism !== this.#options.parallelism
      );
    } catch {
      return true;
    }
  }
}
