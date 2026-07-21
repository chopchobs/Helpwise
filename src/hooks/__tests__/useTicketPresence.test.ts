/**
 * useTicketPresence.test.ts — unit test ของ presence engine (framework-agnostic core ของ hook)
 *
 * ทดสอบในโหมด node โดย mock:
 *   - @/lib/supabase-realtime-client (getRealtimeClient) → fake Supabase client + channel
 *   - global fetch (/api/realtime/token)
 *
 * ครอบ behavior สำคัญ: join topic ถูก + private, track identity, presence sync (ตัดตัวเองออก),
 * typing broadcast throttle (ไม่ยิงทุก keystroke), fail-soft เมื่อ token fetch พัง
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTicketPresenceEngine,
  type TicketPresenceState,
} from "@/hooks/useTicketPresence";

// ─── mock supabase realtime client ───────────────────────────────────────────
const { getRealtimeClientMock } = vi.hoisted(() => ({
  getRealtimeClientMock: vi.fn(),
}));

vi.mock("@/lib/supabase-realtime-client", () => ({
  getRealtimeClient: getRealtimeClientMock,
}));

// ─── fake channel + client factory ───────────────────────────────────────────
type PresenceHandler = () => void;
type BroadcastHandler = (msg: { payload?: { memberId: string; name: string } }) => void;

interface FakeChannel {
  presenceStateValue: Record<string, Array<Record<string, unknown>>>;
  handlers: Map<string, PresenceHandler | BroadcastHandler>;
  subscribeCb: ((status: string) => void) | null;
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
  untrack: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  presenceState: ReturnType<typeof vi.fn>;
}

function createFakeChannel(): FakeChannel {
  const channel = {
    presenceStateValue: {},
    handlers: new Map(),
    subscribeCb: null,
  } as FakeChannel;

  channel.on = vi.fn((type: string, filter: { event: string }, cb: PresenceHandler | BroadcastHandler) => {
    channel.handlers.set(`${type}:${filter.event}`, cb);
    return channel;
  });
  channel.subscribe = vi.fn((cb: (status: string) => void) => {
    channel.subscribeCb = cb;
    // จำลอง server ตอบ SUBSCRIBED ทันที → engine เรียก track
    cb("SUBSCRIBED");
    return channel;
  });
  channel.track = vi.fn(async () => "ok");
  channel.untrack = vi.fn(async () => "ok");
  channel.send = vi.fn(async () => "ok");
  channel.presenceState = vi.fn(() => channel.presenceStateValue);

  return channel;
}

function createFakeClient(channel: FakeChannel) {
  return {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    realtime: { setAuth: vi.fn(async () => undefined) },
  };
}

const OPTIONS = {
  tenantId: "tenant_abc",
  ticketId: "ticket_123",
  memberId: "member_self",
  name: "Alice",
};
const EXPECTED_TOPIC = "tenant:tenant_abc:ticket:ticket_123";

function mockTokenFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { token: "jwt-token", expiresAt: 9_999_999_999 } }),
    }))
  );
}

/** capture state ล่าสุดที่ engine emit ผ่าน subscribe */
function trackState(engine: ReturnType<typeof createTicketPresenceEngine>) {
  const ref = { current: { others: [], typing: [] } as TicketPresenceState };
  engine.subscribe((s) => {
    ref.current = s;
  });
  return ref;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createTicketPresenceEngine", () => {
  let channel: FakeChannel;
  let client: ReturnType<typeof createFakeClient>;

  beforeEach(() => {
    channel = createFakeChannel();
    client = createFakeClient(channel);
    getRealtimeClientMock.mockReturnValue(client);
    mockTokenFetch();
  });

  it("join channel ด้วย topic ที่ถูก + private + presence key = memberId", async () => {
    const engine = createTicketPresenceEngine(OPTIONS);
    await engine.start();

    expect(client.channel).toHaveBeenCalledWith(EXPECTED_TOPIC, {
      config: { private: true, presence: { key: "member_self" } },
    });
    engine.destroy();
  });

  it("track ด้วย memberId + name ที่ให้เมื่อ subscribe สำเร็จ", async () => {
    const engine = createTicketPresenceEngine(OPTIONS);
    await engine.start();

    expect(channel.track).toHaveBeenCalledTimes(1);
    expect(channel.track).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member_self", name: "Alice" })
    );
    engine.destroy();
  });

  it("presence sync → คืน list คนอื่น (ตัดตัวเองออก, dedupe ตาม memberId)", async () => {
    const engine = createTicketPresenceEngine(OPTIONS);
    const state = trackState(engine);
    await engine.start();

    // server reconcile: มีตัวเอง + อีก 2 คน (member_bob ซ้ำ 2 metas → dedupe เหลือ 1)
    channel.presenceStateValue = {
      member_self: [{ memberId: "member_self", name: "Alice", viewingAt: "t0" }],
      member_bob: [
        { memberId: "member_bob", name: "Bob", viewingAt: "t1" },
        { memberId: "member_bob", name: "Bob", viewingAt: "t2" },
      ],
      member_carol: [{ memberId: "member_carol", name: "Carol", viewingAt: "t3" }],
    };
    const syncHandler = channel.handlers.get("presence:sync") as PresenceHandler;
    syncHandler();

    const otherIds = state.current.others.map((o) => o.memberId).sort();
    expect(otherIds).toEqual(["member_bob", "member_carol"]);
    expect(state.current.others.some((o) => o.memberId === "member_self")).toBe(false);
    engine.destroy();
  });

  it("รับ typing broadcast ของคนอื่น → เพิ่มลง typing (ตัดของตัวเองออก)", async () => {
    const engine = createTicketPresenceEngine(OPTIONS);
    const state = trackState(engine);
    await engine.start();

    const typingHandler = channel.handlers.get("broadcast:typing") as BroadcastHandler;
    // ของตัวเอง → ถูกตัดออก
    typingHandler({ payload: { memberId: "member_self", name: "Alice" } });
    expect(state.current.typing).toHaveLength(0);
    // ของ Bob → เพิ่มเข้า
    typingHandler({ payload: { memberId: "member_bob", name: "Bob" } });
    expect(state.current.typing).toEqual([{ memberId: "member_bob", name: "Bob" }]);
    engine.destroy();
  });

  it("setTyping ถูก throttle — ไม่ยิงทุก keystroke", async () => {
    const engine = createTicketPresenceEngine(OPTIONS);
    await engine.start();

    const base = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    // กด 5 ครั้งในเวลาเดียวกัน → ส่งแค่ครั้งเดียว (leading edge)
    for (let i = 0; i < 5; i++) engine.setTyping();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "broadcast",
        event: "typing",
        payload: { memberId: "member_self", name: "Alice" },
      })
    );

    // เลยหน้าต่าง throttle (1500ms) → ยิงได้อีกครั้ง
    nowSpy.mockReturnValue(base + 2_000);
    engine.setTyping();
    expect(channel.send).toHaveBeenCalledTimes(2);
    engine.destroy();
  });

  it("fail-soft: token fetch reject → ไม่ throw, ไม่ join channel, state ว่าง", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const engine = createTicketPresenceEngine(OPTIONS);
    const state = trackState(engine);

    await expect(engine.start()).resolves.toBeUndefined();
    expect(client.channel).not.toHaveBeenCalled();
    expect(state.current.others).toEqual([]);
    expect(state.current.typing).toEqual([]);
    engine.destroy();
  });

  it("fail-soft: env ไม่พร้อม (getRealtimeClient คืน null) → ไม่ join, ไม่ throw", async () => {
    getRealtimeClientMock.mockReturnValue(null);
    const engine = createTicketPresenceEngine(OPTIONS);

    await expect(engine.start()).resolves.toBeUndefined();
    expect(channel.subscribe).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("destroy → untrack + removeChannel (cleanup)", async () => {
    const engine = createTicketPresenceEngine(OPTIONS);
    await engine.start();
    engine.destroy();

    expect(channel.untrack).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });
});
