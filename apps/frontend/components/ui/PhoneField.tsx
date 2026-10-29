"use client";

import * as React from "react";
import { Input } from "./input";

/**
 * Telefon maydoni — "+998" doimiy prefiks (o'chmaydi), foydalanuvchi faqat
 * 9 raqam kiritadi. Tashqariga har doim to'liq "+998XXXXXXXXX" qiymat uzatadi.
 */
export function PhoneField({
  value,
  onChange,
  onKeyDown,
  autoFocus,
}: {
  value: string;
  onChange: (full: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoFocus?: boolean;
}) {
  // value "+998901234567" → ko'rsatiladigan 9 raqam: "901234567".
  const digits = (value || "")
    .replace(/\D/g, "")
    .replace(/^998/, "")
    .slice(0, 9);

  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-500 pointer-events-none select-none">
        +998
      </span>
      <Input
        type="tel"
        inputMode="numeric"
        autoComplete="tel"
        autoFocus={autoFocus}
        placeholder="90 123 45 67"
        className="pl-14"
        value={digits}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          const d = e.target.value.replace(/\D/g, "").slice(0, 9);
          onChange("+998" + d);
        }}
      />
    </div>
  );
}

export default PhoneField;
