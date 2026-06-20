/**
 * src/types/ai.ts
 * Contract types สำหรับ AI Assist (Phase 29) — frontend import จากไฟล์นี้
 *
 * ⚠️ Agent-internal เท่านั้น: ผลลัพธ์ AI = internal draft summary ห้ามหลุดฝั่ง portal
 */

/**
 * Response body ของ POST /api/tickets/:id/ai/summarize
 * คืนผ่าน envelope มาตรฐาน: { data: AiSummaryDTO, error: null }
 */
export interface AiSummaryDTO {
  /** สรุป thread ของ ticket เป็นภาษาไทยกระชับ (draft สำหรับ agent อ่าน — ไม่ trigger action) */
  summary: string;
}
