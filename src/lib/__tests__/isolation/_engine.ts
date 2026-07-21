/**
 * src/lib/__tests__/isolation/_engine.ts
 *
 * Faithful In-Memory Relational Engine — harness สำหรับ Tenant-Isolation Fuzz Suite
 * ------------------------------------------------------------------------------
 * ⚠️ ไฟล์นี้ "ไม่ใช่ test" (ไม่มี describe/it) — เป็น shared harness.
 *
 * 🎯 หลักการจุดตาย (อ่านก่อนแก้):
 *   Engine นี้ตั้งใจให้ "โง่เรื่อง tenant" — มันไม่รู้จักคำว่า tenantId เลย.
 *   มันแค่ "ซื่อสัตย์" ต่อ where / data / include / select ที่ได้รับ เหมือน Postgres จริง:
 *     - apply where filter ตรง ๆ (รองรับ AND/OR/NOT + operator subset)
 *     - สร้าง row ตาม data (รวม nested connect → set FK โดยไม่เช็ค tenant เหมือน DB จริง)
 *     - resolve include/select ตาม FK relation
 *   ตัวที่ "ฉลาดเรื่อง tenant" คือ src/lib/tenant.ts (tenantPrisma) — โค้ด production จริง.
 *
 *   ผลลัพธ์: เมื่อ test เรียก tenantPrisma(A).ticket.findMany() ผ่าน engine นี้
 *     → tenant.ts inject where.tenantId=A → engine กรองตามนั้น
 *     → ถ้า tenant.ts มีบั๊ก (ลืม scope op / strip ไม่ครบ) engine จะปล่อย row ของ tenant อื่นออกมา
 *       → test จับได้จริง (ไม่ใช่ tautology ที่ mock ตัวเอง)
 *
 *   ➡️ พิสูจน์แนวคิด: ถ้าไปคอมเมนต์บรรทัด `mutableArgs["where"] = { ...existingWhere, tenantId }`
 *      ใน tenant.ts ออก แล้วรัน suite นี้ → XT-READ-01 จะแดงทันที (row ของ tenant B หลุด).
 *      นี่คือหลักฐานว่า suite ทดสอบโค้ดจริง ไม่ใช่ spec.
 *
 * เราจำลอง Prisma ให้ "faithful" ที่สุดในจุดที่ threat-model สนใจ:
 *   - filtered-findUnique (Prisma 4.5+/7): where ที่มี non-unique field ถูก apply เป็น filter จริง
 *     → cross-tenant findUnique by id คืน null (XT-READ-02)
 *   - COMPOSITE TENANT FK (XT-WRITE-05 — ปิดแล้ว): migration 20260720000000_composite_tenant_fk_isolation
 *     เปลี่ยน 4 FK ของ Ticket/TicketMessage เป็น composite [tenantId, xxxId] -> Target[tenantId, id].
 *     engine mirror behavior นี้: เมื่อ write set scalar FK (จาก data ตรง ๆ หรือ nested connect) ที่ชี้
 *     record ต่าง tenant (หรือ id ที่ไม่มีจริง) → engine throw ForeignKeyViolationError (code P2003)
 *     เหมือน Postgres reject ด้วย 23503. nullable FK (assignee/author*) เป็น null = ไม่เช็ค (MATCH SIMPLE).
 *     ➡️ เดิม engine "ปล่อย" connect ข้าม tenant (จำลอง FK ที่ไม่มี tenant constraint) → XT-WRITE-05 แดง
 *        เพื่อ flag ช่องโหว่. หลัง fix ที่ DB + app engine ต้อง mirror composite FK → XT-WRITE-05 เขียว
 *        เพราะ assert ว่า cross-tenant connect ถูก reject. ลบ COMPOSITE_TENANT_FKS ออก = XT-WRITE-05 แดงคืน
 *        (หลักฐานว่า test ยังจับ regression ได้จริง).
 */

