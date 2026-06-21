# Helpwise — Landing Page Outline (Phase 30 spec)

> หน้านี้อยู่ใน `app/(marketing)/` — **public root domain (ไม่มี tenant context)** ไม่แตะ tenant isolation
> เป้าหมายสองชั้น: (1) ดูเป็น SaaS product จริง · (2) โชว์ engineering depth ให้ recruiter ที่กดดูลึก
> Palette: ใช้ design token เดิม (sand/terracotta) · ห้าม hardcode hex · semantic class เท่านั้น

---

## ผู้อ่าน 2 กลุ่ม (ออกแบบให้ตอบทั้งคู่)

| กลุ่ม | อยากเห็นอะไร | ตอบด้วย section ไหน |
|---|---|---|
| **Recruiter / HR (30 วิ)** | นี่คือโปรเจกต์จริงไหม · กดเล่นได้ไหม · ทำอะไรเป็น | Hero + Live Demo CTA + Tech strip |
| **Engineer (กดดูลึก)** | สถาปัตยกรรม · multi-tenant · code | "Under the hood" + GitHub + architecture diagram |

---

## โครงหน้า (บนลงล่าง)

### 1. Nav bar (sticky)
- ซ้าย: logo "Helpwise"
- กลาง: `Features` · `AI` · `How it works` · `Pricing`
- ขวา: `View on GitHub` (icon) · `Sign in` · **`Try live demo`** (ปุ่มหลัก terracotta)
- *Note:* `Try live demo` = ตัวชูโรง ต้องเด่นสุด

### 2. Hero
- **Headline:** "The multi-tenant help desk your customers never see coming."
  - ทางเลือก: "Support software that keeps every customer's world completely separate."
- **Subhead:** "Helpwise gives B2B teams a shared inbox, SLA tracking, and AI-assisted replies — with airtight tenant isolation baked in at the database level."
- **CTA หลัก:** `Try the live demo →` · **CTA รอง:** `View on GitHub`
- **Visual:** screenshot ของ agent workspace (ticket list + AI summary panel) — โชว์ของจริง ไม่ใช่ stock
- **Trust line เล็ก ๆ ใต้ปุ่ม:** "Two demo workspaces ready to explore — acme & globex"

### 3. Tech strip (ทำหน้าที่ social proof + โชว์ stack)
- บรรทัดเดียว logo เรียง: Next.js · TypeScript · PostgreSQL · Prisma · Redis · Stripe · Anthropic
- หัวข้อเล็ก: "Built on a modern, production-grade stack"
- *ทำไม:* recruiter เห็น stack ใน 2 วิ + ดูน่าเชื่อถือ

### 4. Core features (grid 3-4 การ์ด)
หัวข้อ: "Everything a support team needs"
- **Shared ticketing** — agent + customer portal, internal notes ที่ลูกค้าไม่มีวันเห็น
- **SLA tracking** — first-response & resolution timers ตาม business hours, breach alerts
- **Email in & out** — ลูกค้าเมลเข้า กลายเป็น ticket อัตโนมัติ (threading + idempotent)
- **Customer self-service portal** — per-tenant branding, ลูกค้าเห็นเฉพาะ ticket ของตัวเอง
- แต่ละการ์ด: icon (lucide) + หัวข้อ 1 บรรทัด + คำอธิบาย 1-2 ประโยค

### 5. ⭐ AI section (spotlight — ตัวชูโรง)
หัวข้อ: "AI that drafts, summarizes, and tags — your agents stay in control."
- 3 ฟีเจอร์ (จาก Phase 29): **Summarize thread** · **Suggest reply (draft)** · **Auto-tag**
- จุดขายสำคัญ (ใส่เป็น badge/บรรทัดเด่น): **"Suggestions only — never auto-sent. Your data never leaves your tenant's context."**
  - *ทำไม:* โชว์ทั้ง AI capability + ความเข้าใจเรื่อง safety/trust (จุดที่ engineer ประทับใจ)
- Visual: gif/mockup ปุ่ม "Summarize with AI" → panel เด้ง

### 6. 🔒 Multi-tenancy section (เปลี่ยน engineering เป็น selling point)
หัวข้อ: "True isolation. Not just a `WHERE` clause."
- 3 จุด:
  - **Subdomain per tenant** — `acme.gethelpwise.xyz` · per-tenant branding
  - **Defense in depth** — app-level scoping + PostgreSQL Row-Level Security
  - **Two audiences, never mixed** — agents & customers ใช้ auth คนละเส้น
