/**
 * TagChip — แสดง tag เป็น chip (พื้น tint + ชื่อ) ตาม TagColor
 * ใช้ static class mapping เพื่อให้ Tailwind v4 เห็น class ทั้งหมดตอน build
 * prop onRemove (optional) — แสดงปุ่ม X เมื่อมี prop นี้ (เช่น ใน picker)
 */

import { X } from "lucide-react";
import type { TagDTO, TagColor } from "@/types/tag";

// =============================================================================
// COLOR MAPPING — static record (Tailwind ต้องเห็น literal class เต็ม ไม่ใช่ dynamic)
// =============================================================================

/** map TagColor → Tailwind class ของ chip (พื้น tint + text ink ผ่าน AA) */
const TAG_COLOR_CLASSES: Record<TagColor, string> = {
  GRAY:       "bg-stone text-secondary border-border",
  TERRACOTTA: "bg-primary-tint text-primary-ink border-primary-tint",
  SAGE:       "bg-success-tint text-success border-success-tint",
  AMBER:      "bg-warning-tint text-warning-ink border-warning-tint",
  SIENNA:     "bg-danger-tint text-danger border-danger-tint",
  SAND:       "bg-sand-tint text-sand-ink border-sand-tint",
};

// =============================================================================
// TYPES
// =============================================================================

interface TagChipProps {
  tag: TagDTO;
  /** ถ้ามี prop นี้จะแสดงปุ่ม X และ chip เป็น interactive */
  onRemove?: (tagId: string) => void;
  /** disable ปุ่ม X ระหว่าง loading */
  isRemoving?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

function TagChip({ tag, onRemove, isRemoving }: TagChipProps) {
  const colorClass = TAG_COLOR_CLASSES[tag.color];

  return (
    <span
      className={[
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border",
        colorClass,
      ].join(" ")}
    >
      {tag.name}

      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(tag.id)}
          disabled={isRemoving}
          aria-label={`ถอด tag ${tag.name}`}
          className="ml-0.5 rounded-full p-0.5 hover:opacity-70 focus:outline-none focus:ring-1 focus:ring-current disabled:cursor-not-allowed disabled:opacity-40 transition-opacity"
        >
          <X size={10} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export default TagChip;
