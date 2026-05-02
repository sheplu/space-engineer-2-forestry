#!/usr/bin/env node
// Validator for Coal Power mod datasets.
// Ports the Stone & Concrete pattern and extends it for raw-resource records:
//   1. JSON Schema validation (envelope, index, raw, item, block).
//   2. Cross-reference: every ingredient id, buildComponents id, producesIds,
//      and fuel.consumesId must resolve to a base-game id OR a local id
//      defined in this mod.
//   3. Cross-reference: every `producedBy` display name (on item recipes) must
//      match a base-game or local block displayName, or one of a small set of
//      well-known non-block producers (e.g. "Backpack Building").
//   4. Cross-reference: every raw resource's `refinableInto[]` entry must
//      match a base-game refinery-product displayName or a local item
//      displayName.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));
const loadAbs = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats.default(ajv);

const envelopeSchema = load("schemas/envelope.schema.json");
const indexSchema = load("schemas/index.schema.json");
const rawSchema = load("schemas/resource-raw.schema.json");
const itemSchema = load("schemas/resource-item.schema.json");
const blockSchema = load("schemas/resource-block.schema.json");

const validateEnvelope = ajv.compile(envelopeSchema);
const validateIndex = ajv.compile(indexSchema);
const validateRaw = ajv.compile(rawSchema);
const validateItem = ajv.compile(itemSchema);
const validateBlock = ajv.compile(blockSchema);

const index = load("index.json");

// Base game cross-reference data.
const baseRepoPath =
  process.env.BASE_GAME_REPO ??
  resolve(repoRoot, "..", "space-engineer-2-base-game");

let baseRawIds = new Set();
let baseItemIds = new Set();
let baseItemDisplayNames = new Set();
let baseBlockDisplayNames = new Set();

const baseRawPath = resolve(baseRepoPath, "data/raw-resources.json");
const baseBlocksDir = resolve(baseRepoPath, "data/blocks");

if (existsSync(baseRawPath)) {
  const baseRaw = loadAbs(baseRawPath);
  baseRawIds = new Set(baseRaw.resources.map((r) => r.id));

  const itemFiles = [
    "data/components/simple.json",
    "data/components/complex.json",
    "data/components/high-tech.json",
    "data/refinery-products.json",
    "data/character-gear.json",
    "data/ammunition.json",
  ];
  for (const rel of itemFiles) {
    const abs = resolve(baseRepoPath, rel);
    if (!existsSync(abs)) continue;
    const doc = loadAbs(abs);
    for (const r of doc.resources) {
      baseItemIds.add(r.id);
      if (r.displayName) baseItemDisplayNames.add(r.displayName);
    }
  }

  const walkBlocks = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walkBlocks(p);
      else if (name.endsWith(".json")) {
        const doc = loadAbs(p);
        for (const r of doc.resources ?? []) {
          if (r.displayName) baseBlockDisplayNames.add(r.displayName);
          // Power cells live under blocks/ but are item records.
          if (r.id) baseItemIds.add(r.id);
        }
      }
    }
  };
  walkBlocks(baseBlocksDir);

  console.log(
    `✓ base-game cross-ref loaded: ${baseRawIds.size} raw ids, ${baseItemIds.size} item/block ids, ${baseBlockDisplayNames.size} block displayNames`,
  );
} else {
  console.warn(
    `! base-game repo not found at ${baseRepoPath} — skipping cross-reference checks (set BASE_GAME_REPO to enable)`,
  );
}

// Well-known non-block producers used across vanilla.
const nonBlockProducers = new Set(["Backpack Building"]);

// Local ids tracked across this mod's datasets.
const localRawIds = new Set();
const localItemIds = new Set();
const localItemDisplayNames = new Set();
const localBlockDisplayNames = new Set();

let failures = 0;
const report = (label, errors) => {
  if (!errors || errors.length === 0) return;
  failures += errors.length;
  console.error(`✗ ${label}`);
  for (const err of errors) {
    console.error(`    ${err.instancePath || "(root)"} ${err.message}`);
    if (err.params && Object.keys(err.params).length) {
      console.error(`      params: ${JSON.stringify(err.params)}`);
    }
  }
};

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failures += 1;
};

const recordKindFor = (datasetId) => {
  if (datasetId === "raw-resources") return { kind: "raw", fn: validateRaw };
  if (datasetId === "items") return { kind: "item", fn: validateItem };
  if (datasetId.startsWith("blocks-")) return { kind: "block", fn: validateBlock };
  throw new Error(`Unknown dataset id: ${datasetId}`);
};

if (!validateIndex(index)) {
  report("index.json", validateIndex.errors);
} else {
  console.log("✓ index.json");
}

