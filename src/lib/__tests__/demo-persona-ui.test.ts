/**
 * Tests: src/lib/demo-persona-ui.ts (Phase 37 slice 2)
 * โฟกัส: resolveDemoNext() = open-redirect hardening ของ param `next` บน /demo
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  resolveDemoNext,
  resolveDemoEntryMode,
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

// เพิ่มโดย qa-testing (Phase 37 gate) — boundary/property ที่ตารางเดิมยังไม่ครอบ
describe("resolveDemoNext — boundary เพิ่มเติม", () => {
  it.each([
    ["null byte ต่อท้าย", "/tickets/abc\u0000"],
    ["null byte แทรกกลาง", "/tickets/ab\u0000c"],
    ["tab ต่อท้าย", "/tickets/abc\t"],
    ["form feed", "/tickets/abc\f"],
    ["vertical tab", "/tickets/abc\v"],
    ["space ต่อท้าย", "/tickets/abc "],
    ["unicode line separator", "/tickets/abc\u2028"],
    ["emoji ใน id", "/tickets/abc😀"],
    ["thai ใน id", "/tickets/ตั๋ว"],
    ["double slash หลัง /tickets", "/tickets//abc"],
    ["uppercase path", "/Tickets/abc"],
    ["จุดใน id", "/tickets/abc.def"],
    ["dot segment เดี่ยว", "/tickets/."],
    ["dot-dot", "/tickets/.."],
    ["semicolon param", "/tickets/abc;jsessionid=1"],
    ["prefix ที่ดูคล้าย", "/ticketsX/abc"],
    ["ซ้อน /demo ต่อ", "/tickets/abc/demo"],
    ["nested path", "/tickets/abc/messages"],
    ["url-encoded newline", "/tickets/abc%0a"],
  ])("fallback เมื่อ %s", (_label, raw) => {
    expect(resolveDemoNext(raw)).toBe(DEMO_NEXT_FALLBACK);
  });

  it("ผ่าน: id ที่มี - และ _ และตัวพิมพ์ใหญ่", () => {
    expect(resolveDemoNext("/tickets/A-b_C123")).toBe("/tickets/A-b_C123");
  });

  it("ผ่าน: id ยาวมาก (ไม่มี length cap โดยตั้งใจ)", () => {
    const long = `/tickets/${"a".repeat(4096)}`;
    expect(resolveDemoNext(long)).toBe(long);
  });

  it("ผ่าน: cuid จริงจาก DB (รูปแบบที่ใช้จริงในระบบ)", () => {
    expect(resolveDemoNext("/tickets/clx3k9q2v0001abcd1234efgh")).toBe(
      "/tickets/clx3k9q2v0001abcd1234efgh"
    );
  });

  it("property: output เป็น fallback หรือ /tickets/<safe-id> เสมอ (ไม่มีทางเป็น absolute/มี control char)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const out = resolveDemoNext(raw);
        if (out === DEMO_NEXT_FALLBACK) return true;
        // ถ้าไม่ fallback ต้องเป็น relative path ของ ticket เท่านั้น
        return (
          out === raw &&
          out.startsWith("/tickets/") &&
          !out.startsWith("//") &&
          /^\/tickets\/[A-Za-z0-9_-]+$/.test(out)
        );
      }),
      { numRuns: 500 }
    );
  });

  it("property: output ที่ผ่าน resolve แล้ว ต้อง resolve ซ้ำได้ค่าเดิม (idempotent)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const once = resolveDemoNext(raw);
        return resolveDemoNext(once) === once;
      }),
      { numRuns: 300 }
    );
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

  // เพิ่มโดย qa-testing: ticketId มาจาก DB (cuid) เสมอ แต่ถ้าโดน inject ค่าแปลก
  // ปลายทางต้อง degrade เป็น /dashboard ไม่ใช่หลุดออกนอก origin
  it.each([
    ["path traversal", "../../settings"],
    ["absolute url", "https://evil.com"],
    ["protocol relative", "//evil.com"],
    ["newline", "abc\nx"],
  ])("ticketId ที่ผิดรูป (%s) → next ที่ได้ต้องไม่ผ่าน validation", (_label, ticketId) => {
    const url = buildDemoPersonaUrl("https://acme.gethelpwise.xyz", ticketId);
    const raw = url.slice(url.indexOf("&next=") + "&next=".length);
    expect(resolveDemoNext(raw)).toBe(DEMO_NEXT_FALLBACK);
  });

  it("คง origin ที่ส่งเข้ามาเสมอ (ไม่ประกอบ host เอง)", () => {
    expect(buildDemoPersonaUrl("http://localhost:3000", "t1")).toBe(
      "http://localhost:3000/demo?persona=secondary&next=/tickets/t1"
    );
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

// ตารางพฤติกรรมของ /demo (Dev กำหนด) — guard มีไว้กัน "การสลับ" เท่านั้น
describe("resolveDemoEntryMode", () => {
  it("ไม่มี session + /demo → auto-login primary ไป /dashboard", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "primary",
        sessionPersona: null,
        hasSession: false,
        nextParam: null,
      })
    ).toEqual({ mode: "auto", destination: "/dashboard" });
  });

  it("ไม่มี session + persona=secondary&next=/tickets/X → auto-login ไป /tickets/X", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "secondary",
        sessionPersona: null,
        hasSession: false,
        nextParam: "/tickets/X",
      })
    ).toEqual({ mode: "auto", destination: "/tickets/X" });
  });

  it("primary อยู่แล้ว + /demo → redirect เงียบ ไม่ POST", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "primary",
        sessionPersona: "primary",
        hasSession: true,
        nextParam: null,
      })
    ).toEqual({ mode: "redirect", destination: "/dashboard" });
  });

  it("secondary อยู่แล้ว + persona=secondary&next=/tickets/X → redirect เงียบไป ticket ใบเดิม", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "secondary",
        sessionPersona: "secondary",
        hasSession: true,
        nextParam: "/tickets/X",
      })
    ).toEqual({ mode: "redirect", destination: "/tickets/X" });
  });

  it("primary อยู่แล้ว + ขอ secondary → หน้ายืนยัน (จะทับ session จริง)", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "secondary",
        sessionPersona: "primary",
        hasSession: true,
        nextParam: "/tickets/X",
      })
    ).toEqual({ mode: "confirm", destination: "/tickets/X" });
  });

  it("secondary อยู่แล้ว + ขอ primary → หน้ายืนยัน", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "primary",
        sessionPersona: "secondary",
        hasSession: true,
        nextParam: null,
      })
    ).toEqual({ mode: "confirm", destination: "/dashboard" });
  });

  it("agent จริง (sessionPersona = null) → หน้ายืนยันเสมอ ห้าม auto-login ทับ session จริง", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "primary",
        sessionPersona: null,
        hasSession: true,
        nextParam: null,
      })
    ).toEqual({ mode: "confirm", destination: "/dashboard" });
    expect(
      resolveDemoEntryMode({
        requestedPersona: "secondary",
        sessionPersona: null,
        hasSession: true,
        nextParam: "/tickets/X",
      })
    ).toEqual({ mode: "confirm", destination: "/tickets/X" });
  });

  it("cookie พัง/ไม่ใช่ member → ถือว่าไม่มี session = auto (fail-open เดิม)", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "secondary",
        sessionPersona: null,
        hasSession: false,
        nextParam: "/tickets/X",
      })
    ).toEqual({ mode: "auto", destination: "/tickets/X" });
  });

  it("เส้นที่ข้าม POST ยังต้อง validate next (ค่าอันตราย → /dashboard)", () => {
    expect(
      resolveDemoEntryMode({
        requestedPersona: "secondary",
        sessionPersona: "secondary",
        hasSession: true,
        nextParam: "//evil.com",
      })
    ).toEqual({ mode: "redirect", destination: DEMO_NEXT_FALLBACK });
  });
});

// เพิ่มโดย qa-testing: ตารางพฤติกรรมครบทุกช่อง (2 requested × 3 session-persona × 2 hasSession)
// = 12 combination — ล็อกไว้ทั้งตารางกันใครแก้ logic แล้วช่องใดช่องหนึ่งเปลี่ยนเงียบ ๆ
describe("resolveDemoEntryMode — ตารางเต็ม (exhaustive)", () => {
  const requested = ["primary", "secondary"] as const;
  const sessions = ["primary", "secondary", null] as const;
  const hasSessionValues = [true, false] as const;

  function expectedMode(
    req: (typeof requested)[number],
    sess: (typeof sessions)[number],
    hasSession: boolean
  ): "auto" | "confirm" | "redirect" {
    if (!hasSession) return "auto";
    if (sess !== null && sess === req) return "redirect";
    return "confirm";
  }

  const cases = requested.flatMap((req) =>
    sessions.flatMap((sess) =>
      hasSessionValues.map(
        (hasSession) => [req, sess, hasSession, expectedMode(req, sess, hasSession)] as const
      )
    )
  );

  it("ครอบทุก combination ที่เป็นไปได้ (12 ช่อง)", () => {
    expect(cases).toHaveLength(12);
  });

  it.each(cases)(
    "requested=%s session=%s hasSession=%s → mode=%s",
    (req, sess, hasSession, mode) => {
      expect(
        resolveDemoEntryMode({
          requestedPersona: req,
          sessionPersona: sess,
          hasSession,
          nextParam: "/tickets/T1",
        })
      ).toEqual({ mode, destination: "/tickets/T1" });
    }
  );

  it.each(cases)(
    "ทุกโหมดต้อง validate next เหมือนกัน (requested=%s session=%s hasSession=%s)",
    (req, sess, hasSession) => {
      const decision = resolveDemoEntryMode({
        requestedPersona: req,
        sessionPersona: sess,
        hasSession,
        nextParam: "https://evil.com/tickets/x",
      });
      expect(decision.destination).toBe(DEMO_NEXT_FALLBACK);
    }
  );

  it("agent จริง (persona=null) ที่มี session → ไม่มีทางได้ auto/redirect (ห้ามทับ session เงียบ)", () => {
    for (const req of requested) {
      expect(
        resolveDemoEntryMode({
          requestedPersona: req,
          sessionPersona: null,
          hasSession: true,
          nextParam: null,
        }).mode
      ).toBe("confirm");
    }
  });
});
