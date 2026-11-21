import { createCipheriv, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AesPaletteCursorAdapter } from './aes-palette-cursor.adapter.js';

const binding = {
  userId: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24',
  organizationId: '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10',
  normalizedQuery: 'équipe plate-forme',
};
const uuidv4 = '2139a9fb-5d80-4135-8323-6a2a043861ba';
const task = { kind: 'task', id: 'CAD-482' } as const;
const list = { kind: 'list', id: '01938f6e-d7b6-7875-9d17-25b0e7bd6b39' } as const;

describe('AesPaletteCursorAdapter', () => {
  it.each([task, list])('shares a fresh opaque $kind anchor across replicas', async (after) => {
    const key = randomBytes(32);
    const first = new AesPaletteCursorAdapter(key);
    const second = new AesPaletteCursorAdapter(Buffer.from(key));
    key.fill(0);

    const cursor = await first.encode({ ...binding, after });

    expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
    expect(cursor.length).toBeLessThanOrEqual(1024);
    expect(await first.encode({ ...binding, after })).not.toBe(cursor);
    await expect(
      second.decode(cursor, {
        ...binding,
        userId: binding.userId.toUpperCase(),
        organizationId: binding.organizationId.toUpperCase(),
      }),
    ).resolves.toEqual(after);
  });

  it.each([
    { userId: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c25' },
    { organizationId: '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11' },
    { normalizedQuery: 'équipe' },
  ])('rejects a different binding %j', async (differentBinding) => {
    const adapter = new AesPaletteCursorAdapter(randomBytes(32));
    const cursor = await adapter.encode({ ...binding, after: task });

    await expect(adapter.decode(cursor, { ...binding, ...differentBinding })).resolves.toBeNull();
  });

  it('rejects a token under a different key, and rejects ciphertext tampering', async () => {
    const adapter = new AesPaletteCursorAdapter(randomBytes(32));
    const otherReplica = new AesPaletteCursorAdapter(randomBytes(32));
    const cursor = await adapter.encode({ ...binding, after: task });
    const changed = Buffer.from(cursor.slice('v1.'.length), 'base64url');
    changed.writeUInt8(changed.readUInt8(12) ^ 1, 12);

    await expect(otherReplica.decode(cursor, binding)).resolves.toBeNull();
    await expect(
      adapter.decode(`v1.${changed.toString('base64url')}`, binding),
    ).resolves.toBeNull();
  });

  it('rejects unversioned, unsupported, noncanonical and out-of-bounds tokens', async () => {
    const adapter = new AesPaletteCursorAdapter(randomBytes(32));
    const cursor = await adapter.encode({ ...binding, after: task });
    const encoded = cursor.slice('v1.'.length);

    for (const invalid of [
      '',
      'v1.',
      encoded,
      `v0.${encoded}`,
      `${cursor}=`,
      `v1.${'A'.repeat(1022)}`,
    ]) {
      await expect(adapter.decode(invalid, binding)).resolves.toBeNull();
    }
  });

  it('rejects noncanonical resource keys', async () => {
    const adapter = new AesPaletteCursorAdapter(randomBytes(32));

    for (const after of [
      { kind: 'list' as const, id: uuidv4 },
      { kind: 'list' as const, id: list.id.toUpperCase() },
      { kind: 'task' as const, id: `${task.id}\n` },
    ]) {
      await expect(adapter.encode({ ...binding, after })).rejects.toThrow(
        'Invalid palette continuation.',
      );
    }
  });

  it.each([
    { payload: ['task', task.id, uuidv4] },
    { payload: ['task'] },
    { payload: ['space', list.id] },
  ])('rejects a sealed payload with invalid structure $payload', async ({ payload }) => {
    const key = randomBytes(32);
    const adapter = new AesPaletteCursorAdapter(key);

    await expect(adapter.decode(sealPayload(key, payload), binding)).resolves.toBeNull();
  });

  it('rejects an authenticated token with obsolete ordering', async () => {
    const key = randomBytes(32);
    const adapter = new AesPaletteCursorAdapter(key);
    const token = sealPayload(key, ['task', task.id], 'list-id-then-task-key/asc');

    await expect(adapter.decode(token, binding)).resolves.toBeNull();
  });

  it('requires exactly 32 bytes of key material', () => {
    expect(() => new AesPaletteCursorAdapter(new Uint8Array(31))).toThrow(RangeError);
    expect(() => new AesPaletteCursorAdapter(new Uint8Array(33))).toThrow(RangeError);
  });
});

function sealPayload(
  key: Uint8Array,
  payload: unknown,
  sort: string = 'task-key-then-list-id/asc',
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        'search-palette/v1',
        sort,
        binding.userId,
        binding.organizationId,
        binding.normalizedQuery,
      ]),
    ),
  );
  const sealed = Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `v1.${sealed.toString('base64url')}`;
}
