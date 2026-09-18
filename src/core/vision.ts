/**
 * Main-thread side of the vision pipeline.
 *
 * Owns the worker, pumps frames into it, and publishes VisionFrames to
 * whoever is subscribed. Also tracks the health stats the operator console
 * needs (real inference fps, dropped frames, delegate in use).
 */

import { camera } from './camera';
import type { VisionConfig, VisionFrame } from './types';

type FrameListener = (frame: VisionFrame) => void;

export interface VisionStats {
  ready: boolean;
  delegate: 'GPU' | 'CPU' | null;
  /** Frames per second actually coming back from the worker. */
  inferenceFps: number;
  /** Rolling mean of time spent inside MediaPipe. */
  inferenceMs: number;
  /** Frames we skipped because the worker was still busy. */
  dropped: number;
  /** capture -> result latency, main thread's view. */
  latencyMs: number;
  error: string | null;
  warning: string | null;
}

const DEFAULT_CONFIG: VisionConfig = {
  mode: 'pose',
  numPoses: 1,
  numHands: 2,
  poseModel: 'lite',
};

/**
 * Inference target. 30fps is plenty for gesture detection and leaves headroom
 * for a 60fps render. Raising this mostly heats the laptop up.
 */
/** See the watchdog in `beginPump`. */
const IN_FLIGHT_TIMEOUT_MS = 2000;

const TARGET_INFERENCE_FPS = 30;

class VisionPipeline {
  private worker: Worker | null = null;
  private listeners = new Set<FrameListener>();
  private statsListeners = new Set<(s: VisionStats) => void>();
  private config: VisionConfig = { ...DEFAULT_CONFIG };

  private running = false;
  private rafHandle = 0;
  private frameId = 0;
  private lastPumpTime = 0;
  private lastVideoTime = -1;
  /**
   * Frames posted to the worker and not yet answered. Capped at one — see the
   * backpressure note in `beginPump`.
   */
  private inFlight = 0;
  /** When the in-flight frame was posted, for the watchdog. */
  private lastPostTime = 0;

  private fpsWindow: number[] = [];
  private msWindow: number[] = [];
  private lastFrameArrival = 0;

  private stats: VisionStats = {
    ready: false,
    delegate: null,
    inferenceFps: 0,
    inferenceMs: 0,
    dropped: 0,
    latencyMs: 0,
    error: null,
    warning: null,
  };

  getStats(): Readonly<VisionStats> {
    return this.stats;
  }

  getConfig(): Readonly<VisionConfig> {
    return this.config;
  }

