// Tarif narxlari (so'mda, YILLIK abonent to'lovi) + ko'rinadigan nomlar.
// subscription.service va invoice.service (shartnoma/faktura) shu yagona
// manbadan o'qiydi — narxlar bitta joyda.

export const PLAN_PRICES: Record<string, number> = {
  SCH_BASIC: 2_500_000, // Maktab — asosiy
  SCH_STANDARD: 3_500_000, // Maktab — standart
  UNI_BASIC: 10_000_000, // OTM — asosiy
  UNI_STANDARD: 15_000_000, // OTM — standart
  ORG_BASIC: 5_000_000, // Idora — asosiy
  ORG_STANDARD: 8_000_000, // Idora — standart
  GOV: 0, // Davlat — bepul (byudjet)
  MAH: 0, // Mahalla — bepul
};

export const PLAN_LABELS: Record<string, string> = {
  SCH_BASIC: "Maktab — Asosiy",
  SCH_STANDARD: "Maktab — Standart",
  UNI_BASIC: "OTM — Asosiy",
  UNI_STANDARD: "OTM — Standart",
  ORG_BASIC: "Idora — Asosiy",
  ORG_STANDARD: "Idora — Standart",
  GOV: "Davlat kutubxonasi (bepul)",
  MAH: "Mahalla kutubxonasi (bepul)",
};

export interface PlanCatalogItem {
  planType: string;
  label: string;
  price: number;
  free: boolean;
}

export function getPlanCatalog(): PlanCatalogItem[] {
  return Object.keys(PLAN_PRICES).map((planType) => ({
    planType,
    label: PLAN_LABELS[planType] ?? planType,
    price: PLAN_PRICES[planType],
    free: PLAN_PRICES[planType] === 0,
  }));
}
