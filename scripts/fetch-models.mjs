/**
 * Downloads MediaPipe models + WASM runtime into /public so the app has ZERO
 * network dependency at runtime.
 *
 * PLAN.md §2: "if wifi dies and we're loading models from a CDN, the entire TV
 * goes dark and there is no recovery."
 *
 * Run once: npm run fetch-models
 */
import { mkdir, writeFile, access, readdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'public', 'models');
const WASM_DIR = join(ROOT, 'public', 'wasm');
const WASM_SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');

const BASE = 'https://storage.googleapis.com/mediapipe-models';

const MODELS = [
  {
    name: 'pose_landmarker_lite.task',
    url: `${BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    note: 'default — fastest, best for 6-player Red Light',
  },
  {
    name: 'pose_landmarker_full.task',
    url: `${BASE}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    note: 'accuracy option — A/B at playtest',
  },
  {
    name: 'hand_landmarker.task',
    url: `${BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
    note: 'Fruit Ninja, Balloon Pop, hover menu',
  },
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function fetchModel(model) {
  const dest = join(MODELS_DIR, model.name);
  if (await exists(dest)) {
    console.log(`  = ${model.name} (already present)`);
    return;
  }
  process.stdout.write(`  ↓ ${model.name} ... `);
  const res = await fetch(model.url);
  if (!res.ok) throw new Error(`${model.name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`${human(buf.length)}  — ${model.note}`);
}

async function copyWasm() {
  if (!(await exists(WASM_SRC))) {
    throw new Error(
      'node_modules/@mediapipe/tasks-vision/wasm not found. Run npm install first.'
    );
  }
  const files = await readdir(WASM_SRC);
  let n = 0;
  for (const f of files) {
    await copyFile(join(WASM_SRC, f), join(WASM_DIR, f));
    n++;
  }
  console.log(`  ✓ copied ${n} WASM runtime files from node_modules`);
}

async function main() {
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(WASM_DIR, { recursive: true });

  console.log('\nMediaPipe models → public/models');
  for (const m of MODELS) await fetchModel(m);

  console.log('\nMediaPipe WASM → public/wasm');
  await copyWasm();

  console.log('\nDone. App is now fully offline-capable.');
  console.log('Verify before the event: put the laptop in airplane mode and load the app.\n');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
