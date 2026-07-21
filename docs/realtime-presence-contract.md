# Contract — Real-time Presence/Collision (Phase 35, Slice 1)

> **Single source of truth** สำหรับ claim shape + channel naming + RLS policy
> ทั้ง `backend` (token endpoint) และ `database` (RLS migration) **ต้องยึดไฟล์นี้** — ห้าม relay ด้วยคำพูด
> Transport: **Supabase Realtime** (Broadcast + Presence). Signing: **Asymmetric JWT (RS256/ES256 + `kid`)**.

## หลักการ isolation (บังคับ — กฎสูงสุดของ project)

1. Channel **tenant-scoped + agent-audience-only**. `tenantId` claim **ผูกจาก server context เท่านั้น** (`x-tenant-id` ที่ proxy inject + `requireAgent()` membership verify) — **ห้ามรับจาก client**.
2. RLS policy บน `realtime.messages` **scope ด้วย JWT claim + `realtime.topic()` ล้วน** — **ห้าม subquery ไปตาราง app** (Ticket/Message/…). เหตุผล: app RLS ปิดอยู่ (BYPASSRLS, `RLS_ENABLED=false`); subquery จะรันใต้ role `authenticated` แล้วพฤติกรรมไม่แน่นอน. Scope ด้วย claim ล้วน = อิสระจาก app RLS 100%.
3. Portal contact **ห้าม** เข้า channel เหล่านี้ — token endpoint นี้ผ่าน `requireAgent()` เท่านั้น.

## Channel topic format

```
tenant:{tenantId}:ticket:{ticketId}
```
- `tenantId` = cuid ของ tenant (จาก verified context)
- `ticketId` = cuid ของ ticket

## JWT claims (backend mint → client `supabase.realtime.setAuth(token)`)

