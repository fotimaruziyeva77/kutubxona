import { apiClient } from "./client";

export interface CompleteProfilePayload {
  name: string;
  dob: string;
  gender: "MALE" | "FEMALE";
  viloyatId: string;
  tumanId: string;
  mahallaId: string;
  street: string;
  house: string;
  apartment: string;
  type: "CITIZEN" | "STUDENT_SCHOOL" | "STUDENT_UNIVERSITY" | "GOVERNMENT_EMPLOYEE" | "TEACHER";
  schoolId?: string;
  schoolClass?: string;
  universityId?: string;
  faculty?: string;
  direction?: string;
  studyCourse?: number;
  organizationId?: string;
  department?: string;
  position?: string;
}

export const usersApi = {
  getMe: () => apiClient.get("/users/me"),
  updateMe: (data: Partial<CompleteProfilePayload>) => apiClient.put("/users/me", data),
  completeProfile: (data: CompleteProfilePayload) =>
    apiClient.post("/users/me/complete-profile", data),
  getQr: () => apiClient.get<{ sifatId: string; qrCode: string }>("/users/me/qr")
};
