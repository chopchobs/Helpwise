/**
 * src/lib/__tests__/isolation/threat-model.ts
 *
 * Tenant-Isolation Fuzz Suite — Typed Attack-Case Catalog (CONTRACT)
 * ------------------------------------------------------------------
 * ไฟล์นี้คือ "แคตตาล็อกกรณีโจมตี" ที่ qa-testing import ไปเดินลูปสร้าง fuzz/property test.
 * เป็น contract อย่างเดียว — ไม่ import โค้ด production, ไม่มี test runtime logic.
 *
 * ที่มาของ invariant ทุกข้อ = พฤติกรรมจริงของ:
 *   - src/lib/tenant.ts   (tenantPrisma $extends: inject where.tenantId / data.tenantId,
 *                          strip tenantId จาก update, throw raw ops, GLOBAL_MODELS ยกเว้น)
 *   - src/lib/auth.ts     (requireAgent / requireContact — audience + membership + double-check)
 *   - src/app/api/portal/**  และ  src/app/api/v1/**  (visibility=PUBLIC filter, own-records scope)
 *
 * ⚠️ RLS (Phase 27) ปิดอยู่ (RLS_ENABLED default off) → defense จริง = app-layer injection ชั้นนี้
 *    ทุก invariant จึงต้องเป็นจริง "โดยไม่พึ่ง RLS".
 */

// =============================================================================
// AXES — 8 แกนของการรั่วข้าม isolation boundary
// =============================================================================

export type IsolationAxis =
  | "cross-tenant-read"
  | "cross-tenant-write"
  | "cross-tenant-delete"
  | "tenant-move" /* B-1: ย้าย record ข้าม tenant ผ่าน data.tenantId */
  | "internal-note-leak"
  | "contact-own-records"
  | "audience-confusion"
  | "tenantid-from-client";

export type Severity = "critical" | "high" | "medium";

export interface AttackCase {
  /** unique id เช่น "XT-READ-01" — qa ใช้เป็น test name */
  id: string;
  axis: IsolationAxis;
  title: string;
  /** อธิบายการโจมตี (attacker ทำอะไร) */
  description: string;
  /** endpoint / layer ที่โดน เช่น "tenantPrisma.findMany" | "GET /api/v1/tickets/:id" */
  surface: string;
  /** input ที่ attacker ป้อน (คร่าว ๆ พอให้ qa สร้าง fixture) */
  attackerInput: string;
  /** property ที่ต้องจริงเสมอ — เขียนเป็นประโยค assert ได้ */
  invariant: string;
  severity: Severity;
  /** true = เหมาะ property-based (สุ่มหลาย input); false = table-driven case เดียว */
  fuzzable: boolean;
  /**
   * true = qa ควรตั้งใจเขียน test เพื่อ "พิสูจน์/หักล้าง" ช่องโหว่ที่ security สงสัย
   * (ไม่ใช่แค่ยืนยัน behavior ที่รู้ว่าผ่านแน่ ๆ) — ดู SUSPECTED_WEAKNESSES ท้ายไฟล์
   */
  suspectedWeakness?: boolean;
}

// =============================================================================
// ATTACK CASES
// =============================================================================

