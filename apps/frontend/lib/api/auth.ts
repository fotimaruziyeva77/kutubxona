import { apiClient } from "./client";

// INFRA-02: All auth endpoints that previously returned `refreshToken` in the
// JSON body now return ONLY the access token. The refresh token is set by
// the backend as an HttpOnly cookie scoped to /api/auth, never readable by
// JS. Response types below intentionally OMIT refreshToken so any code that
// tries to read .data.refreshToken fails at compile time (catches stragglers).

export const authApi = {
  // Kirish: telefon + parol
  login: (phone: string, password: string) =>
    apiClient.post<{ accessToken: string }>(
      "/auth/login",
      { phone, password }
    ),

  // OTP yuborish (faqat ro'yhat va parol tiklash)
  sendOtp: (phone: string, purpose: "register" | "reset") =>
    apiClient.post<{ message: string }>("/auth/otp/send", { phone, purpose }),

  // OTP tasdiqlash
  verifyOtp: (phone: string, code: string) =>
    apiClient.post<{ verified: true; phone: string }>(
      "/auth/otp/verify",
      { phone, code }
    ),

  // Ro'yhat yakunlash (OTP tasdiqlangandan keyin parol o'rnatish)
  completeRegister: (phone: string, password: string) =>
    apiClient.post<{ accessToken: string; isNewUser: true }>(
      "/auth/register/complete",
      { phone, password }
    ),

  // Parol tiklash (OTP tasdiqlangandan keyin yangi parol)
  resetPassword: (phone: string, newPassword: string) =>
    apiClient.post<{ accessToken: string }>(
      "/auth/password/reset",
      { phone, newPassword }
    ),

  // Parolni o'zgartirish (kirgan holatda — joriy parol bilan)
  changePassword: (oldPassword: string, newPassword: string) =>
    apiClient.post<{ success: true }>(
      "/auth/password/change",
      { oldPassword, newPassword }
    ),

  // Refresh — no arguments; the HttpOnly refreshToken cookie travels
  // automatically because the apiClient sets withCredentials:true.
  refresh: () =>
    apiClient.post<{ accessToken: string }>("/auth/refresh", {}),

  logout: () => apiClient.post("/auth/logout")
};
