import { describe, expect, it } from 'vitest';

import { ConnectionRegistry, type RegisteredConnection } from './registry';

function connection(deviceId: string) {
  const conn = { deviceId, replacedCalls: 0, replaced: () => void conn.replacedCalls++ };
  return conn satisfies RegisteredConnection;
}

describe('ConnectionRegistry', () => {
  it('keeps one connection per device and tells the old one it was replaced', () => {
    const registry = new ConnectionRegistry<ReturnType<typeof connection>>();
    const first = connection('device-a');
    const second = connection('device-a');
    registry.add(first);
    registry.add(second);
    expect(registry.get('device-a')).toBe(second);
    expect(first.replacedCalls).toBe(1);
    expect(registry.size).toBe(1);

    // The replaced connection closing later must not remove its successor.
    registry.remove(first);
    expect(registry.get('device-a')).toBe(second);
    registry.remove(second);
    expect(registry.get('device-a')).toBeUndefined();
  });
});