// First pass: schema + envelope validation. Collect local ids.
const perDatasetRecords = new Map();
for (const entry of index.datasets) {
  const data = load(entry.path);
  const label = entry.path;

  if (!validateEnvelope(data)) {
    report(`${label} (envelope)`, validateEnvelope.errors);
    continue;
  }

  const { kind, fn } = recordKindFor(entry.id);
  let recordFailures = 0;
  for (const [i, rec] of data.resources.entries()) {
    const recLabel = `${label} [${i}] ${kind} record "${rec.id ?? "?"}"`;
    if (!fn(rec)) {
      recordFailures += fn.errors.length;
      report(recLabel, fn.errors);
    } else {
      if (kind === "raw") localRawIds.add(rec.id);
      if (kind === "item") {
        localItemIds.add(rec.id);
        if (rec.displayName) localItemDisplayNames.add(rec.displayName);
      }
      if (kind === "block" && rec.displayName) {
        localBlockDisplayNames.add(rec.displayName);
      }
    }
  }

  if (data.resources.length !== entry.entryCount) {
    fail(
      `${label} — index declares ${entry.entryCount} entries but file has ${data.resources.length}`,
    );
  }
  if (recordFailures === 0) {
    console.log(`✓ ${label} (${data.resources.length} ${kind} records)`);
  }
  perDatasetRecords.set(entry.id, data.resources);
}

// Second pass: cross-reference checks (only if base-game data is loaded).
const knownIds = () =>
  new Set([...baseRawIds, ...baseItemIds, ...localRawIds, ...localItemIds]);

const knownItemDisplayNames = () =>
  new Set([...baseItemDisplayNames, ...localItemDisplayNames]);

const isKnownProducer = (name) =>
  baseBlockDisplayNames.has(name) ||
  localBlockDisplayNames.has(name) ||
  nonBlockProducers.has(name);

if (baseRawIds.size > 0) {
  const ids = knownIds();
  const itemDisplayNames = knownItemDisplayNames();

  // Raw records: check refinableInto[] entries.
  const rawRecs = perDatasetRecords.get("raw-resources") ?? [];
  for (const rec of rawRecs) {
    const label = `data/raw-resources.json record "${rec.id}"`;
    for (const [i, target] of (rec.refinableInto ?? []).entries()) {
      if (!itemDisplayNames.has(target)) {
        fail(
          `${label} — refinableInto[${i}] "${target}" does not match any base-game refinery-product or local item displayName`,
        );
      }
    }
  }

  // Items: check every recipe's ingredients[].id and producedBy.
  const itemRecs = perDatasetRecords.get("items") ?? [];
  for (const rec of itemRecs) {
    const label = `data/items.json record "${rec.id}"`;
    for (const [ri, recipe] of (rec.recipes ?? []).entries()) {
      if (!isKnownProducer(recipe.producedBy)) {
        fail(
          `${label} — recipe[${ri}] producedBy "${recipe.producedBy}" does not match any base-game or local block displayName (nor a known non-block producer)`,
        );
      }
      for (const [ii, ing] of recipe.ingredients.entries()) {
        if (!ids.has(ing.id)) {
          fail(
            `${label} — recipe[${ri}].ingredients[${ii}].id "${ing.id}" is not a base-game raw/item id or a local raw/item id`,
          );
        }
      }
    }
  }

  // Blocks: check buildComponents[].id, production.producesIds[], fuel.consumesId.
  for (const [datasetId, recs] of perDatasetRecords.entries()) {
    if (!datasetId.startsWith("blocks-")) continue;
    const entry = index.datasets.find((d) => d.id === datasetId);
    for (const rec of recs) {
      const label = `${entry.path} record "${rec.id}"`;
      for (const [ci, comp] of rec.buildComponents.entries()) {
        if (!ids.has(comp.id)) {
          fail(
            `${label} — buildComponents[${ci}].id "${comp.id}" is not a base-game raw/item id or a local raw/item id`,
          );
        }
      }
      const pIds = rec.production?.producesIds ?? [];
      for (const [pi, pid] of pIds.entries()) {
        if (!ids.has(pid)) {
          fail(
            `${label} — production.producesIds[${pi}] "${pid}" is not a base-game raw/item id or a local raw/item id`,
          );
        }
      }
      // fuel.consumesId may be null (data gap); only check when set.
      const fuelId = rec.fuel?.consumesId;
      if (fuelId && !ids.has(fuelId)) {
        fail(
          `${label} — fuel.consumesId "${fuelId}" is not a base-game raw/item id or a local raw/item id`,
        );
      }
    }
  }

  // totalEntries sanity.
  const sumEntries = index.datasets.reduce((a, d) => a + d.entryCount, 0);
  if (index.totalEntries !== sumEntries) {
    fail(
      `index.json — totalEntries declares ${index.totalEntries} but dataset entryCount sum is ${sumEntries}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} validation error(s)`);
  process.exit(1);
}
console.log("\nAll datasets valid.");