// =============================================================================
// RELATION METADATA — map relation name → target model + FK direction
// (จำกัดเฉพาะ relation ที่ suite ใช้ — เพียงพอต่อ threat-model, ไม่ต้องครบ schema)
// =============================================================================

type RelationKind = "belongsTo" | "hasMany";

interface RelationMeta {
  /** lowercase model name ปลายทาง */
  target: string;
  /** belongsTo = FK อยู่ที่ parent (parent[key] === child.id); hasMany = FK อยู่ที่ child (child[key] === parent.id) */
  kind: RelationKind;
  /** ชื่อ FK field ตาม kind */
  key: string;
  /** hasMany ที่เป็น one-to-one (inverse ของ @unique) → คืน object เดี่ยว ไม่ใช่ array */
  single?: boolean;
}

const RELATIONS: Record<string, Record<string, RelationMeta>> = {
  ticket: {
    messages: { target: "ticketMessage", kind: "hasMany", key: "ticketId" },
    attachments: { target: "attachment", kind: "hasMany", key: "ticketId" },
    requesterContact: { target: "contact", kind: "belongsTo", key: "requesterContactId" },
    assignee: { target: "tenantMember", kind: "belongsTo", key: "assigneeId" },
    csat: { target: "csatResponse", kind: "hasMany", key: "ticketId", single: true },
  },
  ticketMessage: {
    ticket: { target: "ticket", kind: "belongsTo", key: "ticketId" },
    authorContact: { target: "contact", kind: "belongsTo", key: "authorContactId" },
    authorMember: { target: "tenantMember", kind: "belongsTo", key: "authorMemberId" },
    attachments: { target: "attachment", kind: "hasMany", key: "messageId" },
  },
  attachment: {
    ticket: { target: "ticket", kind: "belongsTo", key: "ticketId" },
    message: { target: "ticketMessage", kind: "belongsTo", key: "messageId" },
  },
  tenantMember: {
    user: { target: "user", kind: "belongsTo", key: "userId" },
  },
  contact: {},
  user: {},
};

function relationsFor(model: string): Record<string, RelationMeta> {
  return RELATIONS[model] ?? {};
}

// =============================================================================
// COMPOSITE TENANT FK METADATA (mirror migration 20260720000000_composite_tenant_fk_isolation)
// -----------------------------------------------------------------------------
// Postgres จริงมี composite FK [tenantId, <column>] -> <Target>[tenantId, id] บน 4 ความสัมพันธ์.
// engine จำลอง referential integrity ชั้นนี้: เมื่อ write set scalar FK column ต้องมี target row
// ที่ (tenantId ตรง AND id ตรง) — cross-tenant หรือ id ไม่มีจริง = throw (nullable → null ข้ามการเช็ค).
// จงใจครอบเฉพาะ 4 FK นี้ (ตรงกับ migration) — ไม่ทำให้ engine ฉลาดเรื่อง tenant scoping ของ query
// (นั่นยังเป็นหน้าที่ tenant.ts). engine แค่ "ซื่อสัตย์" ต่อ FK constraint ที่ DB มีจริง.
// =============================================================================

interface CompositeTenantFk {
  /** scalar FK column บน row ที่กำลังเขียน */
  column: string;
  /** lowercase model name ของ target ที่ FK อ้างถึง */
  target: string;
}

const COMPOSITE_TENANT_FKS: Record<string, CompositeTenantFk[]> = {
  ticket: [
    { column: "requesterContactId", target: "contact" }, // Ticket_tenantId_requesterContactId_fkey (NOT NULL)
    { column: "assigneeId", target: "tenantMember" }, // Ticket_tenantId_assigneeId_fkey (nullable)
  ],
  ticketMessage: [
    { column: "authorMemberId", target: "tenantMember" }, // TicketMessage_tenantId_authorMemberId_fkey (nullable)
    { column: "authorContactId", target: "contact" }, // TicketMessage_tenantId_authorContactId_fkey (nullable)
  ],
};

// =============================================================================
// TYPES
// =============================================================================

export type Row = Record<string, unknown>;
export type Where = Record<string, unknown>;

