import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function generateAccessSecret(): string {
  return randomBytes(32).toString("hex");
}

export function hashAccessSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifyAccessSecret(receivedSecret: string | undefined, expectedHash: string | undefined): boolean {
  const receivedHash = hashAccessSecret(receivedSecret ?? "");
  const normalizedExpectedHash = expectedHash?.toLowerCase() ?? "";
  const validExpectedHash = HEX_SHA256_PATTERN.test(normalizedExpectedHash);
  const fixedExpectedHash = validExpectedHash ? normalizedExpectedHash : "0".repeat(64);
  const receivedCompare = createHash("sha256").update(receivedHash).digest();
  const expectedCompare = createHash("sha256").update(fixedExpectedHash).digest();
  return timingSafeEqual(receivedCompare, expectedCompare) && validExpectedHash;
}
