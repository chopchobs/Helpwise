import { describe, it, expect } from "vitest";
import { isValidSlugFormat, buildTenantLoginUrl } from "@/lib/slug";

describe("isValidSlugFormat", () => {
  // security property: ต้อง REJECT ทุก input ที่มี char ใช้ escape host / path
  // (".", "/", "@", ":", "\", whitespace, uppercase) — กัน path-traversal / host-injection / open-redirect
  it.each([
    "evil.com",
    "a@b",
    "x/y",
    "..",
    "../",
    "a:b",
    "a b",
    "",
    "Acme", // uppercase
    "a.b",
    "a\\b",
    "https://x",
  ])("rejects %j", (input) => {
    expect(isValidSlugFormat(input)).toBe(false);
  });

  it.each(["acme", "globex", "my-company", "abc123"])(
    "accepts %j",
    (input) => {
      expect(isValidSlugFormat(input)).toBe(true);
    },
  );
});

describe("buildTenantLoginUrl", () => {
  it("builds the login URL for a valid slug", () => {
    expect(buildTenantLoginUrl("acme", "helpwise.com")).toBe(
      "https://acme.helpwise.com/login",
    );
  });

  // input เหล่านี้คือ open-redirect / host-injection vector โดยตรง
  // (เช่น "evil.com" → host เป็นของ attacker, "x/y" → path-traversal, "@" → userinfo trick)
  // buildTenantLoginUrl ต้องคืน null เสมอ — slug เลวห้ามประกอบเป็น host ที่ attacker คุมได้
  it.each(["evil.com", "a@b", "x/y", "../", "https://evil"])(
    "returns null for malicious slug %j",
    (input) => {
      expect(buildTenantLoginUrl(input, "helpwise.com")).toBeNull();
    },
  );
});