/**
 * LooseClient — cast type สำหรับ "attacker input ที่ไม่ผ่าน TS"
 * เรายิง payload ที่ผิด type (missing required field / ยัด tenantId เกิน / nested connect ข้าม tenant)
 * เข้า tenantPrisma "ตัวจริง" โดยเจตนา — จำลอง malicious input ที่ bypass compile-time check.
 * เป็นการผ่อนเฉพาะ "type ตอน compile" เท่านั้น; runtime ยังเรียกโค้ด tenantPrisma จริง 100%.
 */
export type LooseDelegate = Record<string, (args?: unknown) => Promise<unknown>>;
export type LooseClient = Record<string, LooseDelegate>;

/** in-memory store: lowercase model name → array of rows (ทุก tenant ปนกันในตารางเดียว) */
export type Store = Record<string, Row[]>;

interface FindArgs {
  where?: Where;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];
  skip?: number;
  take?: number;
}

/** Prisma P2025 — record not found (update/delete ที่ไม่ match) */
export class RecordNotFoundError extends Error {
  code = "P2025";
  constructor(model: string, operation: string) {
    super(`No '${model}' record found for a '${operation}' operation.`);
    this.name = "RecordNotFoundError";
  }
}

/**
 * Prisma P2003 — foreign key constraint violation.
 * mirror composite tenant FK ที่ Postgres reject (SQLSTATE 23503 → Prisma P2003).
 * โยนเมื่อ write ตั้ง scalar FK ที่ชี้ record ต่าง tenant / ไม่มีจริง (ดู COMPOSITE_TENANT_FKS).
 */
export class ForeignKeyViolationError extends Error {
  code = "P2003";
  constructor(public constraint: string) {
    super(`Foreign key constraint violated on constraint: \`${constraint}\``);
    this.name = "ForeignKeyViolationError";
  }
}

// =============================================================================
// WHERE MATCHING (ซื่อสัตย์ต่อ where — รองรับ AND/OR/NOT + operator subset)
// =============================================================================

function isPlainOperatorObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !(v instanceof Date) &&
    !Array.isArray(v)
  );
}

function scalarEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === "string") return a.toISOString() === b;
  return a === b;
}

function matchScalarField(rowVal: unknown, cond: unknown): boolean {
  if (cond === null) return rowVal === null || rowVal === undefined;
  if (cond instanceof Date) return scalarEquals(rowVal, cond);
  if (isPlainOperatorObject(cond)) {
    // operator object เช่น { equals, not, in, notIn, gt, gte, lt, lte }
    for (const [op, val] of Object.entries(cond)) {
      switch (op) {
        case "equals":
          if (!scalarEquals(rowVal, val)) return false;
          break;
        case "not":
          if (scalarEquals(rowVal, val)) return false;
          break;
        case "in":
          if (!Array.isArray(val) || !val.some((x) => scalarEquals(rowVal, x))) return false;
          break;
        case "notIn":
          if (Array.isArray(val) && val.some((x) => scalarEquals(rowVal, x))) return false;
          break;
        case "gt":
          if (!(compare(rowVal, val) > 0)) return false;
          break;
        case "gte":
          if (!(compare(rowVal, val) >= 0)) return false;
          break;
        case "lt":
          if (!(compare(rowVal, val) < 0)) return false;
          break;
        case "lte":
          if (!(compare(rowVal, val) <= 0)) return false;
          break;
        default:
          // operator ที่ engine ยังไม่รองรับ → ถือว่าไม่ match (fail-loud ในการพัฒนา harness)
          throw new Error(`[engine] unsupported where operator: ${op}`);
      }
    }
    return true;
  }
  return scalarEquals(rowVal, cond);
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number);
  const bv = b instanceof Date ? b.getTime() : (b as number);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export function matchWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "AND") {
      const arr = Array.isArray(cond) ? cond : [cond];
      if (!arr.every((w) => matchWhere(row, w as Where))) return false;
    } else if (key === "OR") {
      const arr = (cond as Where[]) ?? [];
      if (arr.length > 0 && !arr.some((w) => matchWhere(row, w))) return false;
    } else if (key === "NOT") {
      const arr = Array.isArray(cond) ? cond : [cond];
      if (arr.some((w) => matchWhere(row, w as Where))) return false;
    } else {
      if (!matchScalarField(row[key], cond)) return false;
    }
  }
  return true;
}

