#!/usr/bin/env node
// Downloads the local AI vision model (CLIP ViT-B/32, 8-bit ONNX) into
// public/models/<id>/ so `vite build` copies it into dist/ and the Tauri
// installer, and vision works offline on first launch. No Hugging Face token is
// needed: the model is public. (The ONNX Runtime WASM binary needs no fetch:
// Vite emits it from node_modules/onnxruntime-web as a hashed asset.)
//
// Usage:  node scripts/fetch-ai-models.mjs [--force] [--check]
//   --force  re-download every file
//   --check  verify only; exit 1 if anything is missing (no network)
// Env:    HF_ENDPOINT     alternate Hub host/mirror (default https://huggingface.co)
//         HF_MODEL_REVISION  git revision to fetch (default main)
//
// Idempotent: files already present with the expected size are skipped.
// Resumable: downloads stream to <file>.part and resume with an HTTP Range
// request when a partial file exists.

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_ID = "Xenova/clip-vit-base-patch32";
const ENDPOINT = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "");
const REVISION = process.env.HF_MODEL_REVISION || "main";
const MODEL_DIR = join(ROOT, "public", "models", ...MODEL_ID.split("/"));

// Expected sizes (bytes) as published on the Hub; used when the Hub API is
// unreachable and to sanity-check what was downloaded.
const MODEL_FILES = {
  "config.json": 4524,
  "preprocessor_config.json": 520,
  "tokenizer.json": 2224119,
  "tokenizer_config.json": 775,
  "special_tokens_map.json": 472,
  "onnx/text_model_quantized.onnx": 64504507,
  "onnx/vision_model_quantized.onnx": 89117001,
};

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const CHECK_ONLY = args.has("--check");

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function fetchExpectedSizes() {
  const url = `${ENDPOINT}/api/models/${MODEL_ID}/tree/${encodeURIComponent(REVISION)}?recursive=1`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tree = await response.json();
    const sizes = { ...MODEL_FILES };
    for (const entry of tree) {
      if (entry?.type === "file" && entry.path in sizes) sizes[entry.path] = entry.lfs?.size ?? entry.size;
    }
    return sizes;
  } catch (error) {
    console.warn(`  ! Hub API unavailable (${error.message}); using built-in file sizes.`);
    return { ...MODEL_FILES };
  }
}

async function download(file, expected) {
  const target = join(MODEL_DIR, ...file.split("/"));
  const partial = `${target}.part`;
  await mkdir(dirname(target), { recursive: true });

  const existing = await sizeOf(target);
  if (!FORCE && existing === expected) {
    console.log(`  = ${file} (${formatBytes(expected)}) already present`);
    return expected;
  }
  if (FORCE) await rm(partial, { force: true });

  let offset = (await sizeOf(partial)) ?? 0;
  if (offset > expected) {
    await rm(partial, { force: true });
    offset = 0;
  }
  const url = `${ENDPOINT}/${MODEL_ID}/resolve/${encodeURIComponent(REVISION)}/${file}`;
  const headers = { "User-Agent": "CinaVault-model-fetch/1.0" };
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  let response;
  try {
    response = await fetch(url, { headers, redirect: "follow" });
  } catch (error) {
    throw new Error(`network error fetching ${url}: ${error.cause?.message ?? error.message}`);
  }
  if (response.status === 416 && offset === expected) {
    await rename(partial, target);
    return expected;
  }
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  const resumed = response.status === 206;
  if (!resumed) offset = 0; // server ignored the Range header: start over

  const total = expected;
  let received = offset;
  let lastLog = 0;
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (process.stdout.isTTY && now - lastLog > 500) {
      lastLog = now;
      process.stdout.write(`\r  ↓ ${file} ${formatBytes(received)} / ${formatBytes(total)}   `);
    }
  });
  await pipeline(body, createWriteStream(partial, { flags: resumed ? "a" : "w" }));
  if (process.stdout.isTTY) process.stdout.write("\r");

  const size = await sizeOf(partial);
  if (size !== expected) {
    throw new Error(
      `${file}: size ${size} != expected ${expected}. Re-run to resume, or --force to restart.`,
    );
  }
  await rename(partial, target);
  console.log(`  + ${file} (${formatBytes(size)})${resumed ? " [resumed]" : ""}`);
  return size;
}

async function check() {
  let ok = true;
  for (const [file, expected] of Object.entries(MODEL_FILES)) {
    const size = await sizeOf(join(MODEL_DIR, ...file.split("/")));
    if (size !== expected) {
      ok = false;
      console.log(`  ✗ ${file}: ${size === null ? "missing" : `size ${size} != ${expected}`}`);
    }
  }
  console.log(ok ? "Local AI model files are present." : "Local AI model files are incomplete; run npm run fetch:ai-models.");
  return ok;
}

async function main() {
  console.log(`CinaVault local AI: ${MODEL_ID}@${REVISION} → ${MODEL_DIR}`);
  if (CHECK_ONLY) {
    process.exit((await check()) ? 0 : 1);
  }

  const sizes = await fetchExpectedSizes();
  let modelBytes = 0;
  const failures = [];
  for (const [file, expected] of Object.entries(sizes)) {
    try {
      modelBytes += await download(file, expected);
    } catch (error) {
      failures.push(`${file}: ${error.message}`);
      console.error(`  ✗ ${file}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} file(s) failed. Partial downloads were kept and will resume on the next run.\n` +
        "The app still works without bundled weights: it downloads them from the Hugging Face CDN on first use.",
    );
    process.exit(1);
  }
  console.log(`Done: ${formatBytes(modelBytes)} of model files ready to bundle.`);
}

main().catch((error) => {
  console.error(`fetch-ai-models failed: ${error.stack ?? error}`);
  process.exit(1);
});
