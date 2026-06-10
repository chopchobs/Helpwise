/**
 * src/lib/__tests__/branding.test.ts
 * Unit tests สำหรับ branding.ts — security-critical validators
 * (SSRF guard ผ่าน validateLogoUrl, CSS injection guard ผ่าน validateAccentColor)
 * ไม่มี DOM, no server, no DB
 */

import { describe, it, expect } from "vitest";
import {
  validateLogoUrl,
  validateAccentColor,
  parseBranding,
} from "@/lib/branding";

// =============================================================================
// validateLogoUrl
// =============================================================================

describe("validateLogoUrl", () => {
  describe("accept cases", () => {
    it("valid https URL → returns the trimmed string", () => {
      expect(validateLogoUrl("https://example.com")).toBe(
        "https://example.com"
      );
    });

    it("valid https URL with path + query → returns string as-is", () => {
      const url = "https://cdn.foo.com/path/logo.png?v=2";
      expect(validateLogoUrl(url)).toBe(url);
    });

    it("uppercase scheme HTTPS:// → URL() normalizes protocol → accepted", () => {
      const result = validateLogoUrl("HTTPS://example.com");
      expect(result).not.toBeNull();
      // new URL() lower-cases the protocol internally, but the *returned* value
      // is the original (trimmed) input string — confirm current behavior:
      expect(result).toBe("HTTPS://example.com");
    });

    it("URL with embedded credentials (https://user:pass@host) → accepted (still https)", () => {
      const url = "https://user:pass@host.com";
      expect(validateLogoUrl(url)).toBe(url);
    });

    it("surrounding whitespace → trimmed and accepted, returns trimmed value", () => {
      expect(validateLogoUrl("  https://x.com  ")).toBe("https://x.com");
    });

    it("https IP-literal URL (e.g. cloud metadata endpoint 169.254.169.254) → ACCEPTED", () => {
      // ⚠️ SSRF-adjacent caveat: validateLogoUrl only checks protocol === "https:",
      // it does NOT block IP-literal hosts (including link-local / cloud metadata
      // ranges like 169.254.169.254). This is current behavior — flagged for security review.
      const url = "https://169.254.169.254/latest/meta-data/";
      expect(validateLogoUrl(url)).toBe(url);
    });
  });

  describe("reject cases → null", () => {
    it.each([
      ["number", 123],
      ["null", null],
      ["undefined", undefined],
      ["object", { url: "https://x.com" }],
      ["array", ["https://x.com"]],
      ["boolean true", true],
      ["boolean false", false],
    ])("non-string input (%s) → null", (_label, value) => {
      expect(validateLogoUrl(value)).toBeNull();
    });

    it("empty string → null", () => {
      expect(validateLogoUrl("")).toBeNull();
    });

    it("whitespace-only string → null", () => {
      expect(validateLogoUrl("   ")).toBeNull();
    });

    it("http:// (non-https) → null", () => {
      expect(validateLogoUrl("http://x.com")).toBeNull();
    });

    it("data: URL → null", () => {
      expect(
        validateLogoUrl("data:text/html,<script>alert(1)</script>")
      ).toBeNull();
    });

    it("javascript: URL → null", () => {
      expect(validateLogoUrl("javascript:alert(1)")).toBeNull();
    });

    it("blob: URL → null", () => {
      expect(validateLogoUrl("blob:https://example.com/uuid")).toBeNull();
    });

    it("file:// URL → null", () => {
      expect(validateLogoUrl("file:///etc/passwd")).toBeNull();
    });

    it("ftp:// URL → null", () => {
      expect(validateLogoUrl("ftp://x.com")).toBeNull();
    });

    it("protocol-relative URL (//evil.com) → null (relative — URL() throws)", () => {
      expect(validateLogoUrl("//evil.com")).toBeNull();
    });

    it("relative path (/logo.png) → null", () => {
      expect(validateLogoUrl("/logo.png")).toBeNull();
    });

    it("malformed 'https://' (no host) → null", () => {
      expect(validateLogoUrl("https://")).toBeNull();
    });

    it("malformed protocol 'ht!tp://x.com' → null", () => {
      expect(validateLogoUrl("ht!tp://x.com")).toBeNull();
    });

    it("string longer than 2048 chars → null", () => {
      const longUrl = "https://example.com/" + "a".repeat(2048);
      expect(longUrl.length).toBeGreaterThan(2048);
      expect(validateLogoUrl(longUrl)).toBeNull();
    });
  });
});

// =============================================================================
// validateAccentColor
// =============================================================================

