import type { KeyObject } from "node:crypto";

export interface MinisignKey {
  keyId: Buffer;
  key: KeyObject;
}
export function publicKey(base64: string): MinisignKey;
export function verifySignature(data: Buffer, sigText: string, key: MinisignKey): string | null;
