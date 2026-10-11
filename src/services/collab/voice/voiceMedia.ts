/** Why the microphone couldn't be used, in terms the UI can explain (never the raw exception text). */
export type MicProblem =
  /** The user (or WebView2's prompt) said no. */
  | "denied"
  /** Windows' privacy settings keep desktop apps from the microphone. */
  | "privacy"
  /** No input device, or the chosen one is gone. */
  | "noDevice"
  /** Another program holds it, or the device failed. */
  | "busy"
  | "other";

/** Classifies a `getUserMedia` failure. Chromium says "Permission denied by system" when Windows blocks it. */
export function micProblem(err: unknown): MicProblem {
  const field = (key: "name" | "message"): string => {
    if (typeof err !== "object" || err === null || !(key in err)) return "";
    const value: unknown = (err as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };
  const name = field("name");
  const message = field("message").toLowerCase();
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return message.includes("system") ? "privacy" : "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "noDevice";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    default:
      return "other";
  }
}

/** The browser's own processing, as preferences: a device that can't do one of them still opens. */
export function audioConstraints(deviceId: string): MediaTrackConstraints {
  return {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

export interface MediaApi {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  enumerateDevices: () => Promise<MediaDeviceInfo[]>;
  onDeviceChange: (listener: () => void) => () => void;
}

/** The microphone stream: the chosen device, else the default one (a chosen device that is gone falls back). */
export async function openMicrophone(
  media: MediaApi,
  deviceId: string,
): Promise<{ stream: MediaStream; fellBack: boolean }> {
  try {
    return {
      stream: await media.getUserMedia({ audio: audioConstraints(deviceId), video: false }),
      fellBack: false,
    };
  } catch (err) {
    if (!deviceId || micProblem(err) !== "noDevice") throw err;
    return {
      stream: await media.getUserMedia({ audio: audioConstraints(""), video: false }),
      fellBack: true,
    };
  }
}

export interface AudioDevice {
  id: string;
  label: string;
}

/** Microphones (labels are only known once permission was given), and speakers when the platform reports them. */
export async function listDevices(
  media: MediaApi,
): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  const all = await media.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  const pick = (kind: MediaDeviceKind) =>
    all
      .filter((d) => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d) => ({ id: d.deviceId, label: d.label }));
  return { inputs: pick("audioinput"), outputs: pick("audiooutput") };
}

/** Speaking thresholds (RMS of the waveform, 0..1) and how long a change must last. */
export const SPEAK_ON = 0.04;
export const SPEAK_OFF = 0.02;
const ON_FRAMES = 2;
const OFF_FRAMES = 8;

/**
 * Turns audio levels into a steady speaking/not speaking: it starts after two loud frames and ends only after eight quiet
 * ones (with a lower threshold), so background noise doesn't make the indicator flicker. Levels never leave this window.
 */
export class SpeakingDetector {
  private speaking = false;
  private loud = 0;
  private quiet = 0;

  /** Feeds one level; returns the state when it changed, else `null`. */
  push(level: number): boolean | null {
    if (!this.speaking) {
      this.loud = level >= SPEAK_ON ? this.loud + 1 : 0;
      if (this.loud >= ON_FRAMES) {
        this.speaking = true;
        this.quiet = 0;
        return true;
      }
    } else {
      this.quiet = level < SPEAK_OFF ? this.quiet + 1 : 0;
      if (this.quiet >= OFF_FRAMES) {
        this.speaking = false;
        this.loud = 0;
        return false;
      }
    }
    return null;
  }

  reset(): boolean {
    const was = this.speaking;
    this.speaking = false;
    this.loud = this.quiet = 0;
    return was;
  }
}

/** The RMS level of a waveform frame (bytes centred on 128). */
export function rms(samples: Uint8Array): number {
  let sum = 0;
  for (const v of samples) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}
