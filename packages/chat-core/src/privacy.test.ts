import { describe, expect, it } from 'vitest';

import { PRIVACY_EXPLAINER } from './privacy';

const text = PRIVACY_EXPLAINER.map((section) => `${section.title}\n${section.body}`).join('\n');

describe('privacy explainer wording (REQ §1, §5.4; ARCHITECTURE A10)', () => {
  it('makes the promise in the agreed words', () => {
    expect(text).toContain('no permanent server-side chat history');
  });

  it('never claims that no data reaches a server', () => {
    expect(text).not.toMatch(
      /no data (ever )?(touches|reaches|goes to)|never (touch|reach)es (our|a) server|nothing (is stored|touches)|zero (metadata|data)|we (store|keep) nothing/i,
    );
  });

  it('names the limits: retention, metadata, backups, browser storage, relays, push', () => {
    for (const fact of [
      '14 days',
      'when, and how large',
      'no backup',
      'browser',
      'public key',
      'relay',
      'push',
      'screenshots',
      'who is in whose circle',
      '30 days',
    ]) {
      expect(text).toContain(fact);
    }
  });
});