  subscribe(fn: FrameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeStats(fn: (s: VisionStats) => void): () => void {
    this.statsListeners.add(fn);
    fn(this.stats);
    return () => this.statsListeners.delete(fn);
  }

  private emitStats(patch: Partial<VisionStats>): void {
    this.stats = { ...this.stats, ...patch };
    for (const fn of this.statsListeners) fn(this.stats);
  }

  async start(config: Partial<VisionConfig> = {}): Promise<void> {
    if (this.worker) {
      await this.setConfig(config);
      return;
    }

    this.config = { ...this.config, ...config };

    // MODULE WORKER, PAIRED WITH MediaPipe's MODULE WASM BUILD.
    //
    // This combination is load-bearing and the two halves must not be changed
    // independently. See `createFileset` in vision.worker.ts.
    //
    // MediaPipe loads its runtime by fetching a loader script and then reading
    // `self.ModuleFactory`. It ships two builds of that loader:
    //
    //   vision_wasm_internal.js         classic script, `var ModuleFactory = ...`
    //   vision_wasm_module_internal.js  ES module, `globalThis.ModuleFactory = ...`
    //
    // In a module worker `importScripts` exists but throws, so MediaPipe falls
    // back to `await import(loader)`. Against the CLASSIC loader that is fatal:
    // under ES module semantics its top-level `var` is module-scoped and never
    // reaches `self`, so `self.ModuleFactory` stays undefined and every model
    // load dies with "ModuleFactory not set." — which is what a real camera hit
    // on every machine, in dev and in production alike.
    //
    // The module loader assigns `globalThis.ModuleFactory` explicitly, which is
    // precisely what a dynamic import needs. So the worker stays a module
    // worker and the worker asks for the module fileset.
    //
    // A classic worker was tried instead and cannot work: Vite's dev server
    // hardcodes `type: "module"` for `?worker` regardless of `worker.format`,
    // and its `type=classic` worker file still contains ESM imports. Dev would
    // have been permanently broken while only production worked.
    this.worker = new Worker(new URL('./vision.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (ev) => this.onWorkerMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.emitStats({ error: `Vision worker crashed: ${ev.message}` });
    };

    // Resolve model paths against the document base so this works whether the
    // app is served from root, a subdirectory, or a preview server.
    const base = new URL('./', document.baseURI).href;

    this.worker.postMessage({
      type: 'init',
      wasmPath: `${base}wasm`,
      modelsPath: `${base}models`,
      config: this.config,
    });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.stats.ready || this.stats.error) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    this.beginPump();
  }

  async setConfig(patch: Partial<VisionConfig>): Promise<void> {
    if (!this.worker) {
      this.config = { ...this.config, ...patch };
      return;
    }
    const changed = (Object.keys(patch) as Array<keyof VisionConfig>).some(
      (k) => patch[k] !== undefined && patch[k] !== this.config[k]
    );
    if (!changed) return;

    this.config = { ...this.config, ...patch };
    this.worker.postMessage({ type: 'config', config: patch });
  }

  private onWorkerMessage(msg: {
    type: string;
    frame?: VisionFrame;
    message?: string;
    delegate?: 'GPU' | 'CPU';
  }): void {
    switch (msg.type) {
      case 'ready':
        this.emitStats({ ready: true, delegate: msg.delegate ?? null, error: null });
        break;

      case 'frame': {
        this.inFlight = Math.max(0, this.inFlight - 1);
        const frame = msg.frame!;
        const now = performance.now();

        if (this.lastFrameArrival > 0) {
          const dt = now - this.lastFrameArrival;
          this.fpsWindow.push(1000 / dt);
          if (this.fpsWindow.length > 30) this.fpsWindow.shift();
        }
        this.lastFrameArrival = now;

        this.msWindow.push(frame.inferenceMs);
        if (this.msWindow.length > 30) this.msWindow.shift();

        const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

        this.emitStats({
          inferenceFps: mean(this.fpsWindow),
          inferenceMs: mean(this.msWindow),
          latencyMs: now - frame.captureTime,
        });

        for (const fn of this.listeners) fn(frame);
        break;
      }

      case 'dropped':
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.emitStats({ dropped: this.stats.dropped + 1 });
        break;

      case 'warn':
        this.emitStats({ warning: msg.message ?? null });
        break;

      case 'error':
        // Release the slot too. An error IS a terminal reply, and leaving the
        // counter pinned would stop the pump permanently — trading a bounded
        // queue for a dead camera, which is worse than the bug being fixed.
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.emitStats({ error: msg.message ?? 'Unknown vision error' });
        break;
    }
  }

  private beginPump(): void {
    if (this.running) return;
    this.running = true;

    const interval = 1000 / TARGET_INFERENCE_FPS;

    const pump = () => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(pump);

      const now = performance.now();
      if (now - this.lastPumpTime < interval) return;

      if (!camera.isLive() || !this.worker) return;
      const video = camera.getVideo();

      // Don't re-submit a frame the camera hasn't refreshed. Saves real work
      // when the capture rate is below our inference target.
      if (video.currentTime === this.lastVideoTime) return;

      // ONE FRAME IN FLIGHT. The main thread is the only place backpressure
      // can actually be applied.
      //
      // The worker has a `busy` flag, but it is dead code: `processFrame` is
      // fully synchronous, so `busy` is always false by the time the next
      // message is dequeued, and a worker handles messages one at a time
      // regardless. Frames therefore queue in the message port with nothing
      // bounding the queue.
      //
      // MEASURED: posting at 30Hz (the real pump rate) latency stays flat at
      // ~15ms and nothing queues. Posting faster than the worker can consume,
      // latency grows LINEARLY — a burst of 60 frames ends at 687ms, climbing
      // by exactly one inference time per frame. The queue grows at
      // `pumpRate - 1000/inferenceMs` frames per second, so it stays at zero
      // while inference is under ~33ms and runs away the moment it is not:
      // a CPU-delegate fallback (60-150ms), an integrated GPU landmarking six
      // bodies, or a laptop thermally throttled at hour three. Each queued
      // frame also pins ~3.7MB of ImageBitmap.
      //
      // Dropping the frame instead is strictly better than queueing it: a
      // stale pose delivered half a second late is worse than no pose.
      if (this.inFlight > 0) {
        // WATCHDOG. Every path that posts a frame also releases the slot, but
        // "every path" is exactly the assumption that fails when a worker
        // wedges mid-inference or a message is lost — and the cost of being
        // wrong is a camera that never recovers for the rest of the event.
        // Two seconds is far beyond any legitimate inference, including the
        // ~400ms first frame after a model rebuild.
        if (now - this.lastPostTime > IN_FLIGHT_TIMEOUT_MS) {
          this.inFlight = 0;
        } else {
          this.emitStats({ dropped: this.stats.dropped + 1 });
          return;
        }
      }

      this.lastVideoTime = video.currentTime;
      this.lastPumpTime = now;
      this.lastPostTime = now;
      this.inFlight++;

      createImageBitmap(video)
        .then((bitmap) => {
          if (!this.worker || !this.running) {
            bitmap.close();
            this.inFlight--;
            return;
          }
          this.worker.postMessage(
            { type: 'frame', bitmap, captureTime: now, frameId: this.frameId++ },
            [bitmap]
          );
        })
        .catch(() => {
          /* video not decodable this tick — skip */
          this.inFlight--;
        });
    };

    this.rafHandle = requestAnimationFrame(pump);
  }

  stop(): void {
    this.running = false;
    this.inFlight = 0;
    cancelAnimationFrame(this.rafHandle);
  }

  dispose(): void {
    this.stop();
    this.worker?.postMessage({ type: 'dispose' });
    this.worker?.terminate();
    this.worker = null;
    this.emitStats({ ready: false, delegate: null });
  }
}

export const vision = new VisionPipeline();
