/**
 * src/types/ai.ts
 * Contract types สำหรับ AI Assist (Phase 29) — frontend import จากไฟล์นี้
 *
 * ⚠️ Agent-internal เท่านั้น: ผลลัพธ์ AI = internal draft summary ห้ามหลุดฝั่ง portal
 */

import type { TagDTO } from "./tag";

/**
 * Response body ของ POST /api/tickets/:id/ai/summarize
 * คืนผ่าน envelope มาตรฐาน: { data: AiSummaryDTO, error: null }
 */
export interface AiSummaryDTO {
  /** สรุป thread ของ ticket เป็นภาษาไทยกระชับ (draft สำหรับ agent อ่าน — ไม่ trigger action) */
  summary: string;
}

/**
 * Response body ของ POST /api/tickets/:id/ai/suggest-reply (Slice 2)
 * คืนผ่าน envelope มาตรฐาน: { data: AiReplyDraftDTO, error: null }
 *
 * ⚠️ DRAFT เท่านั้น: route ไม่สร้าง TicketMessage / ไม่ส่ง email — frontend ใส่ข้อความนี้ลง
 *    reply box ให้ agent แก้ + กดส่งเองผ่าน flow เดิม
 */
export interface AiReplyDraftDTO {
  /** ร่างคำตอบให้ลูกค้า (ภาษาไทย) — draft ให้ agent แก้ก่อนส่ง */
  reply: string;
}

/**
 * Response body ของ POST /api/tickets/:id/ai/suggest-tags (Slice 3)
 * คืนผ่าน envelope มาตรฐาน: { data: AiTagSuggestionDTO, error: null }
 *
 * ⚠️ คืนเฉพาะ tag ที่มีจริงใน tenant (validate กลับแล้ว) — agent เลือก apply ผ่าน endpoint เดิม
 */
export interface AiTagSuggestionDTO {
  /** tag ที่ AI เสนอ — ทุกตัวมีจริงใน tenant (subset ของ tag catalog) */
  tags: TagDTO[];
}
