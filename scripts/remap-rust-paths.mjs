#!/usr/bin/env node
/**
 * Runs a Rust build command with rustc's `--remap-path-prefix` for the cargo home and the repo
 * root (Phase 27). Without it, panic locations embed absolute build paths in the binary, e.g.
 * `C:\Users\<name>\.cargo\registry\src\…`, so the committed WASM module named the builder's
 * account and differed per machine. Cargo's `trim-paths` is not stable yet (Rust 1.99).
 *
 *   node scripts/remap-rust-paths.mjs ubrn build wasm2 --config ubrn.config.yaml --release
 *
 * Only for builds that set no RUSTFLAGS of their own: cargo prefers CARGO_ENCODED_RUSTFLAGS
 * over every target-specific flag. (ubrn's jsi2 Android build sets page-size flags per
 * target, so it does not use this; docs/security/audits.md.)
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('usage: node scripts/remap-rust-paths.mjs <command> [args…]');
  process.exit(2);
}

const repo = resolve(import.meta.dirname, '..');
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
const existing = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  : (process.env.RUSTFLAGS ?? '').split(' ').filter(Boolean);
const flags = [
  ...existing,
  `--remap-path-prefix=${join(cargoHome, 'registry', 'src')}=/cargo/registry/src`,
  `--remap-path-prefix=${join(cargoHome, 'git', 'checkouts')}=/cargo/git`,
  `--remap-path-prefix=${repo}=/pingdost`,
];

const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
delete env.RUSTFLAGS;
// The command comes from a package.json script, not user input; the shell resolves `ubrn`
// (a .cmd shim on Windows) from node_modules/.bin.
const result = spawnSync(command.join(' '), { stdio: 'inherit', env, shell: true });
process.exit(result.status ?? 1);
