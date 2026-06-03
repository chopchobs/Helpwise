"use client";

/**
 * หน้า Create Ticket (agent) — form สร้าง ticket ใหม่ฝั่ง agent
 *
 * Requester combobox ทำงาน 2 โหมด:
 *   1. เลือก contact เดิม → ส่ง requesterContactId
 *   2. พิมพ์อีเมลใหม่ (ไม่ตรงใคร) → ส่ง requesterEmail + requesterName (optional)
 *
 * Assignee dropdown: โหลด members จาก GET /api/members
 * หลัง submit สำเร็จ → redirect ไป /tickets/:id
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Search, Check, Loader2 } from "lucide-react";
import FormAlert from "@/components/ui/FormAlert";
import FormButton from "@/components/ui/FormButton";
import FormInput from "@/components/ui/FormInput";
import type {
  AgentCreateTicketResponse,
  TicketPriority,
  MemberListItem,
  MembersResponse,
  ContactListItem,
  ContactsResponse,
} from "@/types/ticket";

// =============================================================================
// VALIDATION SCHEMA (sync กับ backend constraint)
// =============================================================================

// subject: min(3).max(200), firstMessage.body: min(1).max(50000)
const createTicketSchema = z.object({
  subject: z
    .string()
    .min(3, "หัวข้อต้องมีอย่างน้อย 3 ตัวอักษร")
    .max(200, "หัวข้อยาวเกิน 200 ตัวอักษร"),
  // ใช้ requesterEmail แค่เป็นช่องค้นหา/input — validation จริงทำใน submit handler
  requesterEmail: z
    .string()
    .max(254, "อีเมลยาวเกินไป")
    .optional()
    .or(z.literal("")),
  requesterName: z.string().max(200, "ชื่อยาวเกินไป").optional().or(z.literal("")),
  // ใช้ z.enum ไม่มี .default() — set default ผ่าน useForm defaultValues แทน เพื่อหลีกเลี่ยง type mismatch
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
  firstMessage: z
    .string()
    .max(50000, "ข้อความยาวเกิน 50,000 ตัวอักษร")
    .optional()
    .or(z.literal("")),
});

type CreateTicketFormValues = z.infer<typeof createTicketSchema>;

// =============================================================================
// CONSTANTS
// =============================================================================

const PRIORITY_OPTIONS: { value: TicketPriority; label: string }[] = [
  { value: "LOW", label: "ต่ำ" },
  { value: "NORMAL", label: "ปกติ" },
  { value: "HIGH", label: "สูง" },
  { value: "URGENT", label: "เร่งด่วน" },
];

// ตาม backend error code
const ERROR_MESSAGES: Record<string, string> = {
  CONTACT_NOT_FOUND: "ไม่พบ contact นี้ในระบบ กรุณาตรวจสอบอีเมล",
  ASSIGNEE_NOT_FOUND: "ไม่พบ agent ที่เลือก กรุณาเลือกใหม่",
  VALIDATION_ERROR: "ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
  UNAUTHORIZED: "กรุณา login ก่อนใช้งาน",
};

// debounce delay สำหรับ contact search (ms)
const DEBOUNCE_MS = 300;

// =============================================================================
// SUB-COMPONENT: RequesterCombobox
// =============================================================================

interface RequesterComboboxProps {
  onSelectContact: (contact: ContactListItem | null) => void;
  onEmailChange: (email: string) => void;
  onNameChange: (name: string) => void;
  selectedContact: ContactListItem | null;
  emailError?: string;
}

/**
 * RequesterCombobox — input + dropdown list สำหรับเลือก/กรอก requester
 * - พิมพ์ → debounced search GET /api/contacts?q=
 * - เลือก suggestion → set selectedContact (ส่ง requesterContactId)
 * - พิมพ์อีเมลใหม่ที่ไม่มีใน suggestion → ส่ง requesterEmail
 * - แสดง visual ชัดเจนว่ากำลัง "สร้างใหม่" หรือ "เลือกคนเดิม"
 */
