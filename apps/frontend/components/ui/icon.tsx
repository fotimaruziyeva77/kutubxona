/**
 * icon.tsx — loyihaning YAGONA ikonka manbasi.
 *
 * ⚠️ Bu faylda "use client" BO'LMASLIGI kerak. lucide ikonkalari — holatsiz,
 * hooksiz, faqat SVG qaytaradigan funksiyalar; ular server komponentida ham
 * bemalol render bo'ladi. "use client" qo'yilsa `Icon` obyekti RSC chegarasini
 * kesib o'ta olmaydi va `Icon.shield` uchun
 * "Could not find the module ... in the React Client Manifest" xatosi chiqadi
 * (obyekt xossasi orqali murojaat serializatsiya qilinmaydi).
 *
 * lucide-react ning Next barrel-optimizatsiyasi next.config.js da
 * `transpilePackages` orqali o'chirilgan — sababi o'sha yerda izohlangan.
 *
 * Muammo: UI butunlay emoji'ga (📚 🏛️ 👥 🏆) qurilgan edi. Emoji ikonka
 * EMAS — u har OS'da boshqacha chiziladi (Windows'da tekis, iOS'da hajmli,
 * Android'da uchinchi xil), rangi qat'iy, chiziq qalinligi matn bilan mos
 * kelmaydi va o'lchamni boshqarib bo'lmaydi. Davlat muassasasiga (maktab,
 * OTM, kutubxona) topshiriladigan mahsulotda bu havaskorlik taassuroti beradi.
 *
 * Yechim: `lucide-react` (allaqachon bog'liqliklarda bor, lekin ishlatilmagan) —
 * bir xil 24×24 to'r, bir xil 1.5px chiziq, `currentColor` bilan bo'yaladi,
 * tree-shaking tufayli faqat ishlatilgani bundle'ga kiradi.
 *
 * Nega to'g'ridan-to'g'ri lucide'dan import qilmaymiz: bu qatlam ikonkaga
 * MA'NO biriktiradi. `Icon.library` yozganda kutubxona nazarda tutiladi;
 * ertaga lucide `Library` ni o'zgartirsa yoki boshqa to'plamga o'tsak,
 * o'zgarish shu bitta faylda bo'ladi.
 */

import {
  Activity,
  AlertTriangle,
  Award,
  BarChart3,
  Bell,
  Book,
  Bookmark,
  BookOpen,
  Building2,
  Cake,
  Calculator,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  CreditCard,
  Download,
  FileText,
  Flame,
  GraduationCap,
  Handshake,
  Heart,
  Home,
  Inbox,
  Info,
  Landmark,
  Library,
  Lock,
  LogOut,
  Mail,
  MapPin,
  Medal,
  Menu,
  MessageSquare,
  Package,
  Pencil,
  Phone,
  Plus,
  QrCode,
  RefreshCw,
  Scale,
  Search,
  Settings,
  Shield,
  ShoppingBag,
  Sparkles,
  Star,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  Trophy,
  Upload,
  User,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
  X,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Semantik ikonka xaritasi. Kalitlar — DOMEN tushunchalari, lucide nomlari emas.
 */
export const Icon = {
  // ── Domen ────────────────────────────────────────────────────────────────
  book: BookOpen,
  bookClosed: Book,
  bookmark: Bookmark,
  library: Library,
  school: GraduationCap,
  university: Landmark,
  organization: Building2,
  mahalla: Home,
  /** Xonadon/manzil (oila moduli). `mahalla` bilan bir xil glif, boshqa ma'no. */
  household: Home,
  store: ShoppingBag,
  club: MessageSquare,
  family: Users,
  reader: User,
  readers: Users,
  teacher: UserCheck,
  partnership: Handshake,

  // ── Statistika / reyting ─────────────────────────────────────────────────
  stats: BarChart3,
  index: Activity,
  trophy: Trophy,
  medal: Medal,
  award: Award,
  star: Star,
  target: Target,
  streak: Flame,
  trendUp: TrendingUp,
  trendDown: TrendingDown,
  map: MapPin,
  formula: Calculator,
  gender: Scale,
  age: Cake,

  // ── Amallar ──────────────────────────────────────────────────────────────
  search: Search,
  add: Plus,
  edit: Pencil,
  delete: Trash2,
  refresh: RefreshCw,
  download: Download,
  upload: Upload,
  qr: QrCode,
  camera: Camera,
  next: ChevronRight,
  menu: Menu,
  close: X,
  logout: LogOut,
  settings: Settings,

  // ── Holat ────────────────────────────────────────────────────────────────
  success: CheckCircle2,
  check: Check,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  pending: Clock,
  locked: Lock,
  shield: Shield,
  empty: Inbox,
  online: Wifi,
  offline: WifiOff,

  // ── Boshqa ───────────────────────────────────────────────────────────────
  bell: Bell,
  calendar: Calendar,
  document: FileText,
  checklist: ClipboardList,
  payment: CreditCard,
  /** Tezkor to'lov (Click) — `payment` bilan yonma-yon turadi, farqlanishi kerak. */
  instantPayment: Zap,
  package: Package,
  donate: Heart,
  phone: Phone,
  mail: Mail,
  sparkle: Sparkles,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof Icon;
export type { LucideIcon };

/**
 * O'lcham shkalasi — 4px to'riga tiralgan (DESIGN.md §4). Ixtiyoriy
 * `size={17}` kabi qiymatlar ikonkalar qatorini nomutanosib qiladi,
 * shuning uchun faqat shu to'rt qiymat ishlatiladi.
 */
export const ICON_SIZE = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
} as const;

export type IconSize = keyof typeof ICON_SIZE;
