import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function stableRatio(...parts: Array<string | number>): number {
  const digest = createHash("sha256").update(parts.join("|")).digest();
  const value = digest.readUInt32BE(0);
  return value / 0xffffffff;
}

export function stableSeed(...parts: Array<string | number>): number {
  const digest = createHash("sha256").update(parts.join("|")).digest();
  return digest.readUInt32BE(0);
}

export function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
