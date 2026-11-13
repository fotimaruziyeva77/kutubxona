/**
 * Elasticsearch `sifat_books` indeksini Postgres'dan to'liq qayta to'ldirish.
 *
 *   npm run es:reindex -w apps/backend                 # mavjud indeksga upsert
 *   npm run es:reindex -w apps/backend -- --recreate   # o'chirib, mapping bilan qayta yaratish
 *   node dist/scripts/es-reindex.js [--recreate]       # production konteynerida (build'dan keyin)
 *
 * Qachon kerak: ES birinchi marta yoqilganda (ELASTICSEARCH_ENABLED=true),
 * mapping o'zgarganda (--recreate) yoki indeks yo'qolganda. Backend ishlab
 * turgan bo'lsa SUPER_ADMIN `POST /api/books/reindex?recreate=true` xuddi shu
 * ishni qiladi; bo'sh indeks esa backend ishga tushganda o'zi to'ldiriladi.
 *
 * Nest ilovasini ko'tarmaydi (cron/queue ishga tushmasin) — faqat Prisma va
 * ES klientlari; mantiq `books-search-index.ts` bilan umumiy.
 */
import "dotenv/config";
import { Client } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { reindexAllBooks } from "../modules/books/books-search-index";

async function main(): Promise<void> {
  const recreate = process.argv.includes("--recreate");
  const node = process.env.ELASTICSEARCH_NODE ?? "http://localhost:9200";
  const es = new Client({ node, requestTimeout: 60_000 });
  const prisma = new PrismaClient();
  const label = recreate ? "Qayta yaratilmoqda:" : "Indekslanmoqda:";
  try {
    await es.ping();
    const result = await reindexAllBooks(
      { prisma, es },
      { recreate, onBatch: (done, total) => process.stdout.write(`\r${label} ${done}/${total}`) }
    );
    process.stdout.write("\n");
    console.log(
      `${result.index} (${result.indexState}): ${result.indexed} ta indekslandi, ` +
        `${result.failed} ta xato, jami bazada ${result.total} — ${result.tookMs} ms`
    );
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await es.close();
  }
}

main().catch((err) => {
  console.error(`ES reindex xatosi: ${(err as Error).message}`);
  process.exit(1);
});
