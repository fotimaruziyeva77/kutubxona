import { PrismaClient, UserGender, UserType, UserStatus, UserRole, LibraryType, LibraryStatus } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { BADGE_CATALOG } from "../src/modules/badge/badge.service";
import { isProductionEnv } from "../src/common/utils/production-env.util";
import { DEMO_BOOKS, demoIsbn, type ShelfCode } from "./demo-books";

const prisma = new PrismaClient();

// Demo account password — DEV ONLY. Allows local phone+password login
// against the seeded user without going through the OTP flow.
// C10 fix: seedDemoData() (va shu parol bilan yaratiladigan BARCHA demo
// akkauntlar, jumladan SUPER_ADMIN +998900000001) production muhitida
// HECH QACHON ishga tushmaydi — main() dagi isProductionEnv() gate ga qarang.
const DEMO_PASSWORD = "Demo@2026";

const GEO_DATA = [
  {
    code: "01", name: "Qoraqalpog'iston", slug: "qoraqalpogiston",
    tumans: [
      // --- Existing (preserved: codes/slugs/mahallas untouched) ---
      { code: "01-001", name: "Amudaryo", slug: "amudaryo", mahallas: [
        { code: "01-001-0001", name: "Qo'ng'irot mahallasi", slug: "qongirot" },
        { code: "01-001-0002", name: "Amudaryo markaz", slug: "amudaryo-markaz" }
      ]},
      { code: "01-002", name: "Beruniy", slug: "beruniy", mahallas: [
        { code: "01-002-0001", name: "Beruniy markaz", slug: "beruniy-markaz" }
      ]},
      // --- Added real tumans ---
      { code: "01-003", name: "Nukus shahar", slug: "nukus-shahar", mahallas: [
        { code: "01-003-0001", name: "Nukus shahar markaz", slug: "nukus-shahar-markaz" }
      ]},
      { code: "01-004", name: "Bo'zatov", slug: "bozatov", mahallas: [
        { code: "01-004-0001", name: "Bo'zatov markaz", slug: "bozatov-markaz" }
      ]},
      { code: "01-005", name: "Chimboy", slug: "chimboy", mahallas: [
        { code: "01-005-0001", name: "Chimboy markaz", slug: "chimboy-markaz" }
      ]},
      { code: "01-006", name: "Ellikqal'a", slug: "ellikqala", mahallas: [
        { code: "01-006-0001", name: "Ellikqal'a markaz", slug: "ellikqala-markaz" }
      ]},
      { code: "01-007", name: "Kegeyli", slug: "kegeyli", mahallas: [
        { code: "01-007-0001", name: "Kegeyli markaz", slug: "kegeyli-markaz" }
      ]},
      { code: "01-008", name: "Mo'ynoq", slug: "moynoq", mahallas: [
        { code: "01-008-0001", name: "Mo'ynoq markaz", slug: "moynoq-markaz" }
      ]},
      { code: "01-009", name: "Nukus tumani", slug: "nukus-tumani", mahallas: [
        { code: "01-009-0001", name: "Nukus tumani markaz", slug: "nukus-tumani-markaz" }
      ]},
      { code: "01-010", name: "Qanliko'l", slug: "qanlikol", mahallas: [
        { code: "01-010-0001", name: "Qanliko'l markaz", slug: "qanlikol-markaz" }
      ]},
      { code: "01-011", name: "Qorao'zak", slug: "qoraozak", mahallas: [
        { code: "01-011-0001", name: "Qorao'zak markaz", slug: "qoraozak-markaz" }
      ]},
      { code: "01-012", name: "Qo'ng'irot", slug: "qongirot", mahallas: [
        { code: "01-012-0001", name: "Qo'ng'irot markaz", slug: "qongirot-markaz" }
      ]},
      { code: "01-013", name: "Shumanay", slug: "shumanay", mahallas: [
        { code: "01-013-0001", name: "Shumanay markaz", slug: "shumanay-markaz" }
      ]},
      { code: "01-014", name: "Taxtako'pir", slug: "taxtakopir", mahallas: [
        { code: "01-014-0001", name: "Taxtako'pir markaz", slug: "taxtakopir-markaz" }
      ]},
      { code: "01-015", name: "To'rtko'l", slug: "tortkol", mahallas: [
        { code: "01-015-0001", name: "To'rtko'l markaz", slug: "tortkol-markaz" }
      ]},
      { code: "01-016", name: "Xo'jayli", slug: "xojayli", mahallas: [
        { code: "01-016-0001", name: "Xo'jayli markaz", slug: "xojayli-markaz" }
      ]},
      { code: "01-017", name: "Taxiatosh", slug: "taxiatosh", mahallas: [
        { code: "01-017-0001", name: "Taxiatosh markaz", slug: "taxiatosh-markaz" }
      ]}
    ]
  },
  {
    code: "02", name: "Andijon", slug: "andijon",
    tumans: [
      { code: "02-001", name: "Andijon shahar", slug: "andijon-shahar", mahallas: [
        { code: "02-001-0001", name: "Markaziy mahalla", slug: "markaziy" },
        { code: "02-001-0002", name: "Bobur mahallasi", slug: "bobur" }
      ]},
      { code: "02-002", name: "Asaka", slug: "asaka", mahallas: [
        { code: "02-002-0001", name: "Asaka markaz", slug: "asaka-markaz" }
      ]},
      { code: "02-003", name: "Andijon tumani", slug: "andijon-tumani", mahallas: [
        { code: "02-003-0001", name: "Andijon tumani markaz", slug: "andijon-tumani-markaz" }
      ]},
      { code: "02-004", name: "Baliqchi", slug: "baliqchi", mahallas: [
        { code: "02-004-0001", name: "Baliqchi markaz", slug: "baliqchi-markaz" }
      ]},
      { code: "02-005", name: "Bo'z", slug: "boz", mahallas: [
        { code: "02-005-0001", name: "Bo'z markaz", slug: "boz-markaz" }
      ]},
      { code: "02-006", name: "Buloqboshi", slug: "buloqboshi", mahallas: [
        { code: "02-006-0001", name: "Buloqboshi markaz", slug: "buloqboshi-markaz" }
      ]},
      { code: "02-007", name: "Izboskan", slug: "izboskan", mahallas: [
        { code: "02-007-0001", name: "Izboskan markaz", slug: "izboskan-markaz" }
      ]},
      { code: "02-008", name: "Jalaquduq", slug: "jalaquduq", mahallas: [
        { code: "02-008-0001", name: "Jalaquduq markaz", slug: "jalaquduq-markaz" }
      ]},
      { code: "02-009", name: "Xo'jaobod", slug: "xojaobod", mahallas: [
        { code: "02-009-0001", name: "Xo'jaobod markaz", slug: "xojaobod-markaz" }
      ]},
      { code: "02-010", name: "Qo'rg'ontepa", slug: "qorgontepa", mahallas: [
        { code: "02-010-0001", name: "Qo'rg'ontepa markaz", slug: "qorgontepa-markaz" }
      ]},
      { code: "02-011", name: "Marhamat", slug: "marhamat", mahallas: [
        { code: "02-011-0001", name: "Marhamat markaz", slug: "marhamat-markaz" }
      ]},
      { code: "02-012", name: "Oltinko'l", slug: "oltinkol", mahallas: [
        { code: "02-012-0001", name: "Oltinko'l markaz", slug: "oltinkol-markaz" }
      ]},
      { code: "02-013", name: "Paxtaobod", slug: "paxtaobod", mahallas: [
        { code: "02-013-0001", name: "Paxtaobod markaz", slug: "paxtaobod-markaz" }
      ]},
      { code: "02-014", name: "Shahrixon", slug: "shahrixon", mahallas: [
        { code: "02-014-0001", name: "Shahrixon markaz", slug: "shahrixon-markaz" }
      ]},
      { code: "02-015", name: "Ulug'nor", slug: "ulugnor", mahallas: [
        { code: "02-015-0001", name: "Ulug'nor markaz", slug: "ulugnor-markaz" }
      ]}
    ]
  },
  {
    code: "03", name: "Buxoro", slug: "buxoro",
    tumans: [
      { code: "03-001", name: "Buxoro shahar", slug: "buxoro-shahar", mahallas: [
        { code: "03-001-0001", name: "Ark mahallasi", slug: "ark" },
        { code: "03-001-0002", name: "Lyabi Hovuz", slug: "lyabi-hovuz" }
      ]},
      { code: "03-002", name: "G'ijduvon", slug: "gijduvon", mahallas: [
        { code: "03-002-0001", name: "G'ijduvon markaz", slug: "gijduvon-markaz" }
      ]},
      { code: "03-003", name: "Buxoro tumani", slug: "buxoro-tumani", mahallas: [
        { code: "03-003-0001", name: "Buxoro tumani markaz", slug: "buxoro-tumani-markaz" }
      ]},
      { code: "03-004", name: "Jondor", slug: "jondor", mahallas: [
        { code: "03-004-0001", name: "Jondor markaz", slug: "jondor-markaz" }
      ]},
      { code: "03-005", name: "Kogon", slug: "kogon", mahallas: [
        { code: "03-005-0001", name: "Kogon markaz", slug: "kogon-markaz" }
      ]},
      { code: "03-006", name: "Kogon shahar", slug: "kogon-shahar", mahallas: [
        { code: "03-006-0001", name: "Kogon shahar markaz", slug: "kogon-shahar-markaz" }
      ]},
      { code: "03-007", name: "Olot", slug: "olot", mahallas: [
        { code: "03-007-0001", name: "Olot markaz", slug: "olot-markaz" }
      ]},
      { code: "03-008", name: "Peshku", slug: "peshku", mahallas: [
        { code: "03-008-0001", name: "Peshku markaz", slug: "peshku-markaz" }
      ]},
      { code: "03-009", name: "Qorako'l", slug: "qorakol", mahallas: [
        { code: "03-009-0001", name: "Qorako'l markaz", slug: "qorakol-markaz" }
      ]},
      { code: "03-010", name: "Qorovulbozor", slug: "qorovulbozor", mahallas: [
        { code: "03-010-0001", name: "Qorovulbozor markaz", slug: "qorovulbozor-markaz" }
      ]},
      { code: "03-011", name: "Romitan", slug: "romitan", mahallas: [
        { code: "03-011-0001", name: "Romitan markaz", slug: "romitan-markaz" }
      ]},
      { code: "03-012", name: "Shofirkon", slug: "shofirkon", mahallas: [
        { code: "03-012-0001", name: "Shofirkon markaz", slug: "shofirkon-markaz" }
      ]},
      { code: "03-013", name: "Vobkent", slug: "vobkent", mahallas: [
        { code: "03-013-0001", name: "Vobkent markaz", slug: "vobkent-markaz" }
      ]}
    ]
  },
  {
    code: "04", name: "Jizzax", slug: "jizzax",
    tumans: [
      { code: "04-001", name: "Jizzax shahar", slug: "jizzax-shahar", mahallas: [
        { code: "04-001-0001", name: "Jizzax markaz", slug: "jizzax-markaz" }
      ]},
      { code: "04-002", name: "Arnasoy", slug: "arnasoy", mahallas: [
        { code: "04-002-0001", name: "Arnasoy markaz", slug: "arnasoy-markaz" }
      ]},
      { code: "04-003", name: "Baxmal", slug: "baxmal", mahallas: [
        { code: "04-003-0001", name: "Baxmal markaz", slug: "baxmal-markaz" }
      ]},
      { code: "04-004", name: "Do'stlik", slug: "dostlik", mahallas: [
        { code: "04-004-0001", name: "Do'stlik markaz", slug: "dostlik-markaz" }
      ]},
      { code: "04-005", name: "Forish", slug: "forish", mahallas: [
        { code: "04-005-0001", name: "Forish markaz", slug: "forish-markaz" }
      ]},
      { code: "04-006", name: "G'allaorol", slug: "gallaorol", mahallas: [
        { code: "04-006-0001", name: "G'allaorol markaz", slug: "gallaorol-markaz" }
      ]},
      { code: "04-007", name: "Sharof Rashidov", slug: "sharof-rashidov", mahallas: [
        { code: "04-007-0001", name: "Sharof Rashidov markaz", slug: "sharof-rashidov-markaz" }
      ]},
      { code: "04-008", name: "Mirzacho'l", slug: "mirzachol", mahallas: [
        { code: "04-008-0001", name: "Mirzacho'l markaz", slug: "mirzachol-markaz" }
      ]},
      { code: "04-009", name: "Paxtakor", slug: "paxtakor", mahallas: [
        { code: "04-009-0001", name: "Paxtakor markaz", slug: "paxtakor-markaz" }
      ]},
      { code: "04-010", name: "Yangiobod", slug: "yangiobod", mahallas: [
        { code: "04-010-0001", name: "Yangiobod markaz", slug: "yangiobod-markaz" }
      ]},
      { code: "04-011", name: "Zafarobod", slug: "zafarobod", mahallas: [
        { code: "04-011-0001", name: "Zafarobod markaz", slug: "zafarobod-markaz" }
      ]},
      { code: "04-012", name: "Zarbdor", slug: "zarbdor", mahallas: [
        { code: "04-012-0001", name: "Zarbdor markaz", slug: "zarbdor-markaz" }
      ]},
      { code: "04-013", name: "Zomin", slug: "zomin", mahallas: [
        { code: "04-013-0001", name: "Zomin markaz", slug: "zomin-markaz" }
      ]}
    ]
  },
  {
    code: "05", name: "Qashqadaryo", slug: "qashqadaryo",
    tumans: [
      { code: "05-001", name: "Qarshi shahar", slug: "qarshi-shahar", mahallas: [
        { code: "05-001-0001", name: "Qarshi markaz", slug: "qarshi-markaz" }
      ]},
      { code: "05-002", name: "Shahrisabz", slug: "shahrisabz", mahallas: [
        { code: "05-002-0001", name: "Shahrisabz markaz", slug: "shahrisabz-markaz" }
      ]},
      { code: "05-003", name: "Qarshi tumani", slug: "qarshi-tumani", mahallas: [
        { code: "05-003-0001", name: "Qarshi tumani markaz", slug: "qarshi-tumani-markaz" }
      ]},
      { code: "05-004", name: "Chiroqchi", slug: "chiroqchi", mahallas: [
        { code: "05-004-0001", name: "Chiroqchi markaz", slug: "chiroqchi-markaz" }
      ]},
      { code: "05-005", name: "Dehqonobod", slug: "dehqonobod", mahallas: [
        { code: "05-005-0001", name: "Dehqonobod markaz", slug: "dehqonobod-markaz" }
      ]},
      { code: "05-006", name: "G'uzor", slug: "guzor", mahallas: [
        { code: "05-006-0001", name: "G'uzor markaz", slug: "guzor-markaz" }
      ]},
      { code: "05-007", name: "Kasbi", slug: "kasbi", mahallas: [
        { code: "05-007-0001", name: "Kasbi markaz", slug: "kasbi-markaz" }
      ]},
      { code: "05-008", name: "Kitob", slug: "kitob", mahallas: [
        { code: "05-008-0001", name: "Kitob markaz", slug: "kitob-markaz" }
      ]},
      { code: "05-009", name: "Ko'kdala", slug: "kokdala", mahallas: [
        { code: "05-009-0001", name: "Ko'kdala markaz", slug: "kokdala-markaz" }
      ]},
      { code: "05-010", name: "Koson", slug: "koson", mahallas: [
        { code: "05-010-0001", name: "Koson markaz", slug: "koson-markaz" }
      ]},
      { code: "05-011", name: "Mirishkor", slug: "mirishkor", mahallas: [
        { code: "05-011-0001", name: "Mirishkor markaz", slug: "mirishkor-markaz" }
      ]},
      { code: "05-012", name: "Muborak", slug: "muborak", mahallas: [
        { code: "05-012-0001", name: "Muborak markaz", slug: "muborak-markaz" }
      ]},
      { code: "05-013", name: "Nishon", slug: "nishon", mahallas: [
        { code: "05-013-0001", name: "Nishon markaz", slug: "nishon-markaz" }
      ]},
      { code: "05-014", name: "Shahrisabz tumani", slug: "shahrisabz-tumani", mahallas: [
        { code: "05-014-0001", name: "Shahrisabz tumani markaz", slug: "shahrisabz-tumani-markaz" }
      ]},
      { code: "05-015", name: "Yakkabog'", slug: "yakkabog", mahallas: [
        { code: "05-015-0001", name: "Yakkabog' markaz", slug: "yakkabog-markaz" }
      ]}
    ]
  },
  {
    code: "06", name: "Namangan", slug: "namangan",
    tumans: [
      { code: "06-001", name: "Namangan shahar", slug: "namangan-shahar", mahallas: [
        { code: "06-001-0001", name: "Eski shahar", slug: "eski-shahar" },
        { code: "06-001-0002", name: "Yangi shahar", slug: "yangi-shahar" }
      ]},
      { code: "06-002", name: "Chortoq", slug: "chortoq", mahallas: [
        { code: "06-002-0001", name: "Chortoq markaz", slug: "chortoq-markaz" }
      ]},
      { code: "06-003", name: "Namangan tumani", slug: "namangan-tumani", mahallas: [
        { code: "06-003-0001", name: "Namangan tumani markaz", slug: "namangan-tumani-markaz" }
      ]},
      { code: "06-004", name: "Chust", slug: "chust", mahallas: [
        { code: "06-004-0001", name: "Chust markaz", slug: "chust-markaz" }
      ]},
      { code: "06-005", name: "Kosonsoy", slug: "kosonsoy", mahallas: [
        { code: "06-005-0001", name: "Kosonsoy markaz", slug: "kosonsoy-markaz" }
      ]},
      { code: "06-006", name: "Mingbuloq", slug: "mingbuloq", mahallas: [
        { code: "06-006-0001", name: "Mingbuloq markaz", slug: "mingbuloq-markaz" }
      ]},
      { code: "06-007", name: "Norin", slug: "norin", mahallas: [
        { code: "06-007-0001", name: "Norin markaz", slug: "norin-markaz" }
      ]},
      { code: "06-008", name: "Pop", slug: "pop", mahallas: [
        { code: "06-008-0001", name: "Pop markaz", slug: "pop-markaz" }
      ]},
      { code: "06-009", name: "To'raqo'rg'on", slug: "toraqorgon", mahallas: [
        { code: "06-009-0001", name: "To'raqo'rg'on markaz", slug: "toraqorgon-markaz" }
      ]},
      { code: "06-010", name: "Uchqo'rg'on", slug: "uchqorgon", mahallas: [
        { code: "06-010-0001", name: "Uchqo'rg'on markaz", slug: "uchqorgon-markaz" }
      ]},
      { code: "06-011", name: "Uychi", slug: "uychi", mahallas: [
        { code: "06-011-0001", name: "Uychi markaz", slug: "uychi-markaz" }
      ]},
      { code: "06-012", name: "Yangiqo'rg'on", slug: "yangiqorgon", mahallas: [
        { code: "06-012-0001", name: "Yangiqo'rg'on markaz", slug: "yangiqorgon-markaz" }
      ]}
    ]
  },
  {
    code: "07", name: "Navoiy", slug: "navoiy",
    tumans: [
      { code: "07-001", name: "Navoiy shahar", slug: "navoiy-shahar", mahallas: [
        { code: "07-001-0001", name: "Navoiy markaz", slug: "navoiy-markaz" }
      ]},
      { code: "07-002", name: "Karmana", slug: "karmana", mahallas: [
        { code: "07-002-0001", name: "Karmana markaz", slug: "karmana-markaz" },
        { code: "07-002-0045", name: "Yangiobod", slug: "yangiobod" }
      ]},
      { code: "07-003", name: "Konimex", slug: "konimex", mahallas: [
        { code: "07-003-0001", name: "Konimex markaz", slug: "konimex-markaz" }
      ]},
      { code: "07-004", name: "Navbahor", slug: "navbahor", mahallas: [
        { code: "07-004-0001", name: "Navbahor markaz", slug: "navbahor-markaz" }
      ]},
      { code: "07-005", name: "Nurota", slug: "nurota", mahallas: [
        { code: "07-005-0001", name: "Nurota markaz", slug: "nurota-markaz" }
      ]},
      { code: "07-006", name: "Qiziltepa", slug: "qiziltepa", mahallas: [
        { code: "07-006-0001", name: "Qiziltepa markaz", slug: "qiziltepa-markaz" }
      ]},
      { code: "07-007", name: "Tomdi", slug: "tomdi", mahallas: [
        { code: "07-007-0001", name: "Tomdi markaz", slug: "tomdi-markaz" }
      ]},
      { code: "07-008", name: "Uchquduq", slug: "uchquduq", mahallas: [
        { code: "07-008-0001", name: "Uchquduq markaz", slug: "uchquduq-markaz" }
      ]},
      { code: "07-009", name: "Xatirchi", slug: "xatirchi", mahallas: [
        { code: "07-009-0001", name: "Xatirchi markaz", slug: "xatirchi-markaz" }
      ]},
      { code: "07-010", name: "Zarafshon shahar", slug: "zarafshon-shahar", mahallas: [
        { code: "07-010-0001", name: "Zarafshon shahar markaz", slug: "zarafshon-shahar-markaz" }
      ]}
    ]
  },
  {
    code: "08", name: "Samarqand", slug: "samarqand",
    tumans: [
      { code: "08-001", name: "Samarqand shahar", slug: "samarqand-shahar", mahallas: [
        { code: "08-001-0001", name: "Registon mahallasi", slug: "registon" },
        { code: "08-001-0002", name: "Siyob bozor", slug: "siyob" }
      ]},
      { code: "08-002", name: "Urgut", slug: "urgut", mahallas: [
        { code: "08-002-0001", name: "Urgut markaz", slug: "urgut-markaz" }
      ]},
      { code: "08-003", name: "Samarqand tumani", slug: "samarqand-tumani", mahallas: [
        { code: "08-003-0001", name: "Samarqand tumani markaz", slug: "samarqand-tumani-markaz" }
      ]},
      { code: "08-004", name: "Bulung'ur", slug: "bulungur", mahallas: [
        { code: "08-004-0001", name: "Bulung'ur markaz", slug: "bulungur-markaz" }
      ]},
      { code: "08-005", name: "Ishtixon", slug: "ishtixon", mahallas: [
        { code: "08-005-0001", name: "Ishtixon markaz", slug: "ishtixon-markaz" }
      ]},
      { code: "08-006", name: "Jomboy", slug: "jomboy", mahallas: [
        { code: "08-006-0001", name: "Jomboy markaz", slug: "jomboy-markaz" }
      ]},
      { code: "08-007", name: "Kattaqo'rg'on", slug: "kattaqorgon", mahallas: [
        { code: "08-007-0001", name: "Kattaqo'rg'on markaz", slug: "kattaqorgon-markaz" }
      ]},
      { code: "08-008", name: "Kattaqo'rg'on shahar", slug: "kattaqorgon-shahar", mahallas: [
        { code: "08-008-0001", name: "Kattaqo'rg'on shahar markaz", slug: "kattaqorgon-shahar-markaz" }
      ]},
      { code: "08-009", name: "Narpay", slug: "narpay", mahallas: [
        { code: "08-009-0001", name: "Narpay markaz", slug: "narpay-markaz" }
      ]},
      { code: "08-010", name: "Nurobod", slug: "nurobod", mahallas: [
        { code: "08-010-0001", name: "Nurobod markaz", slug: "nurobod-markaz" }
      ]},
      { code: "08-011", name: "Oqdaryo", slug: "oqdaryo", mahallas: [
        { code: "08-011-0001", name: "Oqdaryo markaz", slug: "oqdaryo-markaz" }
      ]},
      { code: "08-012", name: "Pastdarg'om", slug: "pastdargom", mahallas: [
        { code: "08-012-0001", name: "Pastdarg'om markaz", slug: "pastdargom-markaz" }
      ]},
      { code: "08-013", name: "Payariq", slug: "payariq", mahallas: [
        { code: "08-013-0001", name: "Payariq markaz", slug: "payariq-markaz" }
      ]},
      { code: "08-014", name: "Paxtachi", slug: "paxtachi", mahallas: [
        { code: "08-014-0001", name: "Paxtachi markaz", slug: "paxtachi-markaz" }
      ]},
      { code: "08-015", name: "Qo'shrabot", slug: "qoshrabot", mahallas: [
        { code: "08-015-0001", name: "Qo'shrabot markaz", slug: "qoshrabot-markaz" }
      ]},
      { code: "08-016", name: "Tayloq", slug: "tayloq", mahallas: [
        { code: "08-016-0001", name: "Tayloq markaz", slug: "tayloq-markaz" }
      ]}
    ]
  },
  {
    code: "09", name: "Sirdaryo", slug: "sirdaryo",
    tumans: [
      { code: "09-001", name: "Guliston shahar", slug: "guliston-shahar", mahallas: [
        { code: "09-001-0001", name: "Guliston markaz", slug: "guliston-markaz" }
      ]},
      { code: "09-002", name: "Sardoba", slug: "sardoba", mahallas: [
        { code: "09-002-0001", name: "Sardoba markaz", slug: "sardoba-markaz" }
      ]},
      { code: "09-003", name: "Guliston tumani", slug: "guliston-tumani", mahallas: [
        { code: "09-003-0001", name: "Guliston tumani markaz", slug: "guliston-tumani-markaz" }
      ]},
      { code: "09-004", name: "Boyovut", slug: "boyovut", mahallas: [
        { code: "09-004-0001", name: "Boyovut markaz", slug: "boyovut-markaz" }
      ]},
      { code: "09-005", name: "Mirzaobod", slug: "mirzaobod", mahallas: [
        { code: "09-005-0001", name: "Mirzaobod markaz", slug: "mirzaobod-markaz" }
      ]},
      { code: "09-006", name: "Oqoltin", slug: "oqoltin", mahallas: [
        { code: "09-006-0001", name: "Oqoltin markaz", slug: "oqoltin-markaz" }
      ]},
      { code: "09-007", name: "Sayxunobod", slug: "sayxunobod", mahallas: [
        { code: "09-007-0001", name: "Sayxunobod markaz", slug: "sayxunobod-markaz" }
      ]},
      { code: "09-008", name: "Sirdaryo tumani", slug: "sirdaryo-tumani", mahallas: [
        { code: "09-008-0001", name: "Sirdaryo tumani markaz", slug: "sirdaryo-tumani-markaz" }
      ]},
      { code: "09-009", name: "Xovos", slug: "xovos", mahallas: [
        { code: "09-009-0001", name: "Xovos markaz", slug: "xovos-markaz" }
      ]},
      { code: "09-010", name: "Yangiyer shahar", slug: "yangiyer-shahar", mahallas: [
        { code: "09-010-0001", name: "Yangiyer shahar markaz", slug: "yangiyer-shahar-markaz" }
      ]},
      { code: "09-011", name: "Shirin shahar", slug: "shirin-shahar", mahallas: [
        { code: "09-011-0001", name: "Shirin shahar markaz", slug: "shirin-shahar-markaz" }
      ]}
    ]
  },
  {
    code: "10", name: "Surxondaryo", slug: "surxondaryo",
    tumans: [
      { code: "10-001", name: "Termiz shahar", slug: "termiz-shahar", mahallas: [
        { code: "10-001-0001", name: "Termiz markaz", slug: "termiz-markaz" }
      ]},
      { code: "10-002", name: "Denov", slug: "denov", mahallas: [
        { code: "10-002-0001", name: "Denov markaz", slug: "denov-markaz" }
      ]},
      { code: "10-003", name: "Termiz tumani", slug: "termiz-tumani", mahallas: [
        { code: "10-003-0001", name: "Termiz tumani markaz", slug: "termiz-tumani-markaz" }
      ]},
      { code: "10-004", name: "Angor", slug: "angor", mahallas: [
        { code: "10-004-0001", name: "Angor markaz", slug: "angor-markaz" }
      ]},
      { code: "10-005", name: "Bandixon", slug: "bandixon", mahallas: [
        { code: "10-005-0001", name: "Bandixon markaz", slug: "bandixon-markaz" }
      ]},
      { code: "10-006", name: "Boysun", slug: "boysun", mahallas: [
        { code: "10-006-0001", name: "Boysun markaz", slug: "boysun-markaz" }
      ]},
      { code: "10-007", name: "Jarqo'rg'on", slug: "jarqorgon", mahallas: [
        { code: "10-007-0001", name: "Jarqo'rg'on markaz", slug: "jarqorgon-markaz" }
      ]},
      { code: "10-008", name: "Qiziriq", slug: "qiziriq", mahallas: [
        { code: "10-008-0001", name: "Qiziriq markaz", slug: "qiziriq-markaz" }
      ]},
      { code: "10-009", name: "Qumqo'rg'on", slug: "qumqorgon", mahallas: [
        { code: "10-009-0001", name: "Qumqo'rg'on markaz", slug: "qumqorgon-markaz" }
      ]},
      { code: "10-010", name: "Muzrabot", slug: "muzrabot", mahallas: [
        { code: "10-010-0001", name: "Muzrabot markaz", slug: "muzrabot-markaz" }
      ]},
      { code: "10-011", name: "Oltinsoy", slug: "oltinsoy", mahallas: [
        { code: "10-011-0001", name: "Oltinsoy markaz", slug: "oltinsoy-markaz" }
      ]},
      { code: "10-012", name: "Sariosiyo", slug: "sariosiyo", mahallas: [
        { code: "10-012-0001", name: "Sariosiyo markaz", slug: "sariosiyo-markaz" }
      ]},
      { code: "10-013", name: "Sherobod", slug: "sherobod", mahallas: [
        { code: "10-013-0001", name: "Sherobod markaz", slug: "sherobod-markaz" }
      ]},
      { code: "10-014", name: "Sho'rchi", slug: "shorchi", mahallas: [
        { code: "10-014-0001", name: "Sho'rchi markaz", slug: "shorchi-markaz" }
      ]},
      { code: "10-015", name: "Uzun", slug: "uzun", mahallas: [
        { code: "10-015-0001", name: "Uzun markaz", slug: "uzun-markaz" }
      ]}
    ]
  },
  {
    code: "11", name: "Toshkent viloyati", slug: "toshkent-viloyati",
    tumans: [
      { code: "11-001", name: "Nurafshon", slug: "nurafshon", mahallas: [
        { code: "11-001-0001", name: "Nurafshon markaz", slug: "nurafshon-markaz" }
      ]},
      { code: "11-002", name: "Chirchiq", slug: "chirchiq", mahallas: [
        { code: "11-002-0001", name: "Chirchiq markaz", slug: "chirchiq-markaz" }
      ]},
      { code: "11-003", name: "Nurafshon shahar", slug: "nurafshon-shahar", mahallas: [
        { code: "11-003-0001", name: "Nurafshon shahar markaz", slug: "nurafshon-shahar-markaz" }
      ]},
      { code: "11-004", name: "Angren shahar", slug: "angren-shahar", mahallas: [
        { code: "11-004-0001", name: "Angren shahar markaz", slug: "angren-shahar-markaz" }
      ]},
      { code: "11-005", name: "Bekobod shahar", slug: "bekobod-shahar", mahallas: [
        { code: "11-005-0001", name: "Bekobod shahar markaz", slug: "bekobod-shahar-markaz" }
      ]},
      { code: "11-006", name: "Chirchiq shahar", slug: "chirchiq-shahar", mahallas: [
        { code: "11-006-0001", name: "Chirchiq shahar markaz", slug: "chirchiq-shahar-markaz" }
      ]},
      { code: "11-007", name: "Olmaliq shahar", slug: "olmaliq-shahar", mahallas: [
        { code: "11-007-0001", name: "Olmaliq shahar markaz", slug: "olmaliq-shahar-markaz" }
      ]},
      { code: "11-008", name: "Yangiyo'l shahar", slug: "yangiyol-shahar", mahallas: [
        { code: "11-008-0001", name: "Yangiyo'l shahar markaz", slug: "yangiyol-shahar-markaz" }
      ]},
      { code: "11-009", name: "Bekobod tumani", slug: "bekobod-tumani", mahallas: [
        { code: "11-009-0001", name: "Bekobod tumani markaz", slug: "bekobod-tumani-markaz" }
      ]},
      { code: "11-010", name: "Bo'ka", slug: "boka", mahallas: [
        { code: "11-010-0001", name: "Bo'ka markaz", slug: "boka-markaz" }
      ]},
      { code: "11-011", name: "Bo'stonliq", slug: "bostonliq", mahallas: [
        { code: "11-011-0001", name: "Bo'stonliq markaz", slug: "bostonliq-markaz" }
      ]},
      { code: "11-012", name: "Chinoz", slug: "chinoz", mahallas: [
        { code: "11-012-0001", name: "Chinoz markaz", slug: "chinoz-markaz" }
      ]},
      { code: "11-013", name: "Qibray", slug: "qibray", mahallas: [
        { code: "11-013-0001", name: "Qibray markaz", slug: "qibray-markaz" }
      ]},
      { code: "11-014", name: "Ohangaron", slug: "ohangaron", mahallas: [
        { code: "11-014-0001", name: "Ohangaron markaz", slug: "ohangaron-markaz" }
      ]},
      { code: "11-015", name: "Oqqo'rg'on", slug: "oqqorgon", mahallas: [
        { code: "11-015-0001", name: "Oqqo'rg'on markaz", slug: "oqqorgon-markaz" }
      ]},
      { code: "11-016", name: "Parkent", slug: "parkent", mahallas: [
        { code: "11-016-0001", name: "Parkent markaz", slug: "parkent-markaz" }
      ]},
      { code: "11-017", name: "Piskent", slug: "piskent", mahallas: [
        { code: "11-017-0001", name: "Piskent markaz", slug: "piskent-markaz" }
      ]},
      { code: "11-018", name: "Quyichirchiq", slug: "quyichirchiq", mahallas: [
        { code: "11-018-0001", name: "Quyichirchiq markaz", slug: "quyichirchiq-markaz" }
      ]},
      { code: "11-019", name: "O'rtachirchiq", slug: "ortachirchiq", mahallas: [
        { code: "11-019-0001", name: "O'rtachirchiq markaz", slug: "ortachirchiq-markaz" }
      ]},
      { code: "11-020", name: "Yangiyo'l tumani", slug: "yangiyol-tumani", mahallas: [
        { code: "11-020-0001", name: "Yangiyo'l tumani markaz", slug: "yangiyol-tumani-markaz" }
      ]},
      { code: "11-021", name: "Yuqorichirchiq", slug: "yuqorichirchiq", mahallas: [
        { code: "11-021-0001", name: "Yuqorichirchiq markaz", slug: "yuqorichirchiq-markaz" }
      ]},
      { code: "11-022", name: "Zangiota", slug: "zangiota", mahallas: [
        { code: "11-022-0001", name: "Zangiota markaz", slug: "zangiota-markaz" }
      ]}
    ]
  },
  {
    code: "12", name: "Farg'ona", slug: "fargona",
    tumans: [
      { code: "12-001", name: "Farg'ona shahar", slug: "fargona-shahar", mahallas: [
        { code: "12-001-0001", name: "Farg'ona markaz", slug: "fargona-markaz" }
      ]},
      { code: "12-002", name: "Qo'qon", slug: "qoqon", mahallas: [
        { code: "12-002-0001", name: "Qo'qon markaz", slug: "qoqon-markaz" }
      ]},
      { code: "12-003", name: "Marg'ilon shahar", slug: "margilon-shahar", mahallas: [
        { code: "12-003-0001", name: "Marg'ilon shahar markaz", slug: "margilon-shahar-markaz" }
      ]},
      { code: "12-004", name: "Quvasoy shahar", slug: "quvasoy-shahar", mahallas: [
        { code: "12-004-0001", name: "Quvasoy shahar markaz", slug: "quvasoy-shahar-markaz" }
      ]},
      { code: "12-005", name: "Beshariq", slug: "beshariq", mahallas: [
        { code: "12-005-0001", name: "Beshariq markaz", slug: "beshariq-markaz" }
      ]},
      { code: "12-006", name: "Bog'dod", slug: "bogdod", mahallas: [
        { code: "12-006-0001", name: "Bog'dod markaz", slug: "bogdod-markaz" }
      ]},
      { code: "12-007", name: "Buvayda", slug: "buvayda", mahallas: [
        { code: "12-007-0001", name: "Buvayda markaz", slug: "buvayda-markaz" }
      ]},
      { code: "12-008", name: "Dang'ara", slug: "dangara", mahallas: [
        { code: "12-008-0001", name: "Dang'ara markaz", slug: "dangara-markaz" }
      ]},
      { code: "12-009", name: "Farg'ona tumani", slug: "fargona-tumani", mahallas: [
        { code: "12-009-0001", name: "Farg'ona tumani markaz", slug: "fargona-tumani-markaz" }
      ]},
      { code: "12-010", name: "Furqat", slug: "furqat", mahallas: [
        { code: "12-010-0001", name: "Furqat markaz", slug: "furqat-markaz" }
      ]},
      { code: "12-011", name: "Oltiariq", slug: "oltiariq", mahallas: [
        { code: "12-011-0001", name: "Oltiariq markaz", slug: "oltiariq-markaz" }
      ]},
      { code: "12-012", name: "O'zbekiston", slug: "ozbekiston", mahallas: [
        { code: "12-012-0001", name: "O'zbekiston markaz", slug: "ozbekiston-markaz" }
      ]},
      { code: "12-013", name: "Qo'shtepa", slug: "qoshtepa", mahallas: [
        { code: "12-013-0001", name: "Qo'shtepa markaz", slug: "qoshtepa-markaz" }
      ]},
      { code: "12-014", name: "Quva", slug: "quva", mahallas: [
        { code: "12-014-0001", name: "Quva markaz", slug: "quva-markaz" }
      ]},
      { code: "12-015", name: "Rishton", slug: "rishton", mahallas: [
        { code: "12-015-0001", name: "Rishton markaz", slug: "rishton-markaz" }
      ]},
      { code: "12-016", name: "So'x", slug: "sox", mahallas: [
        { code: "12-016-0001", name: "So'x markaz", slug: "sox-markaz" }
      ]},
      { code: "12-017", name: "Toshloq", slug: "toshloq", mahallas: [
        { code: "12-017-0001", name: "Toshloq markaz", slug: "toshloq-markaz" }
      ]},
      { code: "12-018", name: "Uchko'prik", slug: "uchkoprik", mahallas: [
        { code: "12-018-0001", name: "Uchko'prik markaz", slug: "uchkoprik-markaz" }
      ]},
      { code: "12-019", name: "Yozyovon", slug: "yozyovon", mahallas: [
        { code: "12-019-0001", name: "Yozyovon markaz", slug: "yozyovon-markaz" }
      ]}
    ]
  },
  {
    code: "13", name: "Xorazm", slug: "xorazm",
    tumans: [
      { code: "13-001", name: "Urganch shahar", slug: "urganch-shahar", mahallas: [
        { code: "13-001-0001", name: "Urganch markaz", slug: "urganch-markaz" }
      ]},
      { code: "13-002", name: "Xiva", slug: "xiva", mahallas: [
        { code: "13-002-0001", name: "Ichan qal'a", slug: "ichan-qala" }
      ]},
      { code: "13-003", name: "Urganch tumani", slug: "urganch-tumani", mahallas: [
        { code: "13-003-0001", name: "Urganch tumani markaz", slug: "urganch-tumani-markaz" }
      ]},
      { code: "13-004", name: "Bog'ot", slug: "bogot", mahallas: [
        { code: "13-004-0001", name: "Bog'ot markaz", slug: "bogot-markaz" }
      ]},
      { code: "13-005", name: "Gurlan", slug: "gurlan", mahallas: [
        { code: "13-005-0001", name: "Gurlan markaz", slug: "gurlan-markaz" }
      ]},
      { code: "13-006", name: "Xonqa", slug: "xonqa", mahallas: [
        { code: "13-006-0001", name: "Xonqa markaz", slug: "xonqa-markaz" }
      ]},
      { code: "13-007", name: "Hazorasp", slug: "hazorasp", mahallas: [
        { code: "13-007-0001", name: "Hazorasp markaz", slug: "hazorasp-markaz" }
      ]},
      { code: "13-008", name: "Xiva shahar", slug: "xiva-shahar", mahallas: [
        { code: "13-008-0001", name: "Xiva shahar markaz", slug: "xiva-shahar-markaz" }
      ]},
      { code: "13-009", name: "Qo'shko'pir", slug: "qoshkopir", mahallas: [
        { code: "13-009-0001", name: "Qo'shko'pir markaz", slug: "qoshkopir-markaz" }
      ]},
      { code: "13-010", name: "Shovot", slug: "shovot", mahallas: [
        { code: "13-010-0001", name: "Shovot markaz", slug: "shovot-markaz" }
      ]},
      { code: "13-011", name: "Yangiariq", slug: "yangiariq", mahallas: [
        { code: "13-011-0001", name: "Yangiariq markaz", slug: "yangiariq-markaz" }
      ]},
      { code: "13-012", name: "Yangibozor", slug: "yangibozor", mahallas: [
        { code: "13-012-0001", name: "Yangibozor markaz", slug: "yangibozor-markaz" }
      ]},
      { code: "13-013", name: "Tuproqqal'a", slug: "tuproqqala", mahallas: [
        { code: "13-013-0001", name: "Tuproqqal'a markaz", slug: "tuproqqala-markaz" }
      ]}
    ]
  },
  {
    code: "14", name: "Toshkent shahar", slug: "toshkent",
    tumans: [
      { code: "14-001", name: "Chilonzor", slug: "chilonzor", mahallas: [
        { code: "14-001-0001", name: "Chilonzor-1", slug: "chilonzor-1" },
        { code: "14-001-0002", name: "Chilonzor-2", slug: "chilonzor-2" }
      ]},
      { code: "14-002", name: "Yakkasaroy", slug: "yakkasaroy", mahallas: [
        { code: "14-002-0001", name: "Yakkasaroy markaz", slug: "yakkasaroy-markaz" }
      ]},
      { code: "14-003", name: "Shayxontohur", slug: "shayxontohur", mahallas: [
        { code: "14-003-0001", name: "Shayxontohur markaz", slug: "shayxontohur-markaz" }
      ]},
      { code: "14-004", name: "Mirzo Ulug'bek", slug: "mirzo-ulugbek", mahallas: [
        { code: "14-004-0001", name: "Mirzo Ulug'bek markaz", slug: "mirzo-ulugbek-markaz" }
      ]},
      { code: "14-005", name: "Yunusobod", slug: "yunusobod", mahallas: [
        { code: "14-005-0001", name: "Yunusobod markaz", slug: "yunusobod-markaz" }
      ]},
      { code: "14-006", name: "Bektemir", slug: "bektemir", mahallas: [
        { code: "14-006-0001", name: "Bektemir markaz", slug: "bektemir-markaz" }
      ]},
      { code: "14-007", name: "Mirobod", slug: "mirobod", mahallas: [
        { code: "14-007-0001", name: "Mirobod markaz", slug: "mirobod-markaz" }
      ]},
      { code: "14-008", name: "Olmazor", slug: "olmazor", mahallas: [
        { code: "14-008-0001", name: "Olmazor markaz", slug: "olmazor-markaz" }
      ]},
      { code: "14-009", name: "Sergeli", slug: "sergeli", mahallas: [
        { code: "14-009-0001", name: "Sergeli markaz", slug: "sergeli-markaz" }
      ]},
      { code: "14-010", name: "Uchtepa", slug: "uchtepa", mahallas: [
        { code: "14-010-0001", name: "Uchtepa markaz", slug: "uchtepa-markaz" }
      ]},
      { code: "14-011", name: "Yashnobod", slug: "yashnobod", mahallas: [
        { code: "14-011-0001", name: "Yashnobod markaz", slug: "yashnobod-markaz" }
      ]},
      { code: "14-012", name: "Yangihayot", slug: "yangihayot", mahallas: [
        { code: "14-012-0001", name: "Yangihayot markaz", slug: "yangihayot-markaz" }
      ]}
    ]
  }
];

