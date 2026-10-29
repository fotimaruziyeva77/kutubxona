/**
 * i18n Key Sync Checker
 *
 * Validates that all 4 locale JSON files (uz-Latn, uz-Cyrl, kaa, ru) have
 * identical key structures. uz-Latn.json is the source of truth.
 *
 * Usage: npx ts-node scripts/i18n-key-check.ts
 *    or: npx tsx scripts/i18n-key-check.ts
 * Exit code 0: all files in sync
 * Exit code 1: missing keys detected
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");

const MESSAGES_DIR = path.resolve(__dirname, "../apps/frontend/messages");
const SOURCE_LOCALE = "uz-Latn";
const ALL_LOCALES = ["uz-Latn", "uz-Cyrl", "kaa", "ru"];

function extractKeyPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...extractKeyPaths(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

function loadJson(locale: string): Record<string, unknown> {
  const filePath = path.join(MESSAGES_DIR, `${locale}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function main() {
  const sourceData = loadJson(SOURCE_LOCALE);
  const sourceKeys = extractKeyPaths(sourceData);

  let hasMissing = false;
  const targetLocales = ALL_LOCALES.filter((l) => l !== SOURCE_LOCALE);

  for (const locale of targetLocales) {
    const targetData = loadJson(locale);
    const targetKeys = new Set(extractKeyPaths(targetData));

    const missingKeys = sourceKeys.filter((k) => !targetKeys.has(k));
    const extraKeys = [...targetKeys].filter((k) => !sourceKeys.includes(k));

    if (missingKeys.length > 0) {
      hasMissing = true;
      console.error(`\n[${locale}.json] Missing ${missingKeys.length} key(s):`);
      for (const k of missingKeys) {
        console.error(`  - ${k}`);
      }
    }

    if (extraKeys.length > 0) {
      hasMissing = true;
      console.error(`\n[${locale}.json] Extra ${extraKeys.length} key(s) not in ${SOURCE_LOCALE}:`);
      for (const k of extraKeys) {
        console.error(`  - ${k}`);
      }
    }
  }

  if (hasMissing) {
    process.stderr.write("\ni18n key sync FAILED. Fix the above issues.\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`All 4 locale files are in sync: ${sourceKeys.length} keys\n`);
}

main();
