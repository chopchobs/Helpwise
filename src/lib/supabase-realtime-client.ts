/**
 * supabase-realtime-client.ts — Browser Supabase client (singleton) สำหรับ Realtime presence
 *
 * ใช้เฉพาะฝั่ง client (agent workspace) เพื่อเชื่อม Supabase Realtime presence/broadcast channel.
 * - อ่าน config จาก NEXT_PUBLIC_* เท่านั้น (anon key ปลอดภัยต่อการ expose ฝั่ง client)
 * - auth token จริงของ channel มาจาก /api/realtime/token (JWT อายุสั้น) ผ่าน setAuth() ภายหลัง
 *   ไม่ใช่ anon key — เราจึงปิด persistSession/autoRefresh ของ supabase-auth (ไม่ได้ใช้ user session ของ supabase)
 *
 * fail-soft: ถ้า env ไม่ตั้ง → คืน null + warn (ครั้งเดียว) โดย "ไม่ throw"
 * เพราะ presence เป็น enhancement — หน้า ticket ต้องทำงานได้แม้ realtime ใช้ไม่ได้
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;
let hasWarned = false;

/**
 * คืน browser Supabase client (สร้างครั้งเดียวแล้ว cache) หรือ null ถ้า env ไม่พร้อม
 * ⚠️ อย่า throw — presence ต้อง fail-soft
 */
export function getRealtimeClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    if (!hasWarned) {
      hasWarned = true;
      // warn ครั้งเดียวพอ — ไม่ spam console ทุกครั้งที่เปิดหน้า ticket
      console.warn(
        "[realtime] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY ไม่ได้ตั้ง — presence ถูกปิด (ไม่กระทบการใช้งาน ticket)"
      );
    }
    return null;
  }

  cachedClient = createClient(url, anonKey, {
    auth: {
      // ไม่ใช้ Supabase Auth session — token ของ channel เรา mint เองผ่าน /api/realtime/token
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      // จำกัด event rate ฝั่ง client — typing broadcast ถูก throttle ที่ hook อยู่แล้ว
      params: { eventsPerSecond: 5 },
    },
  });

  return cachedClient;
}
