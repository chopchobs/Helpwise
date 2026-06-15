"use client";

/**
 * AttachmentList — แสดงรายการไฟล์แนบของ message พร้อม download
 * ใช้ร่วมกันระหว่าง agent และ portal — รับ downloadEndpointBase เป็น param
 * (agent: /api/attachments, portal: /api/portal/attachments)
 */

import { useState } from "react";
import { File, FileText, Image as ImageIcon, Paperclip, RefreshCw } from "lucide-react";
import { formatFileSize } from "@/lib/attachment-upload";
import type { AttachmentDTO, AttachmentDownloadResponse } from "@/types/attachment";
import type { LucideIcon } from "lucide-react";

interface AttachmentListProps {
  attachments: AttachmentDTO[];
  /** base path ของ download endpoint — agent: /api/attachments, portal: /api/portal/attachments */
  downloadEndpointBase: string;
}

/** เลือก icon ตาม mimeType — รูป → Image, pdf/text → FileText, อื่น ๆ → File */
export function iconForMime(mimeType: string): LucideIcon {
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return FileText;
  return File;
}

export default function AttachmentList({ attachments, downloadEndpointBase }: AttachmentListProps) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function handleDownload(attachmentId: string) {
    if (downloadingId) return;
    setDownloadingId(attachmentId);
    setDownloadError(null);

    try {
      const res = await fetch(`${downloadEndpointBase}/${attachmentId}`, {
        credentials: "include",
      });
      const json = (await res.json()) as AttachmentDownloadResponse;

      if (!res.ok || json.error || !json.data) {
        setDownloadError("ไม่สามารถเปิดไฟล์ได้ กรุณาลองใหม่");
        return;
      }

      window.open(json.data.url, "_blank");
    } catch {
      setDownloadError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setDownloadingId(null);
    }
  }

  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 mt-2">
      {attachments.map((attachment) => {
        const Icon = iconForMime(attachment.mimeType);
        const isDownloading = downloadingId === attachment.id;

        return (
          <button
            key={attachment.id}
            type="button"
            onClick={() => void handleDownload(attachment.id)}
            disabled={isDownloading}
            className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border bg-surface text-left text-xs hover:bg-stone transition-colors focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 max-w-full"
          >
            {isDownloading ? (
              <RefreshCw size={14} className="text-secondary shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <Icon size={14} className="text-primary shrink-0" aria-hidden="true" />
            )}
            <span className="text-foreground truncate">{attachment.fileName}</span>
            <span className="text-muted shrink-0">{formatFileSize(attachment.fileSize)}</span>
          </button>
        );
      })}
      {downloadError && (
        <p className="text-xs text-danger flex items-center gap-1">
          <Paperclip size={10} aria-hidden="true" />
          {downloadError}
        </p>
      )}
    </div>
  );
}
