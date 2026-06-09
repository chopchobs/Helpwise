/**
 * Shared helper สำหรับ SLA policy routes — กัน toDTO ซ้ำระหว่าง route.ts กับ [id]/route.ts
 */

import type { SlaPolicyDTO } from "@/types/sla-policy";

/** shape ของ Prisma SlaPolicy row ที่ toDTO ต้องการ (รองรับ _count optional) */
export interface SlaPolicyRow {
  id: string;
  name: string;
  isDefault: boolean;
  firstResponseLowMin: number;
  firstResponseNormMin: number;
  firstResponseHighMin: number;
  firstResponseUrgMin: number;
  resolutionLowMin: number;
  resolutionNormMin: number;
  resolutionHighMin: number;
  resolutionUrgMin: number;
  createdAt: Date;
  updatedAt: Date;
  _count?: { tickets: number };
}

/** แปลง Prisma SlaPolicy row เป็น SlaPolicyDTO (Date → ISO string) */
export function toDTO(row: SlaPolicyRow): SlaPolicyDTO {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    firstResponseLowMin: row.firstResponseLowMin,
    firstResponseNormMin: row.firstResponseNormMin,
    firstResponseHighMin: row.firstResponseHighMin,
    firstResponseUrgMin: row.firstResponseUrgMin,
    resolutionLowMin: row.resolutionLowMin,
    resolutionNormMin: row.resolutionNormMin,
    resolutionHighMin: row.resolutionHighMin,
    resolutionUrgMin: row.resolutionUrgMin,
    ticketCount: row._count?.tickets,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