- *ทำไม:* customer มอง = ปลอดภัย · recruiter มอง = "คนนี้เข้าใจ multi-tenant ลึกระดับ senior"
- (ลิงก์เล็ก ๆ: "See the architecture ↓" → ไป section 9)

### 7. How it works (3 steps)
หัวข้อ: "Live in three steps"
1. **Spin up your workspace** — get your subdomain + branding
2. **Agents handle tickets** — shared inbox, SLA, AI assist
3. **Customers self-serve** — branded portal, see only their own tickets
- รูปแบบ: timeline/stepper แนวนอน มี icon ต่อ step

### 8. Pricing (โชว์ feature-gating ที่ build ไว้)
หัวข้อ: "Plans that grow with you"
- 3 tier: **Free** · **Pro** · **Enterprise**
- ตารางเทียบ: agent seats · SLA policies · AI assist · API access · custom branding
- *ทำไม:* โชว์ว่าเข้าใจ SaaS monetization + entitlement system (`hasFeature()`/plans) ที่ทำจริง
- ปุ่มแต่ละ tier → `Try demo` (ไม่ต้องมี payment จริงสำหรับ portfolio)

### 9. 🛠️ Under the hood (section เฉพาะ portfolio — ทรงพลังสุดสำหรับ recruiter)
หัวข้อ: "Built by an engineer who sweats the details."
- ฝัง **architecture diagram** (`helpwise-architecture.svg` ที่ทำไว้แล้ว)
- bullets สั้น ๆ: "27+ phases, each on its own branch · Definition-of-Done gated reviews · multi-tenant from day one · AI with tenant-scoped prompts + prompt-injection defense"
- ปุ่ม: **`Read the architecture →`** (ไป README/docs) · **`View source on GitHub →`**
- *ทำไม:* นี่คือจุดที่ recruiter ตัดสินใจเรียกสัมภาษณ์ — เปลี่ยน "แอปสวย" เป็น "วิศวกรตัวจริง"

### 10. Final CTA (band เต็มความกว้าง สี terracotta)
- **Headline:** "See it in action."
- ปุ่มคู่: **`Try the live demo`** · `View on GitHub`

### 11. Footer
- คอลัมน์: Product (Features/AI/Pricing) · Resources (Docs/Architecture/API reference) · Project (GitHub/About)
- บรรทัดล่าง: "A portfolio project demonstrating production-grade multi-tenant SaaS architecture." + ปี+ ชื่อคุณ + GitHub link

---

## Demo entry strategy (สำคัญต่อ portfolio)

ปุ่ม `Try live demo` ควรพาไป **demo ที่กดเล่นได้จริงโดยไม่ต้องสมัคร**:
- Seed 2 tenant: `acme` (มี logo/สีของตัวเอง) + `globex` → โชว์ multi-tenant + per-tenant branding ชัด
- Demo login สำเร็จรูป (ปุ่ม "Log in as demo agent") — recruiter ไม่ต้องกรอกอะไร
- ใส่ ticket ตัวอย่าง 5-10 ใบ/tenant (มี internal note, SLA ใกล้ครบ, ticket หลายสถานะ) เพื่อให้ AI summarize/suggest มีของจริงให้เล่น
- *ถ้า AI key มี:* ปุ่ม AI ใช้งานได้จริงใน demo = ว้าวสุด

---

## หมายเหตุสำหรับตอน build (Phase 30)

- หน้านี้ไม่มี tenant context → ไม่ inject guardrails tenant แต่ยังต้อง: ใช้ design token (ห้าม hardcode hex), function declaration, responsive, a11y (semantic + contrast AA)
- Performance: landing คือหน้าแรก → LCP/CLS สำคัญ (optimize รูป hero, lazy งานหนัก)
- แยกเป็น vertical slice ได้: (1) hero + nav + CTA โครง → (2) feature/AI/multi-tenancy sections → (3) pricing + under-the-hood + footer → (4) demo seed + demo-login entry
- Slice ที่คุ้มสุดต่อ portfolio: **hero + AI section + under-the-hood + demo entry** (ถ้าเวลาจำกัด เน้น 4 อันนี้)