// =============================================================================
// ENGINE
// =============================================================================

export class Engine {
  private counter = 0;

  constructor(public store: Store) {}

  private table(model: string): Row[] {
    const m = model.charAt(0).toLowerCase() + model.slice(1);
    if (!this.store[m]) this.store[m] = [];
    return this.store[m];
  }

  private modelName(model: string): string {
    return model.charAt(0).toLowerCase() + model.slice(1);
  }

  /** entry point เดียวที่ทั้ง $extends executor และ tx delegate เรียก (executor ซื่อสัตย์ตัวเดียวกัน) */
  execute(model: string, operation: string, rawArgs: unknown): unknown {
    const model2 = this.modelName(model);
    const args = (rawArgs ?? {}) as FindArgs & { data?: unknown; create?: Where; update?: Where };

    switch (operation) {
      case "findMany":
        return this.findMany(model2, args);
      case "findFirst":
      case "findFirstOrThrow":
      case "findUnique":
      case "findUniqueOrThrow": {
        // filtered-findUnique (Prisma 4.5+): where ทุก field ถูก apply เป็น filter จริง
        // → tenantId ที่ extension inject ทำหน้าที่ filter (คืน null เมื่อไม่ตรง) — XT-READ-02
        const rows = this.findMany(model2, { ...args, take: undefined, skip: undefined });
        const first = (rows as Row[])[0] ?? null;
        if (!first && operation.endsWith("OrThrow")) {
          throw new RecordNotFoundError(model2, operation);
        }
        return first;
      }
      case "count":
        return this.filtered(model2, args.where).length;
      case "aggregate":
        return this.aggregate(model2, rawArgs as Record<string, unknown>);
      case "groupBy":
        return this.groupBy(model2, rawArgs as Record<string, unknown>);
      case "create":
        return this.create(model2, (rawArgs as { data: Where }).data, args);
      case "createMany":
        return this.createMany(model2, (rawArgs as { data: unknown }).data);
      case "update":
        return this.update(model2, args);
      case "updateMany":
        return this.updateMany(model2, args);
      case "upsert":
        return this.upsert(model2, args);
      case "delete":
        return this.delete(model2, args);
      case "deleteMany":
        return this.deleteMany(model2, args.where);
      default:
        throw new Error(`[engine] unsupported operation: ${operation}`);
    }
  }

  private filtered(model: string, where: Where | undefined): Row[] {
    return this.table(model).filter((r) => matchWhere(r, where));
  }

  private sortRows(rows: Row[], orderBy: FindArgs["orderBy"]): Row[] {
    if (!orderBy) return rows;
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    const out = [...rows];
    out.sort((a, b) => {
      for (const spec of specs) {
        for (const [field, dir] of Object.entries(spec)) {
          const c = compare(a[field], b[field]);
          if (c !== 0) return dir === "desc" ? -c : c;
        }
      }
      return 0;
    });
    return out;
  }

  private findMany(model: string, args: FindArgs): Row[] {
    let rows = this.filtered(model, args.where);
    rows = this.sortRows(rows, args.orderBy);
    if (typeof args.skip === "number") rows = rows.slice(args.skip);
    if (typeof args.take === "number") rows = rows.slice(0, args.take);
    return rows.map((r) => this.project(model, r, args.select, args.include));
  }

  // ---- projection (select / include / _count) --------------------------------

