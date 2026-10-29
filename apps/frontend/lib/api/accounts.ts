import { apiClient } from "./client";

// SUPER_ADMIN akaunt boshqaruvi — admin/xodim yaratish, ro'yxat, parol tiklash,
// o'chirish. Barcha endpointlar backendda @Roles(SUPER_ADMIN) bilan himoyalangan.

export type StaffRole =
  | "VILOYAT_ADMIN"
  | "TUMAN_ADMIN"
  | "MUASSASA_ADMIN"
  | "KUTUBXONACHI"
  | "KLUB_RAHBARI"
  | "BUXGALTER"
  | "DOKON_OPERATOR";

export interface AccountItem {
  id: string;
  name: string;
  phone: string;
  role: StaffRole;
  status: string;
  sifatId: string | null;
  createdAt: string;
  viloyatName: string | null;
  tumanName: string | null;
}

export interface AccountListResult {
  total: number;
  page: number;
  limit: number;
  items: AccountItem[];
}

export interface CreateAccountInput {
  name: string;
  phone: string;
  role: StaffRole;
  gender?: "MALE" | "FEMALE";
  dob?: string;
  password?: string; // bo'sh — backend vaqtinchalik parol generatsiya qiladi
  viloyatId?: string;
  tumanId?: string;
  mahallaId?: string;
  organizationId?: string;
  schoolId?: string;
  universityId?: string;
}

export interface CreatedAccount {
  id: string;
  name: string;
  phone: string;
  role: StaffRole;
  sifatId: string | null;
  status: string;
  tempPassword: string;
}

export async function listAccounts(params: {
  role?: string;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<AccountListResult> {
  const { data } = await apiClient.get<AccountListResult>("/admin/accounts", {
    params,
  });
  return data;
}

export async function createAccount(
  dto: CreateAccountInput,
): Promise<CreatedAccount> {
  const { data } = await apiClient.post<CreatedAccount>("/admin/accounts", dto);
  return data;
}

export async function resetAccountPassword(
  id: string,
  password?: string,
): Promise<{ tempPassword: string }> {
  const { data } = await apiClient.patch<{ tempPassword: string }>(
    `/admin/accounts/${id}/reset-password`,
    password ? { password } : {},
  );
  return data;
}

export async function deleteAccount(id: string): Promise<{ success: boolean }> {
  const { data } = await apiClient.delete<{ success: boolean }>(
    `/admin/accounts/${id}`,
  );
  return data;
}
