-- P2 M9 — Payme Merchant API sertifikatsiya: bekor qilish holatini saqlash.
--
-- CheckTransaction/GetStatement avval cancel_time:0 va reason:null ni hardcode
-- qilardi hamda FAILED/REFUNDED ikkalasini state -1 deb qaytarardi. Rasmiy
-- Payme holat mashinasi (developer.help.paycom.uz, Merchant API):
--    1 = yaratilgan, 2 = bajarilgan,
--   -1 = perform'dan OLDIN bekor qilingan,
--   -2 = perform'dan KEYIN bekor qilingan (refund).
-- CancelTransaction endi sabab kodi + vaqtni saqlaydi; CheckTransaction va
-- GetStatement haqiqiy cancel_time (ms epoch) va reason qaytaradi.
--
-- Ikkala ustun nullable — eski qatorlar uchun NULL, DEFAULT migratsiya
-- xarajati yo'q. IF NOT EXISTS — parallel muhitlarda qayta qo'llashga chidamli.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "cancelReason" INTEGER;
