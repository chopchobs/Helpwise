"use client";

/**
 * AttachmentPicker — ปุ่ม "แนบไฟล์" + แสดง chip ของไฟล์ที่เลือกไว้รอส่ง
 * ใช้ร่วมกันระหว่าง agent และ portal reply box
 * client-side validate (mime/size) ก่อนเพิ่มเข้า list — แจ้งทันทีถ้าเกินลิมิต
 */

import { useRef } from "react";
import { Paperclip, X } from "lucide-react";
import {
  MAX_ATTACHMENT_FILES,
  formatFileSize,
  validateAttachmentFile,
} from "@/lib/attachment-upload";
import { iconForMime } from "@/components/ui/AttachmentList";

interface AttachmentPickerProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  onValidationError: (message: string) => void;
  isDisabled: boolean;
}

export default function AttachmentPicker({
  files,
  onFilesChange,
  onValidationError,
  isDisabled,
}: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFilesSelected(selected: FileList | null) {
    if (!selected) return;

    const next = [...files];
    for (const file of Array.from(selected)) {
      if (next.length >= MAX_ATTACHMENT_FILES) {
        onValidationError(`แนบได้สูงสุด ${MAX_ATTACHMENT_FILES} ไฟล์ต่อข้อความ`);
        break;
      }
      const validationError = validateAttachmentFile(file);
      if (validationError) {
        onValidationError(validationError);
        continue;
      }
      next.push(file);
    }

    onFilesChange(next);
    // reset value เพื่อให้เลือกไฟล์เดิมซ้ำได้
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleRemove(index: number) {
    onFilesChange(files.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => handleFilesSelected(e.target.files)}
          disabled={isDisabled}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={isDisabled}
          aria-label="แนบไฟล์"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-secondary hover:bg-stone hover:text-foreground bg-surface transition-colors focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Paperclip size={14} aria-hidden="true" />
          แนบไฟล์
        </button>
      </div>

      {/* chips ของไฟล์ที่เลือกรอส่ง */}
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((file, index) => {
            const Icon = iconForMime(file.type);
            return (
              <li
                key={`${file.name}-${file.size}-${index}`}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-border bg-stone text-xs"
              >
                <Icon size={12} className="text-primary shrink-0" aria-hidden="true" />
                <span className="text-foreground truncate max-w-[10rem]">{file.name}</span>
                <span className="text-muted shrink-0">{formatFileSize(file.size)}</span>
                <button
                  type="button"
                  onClick={() => handleRemove(index)}
                  disabled={isDisabled}
                  aria-label={`ลบไฟล์ ${file.name}`}
                  className="text-muted hover:text-danger focus:outline-none focus:ring-2 focus:ring-primary rounded-full disabled:opacity-50"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
