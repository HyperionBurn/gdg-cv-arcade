/**
 * The single owner of getUserMedia for the entire app.
 *
 * PLAN.md §2: "One camera module owns getUserMedia. Games are modes that
 * subscribe to a landmark stream. Never let two modules grab the camera."
 *
 * Only one MediaStream can hold a webcam at a time. If a game, the menu and the
 * photobooth each call getUserMedia independently you get a black feed or an
 * outright failure, and it happens at the stall, not at a desk.
 *
 * Device switching is first-class because the Sept 18 camera test has to
 * A/B the laptop cam against an iPhone Continuity Camera.
 */

export interface CameraDevice {
  deviceId: string;
  label: string;
  /** Heuristic: Continuity Camera / iPhone / external USB cams. */
  isLikelyExternal: boolean;
}

export interface CameraState {
  status: 'idle' | 'starting' | 'live' | 'error';
  deviceId: string | null;
  width: number;
  height: number;
  fps: number;
  error: string | null;
}

export interface CameraOptions {
  /** Requested capture size. We ask for 1280x720 — more costs inference time. */
  width: number;
  height: number;
  /** Preferred device, if we've already picked one. */
  deviceId?: string | undefined;
}

const DEFAULT_OPTIONS: CameraOptions = { width: 1280, height: 720 };

const STORAGE_KEY = 'gdg-arcade:camera-device';

type Listener = (state: CameraState) => void;

/** Cameras that are probably not the built-in laptop one. */
function looksExternal(label: string): boolean {
  const l = label.toLowerCase();
  return (
    l.includes('iphone') ||
    l.includes('continuity') ||
    l.includes('usb') ||
    l.includes('logitech') ||
    l.includes('brio') ||
    l.includes('webcam') ||
    l.includes('hd pro')
  );
}

class CameraManager {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private listeners = new Set<Listener>();
  private options: CameraOptions = { ...DEFAULT_OPTIONS };
  private recovering = false;

  private state: CameraState = {
    status: 'idle',
    deviceId: null,
    width: 0,
    height: 0,
    fps: 0,
    error: null,
  };

  getState(): Readonly<CameraState> {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<CameraState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /**
   * The <video> element every consumer reads frames from. Created once, never
   * attached to the DOM — we draw it ourselves.
   */
  getVideo(): HTMLVideoElement {
    if (!this.video) {
      const v = document.createElement('video');
      v.playsInline = true;
      v.muted = true;
      v.autoplay = true;
      this.video = v;
    }
    return this.video;
  }

  isLive(): boolean {
    return this.state.status === 'live' && !!this.video && this.video.readyState >= 2;
  }

  /**
   * Enumerating devices only returns real labels AFTER permission is granted,
   * so call this once the stream is live.
   */
  async listDevices(): Promise<CameraDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
        isLikelyExternal: looksExternal(d.label),
      }));
  }

  getRememberedDeviceId(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private remember(deviceId: string): void {
    try {
      localStorage.setItem(STORAGE_KEY, deviceId);
    } catch {
      /* private mode — not worth failing over */
    }
  }

  async start(opts: Partial<CameraOptions> = {}): Promise<void> {
    if (this.state.status === 'starting') return;

    this.options = { ...this.options, ...opts };
    const deviceId = this.options.deviceId ?? this.getRememberedDeviceId() ?? undefined;

    this.emit({ status: 'starting', error: null });
    this.stop();

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        width: { ideal: this.options.width },
        height: { ideal: this.options.height },
        frameRate: { ideal: 30 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
      },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // An exact deviceId that's gone (unplugged iPhone) throws. Retry loose
      // rather than leaving the stall with a dead camera.
      if (deviceId) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              width: { ideal: this.options.width },
              height: { ideal: this.options.height },
              facingMode: 'user',
            },
          });
        } catch (err2) {
          this.fail(err2);
          return;
        }
      } else {
        this.fail(err);
        return;
      }
    }

    const video = this.getVideo();
    video.srcObject = this.stream;

    try {
      await video.play();
    } catch (err) {
      this.fail(err);
      return;
    }

    await this.waitForDimensions(video);

    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings() ?? {};
    const activeId = settings.deviceId ?? deviceId ?? null;
    if (activeId) this.remember(activeId);

    // If the device vanishes mid-event (iPhone sleeps, USB knocked out) we get
    // 'ended' — try to recover onto whatever camera is left.
    track?.addEventListener('ended', () => this.handleTrackEnded());

    this.emit({
      status: 'live',
      deviceId: activeId,
      width: video.videoWidth,
      height: video.videoHeight,
      fps: settings.frameRate ?? 30,
      error: null,
    });
  }

  private waitForDimensions(video: HTMLVideoElement): Promise<void> {
    if (video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        video.removeEventListener('loadedmetadata', done);
        resolve();
      };
      video.addEventListener('loadedmetadata', done);
      // Don't hang forever if metadata never arrives.
      setTimeout(done, 3000);
    });
  }

  private async handleTrackEnded(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    this.emit({ status: 'error', error: 'Camera disconnected — recovering…' });

    // KEEP TRYING, FOREVER, SLOWLY.
    //
    // This used to give up after five attempts one second apart. A USB camera
    // knocked out of its socket at 11am then stayed dead for the rest of the
    // event, and nothing on the TV said so — the attract screen looks exactly
    // the same with a dead camera as it does with an empty stall, so the
    // failure reads as "nobody is playing" to everyone including the marshal.
    //
    // Five seconds between attempts is cheap, and someone pushing the cable
    // back in is by far the most likely fix at a stall. `getUserMedia` on an
    // absent device rejects quickly, so this does not accumulate work.
    for (let attempt = 0; ; attempt++) {
      await new Promise((r) => setTimeout(r, attempt < 5 ? 1000 : 5000));
      try {
        await this.start({ deviceId: undefined });
        if (this.state.status === 'live') break;
      } catch {
        /* keep trying */
      }
    }
    this.recovering = false;
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    let friendly = message;

    if (message.includes('Permission') || message.includes('NotAllowed')) {
      friendly = 'Camera permission denied. Allow camera access and reload.';
    } else if (message.includes('NotFound') || message.includes('DevicesNotFound')) {
      friendly = 'No camera found. Check the cable or Continuity Camera pairing.';
    } else if (message.includes('NotReadable') || message.includes('TrackStart')) {
      friendly = 'Camera is in use by another app. Close Zoom/Teams/Photo Booth.';
    } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      // The exact failure mode flagged in PLAN.md §9.
      friendly =
        'Camera blocked: page must be served over https or localhost. ' +
        `Currently ${location.protocol}//${location.hostname}`;
    }

    this.emit({ status: 'error', error: friendly });
  }

  /** Switch cameras without tearing down consumers. Used by the Sept 18 test. */
  async switchTo(deviceId: string): Promise<void> {
    await this.start({ deviceId });
  }

  stop(): void {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }
}

/** The one and only camera. */
export const camera = new CameraManager();