  private project(
    model: string,
    row: Row,
    select?: Record<string, unknown>,
    include?: Record<string, unknown>
  ): Row {
    const rels = relationsFor(model);

    if (select) {
      const out: Row = {};
      for (const [key, val] of Object.entries(select)) {
        if (val === false || val === undefined) continue;
        if (key === "_count") {
          out._count = this.resolveCount(model, row, val as Record<string, unknown>);
          continue;
        }
        if (rels[key]) {
          out[key] = this.resolveRelation(model, row, key, val);
          continue;
        }
        // scalar field
        out[key] = row[key];
      }
      return out;
    }

    // include: คืน scalar ทั้งหมด + relation ที่ระบุ
    const out: Row = { ...stripRelations(row, rels) };
    if (include) {
      for (const [key, val] of Object.entries(include)) {
        if (val === false || val === undefined) continue;
        if (key === "_count") {
          out._count = this.resolveCount(model, row, val as Record<string, unknown>);
          continue;
        }
        if (rels[key]) out[key] = this.resolveRelation(model, row, key, val);
      }
    }
    return out;
  }

  private resolveRelation(model: string, parent: Row, relName: string, spec: unknown): unknown {
    const meta = relationsFor(model)[relName];
    if (!meta) return undefined;
    const specObj = (spec === true || spec === undefined ? {} : spec) as FindArgs;

    let children: Row[];
    if (meta.kind === "belongsTo") {
      const fk = parent[meta.key];
      if (fk === null || fk === undefined) return meta.single === false ? [] : null;
      children = this.table(meta.target).filter((c) => c.id === fk);
    } else {
      children = this.table(meta.target).filter((c) => c[meta.key] === parent.id);
    }

    // ⚠️ FAITHFUL: nested where ถูก apply "ที่ relation" — แต่ tenantId ไม่ถูก extension inject
    //    ที่ชั้น nested (isolation ของ relation อาศัย FK integrity). engine ซื่อสัตย์: กรองเฉพาะ
    //    where ที่ query ส่งมาจริง (เช่น visibility=PUBLIC) — ไม่ยัด tenantId ให้เอง.
    children = children.filter((c) => matchWhere(c, specObj.where));
    children = this.sortRows(children, specObj.orderBy);
    if (typeof specObj.take === "number") children = children.slice(0, specObj.take);

    const projected = children.map((c) =>
      this.project(meta.target, c, specObj.select, specObj.include)
    );

    if (meta.kind === "belongsTo" || meta.single) {
      return projected[0] ?? null;
    }
    return projected;
  }

  private resolveCount(model: string, parent: Row, spec: Record<string, unknown>): Row {
    const out: Row = {};
    const selectSpec = (spec.select ?? spec) as Record<string, unknown>;
    for (const [relName, relSpec] of Object.entries(selectSpec)) {
      if (relName === "select") continue;
      const meta = relationsFor(model)[relName];
      if (!meta) continue;
      const children =
        meta.kind === "belongsTo"
          ? this.table(meta.target).filter((c) => c.id === parent[meta.key])
          : this.table(meta.target).filter((c) => c[meta.key] === parent.id);
      const nestedWhere =
        relSpec && typeof relSpec === "object" ? (relSpec as FindArgs).where : undefined;
      out[relName] = children.filter((c) => matchWhere(c, nestedWhere)).length;
    }
    return out;
  }

  // ---- writes ----------------------------------------------------------------

  private applyData(model: string, target: Row, data: Where): void {
    const rels = relationsFor(model);
    for (const [key, val] of Object.entries(data)) {
      const meta = rels[key];
      if (meta && meta.kind === "belongsTo" && isPlainOperatorObject(val)) {
        // nested connect → set scalar FK ตาม id ที่ระบุ. tenant.ts ไม่ scope nested
        //   → attacker connect ข้าม tenant ได้ถึงชั้นนี้ แต่ enforceCompositeFks() (mirror
        //   composite tenant FK ของ DB) จะ reject ตอน commit (XT-WRITE-05 ปิดแล้ว).
        const connect = (val as { connect?: { id?: string } }).connect;
        if (connect && typeof connect.id === "string") {
          target[meta.key] = connect.id;
        }
        continue;
      }
      target[key] = val;
    }
  }