async function seedGeo() {
  let viloyatCount = 0, tumanCount = 0, mahallaCount = 0;
  for (const v of GEO_DATA) {
    const viloyat = await prisma.viloyat.upsert({
      where: { code: v.code },
      create: { code: v.code, name: v.name, slug: v.slug },
      update: { name: v.name, slug: v.slug }
    });
    viloyatCount++;

    for (const t of v.tumans) {
      const tuman = await prisma.tuman.upsert({
        where: { code: t.code },
        create: { code: t.code, name: t.name, slug: t.slug, viloyatId: viloyat.id },
        update: { name: t.name, slug: t.slug }
      });
      tumanCount++;

      for (const m of t.mahallas) {
        await prisma.mahalla.upsert({
          where: { code: m.code },
          create: { code: m.code, name: m.name, slug: m.slug, tumanId: tuman.id },
          update: { name: m.name, slug: m.slug }
        });
        mahallaCount++;
      }
    }
  }
  console.log(`✅ Geo: ${viloyatCount} viloyat, ${tumanCount} tuman, ${mahallaCount} mahalla`);
}

async function seedDemoData() {
  const toshkent = await prisma.viloyat.findUnique({ where: { code: "14" } });
  const chilonzor = await prisma.tuman.findUnique({ where: { code: "14-001" } });
  const mahalla = await prisma.mahalla.findUnique({ where: { code: "14-001-0001" } });
  const navoiy = await prisma.viloyat.findUnique({ where: { code: "07" } });
  const karmana = await prisma.tuman.findUnique({ where: { code: "07-002" } });
  const yangiobod = await prisma.mahalla.findUnique({ where: { code: "07-002-0045" } });
  const samarqand = await prisma.viloyat.findUnique({ where: { code: "08" } });
  const samarqandSh = await prisma.tuman.findUnique({ where: { code: "08-001" } });

  if (!toshkent || !chilonzor || !mahalla) {
    console.log("⚠️  Geo data not found, skipping demo data");
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // ── Addresses ─────────────────────────────────────────────────────────
  const addr1 = await prisma.address.upsert({
    where: { id: "demo-address-001" },
    create: { id: "demo-address-001", viloyatId: toshkent!.id, tumanId: chilonzor!.id, mahallaId: mahalla!.id, street: "Mustaqillik", house: "12", apartment: "34" },
    update: {}
  });
  const addr2 = await prisma.address.upsert({
    where: { id: "demo-address-002" },
    create: { id: "demo-address-002", viloyatId: toshkent!.id, tumanId: chilonzor!.id, mahallaId: mahalla!.id, street: "Buyuk Ipak yo'li", house: "5", apartment: "1" },
    update: {}
  });
  const addr3 = navoiy && karmana && yangiobod ? await prisma.address.upsert({
    where: { id: "demo-address-003" },
    create: { id: "demo-address-003", viloyatId: navoiy.id, tumanId: karmana.id, mahallaId: yangiobod.id, street: "Navoiy ko'chasi", house: "7", apartment: "2" },
    update: {}
  }) : addr1;

  // ── Libraries (5 type) ────────────────────────────────────────────────
  const libGov = await prisma.library.upsert({
    where: { code: "LIB-GOV-14001-001" },
    create: { code: "LIB-GOV-14001-001", type: LibraryType.GOV, name: "Chilonzor tuman kutubxonasi", regionId: "UZ-14-001", tumanId: chilonzor!.id, viloyatId: toshkent!.id, status: LibraryStatus.ACTIVE, fundCount: 350 },
    update: { fundCount: 350, tumanId: chilonzor!.id, viloyatId: toshkent!.id }
  });
  const libSch = await prisma.library.upsert({
    where: { code: "LIB-SCH-14001-008" },
    create: { code: "LIB-SCH-14001-008", type: LibraryType.SCH, name: "8-maktab kutubxonasi", regionId: "UZ-14-001", tumanId: chilonzor!.id, viloyatId: toshkent!.id, status: LibraryStatus.ACTIVE, fundCount: 120 },
    update: { fundCount: 120 }
  });
  const libUni = await prisma.library.upsert({
    where: { code: "LIB-UNI-14001-001" },
    create: { code: "LIB-UNI-14001-001", type: LibraryType.UNI, name: "TDTU kutubxonasi", regionId: "UZ-14-001", tumanId: chilonzor!.id, viloyatId: toshkent!.id, status: LibraryStatus.ACTIVE, fundCount: 500 },
    update: { fundCount: 500 }
  });
  const libOrg = await prisma.library.upsert({
    where: { code: "LIB-ORG-14001-001" },
    create: { code: "LIB-ORG-14001-001", type: LibraryType.ORG, name: "Yoshlar ishlari agentligi kutubxonasi", regionId: "UZ-14-001", tumanId: chilonzor!.id, viloyatId: toshkent!.id, status: LibraryStatus.ACTIVE, fundCount: 80 },
    update: { fundCount: 80 }
  });
  const libMah = await prisma.library.upsert({
    where: { code: "LIB-MAH-14001-0001" },
    create: { code: "LIB-MAH-14001-0001", type: LibraryType.MAH, name: "Chilonzor-1 mahalla kutubxonasi", regionId: "UZ-14-001", tumanId: chilonzor!.id, viloyatId: toshkent!.id, status: LibraryStatus.ACTIVE, fundCount: 45 },
    update: { fundCount: 45 }
  });

  // ── Institution (maktab) ──────────────────────────────────────────────
  const maktab = await prisma.institution.upsert({
    where: { code: "MAKTAB-14001-008" },
    create: { code: "MAKTAB-14001-008", type: "MAKTAB", name: "Chilonzor 8-maktab", tumanId: chilonzor!.id, viloyatId: toshkent!.id, libraryId: libSch.id },
    update: {}
  });

  // ── Institution (idora) ───────────────────────────────────────────────
  const idora = await prisma.institution.upsert({
    where: { code: "IDORA-14001-001" },
    create: { code: "IDORA-14001-001", type: "IDORA", name: "Yoshlar ishlari agentligi", tumanId: chilonzor!.id, viloyatId: toshkent!.id, libraryId: libOrg.id },
    update: {}
  });

  // ── Institution (OTM) ─────────────────────────────────────────────────
  // Mirrors the maktab/idora institutions: links to the existing TDTU
  // LIB-UNI library so the OTM panel (OtmService — resolves students by
  // User.universityId == institution.id) and OTM stats resolve. Without
  // this Institution row the OTM panel + stats were empty even though the
  // LIB-UNI-14001-001 library existed.
  const otm = await prisma.institution.upsert({
    where: { code: "OTM-14001-001" },
    create: { code: "OTM-14001-001", type: "OTM", name: "Toshkent Davlat Texnika Universiteti (TDTU)", tumanId: chilonzor!.id, viloyatId: toshkent!.id, libraryId: libUni.id },
    update: { libraryId: libUni.id, tumanId: chilonzor!.id, viloyatId: toshkent!.id }
  });

  // ── OTM talabalar (STUDENT_UNIVERSITY) ────────────────────────────────
  // OtmService.getStudents/getOtmStats filter on { universityId, type:
  // STUDENT_UNIVERSITY }. faculty/direction/studyCourse drive the byFaculty
  // / byCourse buckets. role KITOBXON + status ACTIVE so they show as active.
  const uniStudent1 = await prisma.user.upsert({
    where: { phone: "+998901234570" },
    create: { phone: "+998901234570", passwordHash, name: "Sanjar Yusupov", dob: new Date("2004-03-12"), gender: UserGender.MALE, type: UserType.STUDENT_UNIVERSITY, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00004", trustScore: 60, addressId: addr2.id, universityId: otm.id, faculty: "Kompyuter injiniringi", direction: "Dasturiy injiniring", studyCourse: 2 },
    update: { passwordHash, type: UserType.STUDENT_UNIVERSITY, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, universityId: otm.id, faculty: "Kompyuter injiniringi", direction: "Dasturiy injiniring", studyCourse: 2 }
  });
  const uniStudent2 = await prisma.user.upsert({
    where: { phone: "+998901234571" },
    create: { phone: "+998901234571", passwordHash, name: "Gulnoza Ismoilova", dob: new Date("2003-09-25"), gender: UserGender.FEMALE, type: UserType.STUDENT_UNIVERSITY, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00005", trustScore: 68, addressId: addr2.id, universityId: otm.id, faculty: "Energetika", direction: "Elektr energetikasi", studyCourse: 3 },
    update: { passwordHash, type: UserType.STUDENT_UNIVERSITY, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, universityId: otm.id, faculty: "Energetika", direction: "Elektr energetikasi", studyCourse: 3 }
  });
  const uniStudent3 = await prisma.user.upsert({
    where: { phone: "+998901234572" },
    create: { phone: "+998901234572", passwordHash, name: "Doston Rahmonov", dob: new Date("2004-11-08"), gender: UserGender.MALE, type: UserType.STUDENT_UNIVERSITY, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00006", trustScore: 63, addressId: addr2.id, universityId: otm.id, faculty: "Kompyuter injiniringi", direction: "Sun'iy intellekt", studyCourse: 1 },
    update: { passwordHash, type: UserType.STUDENT_UNIVERSITY, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, universityId: otm.id, faculty: "Kompyuter injiniringi", direction: "Sun'iy intellekt", studyCourse: 1 }
  });

  // Qo'shimcha talabalar — fakultet kesimi k-anonimlik chegarasidan (5)
  // o'tishi uchun. Uchta talaba bilan OtmService har bir fakultet
  // o'rtachasini `null` qaytarardi va akkreditatsiya paneli bo'sh ko'rinardi.
  // Mavjud 3 talaba bilan birga: Kompyuter injiniringi 6, Energetika 6.
  const uniExtraSpecs = [
    { n: "Nodirbek Xolmatov", g: UserGender.MALE, f: "Kompyuter injiniringi", d: "Dasturiy injiniring", c: 3 },
    { n: "Sarvinoz Alimova", g: UserGender.FEMALE, f: "Kompyuter injiniringi", d: "Kiberxavfsizlik", c: 2 },
    { n: "Behruz Qurbonov", g: UserGender.MALE, f: "Kompyuter injiniringi", d: "Sun'iy intellekt", c: 4 },
    { n: "Dilnoza Yusupova", g: UserGender.FEMALE, f: "Kompyuter injiniringi", d: "Dasturiy injiniring", c: 1 },
    { n: "Aziza Tursunova", g: UserGender.FEMALE, f: "Energetika", d: "Elektr energetikasi", c: 2 },
    { n: "Shohruh Ergashev", g: UserGender.MALE, f: "Energetika", d: "Qayta tiklanuvchi energiya", c: 4 },
    { n: "Kamila Rasulova", g: UserGender.FEMALE, f: "Energetika", d: "Issiqlik energetikasi", c: 1 },
    { n: "Temur Sodiqov", g: UserGender.MALE, f: "Energetika", d: "Elektr energetikasi", c: 3 },
    { n: "Zarina Bekmurodova", g: UserGender.FEMALE, f: "Energetika", d: "Qayta tiklanuvchi energiya", c: 2 },
  ];
  const uniExtras = [];
  for (let i = 0; i < uniExtraSpecs.length; i++) {
    const s = uniExtraSpecs[i];
    const phone = `+9989110004${String(i + 1).padStart(2, "0")}`;
    uniExtras.push(
      await prisma.user.upsert({
        where: { phone },
        create: {
          phone, passwordHash, name: s.n,
          dob: new Date(`${2002 + (i % 4)}-0${(i % 9) + 1}-1${i % 9}`),
          gender: s.g, type: UserType.STUDENT_UNIVERSITY, role: UserRole.KITOBXON,
          status: UserStatus.ACTIVE,
          sifatId: `SL-UZ-14-001-0001-005${String(i + 1).padStart(2, "0")}`,
          trustScore: 52 + ((i * 6) % 40),
          addressId: addr2.id,
          universityId: otm.id, faculty: s.f, direction: s.d, studyCourse: s.c,
        },
        update: {
          passwordHash, universityId: otm.id, faculty: s.f, direction: s.d,
          studyCourse: s.c, status: UserStatus.ACTIVE,
        },
      }),
    );
  }
  for (let i = 0; i < uniExtras.length; i++) {
    const id = `demo-ri-uni-${i}`;
    const existing = await prisma.readingIndex.findFirst({ where: { id } });
    if (!existing) {
      const score = 50 + ((i * 8) % 40);
      await prisma.readingIndex.create({
        data: {
          id, userId: uniExtras[i].id, score,
          components: { booksCount: score - 10, consistency: score - 5, diversity: score - 15, discipline: score + 5, activity: score },
        },
      });
    }
  }

  // RI for the OTM students so getOtmStats avgRi / coverage is non-zero.
  for (const { id, userId, score } of [
    { id: "demo-ri-006", userId: uniStudent1.id, score: 62 },
    { id: "demo-ri-007", userId: uniStudent2.id, score: 71 },
    { id: "demo-ri-008", userId: uniStudent3.id, score: 48 },
  ]) {
    const existing = await prisma.readingIndex.findFirst({ where: { id } });
    if (!existing) {
      await prisma.readingIndex.create({
        data: { id, userId, score, components: { booksCount: score - 10, consistency: score - 5, diversity: score - 15, discipline: score + 5, activity: score } }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── 9 ROL FOYDALANUVCHILARI ───────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════

  // 1. SUPER_ADMIN — +998900000001
  const superAdmin = await prisma.user.upsert({
    where: { phone: "+998900000001" },
    create: { phone: "+998900000001", passwordHash, name: "Abdulla Karimov", dob: new Date("1985-03-15"), gender: UserGender.MALE, type: UserType.GOVERNMENT_EMPLOYEE, role: UserRole.SUPER_ADMIN, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00100", trustScore: 100, addressId: addr1.id },
    update: { passwordHash, role: UserRole.SUPER_ADMIN }
  });

  // 2. BUXGALTER — +998900000002
  const buxgalter = await prisma.user.upsert({
    where: { phone: "+998900000002" },
    create: { phone: "+998900000002", passwordHash, name: "Malika Rahimova", dob: new Date("1990-07-22"), gender: UserGender.FEMALE, type: UserType.GOVERNMENT_EMPLOYEE, role: UserRole.BUXGALTER, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00101", trustScore: 85, addressId: addr1.id },
    update: { passwordHash, role: UserRole.BUXGALTER }
  });

  // 3. VILOYAT_ADMIN — +998900000003
  const viloyatAdmin = await prisma.user.upsert({
    where: { phone: "+998900000003" },
    create: { phone: "+998900000003", passwordHash, name: "Sardor Toshmatov", dob: new Date("1988-11-05"), gender: UserGender.MALE, type: UserType.GOVERNMENT_EMPLOYEE, role: UserRole.VILOYAT_ADMIN, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00102", trustScore: 90, addressId: addr1.id },
    update: { passwordHash, role: UserRole.VILOYAT_ADMIN }
  });

  // 4. TUMAN_ADMIN — +998900000004
  const tumanAdmin = await prisma.user.upsert({
    where: { phone: "+998900000004" },
    create: { phone: "+998900000004", passwordHash, name: "Dildora Xasanova", dob: new Date("1992-04-18"), gender: UserGender.FEMALE, type: UserType.GOVERNMENT_EMPLOYEE, role: UserRole.TUMAN_ADMIN, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00103", trustScore: 88, addressId: addr2.id },
    update: { passwordHash, role: UserRole.TUMAN_ADMIN }
  });

  // 5. MUASSASA_ADMIN — +998900000005
  const muassasaAdmin = await prisma.user.upsert({
    where: { phone: "+998900000005" },
    // RBAC FIX: maktab MUASSASA_ADMIN'i uchun FK `schoolId` bo'lishi kerak,
    // `organizationId` emas. `assertInstitutionInScope` MAKTAB turi uchun
    // AYNAN `user.schoolId` ni o'qiydi (admin-scope.util.ts) — noto'g'ri
    // ustunda bo'lsa maktab statistikasi 403 qaytarardi. `resolveCallerLibraryId`
    // uchidan ikkalasini ham qabul qilgani sababli xato yashirin qolgan edi.
    create: { phone: "+998900000005", passwordHash, name: "Ravshan Sobirov", dob: new Date("1987-09-30"), gender: UserGender.MALE, type: UserType.TEACHER, role: UserRole.MUASSASA_ADMIN, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00104", trustScore: 82, addressId: addr2.id, schoolId: maktab.id },
    update: { passwordHash, role: UserRole.MUASSASA_ADMIN, schoolId: maktab.id, organizationId: null }
  });

  // 6. KUTUBXONACHI — +998900000006
  // RBAC FIX: link the librarian to the maktab institution so the shared
  // library-scope resolver (Institution.libraryId) resolves to the 8-maktab
  // library. Without this link the librarian's /libraries/mine + subscription
  // /me are empty and they cannot manage their own library. Set on BOTH
  // branches so re-seeds (which hit `update`, the user already exists) persist.
  const kutubxonachi = await prisma.user.upsert({
    where: { phone: "+998900000006" },
    create: { phone: "+998900000006", passwordHash, name: "Nodira Aliyeva", dob: new Date("1995-02-14"), gender: UserGender.FEMALE, type: UserType.GOVERNMENT_EMPLOYEE, role: UserRole.KUTUBXONACHI, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00105", trustScore: 75, addressId: addr2.id, schoolId: maktab.id },
    update: { passwordHash, role: UserRole.KUTUBXONACHI, schoolId: maktab.id, organizationId: null }
  });

  // 7. KLUB_RAHBARI — +998900000007
  const klubRahbari = await prisma.user.upsert({
    where: { phone: "+998900000007" },
    create: { phone: "+998900000007", passwordHash, name: "Ulug'bek Nazarov", dob: new Date("1993-06-25"), gender: UserGender.MALE, type: UserType.TEACHER, role: UserRole.KLUB_RAHBARI, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00106", trustScore: 78, addressId: addr1.id, organizationId: maktab.id },
    update: { passwordHash, role: UserRole.KLUB_RAHBARI }
  });

  // 8. DOKON_OPERATOR — +998900000008
  const dokonOperator = await prisma.user.upsert({
    where: { phone: "+998900000008" },
    create: { phone: "+998900000008", passwordHash, name: "Bekzod Mirzayev", dob: new Date("1991-12-10"), gender: UserGender.MALE, type: UserType.CITIZEN, role: UserRole.DOKON_OPERATOR, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00107", trustScore: 70, addressId: addr1.id },
    update: { passwordHash, role: UserRole.DOKON_OPERATOR }
  });

  // 9. KITOBXON — +998901234567 (original demo user)
  const kitobxon = await prisma.user.upsert({
    where: { phone: "+998901234567" },
    create: { phone: "+998901234567", passwordHash, name: "Aziza Karimova", dob: new Date("2000-01-01"), gender: UserGender.FEMALE, type: UserType.CITIZEN, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00001", trustScore: 65, addressId: addr1.id },
    update: { passwordHash }
  });

  // Extra kitobxon users for family, club, and reyting
  const kitobxon2 = await prisma.user.upsert({
    where: { phone: "+998901234568" },
    create: { phone: "+998901234568", passwordHash, name: "Jasur Karimov", dob: new Date("1975-05-20"), gender: UserGender.MALE, type: UserType.CITIZEN, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00002", trustScore: 72, addressId: addr1.id },
    update: { passwordHash }
  });
  const student1 = await prisma.user.upsert({
    where: { phone: "+998901234569" },
    create: { phone: "+998901234569", passwordHash, name: "Shaxlo Karimova", dob: new Date("2010-08-15"), gender: UserGender.FEMALE, type: UserType.STUDENT_SCHOOL, role: UserRole.KITOBXON, status: UserStatus.ACTIVE, sifatId: "SL-UZ-14-001-0001-00003", trustScore: 55, addressId: addr1.id, schoolId: maktab.id, schoolClass: "7-A" },
    update: { passwordHash }
  });

  // ── Demo kitobxonlar: maktab o'quvchilari + idora xodimlari + fuqarolar ──
  //
  // Nega bu kerak: bo'sh panel mahsulotni sotmaydi. Maktab direktori "sinf
  // bo'yicha o'quvchilar" ro'yxatini, idora rahbari "bo'lim reytingi"ni
  // ko'rishi kerak. Idora bo'limlarida kamida 5 kishi bo'lishi SHART —
  // IdoraService bo'lim o'rtachasini k-anonimlik chegarasi (5) dan past
  // guruhlar uchun umuman qaytarmaydi (idora.service.ts), aks holda panel
  // "null" ko'rsatardi.
  //
  // Telefonlar +99891100xxxx blokida — mavjud demo raqamlar (+99890...) bilan
  // kesishmaydi. sifatId'lar 00200+ zaxira diapazonida (pastda `lastSeq`
  // shu diapazondan yuqoriga suriladi).
  // Sinflar ATAYLAB ikkitaga jamlangan (har birida 6 o'quvchi). Maktab
  // paneli sinf o'rtachasini k-anonimlik chegarasidan (5 kishi) past
  // guruhlar uchun yashiradi — 12 o'quvchini 7 sinfga tarqatganda HAR BIR
  // qator "Maxfiylik k<5" bo'lib chiqib, demo ko'rsatuvda panel bo'sh
  // tuyulardi. Ikki to'liq sinf haqiqiy o'rtachani ko'rsatadi.
  const SCHOOL_CLASSES = ["7-A", "9-A"];
  const schoolStudentSpecs = [
    { n: "Diyorbek Rasulov", g: UserGender.MALE, y: 2013 },
    { n: "Madina Yo'ldosheva", g: UserGender.FEMALE, y: 2012 },
    { n: "Islombek Tursunov", g: UserGender.MALE, y: 2011 },
    { n: "Zilola Ergasheva", g: UserGender.FEMALE, y: 2011 },
    { n: "Asadbek Qodirov", g: UserGender.MALE, y: 2010 },
    { n: "Nilufar Sattorova", g: UserGender.FEMALE, y: 2010 },
    { n: "Javohir Umarov", g: UserGender.MALE, y: 2009 },
    { n: "Sevinch Abdullayeva", g: UserGender.FEMALE, y: 2009 },
    { n: "Bexruz Sharipov", g: UserGender.MALE, y: 2008 },
    { n: "Robiya Nazarova", g: UserGender.FEMALE, y: 2008 },
    { n: "Otabek Jalilov", g: UserGender.MALE, y: 2007 },
    { n: "Munisa Tosheva", g: UserGender.FEMALE, y: 2007 },
  ];
  const schoolStudents = [];
  for (let i = 0; i < schoolStudentSpecs.length; i++) {
    const s = schoolStudentSpecs[i];
    const phone = `+9989110001${String(i + 1).padStart(2, "0")}`;
    schoolStudents.push(
      await prisma.user.upsert({
        where: { phone },
        create: {
          phone, passwordHash, name: s.n,
          dob: new Date(`${s.y}-0${(i % 9) + 1}-1${i % 9}`),
          gender: s.g, type: UserType.STUDENT_SCHOOL, role: UserRole.KITOBXON,
          status: UserStatus.ACTIVE,
          sifatId: `SL-UZ-14-001-0001-002${String(i + 1).padStart(2, "0")}`,
          trustScore: 45 + ((i * 7) % 45),
          addressId: i % 2 === 0 ? addr1.id : addr2.id,
          schoolId: maktab.id,
          schoolClass: SCHOOL_CLASSES[Math.floor(i / 6) % SCHOOL_CLASSES.length],
        },
        // `schoolClass` ni update'da ham yozamiz — sinf taqsimoti
        // o'zgarganda qayta seed uni tuzatishi kerak (upsert `update`
        // bandiga kirmagan maydon eski qiymatida qolib ketardi).
        update: {
          passwordHash, schoolId: maktab.id, status: UserStatus.ACTIVE,
          schoolClass: SCHOOL_CLASSES[Math.floor(i / 6) % SCHOOL_CLASSES.length],
        },
      }),
    );
  }

  // Idora xodimlari — 2 bo'lim × 6 kishi (k-anonimlik chegarasidan yuqori).
  const ORG_DEPARTMENTS = ["Yoshlar siyosati bo'limi", "Axborot xizmati"];
  const orgEmployeeSpecs = [
    { n: "Sherzod Halimov", g: UserGender.MALE, p: "Bosh mutaxassis" },
    { n: "Kamola Ismoilova", g: UserGender.FEMALE, p: "Yetakchi mutaxassis" },
    { n: "Rustam Bekmurodov", g: UserGender.MALE, p: "Mutaxassis" },
    { n: "Dilafruz Qosimova", g: UserGender.FEMALE, p: "Bo'lim boshlig'i" },
    { n: "Aziz Normatov", g: UserGender.MALE, p: "Mutaxassis" },
    { n: "Gulbahor Yusupova", g: UserGender.FEMALE, p: "Katta mutaxassis" },
    { n: "Sardor Ochilov", g: UserGender.MALE, p: "Bo'lim boshlig'i" },
    { n: "Nigora Xolmatova", g: UserGender.FEMALE, p: "Yetakchi mutaxassis" },
    { n: "Farrux Tolipov", g: UserGender.MALE, p: "Mutaxassis" },
    { n: "Umida Rahmonova", g: UserGender.FEMALE, p: "Katta mutaxassis" },
    { n: "Jamshid Karimov", g: UserGender.MALE, p: "Mutaxassis" },
    { n: "Feruza Sodiqova", g: UserGender.FEMALE, p: "Bosh mutaxassis" },
  ];
  const orgEmployees = [];
  for (let i = 0; i < orgEmployeeSpecs.length; i++) {
    const s = orgEmployeeSpecs[i];
    const phone = `+9989110002${String(i + 1).padStart(2, "0")}`;
    orgEmployees.push(
      await prisma.user.upsert({
        where: { phone },
        create: {
          phone, passwordHash, name: s.n,
          dob: new Date(`${1985 + (i % 12)}-0${(i % 9) + 1}-1${i % 9}`),
          gender: s.g, type: UserType.GOVERNMENT_EMPLOYEE, role: UserRole.KITOBXON,
          status: UserStatus.ACTIVE,
          sifatId: `SL-UZ-14-001-0001-003${String(i + 1).padStart(2, "0")}`,
          trustScore: 55 + ((i * 5) % 40),
          addressId: i % 2 === 0 ? addr2.id : addr1.id,
          organizationId: idora.id,
          // Bo'limlarni 6/6 qilib bo'lamiz — ikkalasi ham k-anonimlik
          // chegarasidan (5) yuqori bo'lishi uchun.
          department: ORG_DEPARTMENTS[Math.floor(i / 6)],
          position: s.p,
        },
        update: { passwordHash, organizationId: idora.id, status: UserStatus.ACTIVE },
      }),
    );
  }

  // Oddiy fuqarolar — davlat/mahalla kutubxonasining doimiy o'quvchilari.
  const citizenSpecs = [
    { n: "Anvar Sobirov", g: UserGender.MALE, y: 1988 },
    { n: "Lola Mirzayeva", g: UserGender.FEMALE, y: 1994 },
    { n: "Ulug'bek Ahmedov", g: UserGender.MALE, y: 1979 },
    { n: "Shahnoza Rustamova", g: UserGender.FEMALE, y: 1996 },
    { n: "Qahramon Eshonov", g: UserGender.MALE, y: 1983 },
    { n: "Malika Ziyodullayeva", g: UserGender.FEMALE, y: 1991 },
    { n: "Doniyor Salimov", g: UserGender.MALE, y: 2001 },
    { n: "Ozoda Nurmatova", g: UserGender.FEMALE, y: 1999 },
  ];
  const citizens = [];
  for (let i = 0; i < citizenSpecs.length; i++) {
    const s = citizenSpecs[i];
    const phone = `+9989110003${String(i + 1).padStart(2, "0")}`;
    citizens.push(
      await prisma.user.upsert({
        where: { phone },
        create: {
          phone, passwordHash, name: s.n,
          dob: new Date(`${s.y}-0${(i % 9) + 1}-1${i % 9}`),
          gender: s.g, type: UserType.CITIZEN, role: UserRole.KITOBXON,
          status: UserStatus.ACTIVE,
          sifatId: `SL-UZ-14-001-0001-004${String(i + 1).padStart(2, "0")}`,
          trustScore: 50 + ((i * 9) % 45),
          addressId: i % 2 === 0 ? addr1.id : addr2.id,
        },
        update: { passwordHash, status: UserStatus.ACTIVE },
      }),
    );
  }

  // sifatId ketma-ketligini zaxira diapazondan YUQORIGA suramiz.
  // Aks holda birinchi HAQIQIY ro'yxatdan o'tish `SL-UZ-14-001-0001-00001`
  // ni generatsiya qilib, seed'dagi Aziza Karimova bilan unique
  // konstreyntda to'qnashardi (users.service.ts generateSifatId
  // `Mahalla.lastSeq` ni oshiradi, seed esa uni hech qachon yangilamagan).
  await prisma.mahalla.update({
    where: { id: mahalla!.id },
    data: { lastSeq: 500 },
  });

  // ── Family ────────────────────────────────────────────────────────────
  const family = await prisma.family.upsert({
    where: { id: "demo-family-001" },
    create: { id: "demo-family-001", name: "Karimovlar oilasi", addressId: addr1.id, viloyatId: toshkent!.id, tumanId: chilonzor!.id, mahallaId: mahalla!.id },
    update: {}
  });
  await prisma.user.updateMany({ where: { id: { in: [kitobxon.id, kitobxon2.id, student1.id] } }, data: { familyId: family.id } });

  // ── Family memberships (FAM-03) ───────────────────────────────────────
  // computeFamilyRatings filters families on FamilyMembership.joinedAt (NOT
  // User.createdAt) where leftAt IS NULL. Without these rows the family has
  // 0 active members → never rated → Top Families panel empty.
  // BACKDATE joinedAt 40 days so the 30-day waiting rule (JOIN_WAIT_DAYS)
  // qualifies them. Idempotent via stable id (partial-unique index
  // FamilyMembership_userId_active_unique forbids a 2nd active row per user,
  // so the create-if-absent pattern keeps exactly one active row on re-run).
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const familyMemberSeed = [
    { id: "demo-fm-001", userId: kitobxon.id },
    { id: "demo-fm-002", userId: kitobxon2.id },
    { id: "demo-fm-003", userId: student1.id },
  ];
  for (const fm of familyMemberSeed) {
    const existing = await prisma.familyMembership.findFirst({
      where: { userId: fm.userId, familyId: family.id, leftAt: null }
    });
    if (!existing) {
      await prisma.familyMembership.create({
        data: { id: fm.id, userId: fm.userId, familyId: family.id, joinedAt: fortyDaysAgo, leftAt: null }
      });
    } else if (existing.joinedAt > fortyDaysAgo) {
      // Ensure the backdate sticks even if a legacy row joined too recently.
      await prisma.familyMembership.update({
        where: { id: existing.id },
        data: { joinedAt: fortyDaysAgo }
      });
    }
  }

  // ── Family rating (current month) ─────────────────────────────────────
  // Replicate FamilyService._computeSingleFamilyRating inline (seed runs
  // detached from NestJS DI — same rationale as the inlined badge catalog):
  // avgScore = mean of members' latest RI; totalBooks = RETURNED tx this
  // month. Upsert keyed on familyId_month so GET /family/ratings/top and the
  // dashboard family panel show this family with a non-zero rating.
  {
    const nowMonth = new Date();
    const monthStr = `${nowMonth.getFullYear()}-${String(nowMonth.getMonth() + 1).padStart(2, "0")}`;
    const monthStart = new Date(nowMonth.getFullYear(), nowMonth.getMonth(), 1);
    const monthEnd = new Date(nowMonth.getFullYear(), nowMonth.getMonth() + 1, 0, 23, 59, 59);
    const memberIds = familyMemberSeed.map((m) => m.userId);

    const riRows = await prisma.readingIndex.findMany({
      where: { userId: { in: memberIds }, calculatedAt: { lte: monthEnd } },
      orderBy: { calculatedAt: "desc" },
      select: { userId: true, score: true }
    });
    const latestByUser = new Map<string, number>();
    for (const r of riRows) if (!latestByUser.has(r.userId)) latestByUser.set(r.userId, r.score);
    const riScores = memberIds.map((uid) => latestByUser.get(uid) ?? 0);
    const avgScore = Math.round((riScores.reduce((s, v) => s + v, 0) / riScores.length) * 10) / 10;

    const totalBooks = await prisma.bookTransaction.count({
      where: { userId: { in: memberIds }, status: "RETURNED", returnedAt: { gte: monthStart, lte: monthEnd } }
    });

    await prisma.familyRating.upsert({
      where: { familyId_month: { familyId: family.id, month: monthStr } },
      create: { familyId: family.id, month: monthStr, avgScore, totalBooks, memberCount: memberIds.length, rank: 1 },
      update: { avgScore, totalBooks, memberCount: memberIds.length }
    });
  }

  // ── Books (15 ta — turli janrlar) ─────────────────────────────────────
  const booksData = [
    { id: "demo-book-001", isbn: "9789943452787", title: "Alpomish", author: "Xalq dostoni", genre: "Doston", pages: 240, year: 2020, count: 5, libId: libGov.id },
    { id: "demo-book-002", isbn: "9789943000001", title: "O'tkan kunlar", author: "Abdulla Qodiriy", genre: "Roman", pages: 350, year: 2019, count: 3, libId: libGov.id },
    { id: "demo-book-003", isbn: "9789943000002", title: "Mehrobdan chayon", author: "Abdulla Qodiriy", genre: "Roman", pages: 280, year: 2021, count: 4, libId: libGov.id },
    { id: "demo-book-004", isbn: "9789943000003", title: "Kecha va kunduz", author: "Cho'lpon", genre: "Roman", pages: 320, year: 2018, count: 2, libId: libSch.id },
    { id: "demo-book-005", isbn: "9789943000004", title: "Sarob", author: "Abdulla Qahhor", genre: "Qissa", pages: 180, year: 2020, count: 3, libId: libSch.id },
    { id: "demo-book-006", isbn: "9789943000005", title: "Shum bola", author: "G'afur G'ulom", genre: "Bolalar adabiyoti", pages: 150, year: 2022, count: 6, libId: libSch.id },
    { id: "demo-book-007", isbn: "9789943000006", title: "Ikki eshik orasi", author: "O'tkir Hoshimov", genre: "Roman", pages: 400, year: 2017, count: 2, libId: libUni.id },
    { id: "demo-book-008", isbn: "9789943000007", title: "Muqaddas", author: "Erkin Vohidov", genre: "She'riyat", pages: 120, year: 2021, count: 4, libId: libUni.id },
    { id: "demo-book-009", isbn: "9789943000008", title: "Ufq", author: "Said Ahmad", genre: "Roman", pages: 290, year: 2019, count: 3, libId: libOrg.id },
    { id: "demo-book-010", isbn: "9789943000009", title: "Toshkentlik qiz", author: "O'tkir Hoshimov", genre: "Hikoya", pages: 200, year: 2023, count: 5, libId: libMah.id },
    { id: "demo-book-011", isbn: "9789943000010", title: "Boburnoma", author: "Zahiriddin Babur", genre: "Tarix", pages: 450, year: 2016, count: 2, libId: libGov.id },
    { id: "demo-book-012", isbn: "9789943000011", title: "Olis yulduzlar", author: "Hamid Olimjon", genre: "She'riyat", pages: 100, year: 2020, count: 3, libId: libGov.id },
    { id: "demo-book-013", isbn: "9789943000012", title: "Cho'l gulini sug'orma", author: "Abdulla Oripov", genre: "She'riyat", pages: 130, year: 2015, count: 4, libId: libSch.id },
    { id: "demo-book-014", isbn: "9789943000013", title: "Beshqal'a", author: "Odil Yoqubov", genre: "Roman", pages: 380, year: 2018, count: 2, libId: libUni.id },
    { id: "demo-book-015", isbn: "9789943000014", title: "Olmaxon", author: "Muqimiy", genre: "Komediya", pages: 90, year: 2022, count: 7, libId: libMah.id },
  ];
  for (const b of booksData) {
    await prisma.book.upsert({
      where: { id: b.id },
      // `totalCount` ATAYLAB yoziladi. Avval faqat `availableCount` berilar,
      // `totalCount` esa sxema default'i (1) bo'lib qolardi — natijada
      // BooksService.updateLibraryFundCount() (SUM(totalCount)) chaqirilganda
      // kutubxona fondi 350 dan 15 ga "tushib" ketardi.
      create: { id: b.id, isbn: b.isbn, title: b.title, author: b.author, genre: b.genre, lang: "uz-Latn", pages: b.pages, year: b.year, totalCount: b.count, availableCount: b.count, libraryId: b.libId },
      update: { libraryId: b.libId, totalCount: b.count, availableCount: b.count }
    });
  }

  // ── Kengaytirilgan katalog (95 sarlavha × kutubxonalar) ───────────────
  //
  // Har bir (kutubxona, sarlavha) juftligi alohida `Book` qatori: sxemada
  // nusxa modeli yo'q, inventar `totalCount`/`availableCount` bilan
  // yuritiladi. `id` deterministik (`dcat-<index>-<shelf>`) — seed qayta
  // ishga tushirilsa yangi qator emas, o'sha qator yangilanadi.
  //
  // Nusxa soni sarlavha indeksidan hisoblanadi (tasodifiy EMAS): seed
  // idempotent bo'lishi kerak, `Math.random()` esa har ishga tushirishda
  // fondni o'zgartirib yuborardi.
  const shelfLibraryId: Record<ShelfCode, string> = {
    GOV: libGov.id,
    SCH: libSch.id,
    UNI: libUni.id,
    ORG: libOrg.id,
    MAH: libMah.id,
  };
  const fundTotals: Record<string, number> = {};
  let catalogRows = 0;

  for (let i = 0; i < DEMO_BOOKS.length; i++) {
    const book = DEMO_BOOKS[i];
    const isbn = demoIsbn(i);
    for (const shelf of book.shelves) {
      const libraryId = shelfLibraryId[shelf];
      // 2..6 nusxa — indeksdan kelib chiqadi, shuning uchun barqaror.
      const copies = 2 + ((i + shelf.charCodeAt(0)) % 5);
      await prisma.book.upsert({
        where: { id: `dcat-${i}-${shelf}` },
        create: {
          id: `dcat-${i}-${shelf}`,
          isbn,
          title: book.title,
          author: book.author,
          genre: book.genre,
          lang: book.lang,
          pages: book.pages,
          year: book.year,
          totalCount: copies,
          availableCount: copies,
          libraryId,
        },
        update: {
          title: book.title, author: book.author, genre: book.genre,
          lang: book.lang, pages: book.pages, year: book.year,
          totalCount: copies, availableCount: copies, libraryId,
        },
      });
      fundTotals[libraryId] = (fundTotals[libraryId] ?? 0) + copies;
      catalogRows++;
    }
  }

  // Eski 15 ta kitobning nusxalarini ham fondga qo'shamiz, so'ng
  // `Library.fundCount` ni SUM(totalCount) ga tenglashtiramiz — bu
  // BooksService.updateLibraryFundCount() bilan bir xil qoida, shuning
  // uchun inventarizatsiya hisoboti (5%+ farq = alert) yolg'on
  // ogohlantirish bermaydi.
  for (const b of booksData) {
    fundTotals[b.libId] = (fundTotals[b.libId] ?? 0) + b.count;
  }
  for (const [libraryId, total] of Object.entries(fundTotals)) {
    await prisma.library.update({
      where: { id: libraryId },
      data: { fundCount: total },
    });
  }

  // ── Book Transactions (active borrows + history) ──────────────────────
  const now = new Date();
  const fourteenDaysLater = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  // Active borrow for kitobxon
  await prisma.bookTransaction.upsert({
    where: { id: "demo-tx-001" },
    create: { id: "demo-tx-001", userId: kitobxon.id, bookId: "demo-book-001", type: "BORROW", status: "BORROWED", borrowedAt: threeDaysAgo, dueDate: fourteenDaysLater },
    update: {}
  });
  // Completed return for kitobxon
  await prisma.bookTransaction.upsert({
    where: { id: "demo-tx-002" },
    create: { id: "demo-tx-002", userId: kitobxon.id, bookId: "demo-book-002", type: "BORROW", status: "RETURNED", borrowedAt: new Date("2026-05-01"), dueDate: new Date("2026-05-15"), returnedAt: new Date("2026-05-12") },
    update: {}
  });
  // Active borrow for student
  await prisma.bookTransaction.upsert({
    where: { id: "demo-tx-003" },
    create: { id: "demo-tx-003", userId: student1.id, bookId: "demo-book-006", type: "BORROW", status: "BORROWED", borrowedAt: threeDaysAgo, dueDate: fourteenDaysLater },
    update: {}
  });
  // Pending reservation
  await prisma.bookTransaction.upsert({
    where: { id: "demo-tx-004" },
    create: { id: "demo-tx-004", userId: kitobxon2.id, bookId: "demo-book-003", type: "BORROW", status: "PENDING", reservationExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
    update: {}
  });
  // More history for reading index
  for (let i = 5; i <= 12; i++) {
    const bookIdx = ((i - 5) % 15) + 1;
    const bookId = `demo-book-${String(bookIdx).padStart(3, "0")}`;
    await prisma.bookTransaction.upsert({
      where: { id: `demo-tx-${String(i).padStart(3, "0")}` },
      create: {
        id: `demo-tx-${String(i).padStart(3, "0")}`,
        userId: kitobxon.id,
        bookId,
        type: "BORROW",
        status: "RETURNED",
        borrowedAt: new Date(`2026-0${Math.min(i - 4, 5)}-${String(i).padStart(2, "0")}`),
        dueDate: new Date(`2026-0${Math.min(i - 3, 6)}-${String(i).padStart(2, "0")}`),
        returnedAt: new Date(`2026-0${Math.min(i - 3, 6)}-${String(Math.max(i - 2, 1)).padStart(2, "0")}`)
      },
      update: {}
    });
  }

  // ── Reading Index for multiple users ──────────────────────────────────
  const riData = [
    { id: "demo-ri-001", userId: kitobxon.id, score: 78 },
    { id: "demo-ri-002", userId: kitobxon2.id, score: 65 },
    { id: "demo-ri-003", userId: student1.id, score: 52 },
    { id: "demo-ri-004", userId: klubRahbari.id, score: 85 },
    { id: "demo-ri-005", userId: kutubxonachi.id, score: 70 },
  ];
  // Yangi demo kitobxonlar uchun ham RI ball — aks holda maktab/idora
  // panellari "o'rtacha RI = 0" ko'rsatib, muvofiqlik shkalasi "mos emas"
  // bo'lib qolardi. Ball deterministik (indeksdan), tasodifiy emas: seed
  // qayta ishga tushirilganda ko'rsatkichlar sakramaydi.
  //
  // Kechasi ishlaydigan qayta hisoblash cron'i hali ishlamagani uchun bu
  // qatorlar qo'lda yoziladi — mavjud seed ham aynan shu sababdan
  // demo-ri-001..008 ni qo'lda yozadi.
  for (let i = 0; i < schoolStudents.length; i++) {
    riData.push({ id: `demo-ri-sch-${i}`, userId: schoolStudents[i].id, score: 42 + ((i * 11) % 45) });
  }
  for (let i = 0; i < orgEmployees.length; i++) {
    riData.push({ id: `demo-ri-org-${i}`, userId: orgEmployees[i].id, score: 48 + ((i * 7) % 42) });
  }
  for (let i = 0; i < citizens.length; i++) {
    riData.push({ id: `demo-ri-cit-${i}`, userId: citizens[i].id, score: 45 + ((i * 9) % 45) });
  }

  for (const ri of riData) {
    const existing = await prisma.readingIndex.findFirst({ where: { id: ri.id } });
    if (!existing) {
      await prisma.readingIndex.create({
        data: { id: ri.id, userId: ri.userId, score: ri.score, components: { booksCount: ri.score - 10, consistency: ri.score - 5, diversity: ri.score - 15, discipline: ri.score + 5, activity: ri.score } }
      });
    }
  }

  // ── Top-100 reyting (joriy oy, CONFIRMED) ─────────────────────────────
  //
  // NEGA KERAK: `TopService.getTop100()` faqat `status: "CONFIRMED"` va
  // JORIY oydagi yozuvlarni qaytaradi. Ular oyning 28-kunidagi cron bilan
  // hisoblanadi — demo bazasida esa cron ishlamagan, shuning uchun reyting
  // sahifasi butunlay bo'sh ochilardi. Mijozga ko'rsatiladigan mahsulotda
  // bo'sh reyting "ishlamayapti" degan taassurot beradi.
  //
  // Ball MANBASI — haqiqiy ReadingIndex qatorlari (yuqorida yozilgan).
  // O'rin shu ballardan saralanadi, ya'ni sahifadagi raqamlar boshqa
  // joydagi ko'rsatkichlar bilan zid kelmaydi.
  const rankingMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

  // Ball manbai — YUQORIDA yozilgan `riData` demo qiymatlari, DB'dagi eng
  // oxirgi ReadingIndex qatori EMAS. Sabab: backend ishlab turganda kechasi
  // qayta hisoblash cron'i barcha kitobxonlarga bir xil boshlang'ich ball
  // (faoliyat yo'q) yozib qo'yadi va reyting 46 kishi bir xil ballda turgan
  // "buzuq" ro'yxatga aylanadi. Demo ko'rsatuvida bu qabul qilib bo'lmaydi.
  const demoScoreByUser = new Map<string, number>();
  for (const r of riData) demoScoreByUser.set(r.userId, r.score);

  const rankableUsers = await prisma.user.findMany({
    where: {
      role: UserRole.KITOBXON,
      status: UserStatus.ACTIVE,
      id: { in: [...demoScoreByUser.keys()] },
    },
    select: { id: true, dob: true, gender: true, type: true },
  });

  const scored = rankableUsers
    .map((u) => ({ ...u, score: demoScoreByUser.get(u.id) ?? 0 }))
    .sort((a, b) => b.score - a.score);

  const ageGroupOf = (dob: Date): string => {
    const age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
    if (age <= 14) return "7-14";
    if (age <= 30) return "15-30";
    if (age <= 60) return "31-60";
    return "60+";
  };

  // Demo to'plamiga KIRMAYDIGAN shu oydagi yozuvlarni olib tashlaymiz.
  // Aks holda seed logikasi o'zgarganda avvalgi yugurishdan qolgan qatorlar
  // saqlanib qoladi va ro'yxatda bir xil o'rin ikki marta chiqadi
  // (masalan ikkita "#2"), chunki upsert faqat joriy to'plamni yangilaydi.
  await prisma.top100Entry.deleteMany({
    where: {
      month: rankingMonth,
      userId: { notIn: [...demoScoreByUser.keys()] },
    },
  });

  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const score = s.score;
    await prisma.top100Entry.upsert({
      where: { userId_month: { userId: s.id, month: rankingMonth } },
      create: {
        userId: s.id,
        month: rankingMonth,
        rank: i + 1,
        score,
        // Komponentlar Final Score formulasining bo'laklari (TZ §V.2).
        components: {
          verified: Math.round(score * 0.4 * 10) / 10,
          consistency: Math.round(score * 0.15 * 10) / 10,
          diversity: Math.round(score * 0.1 * 10) / 10,
          comprehension: Math.round(score * 0.15 * 10) / 10,
          discipline: Math.round(score * 0.1 * 10) / 10,
          trust: Math.round(score * 0.1 * 10) / 10,
        },
        gender: s.gender,
        ageGroup: ageGroupOf(s.dob),
        userType: s.type,
        status: "CONFIRMED",
      },
      update: { rank: i + 1, score, status: "CONFIRMED" },
    });
  }

  // ── Club (Jadidlar izidan) ────────────────────────────────────────────
  const club = await prisma.club.upsert({
    where: { id: "demo-club-001" },
    create: { id: "demo-club-001", name: "Jadidlar izidan — 8-maktab", institutionId: maktab.id, leaderId: klubRahbari.id, goal: 20, quarterGoal: 5, description: "8-maktab o'quvchilari uchun kitobxonlik klubi" },
    update: {}
  });
  // Add club members
  for (const userId of [student1.id, kitobxon.id]) {
    await prisma.clubMember.upsert({
      where: { id: `cm-${userId.slice(0, 8)}` },
      create: { id: `cm-${userId.slice(0, 8)}`, clubId: club.id, userId, status: "ACTIVE", joinedAt: new Date("2026-04-01") },
      update: {}
    });
  }
  // Add a debate
  await prisma.debate.upsert({
    where: { id: "demo-debate-001" },
    create: { id: "demo-debate-001", clubId: club.id, topic: "O'tkan kunlar — asosiy g'oya va bugungi ahamiyati", heldAt: new Date("2026-06-05"), participants: 8, summary: "8 ta a'zo qatnashdi. Faol muhokama bo'ldi.", recordedById: klubRahbari.id, status: "PUBLISHED" },
    update: {}
  });

  // ── Store (Do'kon) ────────────────────────────────────────────────────
  const crypto = await import("crypto");
  const store = await prisma.store.upsert({
    where: { slug: "bookmart-chilonzor" },
    create: {
      name: "Bookmart Chilonzor",
      slug: "bookmart-chilonzor",
      description: "Chilonzordagi eng yirik kitob do'koni",
      phone: "+998712345678",
      address: "Chilonzor 1-kvartal, 15-uy",
      lat: 41.2856,
      lon: 69.2067,
      operatorId: dokonOperator.id,
      hmacSecret: crypto.randomBytes(32).toString("hex"),
      tumanId: chilonzor!.id,
      viloyatId: toshkent!.id,
    },
    update: {}
  });
  // Store products
  for (const b of booksData.slice(0, 8)) {
    await prisma.storeProduct.upsert({
      where: { id: `sp-${b.id}` },
      create: { id: `sp-${b.id}`, storeId: store.id, isbn: b.isbn, title: b.title, author: b.author, genre: b.genre, price: Math.floor(30000 + Math.random() * 50000), stockCount: Math.floor(3 + Math.random() * 15), active: true },
      update: {}
    });
  }

  // ── Obunalar (har bir demo muassasa uchun) ────────────────────────────
  //
  // MUHIM: OtmService va IdoraService `_assertSubscriptionActive()` bilan
  // Institution.libraryId ning obunasini tekshiradi va ACTIVE|TRIAL
  // bo'lmasa 403 qaytaradi. Avval faqat GOV kutubxonasining obunasi bor
  // edi, shuning uchun demo ko'rsatuvida OTM va Idora panellari ochilmasdi.
  // planType qiymatlari `plan-prices.const.ts` ro'yxatidan olingan.
  const subscriptionSpecs = [
    { id: "demo-sub-001", libraryId: libGov.id, planType: "GOV" },
    { id: "demo-sub-002", libraryId: libSch.id, planType: "SCH_STANDARD" },
    { id: "demo-sub-003", libraryId: libUni.id, planType: "UNI_STANDARD" },
    { id: "demo-sub-004", libraryId: libOrg.id, planType: "ORG_STANDARD" },
    { id: "demo-sub-005", libraryId: libMah.id, planType: "MAH" },
  ];
  for (const s of subscriptionSpecs) {
    await prisma.subscription.upsert({
      where: { id: s.id },
      create: {
        id: s.id, libraryId: s.libraryId, planType: s.planType,
        status: "ACTIVE",
        startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"),
      },
      update: { status: "ACTIVE", planType: s.planType, endDate: new Date("2026-12-31") },
    });
  }

  console.log(`✅ 9 ROL FOYDALANUVCHILARI YARATILDI`);
  console.log(`✅ Katalog: ${DEMO_BOOKS.length} sarlavha → ${catalogRows} kutubxona qatori (+ ${booksData.length} boshlang'ich kitob)`);
  console.log(`✅ Kitobxonlar: ${schoolStudents.length} o'quvchi, ${orgEmployees.length} idora xodimi, ${citizens.length} fuqaro`);
  console.log(`✅ Obunalar: ${subscriptionSpecs.length} ta ACTIVE (GOV/SCH/UNI/ORG/MAH)`);
  console.log(`✅ 5 kutubxona, 1 do'kon, 1 klub, 1 oila`);
  console.log(`✅ OTM: TDTU (OTM-14001-001) + ${3 + uniExtras.length} talaba (2 fakultet × 6)`);
  console.log(`✅ Oila: 3 a'zo (FamilyMembership, 40 kun oldin) + oylik reyting`);
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  9 ROL TEST AKKAUNTLARI (DEV ONLY) — Parol: Demo@2026      ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║  1. SUPER_ADMIN    : +998900000001  Abdulla Karimov         ║");
  console.log("║  2. BUXGALTER      : +998900000002  Malika Rahimova         ║");
  console.log("║  3. VILOYAT_ADMIN  : +998900000003  Sardor Toshmatov        ║");
  console.log("║  4. TUMAN_ADMIN    : +998900000004  Dildora Xasanova        ║");
  console.log("║  5. MUASSASA_ADMIN : +998900000005  Ravshan Sobirov         ║");
  console.log("║  6. KUTUBXONACHI   : +998900000006  Nodira Aliyeva          ║");
  console.log("║  7. KLUB_RAHBARI   : +998900000007  Ulug'bek Nazarov        ║");
  console.log("║  8. DOKON_OPERATOR : +998900000008  Bekzod Mirzayev         ║");
  console.log("║  9. KITOBXON       : +998901234567  Aziza Karimova          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
}

// Plan 03-01 GAME-01: populate the 18-entry Badge catalog so badge awards
// from Phase 2 onward have rows to FK-reference. Idempotent via the unique
// `code` constraint — re-running the seed leaves catalog row count at 18.
// Inline upsert (not BadgeService.seedBadges) because seed.ts runs detached
// from NestJS DI and can't materialize the service.
async function seedBadgeCatalog() {
  for (const b of BADGE_CATALOG) {
    await prisma.badge.upsert({
      where: { code: b.code },
      update: { name: b.name, description: b.description, icon: b.icon },
      create: { code: b.code, name: b.name, description: b.description, icon: b.icon },
    });
  }
  console.log(`✅ Badge catalog: ${BADGE_CATALOG.length} ta badge seed qilindi`);
}

async function main() {
  console.log("🌱 Seeding...");

  // Geo ma'lumotlar va badge katalogi PRODUCTION uchun ham kerak — har doim.
  await seedGeo();
  await seedBadgeCatalog();

  // C10 fix: demo/test ma'lumotlar (9 ta rol akkaunti, jumladan SUPER_ADMIN
  // +998900000001 ma'lum parol bilan, kutubxonalar, kitoblar, tranzaksiyalar)
  // FAQAT production bo'lmagan muhitda seed qilinadi. isProductionEnv()
  // NODE_ENV ni lowercase+trim qilib tekshiradi (main.ts bilan bir xil util).
  if (isProductionEnv()) {
    console.log("⏭️  NODE_ENV=production — demo/test ma'lumotlar seed qilinmadi (faqat geo + badge katalogi yuklandi).");
  } else {
    await seedDemoData();
  }

  console.log("✅ Seed complete");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
