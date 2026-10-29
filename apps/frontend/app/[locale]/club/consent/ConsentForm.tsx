"use client";

import { useState } from "react";
import { apiBase } from "@/lib/api/base";

// H18: canonical `<origin>/api` base from the shared helper.
const API_BASE = apiBase();

type ConsentAction = "APPROVE" | "REJECT";
type Outcome = "idle" | "loading" | "approved" | "rejected" | "error" | "gone";

export function ConsentForm({ token }: { token: string }) {
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function submit(action: ConsentAction) {
    setOutcome("loading");
    setErrorMessage("");
    try {
      const res = await fetch(`${API_BASE}/club/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      if (res.ok) {
        setOutcome(action === "APPROVE" ? "approved" : "rejected");
        return;
      }
      if (res.status === 410) {
        setOutcome("gone");
        return;
      }
      const body = await res.json().catch(() => ({}));
      setErrorMessage(body?.message ?? "Tasdiqlashda xato yuz berdi");
      setOutcome("error");
    } catch {
      setErrorMessage("Tarmoq xatosi");
      setOutcome("error");
    }
  }

  if (outcome === "approved") {
    return (
      <div className="rounded-md bg-green-50 p-4 text-green-800">
        Rahmat! Farzandingizning klubga qo&apos;shilishiga ruxsat berildi.
      </div>
    );
  }

  if (outcome === "rejected") {
    return (
      <div className="rounded-md bg-surface-muted p-4 text-slate-700">
        Tasdiqlanmadi. Farzandingiz klubga qo&apos;shilmaydi.
      </div>
    );
  }

  if (outcome === "gone") {
    return (
      <div className="rounded-md bg-orange-50 p-4 text-orange-800">
        Havola muddati o&apos;tgan yoki ilgari ishlatilgan.
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={outcome === "loading"}
          onClick={() => submit("APPROVE")}
          className="rounded-md bg-green-600 px-4 py-3 text-white font-medium hover:bg-green-700 disabled:opacity-50"
        >
          Roziman
        </button>
        <button
          type="button"
          disabled={outcome === "loading"}
          onClick={() => submit("REJECT")}
          className="rounded-md bg-gray-200 px-4 py-3 text-slate-700 font-medium hover:bg-gray-300 disabled:opacity-50"
        >
          Rad etaman
        </button>
      </div>
      {outcome === "error" && (
        <p className="mt-3 text-sm text-red-600">{errorMessage}</p>
      )}
    </>
  );
}