  /**
   * enforceCompositeFks — จำลอง composite tenant FK ของ Postgres (mirror DB จริง).
   * เรียกกับ "row ผลลัพธ์" ก่อน commit ทุก write. ถ้า scalar FK ชี้ record ต่าง tenant
   * (หรือ id ไม่มีจริง) → throw ForeignKeyViolationError (เหมือน 23503 → P2003).
   * nullable FK ที่เป็น null/undefined = ข้าม (MATCH SIMPLE — assignee/author* ว่างได้).
   */
  private enforceCompositeFks(model: string, row: Row): void {
    const fks = COMPOSITE_TENANT_FKS[model];
    if (!fks) return;
    const tenantId = row.tenantId;
    for (const fk of fks) {
      const fkVal = row[fk.column];
      if (fkVal === null || fkVal === undefined) continue; // FK ไม่ถูก set → ไม่เช็ค
      // composite FK: ต้องมี target row ที่ (tenantId ตรง AND id ตรง)
      const exists = this.table(fk.target).some(
        (t) => t.id === fkVal && t.tenantId === tenantId
      );
      if (!exists) {
        throw new ForeignKeyViolationError(
          `${capitalize(model)}_tenantId_${fk.column}_fkey`
        );
      }
    }
  }

  private create(model: string, data: Where, args: FindArgs): Row {
    const row: Row = {};
    this.applyData(model, row, data ?? {});
    if (row.id === undefined) row.id = `${model}-${++this.counter}`;
    // composite tenant FK: reject ก่อน persist (violation → ไม่มี row ปนเปื้อนถูกสร้าง)
    this.enforceCompositeFks(model, row);
    this.table(model).push(row);
    return this.project(model, row, args.select, args.include);
  }

  private createMany(model: string, data: unknown): { count: number } {
    const records = Array.isArray(data) ? data : [data];
    let count = 0;
    for (const rec of records) {
      const row: Row = {};
      this.applyData(model, row, (rec ?? {}) as Where);
      if (row.id === undefined) row.id = `${model}-${++this.counter}`;
      this.enforceCompositeFks(model, row);
      this.table(model).push(row);
      count++;
    }
    return { count };
  }

  private update(model: string, args: FindArgs & { data?: unknown }): Row {
    const target = this.filtered(model, args.where)[0];
    if (!target) throw new RecordNotFoundError(model, "update");
    // faithful: apply บน preview แล้ว enforce ก่อน commit — violation = target ไม่เปลี่ยน (DB rollback)
    const preview: Row = { ...target };
    this.applyData(model, preview, (args.data ?? {}) as Where);
    this.enforceCompositeFks(model, preview);
    Object.assign(target, preview);
    return this.project(model, target, args.select, args.include);
  }

  private updateMany(model: string, args: FindArgs & { data?: unknown }): { count: number } {
    const matched = this.filtered(model, args.where);
    // validate ทุก row ก่อน (statement atomic: ถ้ามีแถวใด violation → ไม่ commit ทั้งชุด)
    const previews = matched.map((r) => {
      const p: Row = { ...r };
      this.applyData(model, p, (args.data ?? {}) as Where);
      this.enforceCompositeFks(model, p);
      return p;
    });
    matched.forEach((r, i) => Object.assign(r, previews[i]));
    return { count: matched.length };
  }

  private upsert(model: string, args: FindArgs & { create?: Where; update?: Where }): Row {
    const existing = this.filtered(model, args.where)[0];
    if (existing) {
      this.applyData(model, existing, (args.update ?? {}) as Where);
      return this.project(model, existing, args.select, args.include);
    }
    return this.create(model, (args.create ?? {}) as Where, args);
  }

  private delete(model: string, args: FindArgs): Row {
    const table = this.table(model);
    const idx = table.findIndex((r) => matchWhere(r, args.where));
    if (idx === -1) throw new RecordNotFoundError(model, "delete");
    const [removed] = table.splice(idx, 1);
    return this.project(model, removed, args.select, args.include);
  }

