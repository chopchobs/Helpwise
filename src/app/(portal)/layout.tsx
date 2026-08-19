/**
 * Portal Layout — server component ที่ inject tenant branding + render header ถาวรของ portal
 *
 * การทำงาน:
 * 1. ดึง tenant context จาก middleware headers (getTenantContext)
 * 2. Query Tenant (name เสมอ, settings ใช้เมื่อ branding เปิด) แล้ว parse ผ่าน parseBranding
 * 3. ตรวจ feature custom_branding ผ่าน hasFeature()
 * 4. inject CSS custom property เฉพาะเมื่อ brandingEnabled + มีค่า
 * 5. อ่าน contact session (ถ้ามี) เพื่อส่งชื่อผู้ใช้ให้ PortalHeader
 *
 * ⚠️ header แสดงเสมอ (ไม่ผูกกับ branding อีกต่อไป) — จึงต้อง query ชื่อ tenant
 *    แม้ tenant ไม่ได้เปิด custom_branding. ส่วนโลโก้/สี ยังผูกกับ feature gate เหมือนเดิมทุกประการ
 */

// Server Component (ไม่มี "use client") — ดึงข้อมูลได้ฝั่ง server โดยตรง
import React from "react";
import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant";
import { parseBranding } from "@/lib/branding";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { requireContact } from "@/lib/auth";
import PortalHeader from "@/components/portal/PortalHeader";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // ค่า branding default เมื่อ feature ปิด, ไม่มีค่า, หรือ error
  let logoUrl: string | null = null;
  let accentColor: string | null = null;
  let tenantName: string | null = null;
  let brandingEnabled = false;

  try {
    // 1. อ่าน tenant context จาก headers ที่ middleware verify แล้ว
    //    getTenantContext() throw ถ้าไม่อยู่ใต้ tenant subdomain (เช่น localhost:3000 ตรง)
    const ctx = await getTenantContext();

    // 2. ตรวจ feature gate สำหรับโลโก้/สี (ไม่ใช่สำหรับตัว header — header แสดงเสมอ)
    brandingEnabled = await hasFeature(
      ctx.tenantId,
      FEATURE_KEYS.CUSTOM_BRANDING,
      ctx.plan
    );

    // 3. Query Tenant — ใช้ base prisma (Tenant ไม่มี tenantId column)
    //    where: { id: ctx.tenantId } ที่มาจาก verified middleware context เสมอ
    //    ⚠️ query เสมอ (ไม่ short-circuit ตาม brandingEnabled แล้ว) เพราะ header
    //       ต้องใช้ชื่อ tenant เป็น fallback เมื่อไม่มีโลโก้
    const tenant = await prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { settings: true, name: true },
    });

    if (tenant) {
      tenantName = tenant.name;

      // 4. parse branding ผ่าน shared helper — ค่าผ่าน validator แล้ว (https-only, hex-only)
      //    ไม่ parse ด้วยตัวเอง — reuse parseBranding เพื่อป้องกัน double-validation drift
      //    อ่านค่าเฉพาะเมื่อ feature เปิด — tenant ที่ไม่ได้ซื้อ ห้ามได้โลโก้/สีของตัวเอง
      if (brandingEnabled) {
        const branding = parseBranding(tenant.settings);
        logoUrl = branding.logoUrl;
        accentColor = branding.accentColor;
      }
    }
  } catch (err) {
    // ไม่อยู่ใต้ tenant subdomain หรือ DB error → fallback gracefully (render default look)
    // log ไว้เพื่อ observability — DB error ที่ทำให้ branding หายเงียบ ๆ ต้องเห็นใน log
    // (portal อยู่ใต้ subdomain เสมอ → throw ที่นี่ถือว่าผิดปกติ ควรสืบ)
    console.error(
      "[PortalLayout] branding read failed:",
      err instanceof Error ? err.message : String(err)
    );
    brandingEnabled = false;
  }

  // 5. อ่าน contact session สำหรับแสดงชื่อผู้ใช้ + ปุ่มออกจากระบบใน header
  //    แยก try/catch จาก branding — session หมดอายุเป็นเรื่องปกติ ไม่ใช่ error ที่ต้อง log
  //    requireContact() throw AuthError(401) เมื่อไม่มี/หมดอายุ → contactLabel = null
  //    ⚠️ ใช้เพื่อ "แสดงผล" เท่านั้น — การ authorize ข้อมูลจริงยังทำที่ API route ทุกครั้ง
  let contactLabel: string | null = null;
  try {
    const { contact } = await requireContact();
    contactLabel = contact.name ?? contact.email;
  } catch {
    contactLabel = null;
  }

  // กำหนดว่า inject branding ได้หรือเปล่า (feature on + มีค่าอย่างน้อยหนึ่งอย่าง)
  const shouldInjectBranding = brandingEnabled && (accentColor !== null || logoUrl !== null);

  // 6. inject CSS custom property สำหรับ accent color
  //    accentColor ผ่าน /^#[0-9a-fA-F]{6}$/ validator จาก parseBranding แล้ว — safe
  //    inject เฉพาะ primary group: primary, primary-hover, primary-strong, primary-strong-hover
  //    เพื่อให้ portal CTAs/links/buttons รับ brand color ของ tenant อัตโนมัติ
  //    ใช้ type assertion `as React.CSSProperties` เพราะ TypeScript interface ไม่รู้จัก CSS custom prop
  const brandingStyle =
    shouldInjectBranding && accentColor
      ? ({
          // override CSS custom property ทุก primary variant ให้เป็น tenant accent color
          // --color-primary-hover/-strong/-strong-hover ใช้ค่าเดียวกันเพื่อ consistency
          // (portal ไม่ต้องการ palette ซับซ้อน — แค่ให้สีหลักตรงกับ brand tenant)
          "--color-primary": accentColor,
          "--color-primary-hover": accentColor,
          "--color-primary-strong": accentColor,
          "--color-primary-strong-hover": accentColor,
          "--color-primary-ink": accentColor,
        } as React.CSSProperties)
      : undefined;

  return (
    // flex column + min-h-screen ที่ระดับ layout — หน้าลูกใช้ flex-1 แทน min-h-screen ของตัวเอง
    // (ถ้าลูกยังใช้ min-h-screen จะกลายเป็น header + 100vh → scrollbar ปลอมทุกหน้า)
    <div className="min-h-screen flex flex-col bg-background" style={brandingStyle}>
      {/*
       * โลโก้ส่งเข้า header เฉพาะเมื่อ branding ใช้งานได้จริง —
       * tenant ที่ปิด custom_branding ยังเห็น header แต่เป็นชื่อ tenant แบบ text
       */}
      <PortalHeader
        tenantName={tenantName}
        logoUrl={shouldInjectBranding ? logoUrl : null}
        contactLabel={contactLabel}
      />
      <main className="flex-1 flex flex-col">{children}</main>
    </div>
  );
}
