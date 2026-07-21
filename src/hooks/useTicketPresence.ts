/**
 * useTicketPresence — real-time presence + typing indicator สำหรับหน้า agent ticket detail
 *
 * Transport: Supabase Realtime (presence + broadcast) ผ่าน channel tenant-scoped
 *   topic: `tenant:${tenantId}:ticket:${ticketId}` (private → RLS ฝั่ง Supabase บังคับ tenant isolation)
 *   token: mint จาก /api/realtime/token (JWT อายุ 60s) → setAuth() แล้ว refresh ก่อนหมดอายุ
 *
 * ออกแบบเป็น "engine" ที่แยกจาก React (createTicketPresenceEngine) เพื่อ unit-test ได้ในโหมด node
 * โดยไม่ต้องมี DOM — hook เป็นแค่ตัวห่อบางๆ ที่ผูก engine เข้ากับ React state
 *
 * fail-soft: presence เป็น enhancement ไม่ใช่ core — ถ้า env/token/realtime ใช้ไม่ได้
 * hook คืน state ว่างเสมอ ไม่ throw ให้หน้า ticket crash
 */

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { getRealtimeClient } from "@/lib/supabase-realtime-client";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

// =============================================================================
// CONSTANTS
// =============================================================================

/** refresh token ก่อน TTL (60s) หมด — ที่ ~50s กัน disconnect */
const TOKEN_REFRESH_MS = 50_000;
/** ระยะห่างขั้นต่ำระหว่างการยิง typing broadcast (leading-edge throttle) กัน spam */
const TYPING_THROTTLE_MS = 1_500;
/** auto-clear typing ของ peer หลังไม่ได้รับ event ใหม่ */
const TYPING_TIMEOUT_MS = 3_000;

// =============================================================================
// TYPES
// =============================================================================

export interface UseTicketPresenceOptions {
  tenantId: string;
  ticketId: string;
  /** TenantMember.id — ใช้เป็น presence key + ตัวตัวเองออกจาก "คนอื่น" */
  memberId: string;
  /** ชื่อ agent ที่โชว์ */
  name: string;
}

/** agent อื่นที่กำลังดู ticket เดียวกันตอนนี้ */
export interface PresenceParticipant {
  memberId: string;
  name: string;
  viewingAt: string;
}

/** agent อื่นที่กำลังพิมพ์ตอนนี้ */
export interface TypingParticipant {
  memberId: string;
  name: string;
}

export interface TicketPresenceState {
  others: PresenceParticipant[];
  typing: TypingParticipant[];
}

export interface UseTicketPresenceResult extends TicketPresenceState {
  /** ยิง typing broadcast (throttled) — ผูกกับ onChange ของ textarea reply */
  setTyping: () => void;
}

/** metadata ที่ track ผ่าน presence — index signature เพื่อให้เข้ากับ presenceState<T> */
interface PresenceMeta {
  memberId: string;
  name: string;
  viewingAt: string;
  [key: string]: unknown;
}

interface TypingBroadcastPayload {
  memberId: string;
  name: string;
}

export interface TicketPresenceEngine {
  start: () => Promise<void>;
  subscribe: (listener: (state: TicketPresenceState) => void) => () => void;
  setTyping: () => void;
  destroy: () => void;
}

// =============================================================================
// TOKEN FETCH
// =============================================================================

