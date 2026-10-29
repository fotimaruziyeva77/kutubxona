#!/usr/bin/env node
// Plan 05-01 Task 4 — Reproducible GeoJSON viloyat-boundary build.
//
// Source:    https://github.com/akbartus/GeoJSON-Uzbekistan (per D-4)
// Tooling:   mapshaper Node API (npm devDep) — cross-platform (no bash needed)
// Output:    apps/frontend/public/geojson/uzbekistan-viloyats.geojson
// Target:    ≤100KB gzip after 20% simplification, 14 viloyat features
//            with properties.code (Viloyat.code shape, e.g. "08") + name
//
// Tuman-level GeoJSON is NOT built here (deferred to V2 per Q4 user
// decision); the commented-out section below documents how to regenerate
// it when V2 lands.
//
// Run:       node scripts/build-geojson.mjs (or: npm run build:geojson)
// Idempotent: safe to re-run; overwrites the output file.

import { mkdir, writeFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mapshaper from "mapshaper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "public", "geojson");
const OUT_FILE = resolve(OUT_DIR, "uzbekistan-viloyats.geojson");
const GZIP_CEILING = 100_000; // 100KB

// akbartus/GeoJSON-Uzbekistan — uzbekistan_regional.geojson holds the 14
// viloyat polygons (the repo's other files are tuman-level, V2-only per Q4).
const SOURCE_URL =
  "https://raw.githubusercontent.com/akbartus/GeoJSON-Uzbekistan/main/geojson/uzbekistan_regional.geojson";
const SOURCE_URL_FALLBACK =
  "https://raw.githubusercontent.com/akbartus/GeoJSON-Uzbekistan/master/geojson/uzbekistan_regional.geojson";

const die = (msg) => {
  console.error(`[geojson] ${msg}`);
  process.exit(1);
};

const log = (msg) => console.log(`[geojson] ${msg}`);

async function fetchWithFallback() {
  for (const url of [SOURCE_URL, SOURCE_URL_FALLBACK]) {
    try {
      log(`fetching ${url}`);
      const res = await fetch(url);
      if (!res.ok) {
        log(`  -> HTTP ${res.status}, trying fallback`);
        continue;
      }
      return await res.text();
    } catch (err) {
      log(`  -> ${err.message}, trying fallback`);
    }
  }
  die(`failed to fetch source GeoJSON from both URLs`);
}

// Map akbartus ADM1_EN/UZ values to the Viloyat.code shape from
// apps/backend/prisma/seed.ts. Codes are 2-digit numeric strings "01".."14"
// (matching the seed) so Plan 05-06 choropleth queries can `JOIN Viloyat ON
// Viloyat.code = feature.properties.code` directly.
const VILOYAT_CODE_BY_NAME = {
  // Karakalpakstan
  "Republic of Karakalpakstan": { code: "01", name: "Qoraqalpog'iston" },
  // Andijan
  "Andijan region": { code: "02", name: "Andijon" },
  // Buxoro
  "Bukhara region": { code: "03", name: "Buxoro" },
  // Jizzakh
  "Jizzakh region": { code: "04", name: "Jizzax" },
  // Qashqadaryo
  "Kashkadarya province": { code: "05", name: "Qashqadaryo" },
  // Namangan
  "Namangan region": { code: "06", name: "Namangan" },
  // Navoiy
  "Navoi region": { code: "07", name: "Navoiy" },
  // Samarqand
  "Samarkand region": { code: "08", name: "Samarqand" },
  // Sirdaryo
  "Syrdarya region": { code: "09", name: "Sirdaryo" },
  // Surxondaryo
  "Surkhandarya region": { code: "10", name: "Surxondaryo" },
  // Toshkent viloyati
  "Tashkent region": { code: "11", name: "Toshkent viloyati" },
  // Farg'ona
  "Fergana region": { code: "12", name: "Farg'ona" },
  // Xorazm
  "Khorezm region": { code: "13", name: "Xorazm" },
  // Toshkent shahar
  "Tashkent city": { code: "14", name: "Toshkent shahar" },
};

function pickCode(props) {
  const en = props.ADM1_EN;
  if (en && VILOYAT_CODE_BY_NAME[en]) return VILOYAT_CODE_BY_NAME[en].code;
  // Direct property fallbacks for non-akbartus sources.
  const candidates = [props.code, props.CODE, props.HASC_1, props.ISO_1, props.GID_1];
  for (const c of candidates) {
    if (typeof c === "string" && /^[A-Z0-9]{2,6}(-[A-Z0-9]{1,4})?$/.test(c)) {
      return c.replace(/^UZ-/, "");
    }
  }
  return null;
}

function pickName(props) {
  const en = props.ADM1_EN;
  if (en && VILOYAT_CODE_BY_NAME[en]) return VILOYAT_CODE_BY_NAME[en].name;
  // Prefer Latin/Uzbek over Russian or generic English.
  const candidates = [
    props.ADM1_UZ,
    props.name_latn,
    props.name_uz,
    props.name_en,
    props.NAME_1,
    props.name,
    props.ADM1_EN,
  ];
  for (const n of candidates) {
    if (typeof n === "string" && n.trim().length > 0) return n.trim();
  }
  return null;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const sourceText = await fetchWithFallback();
  let source;
  try {
    source = JSON.parse(sourceText);
  } catch (err) {
    die(`source is not valid JSON: ${err.message}`);
  }

  if (!source.features || !Array.isArray(source.features)) {
    die(`source missing 'features' array`);
  }
  log(`source feature count: ${source.features.length}`);

  // Normalize properties: ensure every feature has a `code` + `name`
  // matching what Plan 05-06 expects. Drop verbose ADM1_* fields so the
  // output stays small (only code + name + name_ru survive).
  let normalized = 0;
  for (const f of source.features) {
    const oldProps = f.properties || {};
    const code = pickCode(oldProps);
    const name = pickName(oldProps);
    const nameRu = oldProps.ADM1_RU || oldProps.name_ru || null;
    f.properties = {};
    if (code) f.properties.code = code;
    if (name) f.properties.name = name;
    if (nameRu) f.properties.name_ru = nameRu;
    if (code && name) normalized++;
  }
  log(`normalized code+name on ${normalized}/${source.features.length} features`);

  // Run mapshaper -simplify 20% keep-shapes via the Node API.
  const inputName = "in.geojson";
  const outputName = "out.geojson";
  const cmd = `-i ${inputName} -simplify 20% keep-shapes -o format=geojson ${outputName}`;
  log(`mapshaper: ${cmd}`);
  const output = await mapshaper.applyCommands(cmd, {
    [inputName]: JSON.stringify(source),
  });
  const simplifiedRaw = output[outputName];
  if (!simplifiedRaw) {
    die(`mapshaper produced no output`);
  }
  const simplifiedText =
    typeof simplifiedRaw === "string"
      ? simplifiedRaw
      : Buffer.from(simplifiedRaw).toString("utf-8");

  const simplified = JSON.parse(simplifiedText);

  // Validate the simplified output.
  if (simplified.type !== "FeatureCollection") {
    die(`output is not a FeatureCollection (got: ${simplified.type})`);
  }
  if (simplified.features.length !== 14) {
    die(
      `expected 14 viloyat features, got ${simplified.features.length} — check the source dataset`,
    );
  }

  let badProps = 0;
  for (const f of simplified.features) {
    if (!f.properties?.code || typeof f.properties.code !== "string") badProps++;
    else if (!f.properties.name || typeof f.properties.name !== "string") badProps++;
  }
  if (badProps > 0) {
    die(`${badProps} features missing properties.code or properties.name`);
  }

  const finalText = JSON.stringify(simplified);
  const gzipSize = gzipSync(Buffer.from(finalText, "utf-8")).length;
  log(`raw size: ${finalText.length} bytes / gzip: ${gzipSize} bytes`);
  if (gzipSize > GZIP_CEILING) {
    die(
      `simplified gzip size ${gzipSize}B exceeds ${GZIP_CEILING}B ceiling — bump -simplify to a smaller %`,
    );
  }

  await writeFile(OUT_FILE, finalText, "utf-8");
  const written = await stat(OUT_FILE);
  log(`wrote ${OUT_FILE} (${written.size} bytes)`);

  // ── Tuman regeneration (V2 only — deferred per Q4) ──────────────────────
  // To regenerate tuman boundaries when V2 lands:
  //   curl -fsSL https://raw.githubusercontent.com/akbartus/GeoJSON-Uzbekistan/main/uzbekistan-districts.geojson -o /tmp/tumans.geojson
  //   npx mapshaper -i /tmp/tumans.geojson -simplify 25% keep-shapes -o format=geojson public/geojson/uzbekistan-tumans.geojson
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
