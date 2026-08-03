/**
 * Tests: src/lib/demo-persona-ui.ts (Phase 37 slice 2)
 * โฟกัส: resolveDemoNext() = open-redirect hardening ของ param `next` บน /demo
 */

import { describe, it, expect } from "vitest";
import {
  resolveDemoNext,
  buildDemoPersonaUrl,
  demoBannerDismissKey,
  shouldShowDemoPersonaBanner,
  DEMO_NEXT_FALLBACK,
} from "@/lib/demo-persona-ui";

describe("resolveDemoNext", () => {
  it("ผ่าน: relative path /tickets/<id>", () => {
    expect(resolveDemoNext("/tickets/ckt123abc")).toBe("/tickets/ckt123abc");
  });

  it("fallback เมื่อไม่มีค่า (null / ว่าง)", () => {
    expect(resolveDemoNext(null)).toBe(DEMO_NEXT_FALLBACK);
    expect(resolveDemoNext("")).toBe(DEMO_NEXT_FALLBACK);
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["http absolute", "http://evil.com"],
    ["https absolute", "https://evil.com"],
    ["backslash host", "\\\\evil.com"],
    ["slash-backslash host", "/\\evil.com"],
    ["path traversal", "/tickets/abc/../../settings"],
    ["path อื่นของแอป", "/settings/api-keys"],
    ["userinfo @", "/tickets/abc@evil.com"],
    ["encoded slash", "/tickets/%2F%2Fevil.com"],
    ["encoded slash ล้วน", "%2Ftickets%2Fabc"],
    ["newline ต่อท้าย", "/tickets/abc\n"],
    ["newline แทรกกลาง", "/tickets/abc\nhttps://evil.com"],
    ["carriage return", "/tickets/abc\r"],
    ["query string ต่อท้าย", "/tickets/abc?redirect=//evil.com"],
    ["fragment ต่อท้าย", "/tickets/abc#//evil.com"],
    ["trailing slash", "/tickets/abc/"],
    ["ไม่มี id", "/tickets/"],
    ["absolute path อื่น", "/demo"],
    ["relative ไม่มี /", "tickets/abc"],
    ["ช่องว่างนำหน้า", " /tickets/abc"],
  ])("fallback เมื่อ %s", (_label, raw) => {
    expect(resolveDemoNext(raw)).toBe(DEMO_NEXT_FALLBACK);
  });
});

describe("buildDemoPersonaUrl", () => {
  it("เป็น absolute URL + persona=secondary + พาไป ticket ใบเดิม", () => {
    expect(buildDemoPersonaUrl("https://acme.gethelpwise.xyz", "ckt123abc")).toBe(
      "https://acme.gethelpwise.xyz/demo?persona=secondary&next=/tickets/ckt123abc"
    );
  });

  it("ค่า next ที่ประกอบขึ้นต้องผ่าน resolveDemoNext (round-trip)", () => {
    const url = buildDemoPersonaUrl("https://acme.gethelpwise.xyz", "ckt123abc");
    const nextParam = new URL(url).searchParams.get("next");
    expect(resolveDemoNext(nextParam)).toBe("/tickets/ckt123abc");
  });
});

describe("demoBannerDismissKey", () => {
  it("key ผูกกับ tenant (คนละ tenant คนละ key)", () => {
    expect(demoBannerDismissKey("acme")).toBe(
      "helpwise:demo-persona-banner-dismissed:acme"
    );
    expect(demoBannerDismissKey("acme")).not.toBe(demoBannerDismissKey("globex"));
  });
});

describe("shouldShowDemoPersonaBanner", () => {
  it("แสดงเมื่อ demo tenant + persona primary + ยังไม่ปิด", () => {
    expect(
      shouldShowDemoPersonaBanner({
        demoPersona: "primary",
        tenantSlug: "acme",
        isDismissed: false,
      })
    ).toBe(true);
  });

  it("ไม่แสดงเมื่อ session เป็น secondary อยู่แล้ว", () => {
    expect(
      shouldShowDemoPersonaBanner({
        demoPersona: "secondary",
        tenantSlug: "acme",
        isDismissed: false,
      })
    ).toBe(false);
  });

  it("ไม่แสดงเมื่อไม่ใช่ demo persona (null)", () => {
    expect(
      shouldShowDemoPersonaBanner({
        demoPersona: null,
        tenantSlug: "acme",
        isDismissed: false,
      })
    ).toBe(false);
  });

  it("ไม่แสดงเมื่อไม่ใช่ demo tenant", () => {
    expect(
      shouldShowDemoPersonaBanner({
        demoPersona: "primary",
        tenantSlug: "realco",
        isDismissed: false,
      })
    ).toBe(false);
    expect(
      shouldShowDemoPersonaBanner({
        demoPersona: "primary",
        tenantSlug: null,
        isDismissed: false,
      })
    ).toBe(false);
  });

  it("ไม่แสดงเมื่อเคย dismiss แล้ว", () => {
    expect(
      shouldShowDemoPersonaBanner({
        demoPersona: "primary",
        tenantSlug: "acme",
        isDismissed: true,
      })
    ).toBe(false);
  });
});