/** ขอ realtime token จาก backend — คืน null เมื่อพลาด (fail-soft, ไม่ throw) */
async function fetchRealtimeToken(ticketId: string): Promise<string | null> {
  try {
    const res = await fetch("/api/realtime/token", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { token?: string } | null };
    return json.data?.token ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// ENGINE (framework-agnostic — testable ในโหมด node)
// =============================================================================

export function createTicketPresenceEngine(
  options: UseTicketPresenceOptions
): TicketPresenceEngine {
  const { tenantId, ticketId, memberId, name } = options;
  const topic = `tenant:${tenantId}:ticket:${ticketId}`;

  const listeners = new Set<(state: TicketPresenceState) => void>();
  const typingPeers = new Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>();
  let others: PresenceParticipant[] = [];

  let client: SupabaseClient | null = null;
  let channel: RealtimeChannel | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTypingSentAt = 0;
  let destroyed = false;

  function snapshot(): TicketPresenceState {
    return {
      others,
      typing: Array.from(typingPeers.entries()).map(([id, v]) => ({
        memberId: id,
        name: v.name,
      })),
    };
  }

  function emit(): void {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  }

  // rebuild "others" จาก full presence state ทุก event (sync/join/leave)
  // → idempotent dedupe ตาม memberId กัน flicker ตอน server reconcile
  function rebuildOthers(): void {
    if (!channel) return;
    const raw = channel.presenceState<PresenceMeta>();
    const next: PresenceParticipant[] = [];
    const seen = new Set<string>();
    for (const key of Object.keys(raw)) {
      const metas = raw[key];
      if (!metas || metas.length === 0) continue;
      const meta = metas[0];
      const id = meta.memberId ?? key;
      if (id === memberId) continue; // ตัดตัวเองออกจาก "คนอื่นที่กำลังดู"
      if (seen.has(id)) continue;
      seen.add(id);
      next.push({ memberId: id, name: meta.name ?? "ผู้ใช้", viewingAt: meta.viewingAt ?? "" });
    }
    others = next;
    emit();
  }

  function handleTyping(payload: TypingBroadcastPayload | undefined): void {
    if (!payload || payload.memberId === memberId) return; // ตัด typing ของตัวเอง
    const id = payload.memberId;
    const existing = typingPeers.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      typingPeers.delete(id);
      emit();
    }, TYPING_TIMEOUT_MS);
    typingPeers.set(id, { name: payload.name ?? "ผู้ใช้", timer });
    emit();
  }

  function scheduleRefresh(): void {
    refreshTimer = setTimeout(() => {
      void (async () => {
        if (destroyed) return;
        const token = await fetchRealtimeToken(ticketId);
        if (token && !destroyed && client) {
          await client.realtime.setAuth(token);
        }
        if (!destroyed) scheduleRefresh();
      })();
    }, TOKEN_REFRESH_MS);
  }

  function teardownChannel(): void {
    if (channel && client) {
      void channel.untrack();
      void client.removeChannel(channel);
    }
    channel = null;
  }

  async function start(): Promise<void> {
    const c = getRealtimeClient();
    if (!c) return; // env ไม่พร้อม → fail-soft (state ว่าง)
    client = c;

    const token = await fetchRealtimeToken(ticketId);
    if (!token || destroyed) return;
    await c.realtime.setAuth(token);
    if (destroyed) return;

    // ⚠️ private:true บังคับ (ไม่งั้น Realtime Authorization/RLS ไม่ทำงาน)
    const ch = c.channel(topic, {
      config: { private: true, presence: { key: memberId } },
    });
    channel = ch;

    ch.on("presence", { event: "sync" }, rebuildOthers)
      .on("presence", { event: "join" }, rebuildOthers)
      .on("presence", { event: "leave" }, rebuildOthers)
      .on<TypingBroadcastPayload>("broadcast", { event: "typing" }, ({ payload }) =>
        handleTyping(payload)
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void ch.track({ memberId, name, viewingAt: new Date().toISOString() } satisfies PresenceMeta);
        }
      });

    if (destroyed) {
      teardownChannel();
      return;
    }
    scheduleRefresh();
  }

  function setTyping(): void {
    const now = Date.now();
    if (now - lastTypingSentAt < TYPING_THROTTLE_MS) return; // leading-edge throttle
    lastTypingSentAt = now;
    if (!channel) return;
    void channel.send({
      type: "broadcast",
      event: "typing",
      payload: { memberId, name } satisfies TypingBroadcastPayload,
    });
  }

  function subscribe(listener: (state: TicketPresenceState) => void): () => void {
    listeners.add(listener);
    listener(snapshot());
    return () => {
      listeners.delete(listener);
    };
  }

  function destroy(): void {
    destroyed = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    for (const peer of typingPeers.values()) clearTimeout(peer.timer);
    typingPeers.clear();
    teardownChannel();
    listeners.clear();
  }

  return { start, subscribe, setTyping, destroy };
}

// =============================================================================
// REACT HOOK
// =============================================================================

const EMPTY_STATE: TicketPresenceState = { others: [], typing: [] };

/**
 * useTicketPresence — ผูก presence engine เข้ากับ React
 * ส่ง options = null เมื่อยังไม่รู้ identity (เช่น me ยังโหลดไม่เสร็จ) → hook no-op
 */
export function useTicketPresence(
  options: UseTicketPresenceOptions | null
): UseTicketPresenceResult {
  const [state, setState] = useState<TicketPresenceState>(EMPTY_STATE);
  const engineRef = useRef<TicketPresenceEngine | null>(null);

  const tenantId = options?.tenantId;
  const ticketId = options?.ticketId;
  const memberId = options?.memberId;
  const name = options?.name;

  useEffect(() => {
    if (!tenantId || !ticketId || !memberId || !name) {
      // startTransition: เลี่ยง cascading render ตาม react-hooks/set-state-in-effect
      startTransition(() => setState(EMPTY_STATE));
      return;
    }

    const engine = createTicketPresenceEngine({ tenantId, ticketId, memberId, name });
    engineRef.current = engine;
    // engine.subscribe เรียก listener ทันทีด้วย snapshot ปัจจุบัน — wrap กัน sync setState ใน effect
    const unsubscribe = engine.subscribe((next) =>
      startTransition(() => setState(next))
    );
    void engine.start();

    return () => {
      unsubscribe();
      engine.destroy();
      engineRef.current = null;
    };
  }, [tenantId, ticketId, memberId, name]);

  const setTyping = useCallback(() => {
    engineRef.current?.setTyping();
  }, []);

  return { others: state.others, typing: state.typing, setTyping };
}
