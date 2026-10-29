"use client";

/**
 * Ro'yhatdan o'tish muvaffaqiyati sahifasi.
 *
 * Maxfiylik (P2): sifatId endi URL query (?sifatId=...) orqali KELMAYDI —
 * query brauzer tarixiga, server loglariga va referrer headerlariga sizib
 * chiqardi. Endi register sahifasi uni sessionStorage ga yozadi; agar u
 * bo'lmasa (hard refresh, storage bloklangan) sahifa profilni o'zi yuklaydi.
 *
 * QR — TZ §VIII.1 R22 aylanuvchi komponent (oflaynda statik fallback).
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { usersApi } from "@/lib/api/users";
import { RotatingUserQr } from "@/components/qr/rotating-user-qr";
import { useLocale } from "next-intl";
import Link from "next/link";

const SIFAT_ID_STORAGE_KEY = "sl-register-sifat-id";

export default function RegisterSuccessPage() {
  const locale = useLocale();
  const [sifatId, setSifatId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(SIFAT_ID_STORAGE_KEY);
    } catch { /* storage o'chirilgan bo'lishi mumkin */ }

    if (stored) {
      setSifatId(stored);
      setLoading(false);
      return;
    }

    // Fallback (hard refresh yoki storage yo'q): profildan olamiz.
    usersApi
      .getMe()
      .then((r) => setSifatId((r.data as { sifatId?: string })?.sifatId ?? ""))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-screen bg-surface-muted flex items-center justify-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <Icon.sparkle aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-2 text-green-600" />
          <CardTitle className="text-2xl text-green-600">Tabriklaymiz!</CardTitle>
          <p className="text-slate-500">Siz SIFAT LIBRARY ga muvaffaqiyatli ro&apos;yhatdan o&apos;tdingiz</p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="bg-blue-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-1">Sizning SIFAT ID:</p>
            {loading ? (
              <div className="h-7 bg-blue-100 rounded animate-pulse mx-auto w-3/4" />
            ) : (
              <p className="font-mono text-lg font-bold text-brand-700">
                {sifatId || "—"}
              </p>
            )}
          </div>

          {loading ? (
            <div className="h-48 bg-surface-sunken rounded-xl animate-pulse" />
          ) : sifatId ? (
            <div className="flex flex-col items-center">
              <p className="text-sm text-slate-500 mb-3">
                Kutubxonada QR kod orqali kitob olishingiz mumkin — kod har 5
                daqiqada avtomatik yangilanadi:
              </p>
              <RotatingUserQr sifatId={sifatId} sizeClass="w-48 h-48" />
            </div>
          ) : null}

          <div className="flex gap-3">
            <Link href={`/${locale}/profile`} className="flex-1">
              <Button className="w-full">Profilga o&apos;tish</Button>
            </Link>
            <Link href={`/${locale}`} className="flex-1">
              <Button variant="outline" className="w-full">Bosh sahifa</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
