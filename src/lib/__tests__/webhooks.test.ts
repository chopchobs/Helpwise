/**
 * src/lib/__tests__/webhooks.test.ts
 * Unit tests สำหรับ src/lib/webhooks.ts (Phase 36 Slice 1b — core lib)
 *
 * ครอบ invariant สำคัญของ slice นี้:
 *   (a) signature — sign/verify, secret ผิด, body ถูกแก้, timestamp เก่า, header malformed
 *   (b) SSRF guard — reject ทุกช่วง IP/hostname ต้องห้าม + DNS rebinding
 *   (c) payload envelope ตรง contract § 2 + internal note ห้ามหลุดออก webhook
 *
 * Mock boundary: mock "dns/promises" เพราะ assertSafeDestination ต้อง resolve จริง
 * (unit test ทดสอบ branch logic ของ guard ไม่ใช่ resolver ของ OS)
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock("dns/promises", () => ({ lookup: lookupMock }));

import {
  WEBHOOK_EVENT_WIRE_NAMES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_USER_AGENT,
  assertSafeDestination,
  buildMessageEventPayload,
  buildSignatureHeader,
  buildTicketEventPayload,
  generateWebhookSecret,
  isBlockedIp,
  serializeEnvelope,
  signWebhookPayload,
  validateWebhookUrl,
  verifyWebhookSignature,
} from "@/lib/webhooks";
import type { TicketEventInput, MessageEventInput } from "@/lib/webhooks";

const SECRET = "whsec_testsecret_0123456789";
const NOW = 1_800_000_000; // unix seconds คงที่ — ทำให้ signature test deterministic

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// =============================================================================
// (a) SECRET + SIGNATURE
// =============================================================================

describe("generateWebhookSecret", () => {
  it("ขึ้นต้นด้วย 'whsec_' และสุ่มไม่ซ้ำกัน", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();

    expect(a.startsWith("whsec_")).toBe(true);
    expect(a).not.toBe(b);
    // base64url ของ 32 bytes = 43 ตัวอักษร
    expect(a.slice("whsec_".length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("signWebhookPayload / buildSignatureHeader", () => {
  it("คืน hex sha256 (64 ตัว) และ deterministic", () => {
    const sig = signWebhookPayload(SECRET, '{"a":1}', NOW);

    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(signWebhookPayload(SECRET, '{"a":1}', NOW));
  });

  it("header รูปแบบ t=<ts>,v1=<hex> และ v1 ตรงกับ signWebhookPayload", () => {
    const header = buildSignatureHeader(SECRET, '{"a":1}', NOW);

    expect(header).toBe(`t=${NOW},v1=${signWebhookPayload(SECRET, '{"a":1}', NOW)}`);
  });
});

describe("verifyWebhookSignature", () => {
  const body = '{"id":"evt_1","type":"ticket.created"}';

  it("sign แล้ว verify ผ่าน", () => {
    const header = buildSignatureHeader(SECRET, body, NOW);

    expect(verifyWebhookSignature(SECRET, body, header, { nowSeconds: NOW })).toBe(true);
  });

  it("secret ผิด → false", () => {
    const header = buildSignatureHeader(SECRET, body, NOW);

    expect(
      verifyWebhookSignature("whsec_wrong", body, header, { nowSeconds: NOW })
    ).toBe(false);
  });

  it("body ถูกแก้ 1 ตัวอักษร → false", () => {
    const header = buildSignatureHeader(SECRET, body, NOW);
    const tampered = body.replace("evt_1", "evt_2");

    expect(verifyWebhookSignature(SECRET, tampered, header, { nowSeconds: NOW })).toBe(
      false
    );
  });

  it("timestamp เก่าเกิน tolerance → false (replay window)", () => {
    const header = buildSignatureHeader(SECRET, body, NOW);
    const late = NOW + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1;

    expect(verifyWebhookSignature(SECRET, body, header, { nowSeconds: late })).toBe(
      false
    );
    // ขอบพอดี tolerance = ยังผ่าน
    expect(
      verifyWebhookSignature(SECRET, body, header, {
        nowSeconds: NOW + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      })
    ).toBe(true);
  });

  it("timestamp อนาคตเกิน tolerance → false", () => {
    const header = buildSignatureHeader(SECRET, body, NOW + 10_000);

    expect(verifyWebhookSignature(SECRET, body, header, { nowSeconds: NOW })).toBe(
      false
    );
  });

  it.each([
    ["ว่าง", ""],
    ["ไม่มี key=value", "garbage"],
    ["ไม่มี v1", `t=${NOW}`],
    ["ไม่มี t", `v1=${"a".repeat(64)}`],
    ["t ไม่ใช่ตัวเลข", `t=abc,v1=${"a".repeat(64)}`],
    ["v1 ไม่ใช่ hex 64 ตัว", `t=${NOW},v1=zz`],
  ])("header malformed (%s) → false", (_label, header) => {
    expect(verifyWebhookSignature(SECRET, body, header, { nowSeconds: NOW })).toBe(
      false
    );
  });

  it("ใช้ tolerance default 300s เมื่อไม่ระบุ opts", () => {
    expect(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = buildSignatureHeader(SECRET, body, nowSeconds);

    expect(verifyWebhookSignature(SECRET, body, header)).toBe(true);
  });
});

// =============================================================================
// (b) SSRF GUARD
// =============================================================================

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "::1",
    "::",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::127.0.0.1", // IPv4-compatible (deprecated)
    "not-an-ip", // parse ไม่ได้ → fail-safe block
  ])("block %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // นอกช่วง 172.16/12
    "100.128.0.1", // นอกช่วง CGNAT
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("อนุญาต %s (public)", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("validateWebhookUrl", () => {
  it("อนุญาต https ปลายทาง public", () => {
    const result = validateWebhookUrl("https://example.com/hook");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hostname).toBe("example.com");
  });

  it("reject http:// บน production (dev เท่านั้นที่อนุญาต)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = validateWebhookUrl("http://example.com/hook");

    expect(result).toEqual({ ok: false, reason: "scheme_not_allowed" });
  });

  it("dev escape hatch: http:// + port อื่น ผ่านเมื่อไม่ใช่ production", () => {
    expect(validateWebhookUrl("http://example.com:3001/hook").ok).toBe(true);
  });

  it("reject port ที่ไม่ใช่ 443 บน production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(validateWebhookUrl("https://example.com:8080/hook")).toEqual({
      ok: false,
      reason: "port_not_allowed",
    });
    expect(validateWebhookUrl("https://example.com:443/hook").ok).toBe(true);
  });

  it.each([
    ["https://localhost/x", "blocked_host"],
    ["https://api.localhost/x", "blocked_host"],
    ["https://metadata.google.internal", "blocked_host"],
    ["https://vault.internal/secret", "blocked_host"],
    ["https://127.0.0.1", "blocked_ip"],
    ["https://10.0.0.5", "blocked_ip"],
    ["https://172.16.0.1", "blocked_ip"],
    ["https://192.168.1.1", "blocked_ip"],
    ["https://169.254.169.254", "blocked_ip"],
    ["https://[::1]/", "blocked_ip"],
    ["https://[fc00::1]/", "blocked_ip"],
    ["https://[::ffff:127.0.0.1]/", "blocked_ip"],
  ])("reject %s", (url, reason) => {
    expect(validateWebhookUrl(url)).toEqual({ ok: false, reason });
  });

  // FQDN trailing dot: "localhost." ต้องถูกมองเป็น "localhost" ไม่งั้น deny-list หลุด
  it.each([
    ["https://localhost./", "blocked_host"],
    ["https://LOCALHOST./", "blocked_host"],
    ["https://metadata.google.internal./", "blocked_host"],
    ["https://foo.internal./", "blocked_host"],
  ])("reject trailing-dot FQDN %s", (url, reason) => {
    expect(validateWebhookUrl(url)).toEqual({ ok: false, reason });
  });

  it("regression: host public ที่มี trailing dot ยังผ่าน (เหมือนไม่มีจุด)", () => {
    expect(validateWebhookUrl("https://example.com./").ok).toBe(true);
    expect(validateWebhookUrl("https://example.com/").ok).toBe(true);
  });

  it("reject hostname ที่เหลือว่างหลังตัด trailing dot", () => {
    expect(validateWebhookUrl("https://./").ok).toBe(false);
  });

  it("reject URL ที่ parse ไม่ได้ และ scheme อื่น (file:)", () => {
    expect(validateWebhookUrl("not a url")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(validateWebhookUrl("file:///etc/passwd")).toEqual({
      ok: false,
      reason: "scheme_not_allowed",
    });
  });
});

describe("assertSafeDestination", () => {
  it("ผ่านเมื่อ DNS resolve ได้ public IP อย่างเดียว", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    await expect(assertSafeDestination("https://example.com/hook")).resolves.toEqual({
      ok: true,
    });
    expect(lookupMock).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("block DNS rebinding — hostname ปกติแต่ resolve ได้ 169.254.169.254", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    await expect(assertSafeDestination("https://evil.example.com/hook")).resolves.toEqual(
      { ok: false, reason: "blocked_ip" }
    );
  });

  it("block เมื่อมี IP ต้องห้ามปนมาแม้เพียงตัวเดียว", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ]);

    await expect(assertSafeDestination("https://mixed.example.com/hook")).resolves.toEqual(
      { ok: false, reason: "blocked_ip" }
    );
  });

  it("resolve ไม่ได้ → ok:false (fail-closed)", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(assertSafeDestination("https://nope.example.com/hook")).resolves.toEqual(
      { ok: false, reason: "dns_resolution_failed" }
    );
  });

  it("ส่งต่อ reason ของ static validation โดยไม่แตะ DNS", async () => {
    await expect(assertSafeDestination("https://169.254.169.254/x")).resolves.toEqual({
      ok: false,
      reason: "blocked_ip",
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("IP literal ที่ public ไม่ต้อง resolve DNS", async () => {
    await expect(assertSafeDestination("https://8.8.8.8/hook")).resolves.toEqual({
      ok: true,
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// (c) EVENT MAPPING + PAYLOAD
// =============================================================================

describe("WEBHOOK_EVENT_WIRE_NAMES + constants", () => {
  it("mapping ตรงตาราง § 3 ครบทุก enum", () => {
    expect(WEBHOOK_EVENT_WIRE_NAMES).toEqual({
      TICKET_CREATED: "ticket.created",
      TICKET_STATUS_CHANGED: "ticket.status_changed",
      TICKET_ASSIGNED: "ticket.assigned",
      TICKET_PRIORITY_CHANGED: "ticket.priority_changed",
      TICKET_MESSAGE_CREATED: "ticket.message_created",
    });
  });

  it("constant ตรงกับ contract § 4/§ 5", () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
    expect(WEBHOOK_USER_AGENT).toBe("Helpwise-Webhooks/1.0");
  });
});

const ticketInput: TicketEventInput = {
  eventId: "evt_ticket_1",
  eventType: "TICKET_STATUS_CHANGED",
  tenantId: "tnt_1",
  occurredAt: new Date("2026-07-22T10:00:00.000Z"),
  ticket: {
    id: "tkt_1",
    ticketNumber: 1042,
    subject: "Printer on fire",
    status: "OPEN",
    priority: "HIGH",
    assigneeMemberId: null,
    requesterContactId: "cnt_1",
    channel: "portal",
    createdAt: new Date("2026-07-22T09:00:00.000Z"),
    updatedAt: new Date("2026-07-22T10:00:00.000Z"),
  },
  changes: { status: { from: "NEW", to: "OPEN" } },
};

describe("buildTicketEventPayload", () => {
  it("envelope ตรง § 2 ทุก field (date เป็น ISO string)", () => {
    expect(buildTicketEventPayload(ticketInput)).toEqual({
      id: "evt_ticket_1",
      type: "ticket.status_changed",
      createdAt: "2026-07-22T10:00:00.000Z",
      tenantId: "tnt_1",
      data: {
        ticket: {
          id: "tkt_1",
          ticketNumber: 1042,
          subject: "Printer on fire",
          status: "OPEN",
          priority: "HIGH",
          assigneeMemberId: null,
          requesterContactId: "cnt_1",
          channel: "portal",
          createdAt: "2026-07-22T09:00:00.000Z",
          updatedAt: "2026-07-22T10:00:00.000Z",
        },
        changes: { status: { from: "NEW", to: "OPEN" } },
      },
    });
  });

  it("ticket.created ไม่มี field changes ใน envelope", () => {
    const envelope = buildTicketEventPayload({
      eventId: "evt_created",
      eventType: "TICKET_CREATED",
      tenantId: ticketInput.tenantId,
      occurredAt: ticketInput.occurredAt,
      ticket: ticketInput.ticket,
    });

    expect(envelope.type).toBe("ticket.created");
    expect("changes" in envelope.data).toBe(false);
  });

  it("รับ date เป็น ISO string ได้เหมือนกัน", () => {
    const envelope = buildTicketEventPayload({
      ...ticketInput,
      occurredAt: "2026-07-22T10:00:00.000Z",
      ticket: {
        ...ticketInput.ticket,
        createdAt: "2026-07-22T09:00:00.000Z",
        updatedAt: "2026-07-22T10:00:00.000Z",
      },
    });

    expect(envelope.createdAt).toBe("2026-07-22T10:00:00.000Z");
    expect(envelope.data.ticket.updatedAt).toBe("2026-07-22T10:00:00.000Z");
  });

  it("assigned / priority_changed ใช้ changes shape ของตัวเอง", () => {
    const assigned = buildTicketEventPayload({
      ...ticketInput,
      eventType: "TICKET_ASSIGNED",
      changes: { assigneeMemberId: { from: null, to: "mbr_9" } },
    });
    const priority = buildTicketEventPayload({
      ...ticketInput,
      eventType: "TICKET_PRIORITY_CHANGED",
      changes: { priority: { from: "NORMAL", to: "HIGH" } },
    });

    expect(assigned.type).toBe("ticket.assigned");
    expect(assigned.data.changes).toEqual({
      assigneeMemberId: { from: null, to: "mbr_9" },
    });
    expect(priority.type).toBe("ticket.priority_changed");
    expect(priority.data.changes).toEqual({ priority: { from: "NORMAL", to: "HIGH" } });
  });
});

const messageInput: MessageEventInput = {
  eventId: "evt_msg_1",
  tenantId: "tnt_1",
  occurredAt: new Date("2026-07-22T11:00:00.000Z"),
  ticket: { id: "tkt_1", ticketNumber: 1042, subject: "Printer on fire" },
  message: {
    id: "msg_1",
    visibility: "PUBLIC",
    authorType: "agent",
    authorId: "mbr_1",
    body: "We are on it.",
    createdAt: new Date("2026-07-22T11:00:00.000Z"),
  },
};

describe("buildMessageEventPayload", () => {
  it("envelope ตรง § 2 ทุก field", () => {
    expect(buildMessageEventPayload(messageInput)).toEqual({
      id: "evt_msg_1",
      type: "ticket.message_created",
      createdAt: "2026-07-22T11:00:00.000Z",
      tenantId: "tnt_1",
      data: {
        ticket: { id: "tkt_1", ticketNumber: 1042, subject: "Printer on fire" },
        message: {
          id: "msg_1",
          visibility: "PUBLIC",
          authorType: "agent",
          authorId: "mbr_1",
          body: "We are on it.",
          createdAt: "2026-07-22T11:00:00.000Z",
        },
      },
    });
  });

  it("throw เมื่อ visibility = INTERNAL (internal note ห้ามออกนอกระบบ)", () => {
    expect(() =>
      buildMessageEventPayload({
        ...messageInput,
        message: { ...messageInput.message, visibility: "INTERNAL" },
      })
    ).toThrow(/internal notes must never leave the system/);
  });

  it("throw เมื่อ visibility เป็นค่าแปลกปลอมอื่น (fail-loud)", () => {
    expect(() =>
      buildMessageEventPayload({
        ...messageInput,
        message: { ...messageInput.message, visibility: "public" },
      })
    ).toThrow();
  });
});

describe("serializeEnvelope", () => {
  it("เรียกซ้ำได้ผลลัพธ์เดียวกัน byte-per-byte (raw body ที่ใช้เซ็น)", () => {
    const envelope = buildTicketEventPayload(ticketInput);
    const first = serializeEnvelope(envelope);

    expect(serializeEnvelope(envelope)).toBe(first);
    expect(JSON.parse(first)).toEqual(envelope);
  });

  it("คงลำดับ field ตาม envelope (id → type → createdAt → tenantId → data)", () => {
    const raw = serializeEnvelope(buildMessageEventPayload(messageInput));

    expect(Object.keys(JSON.parse(raw))).toEqual([
      "id",
      "type",
      "createdAt",
      "tenantId",
      "data",
    ]);
    expect(raw.startsWith('{"id":"evt_msg_1","type":"ticket.message_created"')).toBe(
      true
    );
  });

  it("body ที่เซ็นกับที่ส่ง เป็นสตริงเดียวกัน → verify ผ่าน", () => {
    const raw = serializeEnvelope(buildTicketEventPayload(ticketInput));
    const header = buildSignatureHeader(SECRET, raw, NOW);

    expect(verifyWebhookSignature(SECRET, raw, header, { nowSeconds: NOW })).toBe(true);
  });
});