  private deleteMany(model: string, where: Where | undefined): { count: number } {
    const table = this.table(model);
    const keep = table.filter((r) => !matchWhere(r, where));
    const count = table.length - keep.length;
    this.store[model] = keep;
    return { count };
  }

  // ---- aggregate / groupBy (minimal) -----------------------------------------

  private aggregate(model: string, args: Record<string, unknown>): Row {
    const rows = this.filtered(model, args.where as Where | undefined);
    const out: Row = {};
    if (args._count !== undefined) {
      out._count = typeof args._count === "object" ? countFields(rows, args._count as Row) : rows.length;
    }
    if (args._sum) out._sum = sumFields(rows, args._sum as Row);
    return out;
  }

  private groupBy(model: string, args: Record<string, unknown>): Row[] {
    const rows = this.filtered(model, args.where as Where | undefined);
    const by = (args.by as string[]) ?? [];
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const gkey = by.map((f) => String(r[f])).join("|");
      if (!groups.has(gkey)) groups.set(gkey, []);
      groups.get(gkey)!.push(r);
    }
    const out: Row[] = [];
    for (const [, gRows] of groups) {
      const entry: Row = {};
      for (const f of by) entry[f] = gRows[0][f];
      if (args._count !== undefined) {
        entry._count =
          typeof args._count === "object" ? countFields(gRows, args._count as Row) : gRows.length;
      }
      if (args._sum) entry._sum = sumFields(gRows, args._sum as Row);
      out.push(entry);
    }
    return out;
  }
}

function stripRelations(row: Row, rels: Record<string, RelationMeta>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (!rels[k]) out[k] = v;
  }
  return out;
}

function countFields(rows: Row[], spec: Row): Row {
  const out: Row = {};
  for (const f of Object.keys(spec)) out[f] = rows.filter((r) => r[f] !== null && r[f] !== undefined).length;
  return out;
}

function sumFields(rows: Row[], spec: Row): Row {
  const out: Row = {};
  for (const f of Object.keys(spec)) out[f] = rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  return out;
}

// =============================================================================
// PRISMA STUB FACTORIES (mock boundary = @/lib/prisma เท่านั้น)
// =============================================================================

interface AllOperationsArgs {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}
interface ExtendConfig {
  query: { $allModels: { $allOperations: (a: AllOperationsArgs) => Promise<unknown> } };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** delegate proxy: client[model][operation](args) → run(operation, args) */
function makeDelegate(run: (op: string, args: unknown) => unknown): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, op: string) {
        return (args: unknown) => run(op, args);
      },
    }
  );
}

/** tx client ที่ tenant.ts ใช้ใน prisma.$transaction — $executeRaw = no-op, delegate → engine */
function makeTxClient(engine: Engine): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$executeRaw") {
          return async () => 0; // no-op (RLS GUC set — engine ไม่สนใจ)
        }
        return makeDelegate((op, args) => engine.execute(prop, op, args));
      },
    }
  );
}

/** extended client (ผลจาก prisma.$extends) — dispatch ทุก op ผ่าน $allOperations ของ config */
function makeExtendedClient(engine: Engine, config: ExtendConfig): Record<string, unknown> {
  const allOps = config.query.$allModels.$allOperations;
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_t2, operation: string) {
              return (args: unknown) =>
                allOps({
                  model: capitalize(model),
                  operation,
                  // Prisma normalize args เป็น {} เมื่อเรียกโดยไม่ส่ง arg (เช่น findMany())
                  args: args ?? {},
                  // executor ซื่อสัตย์: ตัวเดียวกับที่ tx delegate ใช้
                  query: async (finalArgs: unknown) => engine.execute(model, operation, finalArgs),
                });
            },
          }
        );
      },
    }
  );
}

