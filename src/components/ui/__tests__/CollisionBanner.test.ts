/**
 * CollisionBanner.test.ts — unit test ตรรกะการตัดสิน "แสดงอะไร" ของ collision banner
 *
 * ทดสอบ pure function getCollisionState() ในโหมด node (project ไม่มี jsdom — ไม่ render DOM)
 * ครอบ: ไม่มีใคร → null · 1 คนดู → "กำลังดู" · หลายคนดู → "และอีก N คน" · มีคนพิมพ์ → เตือนเข้ม
 */

import { describe, it, expect } from "vitest";
import { getCollisionState } from "@/components/ui/CollisionBanner";
import type {
  PresenceParticipant,
  TypingParticipant,
} from "@/hooks/useTicketPresence";

function viewer(memberId: string, name: string): PresenceParticipant {
  return { memberId, name, viewingAt: "2026-07-21T00:00:00.000Z" };
}

function typer(memberId: string, name: string): TypingParticipant {
  return { memberId, name };
}

describe("getCollisionState", () => {
  it("ไม่มีใครอื่น (others ว่าง + typing ว่าง) → null (ไม่แสดง)", () => {
    expect(getCollisionState([], [])).toBeNull();
  });

  it("มี 1 คนกำลังดู ไม่พิมพ์ → เตือนระดับ viewing + ข้อความ 'กำลังดู'", () => {
    const state = getCollisionState([viewer("m1", "สมชาย")], []);
    expect(state).not.toBeNull();
    expect(state?.level).toBe("viewing");
    expect(state?.message).toBe("สมชาย กำลังดู ticket นี้อยู่");
  });

  it("หลายคนกำลังดู → 'A และอีก N คน กำลังดู'", () => {
    const state = getCollisionState(
      [viewer("m1", "สมชาย"), viewer("m2", "สมหญิง"), viewer("m3", "อาทิตย์")],
      []
    );
    expect(state?.level).toBe("viewing");
    expect(state?.message).toBe("สมชาย และอีก 2 คน กำลังดู ticket นี้อยู่");
  });

  it("มีคนกำลังพิมพ์ → ยกระดับเป็น typing + ข้อความ 'กำลังพิมพ์ตอบ — ระวังตอบซ้ำ'", () => {
    const state = getCollisionState([viewer("m1", "สมชาย")], [typer("m1", "สมชาย")]);
    expect(state?.level).toBe("typing");
    expect(state?.message).toBe("สมชาย กำลังพิมพ์ตอบอยู่ — ระวังตอบซ้ำ");
  });

  it("typing ชนะ viewing เสมอ (มีทั้งดูและพิมพ์ → level = typing)", () => {
    const state = getCollisionState(
      [viewer("m1", "สมชาย"), viewer("m2", "สมหญิง")],
      [typer("m2", "สมหญิง")]
    );
    expect(state?.level).toBe("typing");
  });

  it("หลายคนกำลังพิมพ์ → 'A และอีก N คน กำลังพิมพ์ตอบ'", () => {
    const state = getCollisionState(
      [],
      [typer("m1", "สมชาย"), typer("m2", "สมหญิง")]
    );
    expect(state?.level).toBe("typing");
    expect(state?.message).toBe("สมชาย และอีก 1 คน กำลังพิมพ์ตอบอยู่ — ระวังตอบซ้ำ");
  });
});
