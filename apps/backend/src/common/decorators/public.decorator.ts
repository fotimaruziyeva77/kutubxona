import { SetMetadata } from "@nestjs/common";

/**
 * Global JwtAuthGuard default-deny rejimida har bir route himoyalangan.
 * @Public() decorator route'ni token talab qilmaydigan qilib belgilaydi
 * (login, OTP, health, landing va h.k.).
 */
export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
