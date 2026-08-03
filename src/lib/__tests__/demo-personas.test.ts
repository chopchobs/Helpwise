/**
 * Tests: src/lib/demo-personas.ts (Phase 37 — เพิ่มโดย qa-testing gate)
 *
 * ไฟล์นี้เป็น single source of truth ที่ 3 ฝั่งพึ่งพา: demo-login route, /api/auth/agent/me
 * และ prisma/seed-demo.ts — ถ้า table เพี้ยน (ขาด persona, email ซ้ำ, slug ไม่ตรง)
 * อาการจะไปโผล่ตอน runtime บน prod เป็น 503 เงียบ ๆ เท่านั้น จึงล็อก invariant ไว้ที่นี่
 */

import { describe, it, expect } from "vitest";
import {
  DEMO_PERSONAS,
  DEMO_TENANT_SLUGS,
  isDemoPersonaKey,
  type DemoPersonaKey,
} from "@/lib/demo-personas";

const KEYS: DemoPersonaKey[] = ["primary", "secondary"];

describe("DEMO_PERSONAS — invariants ของ source of truth", () => {
  it("ทุก demo tenant ต้องมีครบทั้ง primary และ secondary (ไม่งั้น demo-login 503)", () => {
    for (const slug of DEMO_TENANT_SLUGS) {
      for (const key of KEYS) {
        const found = DEMO_PERSONAS.filter((p) => p.tenantSlug === slug && p.key === key);
        expect(found, `${slug}/${key}`).toHaveLength(1);
      }
    }
  });

  it("ไม่มี persona ที่อยู่นอก DEMO_TENANT_SLUGS (กัน persona หลุดไป tenant จริง)", () => {
    const allowed = new Set<string>(DEMO_TENANT_SLUGS);
    for (const p of DEMO_PERSONAS) {
      expect(allowed.has(p.tenantSlug), p.tenantSlug).toBe(true);
    }
  });

  it("email ไม่ซ้ำกันข้าม tenant — email คือ key ที่ /me ใช้จำแนก persona", () => {
    const emails = DEMO_PERSONAS.map((p) => p.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("จำนวน persona = จำนวน tenant × 2 (ไม่มี entry ค้าง/ซ้ำ)", () => {
    expect(DEMO_PERSONAS).toHaveLength(DEMO_TENANT_SLUGS.length * 2);
  });

  it("primary ใช้ password, secondary ใช้ persona branch เสมอ", () => {
    for (const p of DEMO_PERSONAS) {
      expect(p.auth, p.email).toBe(p.key === "primary" ? "password" : "persona");
    }
  });

  it("ทุก persona มี name ที่ไม่ว่าง (ใช้แสดงบนหน้ายืนยันสลับ persona)", () => {
    for (const p of DEMO_PERSONAS) {
      expect(p.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("ไม่มี field ที่ดูเหมือน secret ในตาราง (ไฟล์นี้ client-safe)", () => {
    const serialized = JSON.stringify(DEMO_PERSONAS);
    expect(serialized).not.toContain("demo-helpwise-2026");
    for (const p of DEMO_PERSONAS) {
      expect(Object.keys(p).sort()).toEqual(["auth", "email", "key", "name", "tenantSlug"]);
    }
  });
});

describe("isDemoPersonaKey", () => {
  it("รับเฉพาะ 'primary' / 'secondary'", () => {
    expect(isDemoPersonaKey("primary")).toBe(true);
    expect(isDemoPersonaKey("secondary")).toBe(true);
  });

  it.each([
    ["ตัวพิมพ์ใหญ่", "Primary"],
    ["ตัวพิมพ์ใหญ่ทั้งหมด", "SECONDARY"],
    ["มีช่องว่าง", " secondary"],
    ["ช่องว่างท้าย", "secondary "],
    ["string ว่าง", ""],
    ["ค่าอื่น", "admin"],
    ["prototype pollution key", "__proto__"],
    ["constructor", "constructor"],
    ["ตัวเลข index", 0],
    ["ตัวเลข index 1", 1],
    ["boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["array", ["secondary"]],
    ["object", { key: "secondary" }],
  ])("ปฏิเสธ %s", (_label, value) => {
    expect(isDemoPersonaKey(value)).toBe(false);
  });
});
