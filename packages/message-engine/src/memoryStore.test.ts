import { describe, expect, it } from 'vitest';

import { MemoryEngineStore } from './memoryStore';
import { messageRecord, runEngineStoreContract } from './testing';

runEngineStoreContract('memory', () => Promise.resolve(new MemoryEngineStore()));

describe('MemoryEngineStore', () => {
  it('copies records in and out', async () => {
    const store = new MemoryEngineStore();
    const message = messageRecord();
    await store.apply({ messages: [message] });
    message.body = 'changed by the caller';
    const read = await store.getMessage(message.messageId);
    expect(read?.body).toBe('hello');
    read!.body = 'changed again';
    expect((await store.getMessage(message.messageId))?.body).toBe('hello');
  });

  it('writes nothing from a failed batch', async () => {
    const store = new MemoryEngineStore();
    store.failNextApply = new Error('disk full');
    const message = messageRecord();
    await expect(store.apply({ messages: [message] })).rejects.toThrow('disk full');
    expect(await store.getMessage(message.messageId)).toBeUndefined();
  });
});