**Header:**
```
{ "alg": "<RS256|ES256 ตาม key ที่ Dev generate>", "kid": "<SUPABASE_REALTIME_JWT_KID>", "typ": "JWT" }
```
> ⚠️ `typ: "JWT"` **ต้องใส่เอง** เมื่อ sign ด้วย jose — ไม่งั้น Supabase Realtime verify ไม่ผ่าน (supabase-js #553).

**Payload:**
```jsonc
{
  "sub": "<userId>",             // User.id (global)
  "role": "authenticated",       // ⚠️ บังคับ — policy grant to authenticated
  "aud": "authenticated",        // ⚠️ บังคับ
  "iss": "<SUPABASE_URL>/auth/v1", // หรือค่าที่ Supabase project คาดหวัง
  "tenantId": "<ctx.tenantId>",  // custom claim — จาก server context เท่านั้น
  "memberId": "<member.id>",     // TenantMember.id — ใช้เป็น presence key ฝั่ง client
  "iat": <now>,
  "exp": <now + 60>              // TTL สั้น (~60s) — client ต้อง refresh ก่อนหมดอายุ
}
```

## RLS policies บน `realtime.messages` (database เขียน migration)

Scope ด้วย claim ล้วน — อ่าน `tenantId` จาก `request.jwt.claims`, match กับ prefix ของ topic
ด้วย `starts_with()` (**ไม่ใช่ `LIKE`** — literal prefix ล้วน ไม่มี `%`/`_` pattern semantics):

```sql
-- SELECT = สิทธิ์รับ presence/broadcast ของ channel
create policy "agent receive own-tenant ticket presence"
  on realtime.messages for select to authenticated
  using (
    (realtime.messages.extension in ('presence','broadcast'))
    and (current_setting('request.jwt.claims', true)::json ->> 'tenantId') ~ '^[a-zA-Z0-9-]+$'
    and starts_with(
      realtime.topic(),
      'tenant:' || (current_setting('request.jwt.claims', true)::json ->> 'tenantId') || ':ticket:'
    )
  );

-- INSERT = สิทธิ์ส่ง presence.track / typing broadcast
create policy "agent send own-tenant ticket presence"
  on realtime.messages for insert to authenticated
  with check (
    (realtime.messages.extension in ('presence','broadcast'))
    and (current_setting('request.jwt.claims', true)::json ->> 'tenantId') ~ '^[a-zA-Z0-9-]+$'
    and starts_with(
      realtime.topic(),
      'tenant:' || (current_setting('request.jwt.claims', true)::json ->> 'tenantId') || ':ticket:'
    )
  );
```

**Isolation guard (defense-in-depth ที่ DB layer):** ใช้ `starts_with()` แทน `LIKE` เพื่อไม่ให้ security boundary
แขวนกับ app validation ด่านเดียว — `%`/`_`/`:` ใน claim เป็น literal ล้วน จึงไม่มี wildcard/`:` injection ใน
topic prefix แม้ mint path ในอนาคตลืม validate. เสริม regex guard บน claim (`^[a-zA-Z0-9-]+$`) ที่ policy อีกชั้น.
`starts_with` เป็น STRICT: claim หาย → prefix NULL → deny (fail-closed). Topic ต้องขึ้นต้น `tenant:{claimTenantId}:ticket:`
เป๊ะ → tenant A join channel tenant B ไม่ได้แม้เดา ticketId ถูก. (backend ก็ยัง validate cuid ตอน mint อยู่ — สองชั้น.)

## Env keys ใหม่ (อ้างชื่อ — Dev provision, ห้าม hardcode ค่า)

| key | ใช้ที่ | หมายเหตุ |
|-----|--------|----------|
| `SUPABASE_REALTIME_JWT_PRIVATE_KEY` | backend | PEM private key (asymmetric) sign JWT — server-only |
| `SUPABASE_REALTIME_JWT_KID` | backend | key id ของ signing key (ใส่ใน JWT header) |
| `SUPABASE_URL` | backend | มีอยู่แล้ว — ใช้ประกอบ `iss` |

> Dev provision ใน Supabase dashboard: generate/import signing key + ปิด "Allow public access" ใน Realtime Settings.

## API contract — token endpoint

```
POST /api/realtime/token
  auth: requireAgent()   // agent audience เท่านั้น
  body: (none)   // endpoint ไม่อ่าน body — token เป็น tenant-scoped ไม่ใช่ ticket-scoped
  200 → { data: { token: string, expiresAt: number } }
  401 → { error: "..." } (ไม่ใช่ agent / session หมดอายุ)
  return shape ตาม convention project: { data, error }
```

> **Token scope = tenant-scoped (ไม่ใช่ ticket-scoped).** token 1 ใบ authorize ให้ agent join presence
> ของ ticket ใดก็ได้ใน tenant ตัวเอง — ถูกต้องตาม model เพราะ agent เห็นทุก ticket ใน tenant อยู่แล้ว
> (ดู Identity & Audiences). RLS scope ด้วย `tenantId` claim ล้วน ไม่ผูก ticketId → endpoint จึงไม่ต้อง
> รับ/verify `ticketId` และ**ไม่มี** guard "verify ticket ก่อน mint" (อย่าเข้าใจผิดว่ามี).

## Deliverables Slice 1

- **backend:** `src/app/api/realtime/token/route.ts` + helper mint JWT ใน `src/lib/realtime.ts` (jose asymmetric sign). Unit test: mint แล้ว claim ครบ + `tenantId` มาจาก ctx ไม่ใช่ body + TTL 60s + reject เมื่อไม่ใช่ agent.
- **database:** migration SQL ใหม่ใน `prisma/migrations/` — enable RLS + 2 policies บน `realtime.messages` ตามข้างบน. **ห้ามแตะตาราง app / ห้ามเปลี่ยน `RLS_ENABLED`.** ใส่คอมเมนต์ว่า policy อิสระจาก app RLS โดยเจตนา.

## Out of scope (Slice 2/3 — อย่าทำใน Slice 1)

- Client presence hook / typing UI (Slice 2 — frontend)
- Collision banner UX + security audit + qa isolation test (Slice 3)
