import { randomBytes, webcrypto } from 'node:crypto';

import { getTaskInternalPathTaskKeyRegExp } from '@cadenway/contracts/validators/internal/task-service';
import { z } from 'zod';

import type { PaletteCursor } from '../../../../application/ports/outbound/pagination/palette/palette-cursor.port.js';

const prefix = 'v1.';
const maximumCursorLength = 1024;
const nonceBytes = 12;
const tagBytes = 16;
const uuid = z.uuid();
const taskKey = z
  .string()
  .regex(getTaskInternalPathTaskKeyRegExp)
  .refine((key) => key === key.trim());
const listId = z.uuidv7().refine((id) => id === id.toLowerCase());
const cursorPayload = z.union([
  z.tuple([z.literal('task'), taskKey]),
  z.tuple([z.literal('list'), listId]),
]);
const decodeUtf8 = new TextDecoder('utf-8', { fatal: true });

type CursorBinding = Parameters<PaletteCursor['decode']>[1];
type CursorPosition = Awaited<ReturnType<PaletteCursor['decode']>>;

/** Authenticates opaque palette continuations with the search context and sort order. */
export class AesPaletteCursorAdapter implements PaletteCursor {
  // #region Properties
  /** Non-extractable AES key shared by Search replicas. */
  private readonly key: Promise<webcrypto.CryptoKey>;
  // #endregion

  // #region Constructor
  /** Imports a copy of the configured 32-byte key. */
  public constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new RangeError('Palette cursors require a 32-byte key.');
    this.key = webcrypto.subtle.importKey('raw', Uint8Array.from(key), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  }
  // #endregion

  // #region Methods
  /** Seals the portable position of the last disclosed result. */
  public async encode(binding: Parameters<PaletteCursor['encode']>[0]): Promise<string> {
    const aad = authenticatedBinding(binding);
    const payload = cursorPayload.safeParse([binding.after.kind, binding.after.id]);
    if (aad === null || !payload.success) throw new Error('Invalid palette continuation.');

    const nonce = randomBytes(nonceBytes);
    const ciphertext = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: tagBytes * 8 },
      await this.key,
      Buffer.from(JSON.stringify(payload.data)),
    );
    return prefix + Buffer.concat([nonce, Buffer.from(ciphertext)]).toString('base64url');
  }

  /** Returns the sealed position only if its encoding, binding and contents all validate. */
  public async decode(cursor: string, binding: CursorBinding): Promise<CursorPosition> {
    if (cursor.length > maximumCursorLength || !cursor.startsWith(prefix)) return null;
    const encoded = cursor.slice(prefix.length);
    const sealed = Buffer.from(encoded, 'base64url');
    if (sealed.length <= nonceBytes + tagBytes || sealed.toString('base64url') !== encoded)
      return null;

    const aad = authenticatedBinding(binding);
    if (aad === null) return null;

    try {
      const plaintext = await webcrypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: sealed.subarray(0, nonceBytes),
          additionalData: aad,
          tagLength: tagBytes * 8,
        },
        await this.key,
        sealed.subarray(nonceBytes),
      );
      const data: unknown = JSON.parse(decodeUtf8.decode(plaintext));
      const payload = cursorPayload.safeParse(data);
      if (!payload.success) return null;
      const [kind, id] = payload.data;
      return { kind, id };
    } catch {
      return null;
    }
  }
  // #endregion
}

function authenticatedBinding(binding: CursorBinding): Buffer<ArrayBuffer> | null {
  if (
    !uuid.safeParse(binding.userId).success ||
    !uuid.safeParse(binding.organizationId).success ||
    binding.normalizedQuery.length === 0
  ) {
    return null;
  }

  return Buffer.from(
    JSON.stringify([
      'search-palette/v1',
      'task-key-then-list-id/asc',
      binding.userId.toLowerCase(),
      binding.organizationId.toLowerCase(),
      binding.normalizedQuery,
    ]),
  );
}
