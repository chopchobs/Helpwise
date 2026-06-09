/**
 * Portal Layout — server component ที่ inject tenant branding เข้า portal
 *
 * การทำงาน:
 * 1. ดึง tenant context จาก middleware headers (getTenantContext)
 * 2. Query Tenant.settings แล้ว parse ผ่าน parseBranding (validated upstream)
 * 3. ตรวจ feature custom_branding ผ่าน hasFeature()
 * 4. inject CSS custom property เฉพาะเมื่อ brandingEnabled + มีค่า
 *
 * ไม่ต้องการ contact auth — tenant context มาจาก subdomain header ที่ middleware verify
 */

// Server Component (ไม่มี "use client") — ดึงข้อมูลได้ฝั่ง server โดยตรง
import React from "react";
import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant";
import { parseBranding } from "@/lib/branding";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";

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

    // 2. ตรวจ feature gate ก่อน query settings เพื่อ short-circuit ถ้าปิด
    brandingEnabled = await hasFeature(
      ctx.tenantId,
      FEATURE_KEYS.CUSTOM_BRANDING,
      ctx.plan
    );

    if (brandingEnabled) {
      // 3. Query Tenant settings — ใช้ base prisma (Tenant ไม่มี tenantId column)
      //    where: { id: ctx.tenantId } ที่มาจาก verified middleware context เสมอ
      const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { settings: true, name: true },
      });

      if (tenant) {
        tenantName = tenant.name;

        // 4. parse branding ผ่าน shared helper — ค่าผ่าน validator แล้ว (https-only, hex-only)
        //    ไม่ parse ด้วยตัวเอง — reuse parseBranding เพื่อป้องกัน double-validation drift
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

  // กำหนดว่า inject branding ได้หรือเปล่า (feature on + มีค่าอย่างน้อยหนึ่งอย่าง)
  const shouldInjectBranding = brandingEnabled && (accentColor !== null || logoUrl !== null);

  // 5. inject CSS custom property สำหรับ accent color
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
    <div className="min-h-screen bg-background" style={brandingStyle}>
      {/* Header bar แสดงโลโก้ tenant เฉพาะเมื่อ branding เปิดและมี logoUrl */}
      {shouldInjectBranding && logoUrl && (
        <header className="bg-surface border-b border-border px-4 py-3 flex items-center">
          {/*
           * ใช้ <img> ตรง ๆ ไม่ผ่าน next/image — project convention:
           * next/image optimizer อาจ SSRF ผ่าน /_next/image?url= endpoint
           * logoUrl ผ่าน https-only validator จาก parseBranding แล้ว (SSRF mitigation layer 1)
           * referrerPolicy="no-referrer" กัน tenant URL รั่วไปยัง 3rd-party server (defense-in-depth)
           */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoUrl}
            alt={tenantName ? `${tenantName} logo` : "Logo"}
            referrerPolicy="no-referrer"
            className="h-8 w-auto object-contain"
          />
        </header>
      )}
      {children}
    </div>
  );
}
