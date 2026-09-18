/// <reference lib="webworker" />
/**
 * MediaPipe inference, off the main thread.
 *
 * PLAN.md §2: "Inference in a Web Worker at 30fps; render on main thread at
 * 60fps with interpolated landmarks between inference frames."
 *
 * Running inference on the main thread means every detect() call blocks the
 * render loop. At 30fps inference that's a visible hitch twice per rendered
 * frame, and it reads as "the game is laggy" even though input latency is fine.
 *
 * Frames arrive as transferred ImageBitmaps (zero-copy). We close each one
 * after use — leaking ImageBitmaps will exhaust GPU memory within minutes,
 * which is exactly the kind of failure that shows up at hour three of a stall.
 */

import {
  FilesetResolver,
  PoseLandmarker,
  HandLandmarker,
  type PoseLandmarkerResult,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';

import type { VisionConfig, VisionFrame, RawPose, RawHand, Landmark } from './types';

type InitMessage = {
  type: 'init';
  wasmPath: string;
  modelsPath: string;
  config: VisionConfig;
};
type FrameMessage = {
  type: 'frame';
  bitmap: ImageBitmap;
  captureTime: number;
  frameId: number;
};
type ConfigMessage = { type: 'config'; config: Partial<VisionConfig> };
type DisposeMessage = { type: 'dispose' };

type InboundMessage = InitMessage | FrameMessage | ConfigMessage | DisposeMessage;

let poseLandmarker: PoseLandmarker | null = null;
let handLandmarker: HandLandmarker | null = null;
let filesetPath = '';
let modelsPath = '';
let config: VisionConfig = {
  mode: 'pose',
  numPoses: 1,
  numHands: 2,
  poseModel: 'lite',
};

let busy = false;
/** detectForVideo demands strictly increasing timestamps or it throws. */
let lastTimestamp = -1;
let delegate: 'GPU' | 'CPU' = 'GPU';

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function toLandmarks(raw: Array<{ x: number; y: number; z: number; visibility?: number }>): Landmark[] {
  const out: Landmark[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]!;
    out[i] = { x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 };
  }
  return out;
}

/**
 * The MODULE WASM build, not the classic one.
 *
 * `forVisionTasks(path)` defaults to the classic loader, whose only export is a
 * top-level `var ModuleFactory`. We run in a module worker, where MediaPipe
 * reaches that loader via `await import()` and a top-level `var` never becomes
 * a global — so `self.ModuleFactory` is undefined and every task throws
 * "ModuleFactory not set."
 *
 * The second argument switches it to `vision_wasm_module_internal.js`, which
 * ends with an explicit `globalThis.ModuleFactory = ModuleFactory`. Both builds
 * are already on disk; only this flag was missing.
 */
async function createFileset(): ReturnType<typeof FilesetResolver.forVisionTasks> {
  const fileset = await FilesetResolver.forVisionTasks(filesetPath, true);

  // SELF-DIAGNOSING, because "ModuleFactory not set." on its own names neither
  // the file it failed to load nor the reason. Both are knowable here, and a
  // stall at 3pm is the wrong place to be reverse-engineering a minified
  // bundle. Verify the loader is reachable and is the MODULE build before
  // MediaPipe gets a chance to fail opaquely.
  const loader = (fileset as { wasmLoaderPath?: string }).wasmLoaderPath ?? '(none)';
  if (!loader.includes('module')) {
    throw new Error(
      `WASM loader is the CLASSIC build (${loader}). In a module worker that ` +
        `cannot define self.ModuleFactory. forVisionTasks() needs its second ` +
        `argument set to true.`
    );
  }

  const res = await fetch(loader, { method: 'GET' }).catch((e: unknown) => {
    throw new Error(`WASM loader unreachable at ${loader}: ${String(e)}`);
  });
  if (!res.ok) {
    throw new Error(
      `WASM loader ${loader} returned HTTP ${res.status}. ` +
        `public/wasm is fetched by \`npm run setup\` and is NOT in git — a ` +
        `fresh clone or a build that skipped setup will 404 here.`
    );
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    throw new Error(
      `WASM loader ${loader} served as HTML, not JavaScript — it is almost ` +
        `certainly a 404 page from an SPA rewrite.`
    );
  }

  return fileset;
}

