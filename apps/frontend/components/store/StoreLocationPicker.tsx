"use client";

import dynamic from "next/dynamic";

// Leaflet faqat browserda — SSR'siz dinamik import.
const Inner = dynamic(() => import("./StoreLocationPickerInner"), { ssr: false });

/** Bosib joylashuvni tanlash xaritasi — bosilganda onPick(lat, lon) chaqiriladi. */
export default function StoreLocationPicker({
  lat,
  lon,
  onPick,
}: {
  lat: number;
  lon: number;
  onPick: (lat: number, lon: number) => void;
}) {
  return <Inner lat={lat} lon={lon} onPick={onPick} />;
}
