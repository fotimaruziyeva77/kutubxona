"use client";

import dynamic from "next/dynamic";

interface StoreMapProps {
  lat: number | null | undefined;
  lon: number | null | undefined;
  name: string;
  address?: string;
}

// Leaflet must not run on the server — dynamic import with ssr: false
const StoreMapInner = dynamic(() => import("./StoreMapInner"), { ssr: false });

export default function StoreMap({ lat, lon, name, address }: StoreMapProps) {
  if (lat == null || lon == null) {
    return (
      <div className="w-full h-[300px] rounded-xl bg-surface-sunken flex items-center justify-center text-slate-400 text-sm">
        Xarita mavjud emas
      </div>
    );
  }

  return <StoreMapInner lat={lat} lon={lon} name={name} address={address} />;
}