describe("validateAccentColor", () => {
  describe("accept cases", () => {
    it("lowercase hex #abc123 → returns as-is", () => {
      expect(validateAccentColor("#abc123")).toBe("#abc123");
    });

    it("uppercase hex #ABC123 → accepted (returns uppercase as-is)", () => {
      expect(validateAccentColor("#ABC123")).toBe("#ABC123");
    });

    it("#000000 → accepted", () => {
      expect(validateAccentColor("#000000")).toBe("#000000");
    });

    it("#ffffff → accepted", () => {
      expect(validateAccentColor("#ffffff")).toBe("#ffffff");
    });

    it("surrounding whitespace → trimmed and accepted", () => {
      expect(validateAccentColor("  #abc123  ")).toBe("#abc123");
    });
  });

  describe("reject cases → null", () => {
    it.each([
      ["number", 123],
      ["null", null],
      ["undefined", undefined],
      ["object", { color: "#abc123" }],
      ["array", ["#abc123"]],
      ["boolean", true],
    ])("non-string input (%s) → null", (_label, value) => {
      expect(validateAccentColor(value)).toBeNull();
    });

    it("3-digit hex #abc → null", () => {
      expect(validateAccentColor("#abc")).toBeNull();
    });

    it("4-digit hex #abcd → null", () => {
      expect(validateAccentColor("#abcd")).toBeNull();
    });

    it("7-digit hex #abcdefa → null", () => {
      expect(validateAccentColor("#abcdefa")).toBeNull();
    });

    it("missing # prefix (abc123) → null", () => {
      expect(validateAccentColor("abc123")).toBeNull();
    });

    it("named color 'red' → null", () => {
      expect(validateAccentColor("red")).toBeNull();
    });

    it("rgb(...) → null", () => {
      expect(validateAccentColor("rgb(0,0,0)")).toBeNull();
    });

    it("rgba(...) → null", () => {
      expect(validateAccentColor("rgba(0,0,0,0.5)")).toBeNull();
    });

    it("non-hex char #abc12g → null", () => {
      expect(validateAccentColor("#abc12g")).toBeNull();
    });

    it("CSS injection payload #abc123;background:url(x) → null", () => {
      expect(validateAccentColor("#abc123;background:url(x)")).toBeNull();
    });

    it("space inside value '#abc 123' → null", () => {
      expect(validateAccentColor("#abc 123")).toBeNull();
    });

    it("value containing semicolon → null", () => {
      expect(validateAccentColor("#abc123;")).toBeNull();
    });

    it("value containing parentheses → null", () => {
      expect(validateAccentColor("#abc123()")).toBeNull();
    });

    it("trailing newline is trimmed away → '#abc123' becomes valid (current behavior of .trim())", () => {
      // .trim() strips \n along with whitespace, so this is NOT rejected —
      // documenting actual behavior rather than assuming rejection.
      expect(validateAccentColor("#abc123\n")).toBe("#abc123");
    });

    it("internal newline (not trimmable) → null", () => {
      expect(validateAccentColor("#abc\n123")).toBeNull();
    });

    it("empty string → null", () => {
      expect(validateAccentColor("")).toBeNull();
    });
  });
});

// =============================================================================
// parseBranding
// =============================================================================

describe("parseBranding", () => {
  describe("non-object / missing branding → both null", () => {
    it.each([
      ["string", "not-an-object"],
      ["number", 123],
      ["boolean", true],
      ["null", null],
      ["undefined", undefined],
    ])("settings is %s → { logoUrl: null, accentColor: null }", (_label, value) => {
      expect(parseBranding(value)).toEqual({
        logoUrl: null,
        accentColor: null,
      });
    });

    it("settings is an array → both null", () => {
      expect(parseBranding(["branding"])).toEqual({
        logoUrl: null,
        accentColor: null,
      });
    });

    it("settings is object without 'branding' key → both null", () => {
      expect(parseBranding({ businessHours: { tz: "Asia/Bangkok" } })).toEqual(
        { logoUrl: null, accentColor: null }
      );
    });

    it("branding is null → both null", () => {
      expect(parseBranding({ branding: null })).toEqual({
        logoUrl: null,
        accentColor: null,
      });
    });

    it("branding is an array → both null", () => {
      expect(parseBranding({ branding: ["x"] })).toEqual({
        logoUrl: null,
        accentColor: null,
      });
    });

    it("branding is a non-object primitive (string) → both null", () => {
      expect(parseBranding({ branding: "https://x.com" })).toEqual({
        logoUrl: null,
        accentColor: null,
      });
    });
  });

  describe("valid branding object → validated extraction", () => {
    it("both logoUrl and accentColor valid → both returned", () => {
      const settings = {
        branding: {
          logoUrl: "https://cdn.example.com/logo.png",
          accentColor: "#C4652A",
        },
      };
      expect(parseBranding(settings)).toEqual({
        logoUrl: "https://cdn.example.com/logo.png",
        accentColor: "#C4652A",
      });
    });

    it("logoUrl valid, accentColor invalid → accentColor becomes null", () => {
      const settings = {
        branding: {
          logoUrl: "https://cdn.example.com/logo.png",
          accentColor: "red",
        },
      };
      expect(parseBranding(settings)).toEqual({
        logoUrl: "https://cdn.example.com/logo.png",
        accentColor: null,
      });
    });

    it("logoUrl invalid, accentColor valid → logoUrl becomes null", () => {
      const settings = {
        branding: {
          logoUrl: "javascript:alert(1)",
          accentColor: "#abc123",
        },
      };
      expect(parseBranding(settings)).toEqual({
        logoUrl: null,
        accentColor: "#abc123",
      });
    });

    it("both invalid (http URL + named color) → both null", () => {
      const settings = {
        branding: {
          logoUrl: "http://x.com",
          accentColor: "red",
        },
      };
      expect(parseBranding(settings)).toEqual({
        logoUrl: null,
        accentColor: null,
      });
    });

    it("injection payloads in settings JSON neutralized to null", () => {
      const settings = {
        branding: {
          logoUrl: "data:text/html,<script>alert(document.cookie)</script>",
          accentColor: "#abc123;background:url(javascript:alert(1))",
        },
      };
      expect(parseBranding(settings)).toEqual({
        logoUrl: null,
        accentColor: null,
      });
    });

    it("branding object missing keys entirely → both null (validators reject undefined)", () => {
      expect(parseBranding({ branding: {} })).toEqual({
        logoUrl: null,
        accentColor: null,
      });
    });

    it("branding object with extra unrelated keys (e.g. businessHours sibling) → ignored, only branding extracted", () => {
      const settings = {
        branding: { logoUrl: "https://x.com", accentColor: "#000000" },
        businessHours: { tz: "Asia/Bangkok" },
      };
      expect(parseBranding(settings)).toEqual({
        logoUrl: "https://x.com",
        accentColor: "#000000",
      });
    });
  });
});
