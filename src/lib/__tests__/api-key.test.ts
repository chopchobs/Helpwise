/**
 * src/lib/__tests__/api-key.test.ts
 * Unit tests สำหรับ api-key.ts (generation + hashing) — Phase 14
 *
 * ⚠️ เก็บแค่ keyHash + keyPrefix — ห้ามเก็บ plaintext
 */

import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey, KEY_PREFIX_DISPLAY_LENGTH } from "@/lib/api-key";

describe("generateApiKey", () => {
  it("plaintext ขึ้นต้นด้วย 'hw_live_'", () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith("hw_live_")).toBe(true);
  });

  it("keyPrefix = 12 ตัวแรกของ plaintext", () => {
    const { plaintext, keyPrefix } = generateApiKey();
    expect(keyPrefix).toBe(plaintext.slice(0, KEY_PREFIX_DISPLAY_LENGTH));
    expect(keyPrefix).toHaveLength(12);
  });

  it("keyHash = sha256 hex ของ plaintext (deterministic, ตรงกับ hashApiKey)", () => {
    const { plaintext, keyHash } = generateApiKey();
    expect(keyHash).toBe(hashApiKey(plaintext));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("เรียก 2 ครั้ง → ได้ plaintext/keyHash/keyPrefix ต่างกัน (random)", () => {
    const a = generateApiKey();
    const b = generateApiKey();

    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.keyHash).not.toBe(b.keyHash);
    expect(a.keyPrefix).not.toBe(b.keyPrefix);
  });
});

describe("hashApiKey", () => {
  it("คืน sha256 hex string ความยาว 64 ตัวอักษร", () => {
    const hash = hashApiKey("hw_live_sometestkey");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deterministic — input เดียวกัน → hash เดียวกันเสมอ", () => {
    const input = "hw_live_fixedvalue";
    expect(hashApiKey(input)).toBe(hashApiKey(input));
  });

  it("input ต่างกัน → hash ต่างกัน", () => {
    expect(hashApiKey("a")).not.toBe(hashApiKey("b"));
  });

  it("empty string → ยังคืน valid sha256 hash (ไม่ throw)", () => {
    expect(hashApiKey("")).toMatch(/^[0-9a-f]{64}$/);
  });
});
