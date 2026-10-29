import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { LibraryType } from "@prisma/client";

/**
 * Plan 04-04 audit-fix FIX C (SEC HIGH input validation).
 *
 * Library.name is interpolated into:
 *   - Faktura HTML (escaped at the splice — Plan 04-03 FIX A).
 *   - SMS reminders (sanitized at the splice — Plan 04-04 audit-fix FIX B).
 *   - XLSX + 1C exports (formula-escaped — Plan 04-04 audit-fix FIX A).
 *
 * Defence in depth: reject obviously hostile names at the registration
 * endpoint so legitimate downstream callers don't have to assume the
 * worst.
 *
 * Allowed character classes (regex below):
 *   - Cyrillic (Ѐ-ӿ)
 *   - Latin (a-z, A-Z)
 *   - Digits (0-9)
 *   - Space, hyphen, apostrophe (' — both ASCII 0x27 and U+2019), ampersand
 *
 * Explicitly rejected:
 *   - CR / LF (would land in SMS bodies before sanitization)
 *   - URL fragments — these cannot legitimately appear in a library NAME
 *     and would otherwise enable phishing inside notification text.
 *
 * Length: 2..120 chars. Below 2 chars is clearly garbage; above 120 is
 * implausible for any real organization name and would degrade SMS / PDF
 * layout. Plan 04-04 audit-fix FIX B truncates to 60 chars for SMS — the
 * 120-cap here is the input-side bound; SMS truncation is the output-side.
 *
 * NOTE: existing Library rows in the DB are NOT migrated by this change.
 * This is forward protection for new registrations. A data-migration pass
 * over legacy rows is deferred (see VALIDATION).
 */
const NAME_ALLOWED_CHARS =
  /^[Ѐ-ӿa-zA-Z0-9 \-'’&.,()№"]+$/;

// Reject anything that LOOKS like a URL embedded in the name. Sites we
// explicitly call out are the ones most commonly used for short-link
// phishing in this region.
const NAME_URL_BLACKLIST = [
  /https?:\/\//i,
  /\bbit\.ly\b/i,
  /\bt\.me\b/i,
  /\bwa\.me\b/i,
  /\btinyurl\b/i,
  /\bgoo\.gl\b/i,
];

/**
 * Apply both regexes. Returns true when name is acceptable.
 */
export function isLibraryNameSafe(raw: string): boolean {
  if (!raw) return false;
  if (raw.length < 2 || raw.length > 120) return false;
  if (/[\r\n]/.test(raw)) return false;
  if (!NAME_ALLOWED_CHARS.test(raw)) return false;
  for (const rx of NAME_URL_BLACKLIST) {
    if (rx.test(raw)) return false;
  }
  return true;
}

export class CreateLibraryDto {
  @IsEnum(LibraryType, {
    message: "type GOV | SCH | UNI | ORG | MAH bo'lishi kerak",
  })
  type!: LibraryType;

  @IsString()
  @MinLength(2, { message: "name kamida 2 belgi bo'lishi kerak" })
  @MaxLength(120, { message: "name 120 belgidan oshmasligi kerak" })
  // Reject any newline / control character first — a separate Matches with a
  // simple negative class gives a clearer error than the combined positive
  // class below.
  @Matches(/^[^\r\n]+$/, {
    message: "name yangi qator belgilarini o'z ichiga olmasligi kerak",
  })
  // Positive character class. The list intentionally excludes characters
  // that have no legitimate use in a real library name AND that we splice
  // into HTML / SMS / CSV downstream.
  @Matches(NAME_ALLOWED_CHARS, {
    message:
      "name faqat harf, raqam, bo'sh joy, defis, apostrof yoki ampersand bo'lishi mumkin",
  })
  // Reject URL fragments. Even legitimate libraries don't put bit.ly /
  // https:// in their name. This blocks the SMS-phishing payload class.
  @Matches(/^(?!.*(https?:\/\/|bit\.ly|t\.me|wa\.me|tinyurl|goo\.gl)).*$/i, {
    message: "name URL fragmentini o'z ichiga olmasligi kerak",
  })
  name!: string;

  @IsString()
  regionId!: string;

  @IsOptional()
  @IsString()
  tumanId?: string;

  @IsOptional()
  @IsString()
  viloyatId?: string;

  @IsOptional()
  @IsString()
  institutionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  workHours?: string;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;
}

export class UpdateLibraryDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(/^[^\r\n]+$/)
  @Matches(NAME_ALLOWED_CHARS)
  @Matches(/^(?!.*(https?:\/\/|bit\.ly|t\.me|wa\.me|tinyurl|goo\.gl)).*$/i)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  workHours?: string;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;
}