function RequesterCombobox({
  onSelectContact,
  onEmailChange,
  onNameChange,
  selectedContact,
  emailError,
}: RequesterComboboxProps) {
  const [query, setQuery] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [suggestions, setSuggestions] = useState<ContactListItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // AbortController สำหรับยกเลิก fetch ที่ค้างอยู่เมื่อ search ใหม่เข้ามา
  const abortRef = useRef<AbortController | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ปิด dropdown เมื่อคลิกนอก
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // FIX-1: clear debounce timer เมื่อ unmount — ป้องกัน setState บน unmounted component
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // FIX-2: ยกเลิก fetch ที่ค้างอยู่ด้วย
      abortRef.current?.abort();
    };
  }, []);

  // debounced search contacts
  // FIX-2: ใช้ AbortController แทน sequence counter — ยกเลิก request เก่าทั้งหมดทันที
  // เมื่อ search ใหม่เข้ามา แทนที่จะรอ response แล้วค่อย discard
  const searchContacts = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    // ยกเลิก request ที่ยังค้างอยู่ก่อนเริ่ม request ใหม่
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    try {
      const params = new URLSearchParams({ q: q.trim(), limit: "10" });
      const res = await fetch(`/api/contacts?${params.toString()}`, {
        credentials: "include",
        signal: controller.signal,
      });
      const json = (await res.json()) as ContactsResponse;
      if (res.ok && json.data) {
        setSuggestions(json.data.contacts);
        setIsOpen(true);
      } else {
        setSuggestions([]);
      }
    } catch (err) {
      // AbortError คือ request ถูกยกเลิกโดยตั้งใจ — ไม่ต้อง update state
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSuggestions([]);
    } finally {
      // ตรวจก่อน setIsSearching เพื่อหลีกเลี่ยง update บน request ที่ถูก abort แล้ว
      if (!controller.signal.aborted) setIsSearching(false);
    }
  }, []);

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    // เคลียร์ selectedContact เมื่อผู้ใช้แก้ไข input
    onSelectContact(null);
    onEmailChange(val);

    // debounce การค้นหา
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void searchContacts(val);
    }, DEBOUNCE_MS);
  }

  function handleSelect(contact: ContactListItem) {
    setQuery(contact.email);
    onSelectContact(contact);
    onEmailChange(contact.email);
    setSuggestions([]);
    setIsOpen(false);
  }

  function handleClear() {
    setQuery("");
    setNameInput("");
    onSelectContact(null);
    onEmailChange("");
    onNameChange("");
    setSuggestions([]);
    setIsOpen(false);
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    setNameInput(e.target.value);
    onNameChange(e.target.value);
  }

  // โหมด "เลือกคนเดิม" — contact ถูกเลือกแล้ว
  const isContactSelected = selectedContact !== null;
  // โหมด "สร้างใหม่" — พิมพ์อีเมลแต่ยังไม่ตรงใคร
  const isNewEmail = !isContactSelected && query.trim().length > 0;

  return (
    <div ref={wrapperRef} className="flex flex-col gap-1">
      <label htmlFor="requester-email" className="text-sm font-medium text-[#1F2933]">
        ผู้แจ้ง (Requester)
      </label>

      {/* Status badge แสดงโหมดปัจจุบัน */}
      {isContactSelected && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#EEF2FF] border border-[#C5D0FF] text-sm">
          <Check size={14} className="text-[#3B5BDB] shrink-0" aria-hidden="true" />
          <span className="text-[#3B5BDB] font-medium">
            เลือกคนเดิม: {selectedContact.name ?? selectedContact.email}
          </span>
          <button
            type="button"
            onClick={handleClear}
            aria-label="ล้างการเลือก"
            className="ml-auto text-[#6B7280] hover:text-[#E03131] text-xs focus:outline-none focus:underline"
          >
            ล้าง
          </button>
        </div>
      )}
      {isNewEmail && !isContactSelected && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#F0FDF4] border border-[#A7F3D0] text-sm">
          <span className="text-[#0CA678] font-medium">
            สร้าง contact ใหม่: {query}
          </span>
        </div>
      )}

      {/* Input อีเมล */}
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7280]">
          {isSearching ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Search size={14} aria-hidden="true" />
          )}
        </div>
        <input
          id="requester-email"
          type="text"
          autoComplete="off"
          value={query}
          onChange={handleQueryChange}
          onFocus={() => { if (suggestions.length > 0) setIsOpen(true); }}
          placeholder="ค้นหาด้วยอีเมลหรือชื่อ..."
          aria-autocomplete="list"
          aria-controls="requester-suggestions"
          aria-describedby={emailError ? "requester-error" : undefined}
          aria-invalid={emailError ? true : undefined}
          className={[
            "w-full rounded-lg border pl-9 pr-3 py-2 text-sm text-[#1F2933]",
            "placeholder:text-[#6B7280]",
            "focus:outline-none focus:ring-2 focus:ring-[#3B5BDB] focus:border-transparent",
            "transition-colors",
            emailError
              ? "border-[#E03131] bg-red-50"
              : "border-[#E4E7EB] bg-white hover:border-[#3B5BDB]",
          ].join(" ")}
        />

        {/* Dropdown suggestions */}
        {isOpen && suggestions.length > 0 && (
          <ul
            id="requester-suggestions"
            role="listbox"
            aria-label="Contact suggestions"
            className="absolute z-10 mt-1 w-full bg-white border border-[#E4E7EB] rounded-lg shadow-lg max-h-48 overflow-y-auto"
          >
            {suggestions.map((contact) => (
              <li
                key={contact.id}
                role="option"
                aria-selected={selectedContact?.id === contact.id}
                onClick={() => handleSelect(contact)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSelect(contact); }}
                tabIndex={0}
                className="flex flex-col px-3 py-2 cursor-pointer hover:bg-[#F7F9FB] focus:bg-[#F7F9FB] focus:outline-none transition-colors border-b border-[#E4E7EB] last:border-0"
              >
                <span className="text-sm font-medium text-[#1F2933]">
                  {contact.name ?? contact.email}
                </span>
                {contact.name && (
                  <span className="text-xs text-[#6B7280]">{contact.email}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {emailError && (
        <p id="requester-error" role="alert" className="text-xs text-[#E03131] mt-0.5">
          {emailError}
        </p>
      )}

      {/* ช่องชื่อ — แสดงเฉพาะเมื่อกำลังสร้าง contact ใหม่ */}
      {isNewEmail && !isContactSelected && (
        <div className="mt-1">
          <input
            type="text"
            value={nameInput}
            onChange={handleNameChange}
            placeholder="ชื่อผู้แจ้ง (optional)"
            className="w-full rounded-lg border border-[#E4E7EB] bg-white px-3 py-2 text-sm text-[#1F2933] placeholder:text-[#6B7280] focus:outline-none focus:ring-2 focus:ring-[#3B5BDB] focus:border-transparent transition-colors hover:border-[#3B5BDB]"
            aria-label="ชื่อผู้แจ้ง (สำหรับ contact ใหม่)"
          />
        </div>
      )}

      {/* Helper text */}
      <p className="text-xs text-[#6B7280]">
        ค้นหา contact เดิม หรือพิมพ์อีเมลใหม่เพื่อสร้าง contact อัตโนมัติ
      </p>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function AgentCreateTicketPage() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [requesterEmailError, setRequesterEmailError] = useState<string | null>(null);

  // state สำหรับ requester combobox
  const [selectedContact, setSelectedContact] = useState<ContactListItem | null>(null);
  const [requesterEmail, setRequesterEmail] = useState("");
  const [requesterName, setRequesterName] = useState("");

  // state สำหรับ assignee dropdown
  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [isMembersLoading, setIsMembersLoading] = useState(true);
  const [isMembersError, setIsMembersError] = useState(false);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string>("");

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateTicketFormValues>({
    resolver: zodResolver(createTicketSchema),
    defaultValues: { priority: "NORMAL" },
  });

  // โหลด members เมื่อ mount
  useEffect(() => {
    async function loadMembers() {
      try {
        const res = await fetch("/api/members", { credentials: "include" });
        const json = (await res.json()) as MembersResponse;
        if (res.ok && json.data) {
          setMembers(json.data.members);
        } else {
          // FIX-4: แจ้งให้ user รู้ว่าโหลดไม่ได้ ไม่ใช่แค่ dropdown ว่างเงียบ ๆ
          setIsMembersError(true);
        }
      } catch {
        // FIX-4: ไม่ block form — assignee เป็น optional แต่แสดง error แทน dropdown ว่าง
        setIsMembersError(true);
      } finally {
        setIsMembersLoading(false);
      }
    }
    void loadMembers();
  }, []);

  async function handleCreate(values: CreateTicketFormValues) {
    // กัน double-submit
    if (isSubmitting) return;

    setFormError(null);
    setRequesterEmailError(null);

    // validate requester: ต้องมีอย่างน้อย requesterContactId หรือ requesterEmail
    const hasRequester = selectedContact !== null || requesterEmail.trim().length > 0;
    if (!hasRequester) {
      setRequesterEmailError("กรุณาระบุผู้แจ้ง");
      return;
    }

    // ถ้าพิมพ์อีเมลใหม่ ต้อง validate รูปแบบอีเมล
    if (!selectedContact && requesterEmail.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(requesterEmail.trim())) {
        setRequesterEmailError("รูปแบบ email ไม่ถูกต้อง");
        return;
      }
    }

    // สร้าง body ตาม API contract
    const body: Record<string, unknown> = {
      subject: values.subject,
      priority: values.priority,
    };

    if (selectedContact) {
      // โหมดเลือกคนเดิม → ส่ง requesterContactId
      body.requesterContactId = selectedContact.id;
    } else if (requesterEmail.trim()) {
      // โหมดสร้างใหม่ → ส่ง requesterEmail + requesterName (optional)
      body.requesterEmail = requesterEmail.trim();
      if (requesterName.trim()) {
        body.requesterName = requesterName.trim();
      }
    }

    // assignee (optional)
    if (selectedAssigneeId) {
      body.assigneeId = selectedAssigneeId;
    }

    // firstMessage (optional)
    const msgBody = values.firstMessage?.trim();
    if (msgBody) {
      body.firstMessage = { body: msgBody, visibility: "PUBLIC" };
    }

    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = (await res.json()) as AgentCreateTicketResponse;

      if (!res.ok || json.error) {
        const code = json.error?.code ?? "";
        setFormError(
          ERROR_MESSAGES[code] ?? json.error?.message ?? "สร้าง ticket ไม่สำเร็จ กรุณาลองใหม่"
        );
        return;
      }

      if (json.data) {
        // redirect ไปหน้า detail หลังสร้างสำเร็จ
        router.push(`/tickets/${json.data.id}`);
      }
    } catch {
      setFormError("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F9FB]">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Back button */}
        <button
          type="button"
          onClick={() => router.push("/tickets")}
          className="inline-flex items-center gap-2 text-sm text-[#6B7280] hover:text-[#1F2933] mb-6 transition-colors focus:outline-none focus:underline"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          กลับไป Ticket List
        </button>

        {/* Form card */}
        <div className="bg-white rounded-xl border border-[#E4E7EB] shadow-sm p-6 sm:p-8">
          <div className="mb-6">
            <h1 className="text-xl font-bold text-[#1F2933]">สร้าง Ticket ใหม่</h1>
            <p className="mt-1 text-sm text-[#6B7280]">
              กรอกรายละเอียดเพื่อเปิด ticket ให้ลูกค้า
            </p>
          </div>

          {/* Form-level error */}
          {formError && (
            <div className="mb-5">
              <FormAlert variant="error" message={formError} />
            </div>
          )}

          <form
            onSubmit={handleSubmit(handleCreate)}
            noValidate
            className="flex flex-col gap-5"
          >
            {/* Subject */}
            <FormInput
              id="subject"
              label="หัวข้อ *"
              type="text"
              placeholder="เช่น ไม่สามารถเข้าสู่ระบบได้"
              autoComplete="off"
              error={errors.subject?.message}
              {...register("subject")}
            />

            {/* Requester combobox */}
            <RequesterCombobox
              selectedContact={selectedContact}
              onSelectContact={setSelectedContact}
              onEmailChange={setRequesterEmail}
              onNameChange={setRequesterName}
              emailError={requesterEmailError ?? undefined}
            />

            {/* Priority */}
            <div className="flex flex-col gap-1">
              <label htmlFor="priority" className="text-sm font-medium text-[#1F2933]">
                Priority
              </label>
              <select
                id="priority"
                {...register("priority")}
                className="rounded-lg border border-[#E4E7EB] bg-white px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:ring-2 focus:ring-[#3B5BDB] transition-colors hover:border-[#3B5BDB]"
              >
                {PRIORITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Assignee dropdown */}
            <div className="flex flex-col gap-1">
              <label htmlFor="assignee" className="text-sm font-medium text-[#1F2933]">
                ผู้รับผิดชอบ (optional)
              </label>
              <select
                id="assignee"
                value={selectedAssigneeId}
                disabled={isMembersLoading}
                onChange={(e) => setSelectedAssigneeId(e.target.value)}
                className="rounded-lg border border-[#E4E7EB] bg-white px-3 py-2 text-sm text-[#1F2933] focus:outline-none focus:ring-2 focus:ring-[#3B5BDB] disabled:opacity-60 transition-colors hover:border-[#3B5BDB]"
              >
                <option value="">ยังไม่มอบหมาย</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.user.name ?? m.user.email}
                    {m.user.name ? ` (${m.user.email})` : ""}
                  </option>
                ))}
              </select>
              {isMembersLoading && (
                <p className="text-xs text-[#6B7280]">กำลังโหลดรายชื่อ agent...</p>
              )}
              {/* FIX-4: แสดง error แทนการปล่อย dropdown ว่างโดยไม่บอก user */}
              {!isMembersLoading && isMembersError && (
                <p className="text-xs text-[#E03131]">โหลดรายชื่อ agent ไม่ได้ — assignee เป็น optional สามารถกำหนดทีหลังได้</p>
              )}
            </div>

            {/* First message (optional textarea) */}
            <div className="flex flex-col gap-1">
              <label htmlFor="firstMessage" className="text-sm font-medium text-[#1F2933]">
                ข้อความแรก (optional)
              </label>
              <textarea
                id="firstMessage"
                rows={4}
                placeholder="รายละเอียดปัญหาเพิ่มเติม... (จะถูกส่งเป็น public reply)"
                aria-describedby={errors.firstMessage ? "firstMessage-error" : undefined}
                aria-invalid={errors.firstMessage ? true : undefined}
                className={[
                  "w-full rounded-lg border px-3 py-2 text-sm text-[#1F2933] resize-none",
                  "placeholder:text-[#6B7280]",
                  "focus:outline-none focus:ring-2 focus:ring-[#3B5BDB] focus:border-transparent",
                  "transition-colors",
                  errors.firstMessage
                    ? "border-[#E03131] bg-red-50"
                    : "border-[#E4E7EB] bg-white hover:border-[#3B5BDB]",
                ].join(" ")}
                {...register("firstMessage")}
              />
              {errors.firstMessage && (
                <p
                  id="firstMessage-error"
                  role="alert"
                  className="text-xs text-[#E03131] mt-0.5"
                >
                  {errors.firstMessage.message}
                </p>
              )}
            </div>

            {/* Submit */}
            <div className="pt-2">
              <FormButton isLoading={isSubmitting}>
                {isSubmitting ? "กำลังสร้าง..." : "สร้าง Ticket"}
              </FormButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
