import { apiClient } from "./client";

export interface GeoItem {
  id: string;
  code: string;
  name: string;
  slug: string;
}

export const geoApi = {
  getViloyatlar: () => apiClient.get<GeoItem[]>("/geo/viloyatlar"),
  getTumanlar: (viloyatId: string) =>
    apiClient.get<GeoItem[]>(`/geo/viloyatlar/${viloyatId}/tumanlar`),
  getMahallalar: (tumanId: string) =>
    apiClient.get<GeoItem[]>(`/geo/tumanlar/${tumanId}/mahallalar`)
};

// Named exports for convenience
export const getViloyatlar = () =>
  apiClient.get<GeoItem[]>("/geo/viloyatlar").then((r) => r.data);

export const getTumanlar = (viloyatId: string) =>
  apiClient.get<GeoItem[]>(`/geo/viloyatlar/${viloyatId}/tumanlar`).then((r) => r.data);

export const getMahallalar = (tumanId: string) =>
  apiClient.get<GeoItem[]>(`/geo/tumanlar/${tumanId}/mahallalar`).then((r) => r.data);