/**
 * createFaithfulPrisma — stub ของ @/lib/prisma ที่ backed ด้วย faithful Engine
 *
 * ใช้ใน vi.mock("@/lib/prisma", () => ({ prisma: createFaithfulPrisma(store) }))
 * แล้ว import tenantPrisma "ตัวจริง" จาก @/lib/tenant → มัน $extends stub นี้.
 *
 * @param store shared in-memory store (seed ก่อนรัน test)
 */
export function createFaithfulPrisma(store: Store): {
  prisma: Record<string, unknown>;
  engine: Engine;
} {
  const engine = new Engine(store);
  const prisma = new Proxy(
    {},
    {
      get(_t, prop: string) {
        // accessor สำหรับ test: ดึง store/engine reference เดียวกับที่ mock ใช้
        // (ใช้ร่วมกับ async vi.mock factory — กัน TDZ ของ vi.hoisted)
        if (prop === "__store") return store;
        if (prop === "__engine") return engine;
        if (prop === "$extends") {
          return (config: ExtendConfig) => makeExtendedClient(engine, config);
        }
        if (prop === "$transaction") {
          return (arg: unknown) => {
            if (typeof arg === "function") {
              return (arg as (tx: unknown) => unknown)(makeTxClient(engine));
            }
            return Promise.all(arg as Promise<unknown>[]);
          };
        }
        if (prop === "$executeRaw") return async () => 0;
        // base delegate ตรง (เช่น proxy.ts เรียก prisma.tenant.findFirst โดยไม่ผ่าน tenantPrisma)
        return makeDelegate((op, args) => engine.execute(prop, op, args));
      },
    }
  );
  return { prisma, engine };
}

// =============================================================================
// SPY PRISMA — สำหรับ UNHANDLED-OP coverage guard
// จับ "args สุดท้าย" ที่ tenant.ts ส่งเข้า executor ต่อ operation เพื่อยืนยันว่า tenantId
// ถูก inject จริง (ไม่พึ่งผลลัพธ์ engine) — ครอบ op ที่ codebase ใช้จริงทั้งหมด
// =============================================================================

export interface SpyRecord {
  model: string;
  operation: string;
  args: Record<string, unknown>;
}

function benignReturn(operation: string): unknown {
  if (operation === "count") return 0;
  if (operation === "aggregate") return {};
  if (operation === "groupBy") return [];
  if (operation === "createMany" || operation === "updateMany" || operation === "deleteMany")
    return { count: 0 };
  if (operation === "findMany") return [];
  return null;
}

/** stub prisma ที่บันทึก args ที่ dispatch จริง (หลัง tenant.ts inject) แทนการรัน engine */
export function createSpyPrisma(): {
  prisma: Record<string, unknown>;
  records: SpyRecord[];
} {
  const records: SpyRecord[] = [];
  const record = (model: string, operation: string, args: unknown): unknown => {
    records.push({ model, operation, args: (args ?? {}) as Record<string, unknown> });
    return benignReturn(operation);
  };
  const txClient = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$executeRaw") return async () => 0;
        return makeDelegate((op, args) => record(prop, op, args));
      },
    }
  );
  const prisma = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "__records") return records;
        if (prop === "$extends") {
          return (config: ExtendConfig) => {
            const allOps = config.query.$allModels.$allOperations;
            return new Proxy(
              {},
              {
                get(_t2, model: string) {
                  return new Proxy(
                    {},
                    {
                      get(_t3, operation: string) {
                        return (args: unknown) =>
                          allOps({
                            model: capitalize(model),
                            operation,
                            args: args ?? {},
                            query: async (finalArgs: unknown) => record(model, operation, finalArgs),
                          });
                      },
                    }
                  );
                },
              }
            );
          };
        }
        if (prop === "$transaction") {
          return (arg: unknown) =>
            typeof arg === "function" ? (arg as (tx: unknown) => unknown)(txClient) : Promise.all(arg as Promise<unknown>[]);
        }
        if (prop === "$executeRaw") return async () => 0;
        return makeDelegate((op, args) => record(prop, op, args));
      },
    }
  );
  return { prisma, records };
}