async function createPose(): Promise<void> {
  const fileset = await createFileset();
  const modelFile =
    config.poseModel === 'full' ? 'pose_landmarker_full.task' : 'pose_landmarker_lite.task';

  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${modelsPath}/${modelFile}`, delegate },
      runningMode: 'VIDEO',
      numPoses: config.numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
  } catch (err) {
    if (delegate === 'GPU') {
      // Integrated graphics on a borrowed laptop may not give us a WebGL
      // context. Degrade rather than die.
      delegate = 'CPU';
      post({ type: 'warn', message: 'GPU delegate unavailable, falling back to CPU' });
      await createPose();
      return;
    }
    throw err;
  }
}

async function createHands(): Promise<void> {
  const fileset = await createFileset();
  handLandmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${modelsPath}/hand_landmarker.task`, delegate },
    runningMode: 'VIDEO',
    numHands: config.numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

async function ensureModels(): Promise<void> {
  const wantsPose = config.mode === 'pose' || config.mode === 'both';
  const wantsHands = config.mode === 'hands' || config.mode === 'both';

  if (wantsPose && !poseLandmarker) await createPose();
  if (wantsHands && !handLandmarker) await createHands();

  // Keep unused models loaded rather than disposing — a player switching games
  // should not wait 2 seconds for a model to reload mid-queue. 22MB of models
  // resident is a trade we can afford; a stalled kiosk is not.
}

async function init(msg: InitMessage): Promise<void> {
  filesetPath = msg.wasmPath;
  modelsPath = msg.modelsPath;
  config = msg.config;

  try {
    await ensureModels();
    post({ type: 'ready', delegate });
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function applyConfig(patch: Partial<VisionConfig>): Promise<void> {
  const prev = config;
  config = { ...config, ...patch };

  // numPoses / model choice are baked in at creation, so those need a rebuild.
  if (patch.numPoses !== undefined && patch.numPoses !== prev.numPoses) {
    poseLandmarker?.close();
    poseLandmarker = null;
  }
  if (patch.poseModel !== undefined && patch.poseModel !== prev.poseModel) {
    poseLandmarker?.close();
    poseLandmarker = null;
  }
  if (patch.numHands !== undefined && patch.numHands !== prev.numHands) {
    handLandmarker?.close();
    handLandmarker = null;
  }

  try {
    await ensureModels();
    post({ type: 'configured', config });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function processFrame(msg: FrameMessage): void {
  // Drop frames rather than queue them. A backed-up queue means we're showing
  // the player where they were half a second ago, which feels far worse than a
  // lower effective framerate.
  if (busy) {
    msg.bitmap.close();
    post({ type: 'dropped', frameId: msg.frameId });
    return;
  }

  busy = true;
  const start = performance.now();

  let timestamp = Math.round(msg.captureTime);
  if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1;
  lastTimestamp = timestamp;

  const poses: RawPose[] = [];
  const hands: RawHand[] = [];

  try {
    if ((config.mode === 'pose' || config.mode === 'both') && poseLandmarker) {
      const result: PoseLandmarkerResult = poseLandmarker.detectForVideo(msg.bitmap, timestamp);
      for (let i = 0; i < result.landmarks.length; i++) {
        poses.push({
          landmarks: toLandmarks(result.landmarks[i]!),
          worldLandmarks: toLandmarks(result.worldLandmarks[i] ?? []),
        });
      }
    }

    if ((config.mode === 'hands' || config.mode === 'both') && handLandmarker) {
      const result: HandLandmarkerResult = handLandmarker.detectForVideo(msg.bitmap, timestamp);
      for (let i = 0; i < result.landmarks.length; i++) {
        const cat = result.handedness[i]?.[0];
        hands.push({
          landmarks: toLandmarks(result.landmarks[i]!),
          // MediaPipe reports handedness for the UNMIRRORED image. We mirror the
          // display, so on screen a 'Left' hand appears on the right. Games that
          // care flip this in gestures.ts, not here — this stays raw.
          handedness: (cat?.categoryName as 'Left' | 'Right') ?? 'Right',
          score: cat?.score ?? 0,
        });
      }
    }

    const frame: VisionFrame = {
      poses,
      hands,
      captureTime: msg.captureTime,
      inferenceMs: performance.now() - start,
      frameId: msg.frameId,
    };
    post({ type: 'frame', frame });
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      frameId: msg.frameId,
    });
  } finally {
    msg.bitmap.close();
    busy = false;
  }
}

self.onmessage = (ev: MessageEvent<InboundMessage>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      void init(msg);
      break;
    case 'frame':
      processFrame(msg);
      break;
    case 'config':
      void applyConfig(msg.config);
      break;
    case 'dispose':
      poseLandmarker?.close();
      handLandmarker?.close();
      poseLandmarker = null;
      handLandmarker = null;
      break;
  }
};
