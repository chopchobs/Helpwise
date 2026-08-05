import { describe, it, expect, afterEach, vi } from "vitest";
import { buildCsp } from "@/lib/csp";

// ค่าปลอมเท่านั้น — ห้ามใส่ Supabase project จริงลง fixture
const TEST_SUPABASE_URL = "https://test-project.supabase.co";

// อ่าน directive ตัวเดียวออกจาก CSP string (คืน "" ถ้าไม่มี directive นั้น)
function directive(csp: string, name: string): string {
  const found = csp
    .split("; ")
    .find((d) => d === name || d.startsWith(`${name} `));
  return found ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildCsp — connect-src (P6a: กัน CSP regression ของ external origin)", () => {
  it("includes both https and wss origins of NEXT_PUBLIC_SUPABASE_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);

    const connectSrc = directive(buildCsp(), "connect-src");

    // Realtime presence (Phase 35) ต้องต่อ WebSocket ได้ — ขาด wss: = presence ตายเงียบ
    expect(connectSrc).toContain("https://test-project.supabase.co");
    expect(connectSrc).toContain("wss://test-project.supabase.co");
    expect(connectSrc).toContain("'self'");
  });

  it("keeps the origin narrow — ไม่เปิดกว้างเป็น wildcard supabase", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);

    const connectSrc = directive(buildCsp(), "connect-src");

    expect(connectSrc).not.toContain("*");
    expect(connectSrc).toBe(
      "connect-src 'self' https://test-project.supabase.co wss://test-project.supabase.co",
    );
  });

  // documents พฤติกรรม fail-silent ที่มีอยู่: env หายตอน build = connect-src 'self' เฉย ๆ
  // การจับ "env หายตอน build" เป็นงานของ P1a (build-time guard) ไม่ใช่ test นี้
  it("falls back to 'self' only when NEXT_PUBLIC_SUPABASE_URL is unset (fail-silent)", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);

    expect(directive(buildCsp(), "connect-src")).toBe("connect-src 'self'");
  });
});

describe("buildCsp — directive ที่ห้ามหาย", () => {
  it.each([
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "default-src 'self'",
    "frame-src 'none'",
  ])("always emits %j", (expected) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);

    expect(buildCsp().split("; ")).toContain(expected);
  });
});

describe("buildCsp — prod vs dev", () => {
  it("adds upgrade-insecure-requests in production only", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(buildCsp().split("; ")).toContain("upgrade-insecure-requests");

    vi.stubEnv("NODE_ENV", "development");
    expect(buildCsp().split("; ")).not.toContain("upgrade-insecure-requests");
  });

  it("never allows 'unsafe-eval' in script-src in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(directive(buildCsp(), "script-src")).toBe(
      "script-src 'self' 'unsafe-inline'",
    );
  });

  it("allows 'unsafe-eval' in dev (HMR ต้องใช้ eval)", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(directive(buildCsp(), "script-src")).toContain("'unsafe-eval'");
  });
});
