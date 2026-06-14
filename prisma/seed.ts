/**
 * prisma/seed.ts
 * Seed global reference data สำหรับ Helpwise
 *
 * รัน: npx prisma db seed  (หรือ npx tsx prisma/seed.ts)
 *
 * idempotent: ใช้ upsert ทุก record — รันซ้ำได้ปลอดภัย ไม่สร้าง duplicate
 * ราคาทุกค่าเป็น Int (satang) — ห้าม Float ตาม billing rules
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// สร้าง PrismaClient ตรงใน seed โดยไม่ import @/lib/prisma
// เพราะ tsx runner ไม่ resolve path alias @/ ของ Next.js
function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — กรุณาตั้งค่าใน .env");
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

// === Plans ===
// price เป็น satang (บาท × 100)
// 0 = unlimited สำหรับ maxAgents / maxSlaPolicies ตาม schema comment
const PLANS = [
  {
    name: "starter",
    displayName: "Starter",
    pricePerMonth: 0, // ฟรี
    pricePerYear: 0,
    maxAgents: 3,
    maxSlaPolicies: 1,
    features: [] as string[], // starter ไม่รวม feature พิเศษ
    // Stripe Price IDs — null จนกว่าจะผูก Price จาก Stripe Dashboard
    stripePriceIdMonthly: null as string | null,
    stripePriceIdYearly: null as string | null,
    isActive: true,
  },
  {
    name: "pro",
    displayName: "Pro",
    pricePerMonth: 99000, // ฿990/เดือน
    pricePerYear: 990000, // ฿9,900/ปี (~2 เดือนฟรี)
    maxAgents: 15,
    maxSlaPolicies: 5,
    features: ["sla_policies", "csat_survey", "custom_branding"],
    stripePriceIdMonthly: null as string | null,
    stripePriceIdYearly: null as string | null,
    isActive: true,
  },
  {
    name: "enterprise",
    displayName: "Enterprise",
    pricePerMonth: 299000, // ฿2,990/เดือน
    pricePerYear: 2990000, // ฿29,900/ปี (~2 เดือนฟรี)
    maxAgents: 0, // 0 = unlimited
    maxSlaPolicies: 0, // 0 = unlimited
    features: ["sla_policies", "csat_survey", "custom_branding", "api_access"],
    stripePriceIdMonthly: null as string | null,
    stripePriceIdYearly: null as string | null,
    isActive: true,
  },
] as const;

// === Feature Flags ===
// defaultEnabled + requiredPlan กำหนด tier ขั้นต่ำ
// null = ไม่ gate ตาม plan
const FEATURE_FLAGS = [
  {
    key: "sla_policies",
    description: "SLA policies with custom response/resolution times per priority",
    defaultEnabled: false,
    requiredPlan: "pro" as string | null,
  },
  {
    key: "csat_survey",
    description: "Customer satisfaction survey sent after ticket is resolved",
    defaultEnabled: true,
    requiredPlan: null as string | null,
  },
  {
    key: "custom_branding",
    description: "Custom logo and accent color on customer portal",
    defaultEnabled: false,
    requiredPlan: "pro" as string | null,
  },
  {
    key: "api_access",
    description: "REST API access for integrations and automation",
    defaultEnabled: false,
    requiredPlan: "enterprise" as string | null,
  },
  {
    key: "analytics",
    description: "Reporting and analytics dashboard with KPIs, trends, and breakdowns",
    defaultEnabled: false,
    requiredPlan: "pro" as string | null,
  },
] as const;

async function main(): Promise<void> {
  const db = createClient();

  try {
    console.log("--- Helpwise DB Seed เริ่มต้น ---\n");

    // ---- Seed Plans ----
    console.log("Seeding Plans...");
    let planCount = 0;
    for (const plan of PLANS) {
      await db.plan.upsert({
        where: { name: plan.name },
        update: {
          displayName: plan.displayName,
          pricePerMonth: plan.pricePerMonth,
          pricePerYear: plan.pricePerYear,
          maxAgents: plan.maxAgents,
          maxSlaPolicies: plan.maxSlaPolicies,
          features: [...plan.features],
          // stripePriceId* ไม่ overwrite หาก set ไว้แล้ว (ป้องกัน seed ล้างค่าที่ผูกจาก Dashboard)
          // ใช้ undefined แทน null เพื่อให้ Prisma ข้าม field นี้ในคำสั่ง UPDATE
          stripePriceIdMonthly: plan.stripePriceIdMonthly ?? undefined,
          stripePriceIdYearly: plan.stripePriceIdYearly ?? undefined,
          isActive: plan.isActive,
        },
        create: {
          name: plan.name,
          displayName: plan.displayName,
          pricePerMonth: plan.pricePerMonth,
          pricePerYear: plan.pricePerYear,
          maxAgents: plan.maxAgents,
          maxSlaPolicies: plan.maxSlaPolicies,
          features: [...plan.features],
          stripePriceIdMonthly: plan.stripePriceIdMonthly,
          stripePriceIdYearly: plan.stripePriceIdYearly,
          isActive: plan.isActive,
        },
      });
      console.log(`  [ok] Plan: ${plan.name} (${plan.displayName})`);
      planCount++;
    }

    // ---- Seed Feature Flags ----
    console.log("\nSeeding FeatureFlags...");
    let flagCount = 0;
    for (const flag of FEATURE_FLAGS) {
      await db.featureFlag.upsert({
        where: { key: flag.key },
        update: {
          description: flag.description,
          defaultEnabled: flag.defaultEnabled,
          requiredPlan: flag.requiredPlan,
        },
        create: {
          key: flag.key,
          description: flag.description,
          defaultEnabled: flag.defaultEnabled,
          requiredPlan: flag.requiredPlan,
        },
      });
      console.log(`  [ok] FeatureFlag: ${flag.key} (defaultEnabled=${flag.defaultEnabled}, requiredPlan=${flag.requiredPlan ?? "none"})`);
      flagCount++;
    }

    console.log(`\n--- Seed สำเร็จ ---`);
    console.log(`  Plans seeded   : ${planCount}`);
    console.log(`  FeatureFlags seeded: ${flagCount}`);
  } finally {
    // ปิด connection ทุกกรณี (ทั้ง success และ error)
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("Seed ล้มเหลว:", err);
  process.exit(1);
});
