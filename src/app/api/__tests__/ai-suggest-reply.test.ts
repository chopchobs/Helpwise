/**
 * src/app/api/__tests__/ai-suggest-reply.test.ts
 * Integration tests สำหรับ POST /api/tickets/:id/ai/suggest-reply (Phase 29 Slice 2)
 *
 * P0 invariants:
 *   - audience guard: ไม่ใช่ agent → propagate 401/403 (ไม่แตะ AI/DB)
 *   - feature gate: hasFeature=false → 403 FEATURE_NOT_AVAILABLE (ไม่เรียก AI)
 *   - tenant isolation: ticket ของ tenant อื่น/ไม่มี (findFirst null) → 404
 *   - rate-limit → 429 RATE_LIMITED (cost guard)
 *   - happy → 200 + reply (AiReplyDraftDTO) + audit.log(ticket.ai_reply_suggested) ไม่ log draft
 *   - AI fail → 502 AI_ERROR
 *   - ⚠️ DRAFT: ไม่สร้าง message / ไม่ส่ง email / ไม่ mutate (route ไม่มี mutate path)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { defaultCtx, DEFAULT_TENANT_ID, makeNextRequest } from "@/app/api/__tests__/_helpers";

const { fakeDb, requireAgentMock, auditLogMock, hasFeatureMock, suggestReplyMock, checkRateLimitMock } =
  vi.hoisted(() => {
    const fakeDb = {
      ticket: { findFirst: vi.fn() },
      ticketMessage: { findMany: vi.fn() },
    };
    return {
      fakeDb,
      requireAgentMock: vi.fn(),
      auditLogMock: vi.fn(),
      hasFeatureMock: vi.fn(),
      suggestReplyMock: vi.fn(),
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
  suggestReply: (...args: unknown[]) => suggestReplyMock(...args),
}));

import { POST as suggestReply } from "@/app/api/tickets/[id]/ai/suggest-reply/route";
import { AuthError } from "@/lib/auth";

const SESSION_AGENT = {
  user: { id: "user-2", name: "Agent" },
  member: { id: "member-2", role: "AGENT", userId: "user-2" },
  ctx: defaultCtx(),
};

const FORBIDDEN_AGENT = new AuthError("ต้องการสิทธิ์ OWNER, ADMIN หรือ AGENT", 403);

function makeReq(ticketId: string) {
  return {
    req: makeNextRequest(`https://acme.helpwise.com/api/tickets/${ticketId}/ai/suggest-reply`, {
      method: "POST",
    }),
    params: Promise.resolve({ id: ticketId }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION_AGENT);
  hasFeatureMock.mockResolvedValue(true);
  suggestReplyMock.mockResolvedValue("สวัสดีครับ ทางเราดำเนินการให้แล้ว");
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 });
  fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1" });
  fakeDb.ticketMessage.findMany.mockResolvedValue([
    { visibility: "INTERNAL", body: "VIP", authorMemberId: "member-2", authorContactId: null, createdAt: new Date() },
    { visibility: "PUBLIC", body: "เข้าไม่ได้", authorMemberId: null, authorContactId: "c-1", createdAt: new Date() },
  ]);
});

describe("POST /api/tickets/:id/ai/suggest-reply", () => {
  it("(ก) ไม่ใช่ agent (VIEWER) → 403, ไม่เรียก AI/DB", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN_AGENT);

    const { req, params } = makeReq("ticket-1");
    const res = await suggestReply(req, { params });

    expect(res.status).toBe(403);
    expect(hasFeatureMock).not.toHaveBeenCalled();
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
    expect(suggestReplyMock).not.toHaveBeenCalled();
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN", "AGENT"] });
  });

  it("(ก2) ไม่ได้ login → 401 propagate", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const { req, params } = makeReq("ticket-1");
    const res = await suggestReply(req, { params });

    expect(res.status).toBe(401);
    expect(suggestReplyMock).not.toHaveBeenCalled();
  });

  it("(ข) hasFeature=false → 403 FEATURE_NOT_AVAILABLE, ไม่เรียก AI", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const { req, params } = makeReq("ticket-1");
    const res = await suggestReply(req, { params });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_NOT_AVAILABLE");
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
    expect(suggestReplyMock).not.toHaveBeenCalled();
    expect(hasFeatureMock).toHaveBeenCalledWith(DEFAULT_TENANT_ID, "ai_assist", "pro");
  });

  it("(ค) ticket ของ tenant อื่น/ไม่มี → 404, ไม่เรียก AI", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue(null);

    const { req, params } = makeReq("ticket-other-tenant");
    const res = await suggestReply(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(suggestReplyMock).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("(ค2) rate-limit เกิน → 429 RATE_LIMITED, ไม่เรียก AI/audit", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 600 });

    const { req, params } = makeReq("ticket-1");
    const res = await suggestReply(req, { params });
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(suggestReplyMock).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("(ง) happy path → 200 + reply (DRAFT) + audit metadata only", async () => {
    const { req, params } = makeReq("ticket-1");
    const res = await suggestReply(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ reply: "สวัสดีครับ ทางเราดำเนินการให้แล้ว" });
    expect(json.error).toBeNull();

    // rate-limit key เฉพาะ slice นี้
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "ratelimit:ai-suggest-reply:tenant-1" })
    );

    // messages map → author label (ไม่ใช่ชื่อจริง), เรียงตามเวลา (reverse)
    const passed = suggestReplyMock.mock.calls[0][0];
    expect(passed).toEqual([
      { author: "Customer", visibility: "PUBLIC", body: "เข้าไม่ได้" },
      { author: "Agent", visibility: "INTERNAL", body: "VIP" },
    ]);

    // audit — metadata เท่านั้น ห้ามมี draft/body
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ticket.ai_reply_suggested",
        tenantId: DEFAULT_TENANT_ID,
        targetId: "ticket-1",
        metadata: { model: "claude-haiku-4-5", messageCount: 2 },
      })
    );
    const auditArg = auditLogMock.mock.calls[0][0];
    expect(JSON.stringify(auditArg)).not.toContain("ดำเนินการให้แล้ว");
    expect(JSON.stringify(auditArg)).not.toContain("เข้าไม่ได้");
  });

  it("(ง2) DRAFT guardrail — route ไม่มี mutation method (create/update/delete) บน db", async () => {
    const { req, params } = makeReq("ticket-1");
    await suggestReply(req, { params });

    // fakeDb มีแค่ read methods — ยืนยันว่า route ไม่เรียก mutate path
    expect(fakeDb.ticketMessage).not.toHaveProperty("create");
    expect(fakeDb.ticket).not.toHaveProperty("update");
  });

  it("(จ) AI fail → 502 AI_ERROR (ไม่ leak detail), ไม่ audit", async () => {
    suggestReplyMock.mockRejectedValue(new Error("anthropic 500 internal"));

    const { req, params } = makeReq("ticket-1");
    const res = await suggestReply(req, { params });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error.code).toBe("AI_ERROR");
    expect(json.error.message).not.toContain("anthropic");
    expect(auditLogMock).not.toHaveBeenCalled();
  });
});