export const ATTACK_CASES: AttackCase[] = [
  // ───────────────────────────────────────────────────────────────────────────
  // AXIS 1: cross-tenant-read
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "XT-READ-01",
    axis: "cross-tenant-read",
    title: "findMany ไม่มี where → ต้องคืนเฉพาะ tenant ปัจจุบัน",
    description:
      "seed หลาย tenant ในตารางเดียวกัน แล้วเรียก tenantPrisma(A).<model>.findMany() แบบไม่ใส่ where. " +
      "extension ต้อง inject where.tenantId=A เสมอ.",
    surface: "tenantPrisma.findMany / findFirst",
    attackerInput: "ไม่ส่ง where เลย; DB มี row ของ tenant B, C ปนอยู่",
    invariant: "ทุก row ในผลลัพธ์ต้องมี tenantId === ctx.tenantId (ไม่มี row ของ tenant อื่นแม้แถวเดียว)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "XT-READ-02",
    axis: "cross-tenant-read",
    title: "findUnique/findFirst ด้วย id ของ tenant อื่น → ต้องได้ null",
    description:
      "attacker รู้ primary key ของ record ที่เป็นของ tenant B แล้วยิง findUnique({ where: { id } }) " +
      "ผ่าน tenantPrisma(A). extension inject tenantId=A เข้า where (filtered-findUnique). " +
      "ต้องพิสูจน์ว่า Prisma apply tenantId เป็น filter จริง ไม่ใช่ ignore แล้ว match by id อย่างเดียว.",
    surface: "tenantPrisma.findUnique / findFirst",
    attackerInput: "id = primary key จริงของ record tenant B",
    invariant: "ผลลัพธ์ต้องเป็น null (record ของ tenant อื่นห้าม resolve ได้แม้รู้ id ที่ถูกต้อง)",
    severity: "critical",
    fuzzable: true,
    suspectedWeakness: true,
  },
  {
    id: "XT-READ-03",
    axis: "cross-tenant-read",
    title: "where.OR แฝง tenantId ของ tenant อื่น → ต้อง bypass ไม่ได้",
    description:
      "attacker ส่ง where: { OR: [{ tenantId: 'B' }, { id: '...' }] }. extension เติม tenantId=A ที่ top-level " +
      "(AND กับ OR). ต้องพิสูจน์ว่า branch tenantId=B ใน OR ไม่ทำให้ row ของ B หลุดออกมา.",
    surface: "tenantPrisma.findMany",
    attackerInput: "where: { OR: [{ tenantId: '<B>' }, { NOT: { tenantId: '<A>' } }] }",
    invariant: "ทุก row ในผลลัพธ์ต้องมี tenantId === ctx.tenantId แม้ where จะมี OR/NOT/AND ที่อ้าง tenantId อื่น",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "XT-READ-04",
    axis: "cross-tenant-read",
    title: "nested include/relation — extension ไม่ inject tenantId ให้ relation ชั้นลึก",
    description:
      "extension inject where.tenantId เฉพาะ operation ระดับบนสุด — nested include/select (เช่น ticket.messages, " +
      "ticket.requesterContact, message.attachments) ไม่ถูก inject. isolation ของ relation อาศัย FK integrity " +
      "ว่า child อยู่ tenant เดียวกับ parent. qa ต้อง seed relation ที่ FK ชี้ข้าม tenant (ถ้าสร้างได้) เพื่อพิสูจน์ว่าไม่หลุด.",
    surface: "tenantPrisma.findFirst({ include/select: { <relation> } })",
    attackerInput: "query ที่ include relation ซ้อนหลายชั้นบน record ที่ครอบครองได้",
    invariant:
      "ทุก related row ที่ traverse ผ่าน include ต้องมี tenantId === ctx.tenantId " +
      "(ไม่มี relation row ของ tenant อื่นโผล่ผ่าน nested read)",
    severity: "high",
    fuzzable: true,
    suspectedWeakness: true,
  },
  {
    id: "XT-READ-05",
    axis: "cross-tenant-read",
    title: "count / aggregate / groupBy ต้องไม่นับข้าม tenant",
    description:
      "attacker เรียก count()/aggregate()/groupBy() หวังให้ตัวเลขรวม row ของ tenant อื่น (metadata leak). " +
      "extension inject where.tenantId ให้ op เหล่านี้.",
    surface: "tenantPrisma.count / aggregate / groupBy",
    attackerInput: "count/aggregate โดยไม่ใส่ where; DB มี row ของ tenant อื่นปน",
    invariant:
      "ผลนับ/ผลรวม ต้องเท่ากับที่คำนวณจาก row ของ ctx.tenantId เท่านั้น (ไม่รวม row ของ tenant อื่น)",
    severity: "high",
    fuzzable: true,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AXIS 2: cross-tenant-write
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "XT-WRITE-01",
    axis: "cross-tenant-write",
    title: "updateMany where กว้าง ต้องไม่แตะ row ของ tenant อื่น",
    description:
      "attacker เรียก updateMany({ where: { status: 'OPEN' }, data: {...} }) หวังแก้ ticket ของทุก tenant. " +
      "extension inject where.tenantId=A.",
    surface: "tenantPrisma.updateMany",
    attackerInput: "where: { status: 'OPEN' } (ไม่มี tenant filter); DB มี OPEN ticket ของ tenant อื่น",
    invariant: "row ที่ถูกแก้ต้องมี tenantId === ctx.tenantId ทุกแถว; row ของ tenant อื่นต้องไม่เปลี่ยนแปลง",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "XT-WRITE-02",
    axis: "cross-tenant-write",
    title: "update by id ของ record tenant อื่น → ต้อง not-found / no-op",
    description:
      "attacker update({ where: { id: <ของ tenant B> }, data: {...} }). extension เติม tenantId=A → ไม่ match → throw P2025.",
    surface: "tenantPrisma.update",
    attackerInput: "where.id = record ของ tenant B",
    invariant: "record ของ tenant B ต้องไม่ถูกแก้ (update ต้อง error not-found หรือไม่กระทบข้อมูล)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "XT-WRITE-03",
    axis: "cross-tenant-write",
    title: "create ที่ client ยัด data.tenantId=other → ต้องถูก override เป็น ctx",
    description:
      "attacker ส่ง create({ data: { ..., tenantId: '<B>' } }). extension spread tenantId=A ท้ายสุด → override.",
    surface: "tenantPrisma.create",
    attackerInput: "data: { ...valid, tenantId: '<B>' }",
    invariant: "record ที่สร้างต้องมี tenantId === ctx.tenantId เสมอ (ค่า tenantId จาก client ถูกทับ)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "XT-WRITE-04",
    axis: "cross-tenant-write",
    title: "createMany หลาย record ปน tenantId ต่างกัน → ทุก record ต้องเป็น ctx",
    description:
      "attacker ส่ง createMany({ data: [{ tenantId: 'B' }, { tenantId: 'C' }, { /* ไม่ใส่ */ }] }). " +
      "extension map ทุก record เติม tenantId=A.",
    surface: "tenantPrisma.createMany",
    attackerInput: "data: array ที่บาง record มี tenantId ของ tenant อื่น บาง record ไม่มีเลย",
    invariant: "ทุก record ที่ถูกสร้างต้องมี tenantId === ctx.tenantId (ไม่มี record หลุดไปอยู่ tenant อื่น)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "XT-WRITE-05",
    axis: "cross-tenant-write",
    title: "nested create + relation connect ข้าม tenant → FK contamination",
    description:
      "extension inject tenantId ที่ data ระดับบน แต่ nested write (create/connect ของ relation) ไม่ถูก scope. " +
      "attacker create ticket ที่ nested connect authorContact/assignee เป็น id ของอีก tenant. " +
      "ต้องพิสูจน์ว่า connect ข้าม tenant ทำไม่ได้ (FK ต้องไม่ลิงก์ record ข้าม tenant).",
    surface: "tenantPrisma.create({ data: { <relation>: { connect: { id } } } })",
    attackerInput: "data.messages.create[].authorContact.connect.id = contact ของ tenant B",
    invariant:
      "ห้ามสร้าง record ที่มี relation FK ชี้ไป record ของ tenant อื่น " +
      "(ทุก FK ของ record ใหม่ต้องผูกกับ record ที่ tenantId === ctx.tenantId เท่านั้น)",
    severity: "high",
    fuzzable: false,
    suspectedWeakness: true,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AXIS 3: cross-tenant-delete
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "XT-DEL-01",
    axis: "cross-tenant-delete",
    title: "deleteMany where กว้าง ต้องไม่ลบ row ของ tenant อื่น",
    description:
      "attacker เรียก deleteMany({ where: { status: 'CLOSED' } }) หวังลบข้ามทุก tenant. extension inject tenantId=A.",
    surface: "tenantPrisma.deleteMany",
    attackerInput: "where: { status: 'CLOSED' }; DB มี CLOSED ticket ของ tenant อื่น",
    invariant: "row ที่ถูกลบต้องมี tenantId === ctx.tenantId ทุกแถว; จำนวน row ของ tenant อื่นต้องคงเดิม",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "XT-DEL-02",
    axis: "cross-tenant-delete",
    title: "delete by id ของ record tenant อื่น → ต้อง not-found",
    description:
      "attacker delete({ where: { id: <ของ tenant B> } }). extension เติม tenantId=A → ไม่ match.",
    surface: "tenantPrisma.delete",
    attackerInput: "where.id = record ของ tenant B",
    invariant: "record ของ tenant B ต้องยังคงอยู่ (delete ต้อง error not-found หรือไม่กระทบ)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "XT-DEL-03",
    axis: "cross-tenant-delete",
    title: "deleteMany where ว่าง {} → ลบเฉพาะ tenant ปัจจุบัน",
    description:
      "attacker deleteMany({}) (หรือไม่ส่ง where). extension inject where.tenantId=A → ลบเฉพาะ A. " +
      "case อันตราย: ถ้า injection พลาด = ล้างทั้งตาราง (mass data loss ข้าม tenant).",
    surface: "tenantPrisma.deleteMany",
    attackerInput: "deleteMany({}) หรือ deleteMany() ไม่มี where",
    invariant:
      "ลบเฉพาะ row ที่ tenantId === ctx.tenantId; row ของทุก tenant อื่นต้องยังอยู่ครบ",
    severity: "critical",
    fuzzable: true,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AXIS 4: tenant-move (B-1)
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "B1-MOVE-01",
    axis: "tenant-move",
    title: "update data.tenantId=other → ต้อง strip ออก (record อยู่ tenant เดิม)",
    description:
      "attacker ครอบครอง record ของตัวเอง (tenant A) แล้ว update({ where: { id }, data: { tenantId: 'B' } }) " +
      "เพื่อย้าย record ไป tenant B. extension strip tenantId ออกจาก data.",
    surface: "tenantPrisma.update",
    attackerInput: "data: { ...fields, tenantId: '<B>' } บน record ของตัวเอง",
    invariant: "หลัง update, record ต้องยังมี tenantId === ctx.tenantId (ค่า tenantId ใน data ถูกละเว้น)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "B1-MOVE-02",
    axis: "tenant-move",
    title: "updateMany data.tenantId=other → ต้อง strip ออก",
    description:
      "เหมือน B1-MOVE-01 แต่ผ่าน updateMany (แก้หลาย record ของ tenant A พร้อมกัน ยัด tenantId=B).",
    surface: "tenantPrisma.updateMany",
    attackerInput: "where: {}, data: { tenantId: '<B>', ...fields }",
    invariant: "ทุก record ที่ถูกแก้ต้องยังมี tenantId === ctx.tenantId (ไม่มี record ย้ายไป tenant B)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "B1-MOVE-03",
    axis: "tenant-move",
    title: "upsert update-block ยัด tenantId=other → ต้อง strip",
    description:
      "attacker upsert record ที่มีอยู่แล้ว โดยใส่ update: { tenantId: 'B' }. extension strip tenantId ออกจาก update block.",
    surface: "tenantPrisma.upsert (update path)",
    attackerInput: "upsert({ where, create, update: { tenantId: '<B>', ...fields } }) กับ record ที่มีอยู่",
    invariant: "หลัง upsert (เข้า update path), record ต้องยังมี tenantId === ctx.tenantId",
    severity: "high",
    fuzzable: false,
  },
  {
    id: "B1-MOVE-04",
    axis: "tenant-move",
    title: "upsert create-block ยัด tenantId=other → ต้อง override เป็น ctx",
    description:
      "attacker upsert record ใหม่ โดยใส่ create: { tenantId: 'B' }. extension inject create.tenantId=A (override).",
    surface: "tenantPrisma.upsert (create path)",
    attackerInput: "upsert({ where, create: { tenantId: '<B>', ...fields }, update }) กับ record ที่ยังไม่มี",
    invariant: "record ที่ถูกสร้างผ่าน upsert ต้องมี tenantId === ctx.tenantId เสมอ",
    severity: "high",
    fuzzable: false,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AXIS 5: internal-note-leak
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "NOTE-LEAK-01",
    axis: "internal-note-leak",
    title: "portal ticket detail ต้องไม่คืน message ที่ visibility=INTERNAL",
    description:
      "seed ticket ที่มีทั้ง PUBLIC และ INTERNAL message แล้วให้ contact เจ้าของเรียก GET /api/portal/tickets/:id. " +
      "query กรอง visibility=PUBLIC ที่ backend.",
    surface: "GET /api/portal/tickets/:id",
    attackerInput: "contact เจ้าของ ticket ที่มี internal note ปนอยู่ (จำนวน internal สุ่ม 0..N)",
    invariant:
      "response.messages ต้องไม่มี message ที่ตรงกับ INTERNAL message ที่ seed ไว้ (นับ + เทียบ id/ body)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "NOTE-LEAK-02",
    axis: "internal-note-leak",
    title: "public v1 API ticket detail ต้องไม่คืน INTERNAL message",
    description:
      "API-key auth เรียก GET /api/v1/tickets/:id บน ticket ที่มี internal note. query กรอง visibility=PUBLIC.",
    surface: "GET /api/v1/tickets/:id",
    attackerInput: "valid API key + ticket id ที่มี internal note (สุ่มจำนวน)",
    invariant: "response.messages ทุกตัวต้องมาจาก PUBLIC message เท่านั้น (ไม่มี body/id ของ INTERNAL หลุด)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "NOTE-LEAK-03",
    axis: "internal-note-leak",
    title: "portal ticket list _count.messages ต้องนับเฉพาะ PUBLIC",
    description:
      "portal list ใช้ _count.messages โดยกรอง visibility=PUBLIC. ถ้าลืมกรอง จำนวนจะ leak การมีอยู่ของ internal note.",
    surface: "GET /api/portal/tickets (list, _count)",
    attackerInput: "ticket ที่มี PUBLIC=p และ INTERNAL=i (สุ่ม p,i)",
    invariant: "_count.messages ที่คืน ต้อง === จำนวน PUBLIC message (p) เท่านั้น ไม่รวม INTERNAL (i)",
    severity: "high",
    fuzzable: true,
  },
  {
    id: "NOTE-LEAK-04",
    axis: "internal-note-leak",
    title: "portal download attachment ของ INTERNAL message → ต้อง 404",
    description:
      "attacker (contact เจ้าของ ticket) รู้ attachment id ที่แนบกับ INTERNAL message แล้วขอ signed URL. " +
      "backend เช็ค parent message.visibility=PUBLIC → 404 ถ้าไม่ใช่.",
    surface: "GET /api/portal/attachments/:id",
    attackerInput: "attachment id ที่ผูกกับ INTERNAL message ของ ticket ตัวเอง",
    invariant: "ต้องได้ 404 และต้องไม่คืน signed download URL ของ attachment ที่ parent เป็น INTERNAL",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "NOTE-LEAK-05",
    axis: "internal-note-leak",
    title: "ทุก surface ฝั่ง portal/v1 ที่คืน message ต้องไม่มี INTERNAL (property รวม)",
    description:
      "การกรอง visibility=PUBLIC ไม่ได้ถูกบังคับใน tenantPrisma extension — เป็นความรับผิดชอบของแต่ละ query. " +
      "property test ครอบทุก endpoint (portal + v1) ที่คืน message เพื่อจับ endpoint ที่ลืมกรอง (regression net).",
    surface: "ทุก endpoint portal/v1 ที่ response มี messages[]",
    attackerInput: "สุ่ม ticket ที่มี INTERNAL note แล้วยิงทุก endpoint ที่คืน message",
    invariant:
      "ไม่มี response ฝั่ง portal หรือ v1 ใด ๆ ที่มี message ซึ่ง seed ไว้เป็น INTERNAL " +
      "(ไม่พึ่งการกรองใน UI — ต้องกรองที่ payload จาก backend)",
    severity: "critical",
    fuzzable: true,
    suspectedWeakness: true,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AXIS 6: contact-own-records
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "OWN-01",
    axis: "contact-own-records",
    title: "contact ขอ ticket ของ contact อื่น (tenant เดียวกัน) → 404",
    description:
      "contact A กับ contact B อยู่ tenant เดียวกัน. A รู้ ticket id ของ B แล้วเรียก GET /api/portal/tickets/:id. " +
      "query กรอง requesterContactId = session.contact.id → findFirst คืน null → 404 (ไม่ 403 เพื่อไม่ reveal).",
    surface: "GET /api/portal/tickets/:id",
    attackerInput: "session = contact A; path id = ticket ของ contact B (tenant เดียวกัน)",
    invariant:
      "ต้องได้ 404 เสมอ และ response ต้องไม่มีข้อมูลใด ๆ ของ ticket B (แม้ subject/สถานะ/การมีอยู่)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "OWN-02",
    axis: "contact-own-records",
    title: "contact list ต้องคืนเฉพาะ ticket ที่ requesterContactId = ตัวเอง",
    description:
      "seed ticket ของหลาย contact ใน tenant เดียว. contact A เรียก GET /api/portal/tickets. " +
      "where บังคับ requesterContactId = A.",
    surface: "GET /api/portal/tickets (list)",
    attackerInput: "session = contact A; DB มี ticket ของ contact อื่นใน tenant เดียวกัน",
    invariant: "ทุก ticket ใน list ต้องมี requesterContactId === session.contact.id",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "OWN-03",
    axis: "contact-own-records",
    title: "contact POST message ไป ticket ของ contact อื่น → 404 + ไม่สร้าง message",
    description:
      "contact A ยิง POST /api/portal/tickets/:id/messages ที่ id เป็น ticket ของ B. own-records verify ก่อน → 404.",
    surface: "POST /api/portal/tickets/:id/messages",
    attackerInput: "session = contact A; path id = ticket ของ contact B; body ปกติ",
    invariant: "ต้องได้ 404 และต้องไม่มี TicketMessage ใหม่ถูกสร้างใน ticket ของ B",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "OWN-04",
    axis: "contact-own-records",
    title: "contact download attachment ของ ticket contact อื่น → 404",
    description:
      "contact A รู้ attachment id ที่อยู่ใน ticket ของ B (แม้ message เป็น PUBLIC). backend เช็ค " +
      "ticket.requesterContactId === contact.id → 404 ถ้าไม่ตรง.",
    surface: "GET /api/portal/attachments/:id",
    attackerInput: "session = contact A; attachment id ผูกกับ ticket ของ contact B",
    invariant: "ต้องได้ 404 และไม่คืน signed URL ของ attachment ที่ ticket ไม่ใช่ของ contact นี้",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "OWN-05",
    axis: "contact-own-records",
    title: "contact สร้าง ticket ยัด requesterContactId จาก body → ต้องถูกละเว้น",
    description:
      "attacker ส่ง body มี requesterContactId ของ contact อื่น. route ต้องใช้ session.contact.id เสมอ " +
      "(schema ไม่รับ field นี้ + code hardcode contact.id).",
    surface: "POST /api/portal/tickets",
    attackerInput: "body: { subject, firstMessage, requesterContactId: '<contact อื่น>' }",
    invariant: "ticket ที่สร้างต้องมี requesterContactId === session.contact.id เสมอ (ค่าจาก body ถูกละเว้น)",
    severity: "high",
    fuzzable: false,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AXIS 7: audience-confusion
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "AUD-01",
    axis: "audience-confusion",
    title: "agent token ใช้กับ portal endpoint (requireContact) → 401",
    description:
      "attacker เอา valid agent token (type='agent') ยัดใน contact cookie แล้วเรียก portal endpoint. " +
      "requireContact เช็ค payload.type !== 'contact' → 401.",
    surface: "requireContact (ทุก portal endpoint)",
    attackerInput: "hw_contact_session cookie = agent token ที่ signature ถูกต้อง",
    invariant: "ต้อง reject (401) — agent token ห้ามผ่าน portal endpoint แม้ signature valid",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "AUD-02",
    axis: "audience-confusion",
    title: "contact token ใช้กับ agent endpoint (requireAgent) → 401",
    description:
      "attacker เอา valid contact token (type='contact') ยัดใน agent cookie. requireAgent เช็ค type !== 'agent' → 401.",
    surface: "requireAgent (ทุก agent endpoint)",
    attackerInput: "hw_agent_session cookie = contact token ที่ signature ถูกต้อง",
    invariant: "ต้อง reject (401) — contact token ห้ามได้ agent privilege",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "AUD-03",
    axis: "audience-confusion",
    title: "contact token ของ tenant A replay บน subdomain tenant B → 401",
    description:
      "attacker เอา valid contact token ของ tenant A (payload.tenantId=A) ไปยิงบน subdomain ของ B " +
      "(ctx.tenantId=B จาก header). requireContact double-check payload.tenantId !== ctx.tenantId → 401.",
    surface: "requireContact (double-check tenantId)",
    attackerInput: "contact token tenantId=A บน request ที่ x-tenant-id=B",
    invariant: "ต้อง reject (401) เมื่อ payload.tenantId !== ctx.tenantId (token ข้าม tenant ใช้ไม่ได้)",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "AUD-04",
    axis: "audience-confusion",
    title: "agent token ของ user ที่ไม่ได้เป็น member ของ tenant นี้ → 403",
    description:
      "valid agent token (user X) แต่ X ไม่มี TenantMember ใน tenant B. requireAgent query TenantMember แล้วไม่พบ → 403. " +
      "(User เป็น global — token valid ข้าม tenant ได้ แต่ membership ต้อง gate)",
    surface: "requireAgent (membership check)",
    attackerInput: "agent token ของ user ที่เป็น member เฉพาะ tenant A; request บน subdomain B",
    invariant: "ต้อง reject (403) เมื่อ user ไม่มี TenantMember(isActive) ใน ctx.tenantId",
    severity: "critical",
    fuzzable: true,
  },
  {
    id: "AUD-05",
    axis: "audience-confusion",
    title: "member ที่ isActive=false → 403 (deactivated ยังถือ token เก่า)",
    description:
      "user เคยเป็น member แต่ถูก deactivate (isActive=false). token ยังไม่หมดอายุ. " +
      "requireAgent ใส่ isActive=true ใน where → ไม่พบ → 403.",
    surface: "requireAgent (isActive filter)",
    attackerInput: "agent token ของ member ที่ TenantMember.isActive=false",
    invariant: "ต้อง reject (403) — member ที่ถูก deactivate ห้ามเข้าถึงแม้ token ยัง valid",
    severity: "high",
    fuzzable: false,
  },
  {
    id: "AUD-06",
    axis: "audience-confusion",
    title: "token ที่ signature ผิด/แก้ payload → reject ทุกกรณี",
    description:
      "attacker แก้ payload (เช่นเปลี่ยน type/tenantId/sub) หรือใช้ secret ผิด. jwtVerify ต้อง throw → 401. " +
      "รวม case: alg=none, secret สั้นกว่า 32 (getJwtSecret throw), token หมดอายุ.",
    surface: "verifyToken (requireAgent/requireContact)",
    attackerInput: "token ที่ถูกแก้ payload หรือ sign ด้วย key อื่น / alg=none / expired",
    invariant:
      "ทุก token ที่ signature/exp ไม่ผ่าน ต้อง reject (401) — ห้าม accept token ที่ integrity เสีย",
    severity: "critical",
    fuzzable: true,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // AXIS 8: tenantid-from-client
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: "TID-CLIENT-01",
    axis: "tenantid-from-client",
    title: "tenantId ใน request body → ต้องถูกละเว้น (ใช้ header context)",
    description:
      "attacker ยัด tenantId ใน JSON body ของ POST endpoint หวังให้ query อ่าน tenant อื่น. " +
      "route ใช้ ctx.tenantId จาก getTenantContext() (header) เท่านั้น; schema ไม่รับ tenantId.",
    surface: "POST /api/portal/tickets, POST /api/v1/tickets ฯลฯ",
    attackerInput: "body: { ...valid, tenantId: '<B>' }",
    invariant: "ผลลัพธ์ (record ที่สร้าง/อ่าน) ต้อง scoped ด้วย ctx.tenantId จาก header ไม่ใช่ค่าใน body",
    severity: "high",
    fuzzable: true,
  },
  {
    id: "TID-CLIENT-02",
    axis: "tenantid-from-client",
    title: "client ส่ง x-tenant-id header เอง → proxy ต้องเขียนทับเสมอ",
    description:
      "attacker set header x-tenant-id=B ตรง ๆ จาก client. proxy (src/proxy.ts) resolve จาก subdomain แล้ว " +
      "เขียนทับ header เสมอ. test นี้ยืนยันว่า app ไม่เชื่อ x-tenant-id ที่ client ตั้งเอง (ต้องมาจาก proxy).",
    surface: "src/proxy.ts → getTenantContext",
    attackerInput: "HTTP header x-tenant-id=<B> ที่ client แนบมาเอง บน subdomain ของ A",
    invariant:
      "ctx.tenantId ที่ route ใช้ ต้องตรงกับ tenant ที่ resolve จาก subdomain (A) ไม่ใช่ค่า header ที่ client ยัด (B)",
    severity: "critical",
    fuzzable: false,
    suspectedWeakness: true,
  },
  {
    id: "TID-CLIENT-03",
    axis: "tenantid-from-client",
    title: "tenantId ใน query string → ต้องถูกละเว้น",
    description:
      "attacker เติม ?tenantId=B ใน URL. route parse เฉพาะ field ที่ zod schema กำหนด (ไม่มี tenantId). scope มาจาก ctx.",
    surface: "GET endpoints ที่ parse searchParams",
    attackerInput: "?tenantId=<B>&status=OPEN",
    invariant: "ผลลัพธ์ต้อง scoped ด้วย ctx.tenantId เท่านั้น (query string tenantId ไม่มีผล)",
    severity: "high",
    fuzzable: true,
  },
  {
    id: "TID-CLIENT-04",
    axis: "tenantid-from-client",
    title: "path param id ข้าม tenant → 404 (id ไม่ override tenant scope)",
    description:
      "attacker ใส่ path param เป็น resource id ของ tenant B บน subdomain A. tenantPrisma inject tenantId=A " +
      "→ findFirst ไม่พบ → 404. (id จาก client ไม่ทำให้ข้าม tenant)",
    surface: "GET /api/v1/tickets/:id, GET /api/portal/tickets/:id",
    attackerInput: "path id = resource จริงของ tenant B; subdomain = A",
    invariant: "ต้องได้ 404 — resource id ของ tenant อื่นห้าม resolve ได้ผ่าน path param",
    severity: "critical",
    fuzzable: true,
  },
];

