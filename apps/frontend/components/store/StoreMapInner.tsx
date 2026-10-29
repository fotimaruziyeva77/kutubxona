"use client";

import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix default marker icon in Next.js (webpack breaks the asset paths)
const markerIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface StoreMapInnerProps {
  lat: number;
  lon: number;
  name: string;
  address?: string;
}

export default function StoreMapInner({
  lat,
  lon,
  name,
  address,
}: StoreMapInnerProps) {
  return (
    <MapContainer
      center={[lat, lon]}
      zoom={15}
      scrollWheelZoom={false}
      className="w-full h-[300px] rounded-xl z-0"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Marker position={[lat, lon]} icon={markerIcon}>
        <Popup>
          <strong>{name}</strong>
          {address && <br />}
          {address}
        </Popup>
      </Marker>
    </MapContainer>
  );
}
