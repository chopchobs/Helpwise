/**
 * src/app/api/__tests__/ai-suggest-tags.test.ts
 * Integration tests สำหรับ POST /api/tickets/:id/ai/suggest-tags (Phase 29 Slice 3)
 *
 * P0 invariants:
 *   - audience guard: ไม่ใช่ agent → propagate 401/403
 *   - feature gate: hasFeature=false → 403 FEATURE_NOT_AVAILABLE
 *   - tenant isolation: ticket ของ tenant อื่น/ไม่มี → 404
 *   - rate-limit → 429 RATE_LIMITED
 *   - happy → 200 + tags (AiTagSuggestionDTO) + audit metadata only
 *   - AI fail → 502 AI_ERROR
 *   - ⚠️ tenant validation: tag ที่ AI เสนอแต่ไม่มีจริงใน tenant → ถูก filter ทิ้ง
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { defaultCtx, DEFAULT_TENANT_ID, makeNextRequest } from "@/app/api/__tests__/_helpers";

const { fakeDb, requireAgentMock, auditLogMock, hasFeatureMock, suggestTagsMock, checkRateLimitMock } =
  vi.hoisted(() => {
    const fakeDb = {
      ticket: { findFirst: vi.fn() },
      ticketMessage: { findMany: vi.fn() },
      tag: { findMany: vi.fn() },
    };
    return {
      fakeDb,
      requireAgentMock: vi.fn(),
      auditLogMock: vi.fn(),
      hasFeatureMock: vi.fn(),
      suggestTagsMock: vi.fn(),
      checkRateLimitMock: vi.fn(),
    };
  });

vi.mock("@/lib/tenant", () => ({
  getTenantContext: vi.fn(),
  tenantPrisma: () => fakeDb,
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

vi.mock("@/lib/audit", () => ({
  audit: { log: (...args: unknown[]) => auditLogMock(...args) },
}));

vi.mock("@/lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features")>();
  return {
    ...actual,
    hasFeature: (...args: unknown[]) => hasFeatureMock(...args),
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  rateLimitKey: (scope: string, id: string) => `ratelimit:${scope}:${id}`,
  rateLimitResponse: (retryAfterSeconds: number) =>
    NextResponse.json(
      { data: null, error: { code: "RATE_LIMITED", message: "คำขอบ่อยเกินไป" } },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    ),
}));

vi.mock("@/lib/ai", () => ({
  AI_SUMMARY_MODEL: "claude-haiku-4-5",
  suggestTags: (...args: unknown[]) => suggestTagsMock(...args),
}));

import { POST as suggestTags } from "@/app/api/tickets/[id]/ai/suggest-tags/route";
import { AuthError } from "@/lib/auth";

const SESSION_AGENT = {
  user: { id: "user-2", name: "Agent" },
  member: { id: "member-2", role: "AGENT", userId: "user-2" },
  ctx: defaultCtx(),
};

const FORBIDDEN_AGENT = new AuthError("ต้องการสิทธิ์ OWNER, ADMIN หรือ AGENT", 403);

const TENANT_TAGS = [
  { id: "tag-1", name: "billing", color: "TERRACOTTA" },
  { id: "tag-2", name: "bug", color: "SIENNA" },
  { id: "tag-3", name: "login", color: "AMBER" },
];

function makeReq(ticketId: string) {
  return {
    req: makeNextRequest(`https://acme.helpwise.com/api/tickets/${ticketId}/ai/suggest-tags`, {
      method: "POST",
    }),
    params: Promise.resolve({ id: ticketId }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION_AGENT);
  hasFeatureMock.mockResolvedValue(true);
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 });
  fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1" });
  fakeDb.tag.findMany.mockResolvedValue(TENANT_TAGS);
  fakeDb.ticketMessage.findMany.mockResolvedValue([
    { visibility: "PUBLIC", body: "ชำระเงินไม่ได้", authorMemberId: null, authorContactId: "c-1", createdAt: new Date() },
  ]);
  // default: suggestTags คืนชื่อ tag ที่ valid
  suggestTagsMock.mockResolvedValue(["billing", "bug"]);
});

describe("POST /api/tickets/:id/ai/suggest-tags", () => {
  it("(ก) ไม่ใช่ agent → 403, ไม่เรียก AI/DB", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN_AGENT);

    const { req, params } = makeReq("ticket-1");
    const res = await suggestTags(req, { params });

    expect(res.status).toBe(403);
    expect(hasFeatureMock).not.toHaveBeenCalled();
    expect(suggestTagsMock).not.toHaveBeenCalled();
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN", "AGENT"] });
  });

  it("(ก2) ไม่ได้ login → 401 propagate", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const { req, params } = makeReq("ticket-1");
    const res = await suggestTags(req, { params });

    expect(res.status).toBe(401);
    expect(suggestTagsMock).not.toHaveBeenCalled();
  });

  it("(ข) hasFeature=false → 403 FEATURE_NOT_AVAILABLE", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const { req, params } = makeReq("ticket-1");
    const res = await suggestTags(req, { params });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_NOT_AVAILABLE");
    expect(suggestTagsMock).not.toHaveBeenCalled();
    expect(hasFeatureMock).toHaveBeenCalledWith(DEFAULT_TENANT_ID, "ai_assist", "pro");
  });

  it("(ค) ticket ของ tenant อื่น/ไม่มี → 404", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue(null);

    const { req, params } = makeReq("ticket-other-tenant");
    const res = await suggestTags(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(suggestTagsMock).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("(ค2) rate-limit เกิน → 429 RATE_LIMITED", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 600 });

    const { req, params } = makeReq("ticket-1");
    const res = await suggestTags(req, { params });
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(suggestTagsMock).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("(ง) happy path → 200 + tags (TagDTO) + audit metadata only", async () => {
    const { req, params } = makeReq("ticket-1");
    const res = await suggestTags(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      tags: [
        { id: "tag-1", name: "billing", color: "TERRACOTTA" },
        { id: "tag-2", name: "bug", color: "SIENNA" },
      ],
    });
    expect(json.error).toBeNull();

    // rate-limit key เฉพาะ slice นี้
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "ratelimit:ai-suggest-tags:tenant-1" })
    );

    // suggestTags รับ messages + ชื่อ tag ที่มีใน tenant
    const callArgs = suggestTagsMock.mock.calls[0];
    expect(callArgs[1]).toEqual(["billing", "bug", "login"]);

    // audit metadata เท่านั้น
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ticket.ai_tags_suggested",
        tenantId: DEFAULT_TENANT_ID,
        targetId: "ticket-1",
      })
    );
  });

  it("(ง2) ⚠️ tenant validation: tag ที่ AI เสนอแต่ไม่อยู่ใน tenant → filter ทิ้ง", async () => {
    // LLM lib อาจ leak ชื่อแปลก (defense-in-depth) — route validate กลับด้วย byName map
    suggestTagsMock.mockResolvedValue(["billing", "ghost-tag", "bug"]);

    const { req, params } = makeReq("ticket-1");
    const res = await suggestTags(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    // ghost-tag ไม่มีใน TENANT_TAGS → หายไป เหลือเฉพาะ tag จริง
    expect(json.data.tags).toEqual([
      { id: "tag-1", name: "billing", color: "TERRACOTTA" },
      { id: "tag-2", name: "bug", color: "SIENNA" },
    ]);
    expect(JSON.stringify(json.data.tags)).not.toContain("ghost-tag");
  });

  it("(ง3) tenant ไม่มี tag เลย → tags=[] (suggestTags ได้ list ว่าง)", async () => {
    fakeDb.tag.findMany.mockResolvedValue([]);
    suggestTagsMock.mockResolvedValue([]);

    const { req, params } = makeReq("ticket-1");
    const res = await suggestTags(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.tags).toEqual([]);
    // suggestTags ถูกเรียกด้วย available names = []
    expect(suggestTagsMock.mock.calls[0][1]).toEqual([]);
  });

  it("(จ) AI fail → 502 AI_ERROR, ไม่ audit", async () => {
    suggestTagsMock.mockRejectedValue(new Error("anthropic 500 internal"));

    const { req, params } = makeReq("ticket-1");
    const res = await suggestTags(req, { params });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error.code).toBe("AI_ERROR");
    expect(json.error.message).not.toContain("anthropic");
    expect(auditLogMock).not.toHaveBeenCalled();
  });
});