// =============================================================================
// HELPERS (qa อาจใช้จัดกลุ่ม/กรอง)
// =============================================================================

/** ดึง case ทั้งหมดของ axis หนึ่ง */
export function casesByAxis(axis: IsolationAxis): AttackCase[] {
  return ATTACK_CASES.filter((c) => c.axis === axis);
}

/** case ที่เหมาะทำ property-based fuzz */
export function fuzzableCases(): AttackCase[] {
  return ATTACK_CASES.filter((c) => c.fuzzable);
}

/** case ที่ security สงสัยว่าอาจมีช่องโหว่จริง — qa ควรตั้งใจพิสูจน์ */
export function suspectedWeaknessCases(): AttackCase[] {
  return ATTACK_CASES.filter((c) => c.suspectedWeakness === true);
}

/**
 * ช่องโหว่ที่ security "สงสัย" ระหว่างอ่านโค้ด — flag ไว้ให้ qa เขียน test พิสูจน์/หักล้าง
 * (ไม่ใช่ finding ที่ยืนยันแล้ว — เป็น hypothesis ที่ต้องมีหลักฐาน)
 */
export const SUSPECTED_WEAKNESSES: { caseId: string; note: string }[] = [
  {
    caseId: "XT-READ-02",
    note:
      "filtered-findUnique: extension เติม tenantId เข้า where ของ findUnique. ต้องยืนยันว่า Prisma รุ่นที่ใช้ " +
      "apply tenantId เป็น filter จริง (คืน null เมื่อไม่ตรง) ไม่ใช่ ignore field ที่ไม่ unique แล้ว match by id อย่างเดียว. " +
      "ถ้า Prisma ignore = cross-tenant read ผ่าน findUnique by id → Critical.",
  },
  {
    caseId: "XT-READ-04",
    note:
      "extension inject tenantId เฉพาะ operation ระดับบนสุด — nested include/select ไม่ถูก scope. isolation " +
      "ของ relation อาศัย FK integrity ล้วน ๆ. ถ้ามีทางสร้าง FK ข้าม tenant (ดู XT-WRITE-05) relation read จะหลุด.",
  },
  {
    caseId: "XT-WRITE-05",
    note:
      "nested write (create/connect ของ relation ซ้อน) ไม่ถูก extension scope — connect by id ข้าม tenant " +
      "อาจสร้าง FK ที่ลิงก์ record ข้าม tenant ได้. ต้องพิสูจน์ว่า schema/FK constraint กันไว้จริง มิฉะนั้นเป็นทางลัด contaminate.",
  },
  {
    caseId: "NOTE-LEAK-05",
    note:
      "การกรอง visibility=PUBLIC ไม่ได้ centralize ใน tenantPrisma — ทุก query ที่ดึง message ต้องเติม where เอง. " +
      "endpoint ใหม่ที่ลืมกรองจะ leak internal note เงียบ ๆ. ต้องมี property test ครอบทุก message-returning surface เป็น regression net.",
  },
  {
    caseId: "TID-CLIENT-02",
    note:
      "ความปลอดภัยของ 'ห้าม tenantId จาก client' พึ่งการที่ proxy (src/proxy.ts) เขียนทับ x-tenant-id เสมอ. " +
      "ต้องมี test ยืนยันว่า header ที่ client ตั้งเองถูก overwrite (ไม่ใช่ trust ค่าที่ client แนบ) — ทดสอบที่ proxy layer.",
  },
  {
    caseId: "UNHANDLED-OP",
    note:
      "operation ที่ไม่อยู่ใน branch (เช่น op ใหม่ของ Prisma ในอนาคต) extension ไม่ inject tenantId — พึ่ง RLS เป็น backstop " +
      "ชั้นเดียว ซึ่ง 'ปิดอยู่' (RLS_ENABLED=off). แปลว่าตอนนี้ unhandled op = ไม่มี tenant scope เลย. qa ควรมี guard " +
      "test ว่า operation set ที่ extension handle ครอบคลุม op ที่ codebase ใช้จริงทั้งหมด (fail ถ้ามี op หลุด branch).",
  },
];
