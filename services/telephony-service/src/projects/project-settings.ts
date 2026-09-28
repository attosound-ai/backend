/**
 * Per project editor settings stored as JSON on the project row. Every
 * field is optional so older rows and older app builds keep working.
 *
 * master: the mix bus effects (the editor's Master Effects sheet). The app
 * previews them on the device; the export applies the same values here.
 * exportPrefs: what the exporter sheet remembers between mixdowns.
 */
export interface MasterEffects {
  /** Semitone shift of the whole mix, minus 12 to 12 (fractional allowed). */
  pitchSemitones?: number;
  /** Playback rate of the whole mix, 0.5 to 2. */
  tempoRate?: number;
  reverb?: {
    /** smallRoom, mediumRoom, largeRoom, plate, largeHall, cathedral. */
    preset?: string;
    /** 0 to 100 */
    wetDryMix?: number;
  };
  /** Ten gains in dB at 32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 Hz. */
  eqGainsDb?: number[];
}

export type ExportFormat = "wav" | "mp3" | "aac" | "alac" | "flac";
export type ExportQuality = "low" | "medium" | "high";

export interface ExportOptions {
  format?: ExportFormat;
  quality?: ExportQuality;
  /** Output sample rate; the pipeline is 8 kHz so upsampling only pads. */
  sampleRate?: 8000 | 22050 | 44100 | 48000;
  channels?: 1 | 2;
  title?: string;
  author?: string;
  isrc?: string;
  fileName?: string;
  /** Storage key of an uploaded cover image (jpg or png) to embed. */
  coverKey?: string;
}

export interface ProjectSettings {
  master?: MasterEffects;
  exportPrefs?: ExportOptions;
  /** Volume automation envelopes keyed by clip id: [timeMs, gain 0..1] points. */
  automation?: Record<string, Array<[number, number]>>;
}

const EQ_BANDS_HZ = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * Translate the master effects into an ffmpeg audio filter chain that runs
 * after the lane mix and before loudness normalisation. Order mirrors the
 * app's preview: EQ, reverb, then pitch and tempo.
 *
 * Pitch keeps the length: resample by the ratio, then atempo by its inverse.
 * Reverb is a multi tap echo (ffmpeg carries no convolution reverb without
 * an impulse file); the taps per preset approximate room sizes.
 */
export function masterFilterChain(
  master: MasterEffects | undefined,
  sampleRate: number,
): string[] {
  if (!master) return [];
  const filters: string[] = [];
  const nyquist = sampleRate / 2;

  if (Array.isArray(master.eqGainsDb)) {
    master.eqGainsDb.forEach((g, i) => {
      const hz = EQ_BANDS_HZ[i];
      if (!Number.isFinite(g) || Math.abs(g) < 0.05 || hz >= nyquist) return;
      filters.push(
        `equalizer=f=${hz}:t=o:w=1:g=${clamp(g, -24, 24).toFixed(2)}`,
      );
    });
  }

  const mix = master.reverb?.wetDryMix;
  if (typeof mix === "number" && mix > 0.5) {
    const wet = clamp(mix, 0, 100) / 100;
    const presets: Record<string, string> = {
      smallRoom: "0.8:0.7:20|35:0.35|0.25",
      mediumRoom: "0.8:0.75:35|60:0.4|0.3",
      largeRoom: "0.8:0.8:55|90:0.45|0.35",
      plate: "0.8:0.8:25|45|70:0.4|0.3|0.2",
      largeHall: "0.8:0.85:80|130|190:0.5|0.35|0.25",
      cathedral: "0.8:0.9:120|200|300:0.55|0.4|0.3",
    };
    const taps = presets[master.reverb?.preset ?? "mediumRoom"] ?? presets.mediumRoom;
    // in_gain:out_gain:delays:decays. Scale the decays by the wet amount.
    const [inGain, outGain, delays, decays] = taps.split(":");
    const scaledDecays = decays
      .split("|")
      .map((d) => (Number(d) * wet).toFixed(3))
      .join("|");
    filters.push(`aecho=${inGain}:${outGain}:${delays}:${scaledDecays}`);
  }

  const semis = master.pitchSemitones;
  if (typeof semis === "number" && Math.abs(semis) >= 0.01) {
    const ratio = Math.pow(2, clamp(semis, -12, 12) / 12);
    filters.push(
      `asetrate=${Math.round(sampleRate * ratio)}`,
      `aresample=${sampleRate}`,
      ...atempoChain(1 / ratio),
    );
  }

  const tempo = master.tempoRate;
  if (typeof tempo === "number" && Math.abs(tempo - 1) >= 0.005) {
    filters.push(...atempoChain(clamp(tempo, 0.25, 4)));
  }
  return filters;
}

/** atempo accepts 0.5 to 100 per stage; chain stages for slower rates. */
function atempoChain(rate: number): string[] {
  const out: string[] = [];
  let r = rate;
  while (r < 0.5) {
    out.push("atempo=0.5");
    r /= 0.5;
  }
  while (r > 2) {
    out.push("atempo=2");
    r /= 2;
  }
  out.push(`atempo=${r.toFixed(4)}`);
  return out;
}

export interface EncodePlan {
  extension: string;
  mimeType: string;
  codecArgs: string[];
  /** Container supports an attached picture. */
  supportsCover: boolean;
}

/** Codec and bitrate for the exporter's format and quality picks. */
export function encodePlan(options: ExportOptions | undefined): EncodePlan {
  const format = options?.format ?? "wav";
  const quality = options?.quality ?? "medium";
  const bitrate = { low: "64k", medium: "128k", high: "256k" }[quality];
  const mp3Quality = { low: "7", medium: "4", high: "0" }[quality];
  switch (format) {
    case "mp3":
      return {
        extension: "mp3",
        mimeType: "audio/mpeg",
        codecArgs: ["-c:a", "libmp3lame", "-q:a", mp3Quality],
        supportsCover: true,
      };
    case "aac":
      return {
        extension: "m4a",
        mimeType: "audio/mp4",
        codecArgs: ["-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart"],
        supportsCover: true,
      };
    case "alac":
      return {
        extension: "m4a",
        mimeType: "audio/mp4",
        codecArgs: ["-c:a", "alac", "-movflags", "+faststart"],
        supportsCover: true,
      };
    case "flac":
      return {
        extension: "flac",
        mimeType: "audio/flac",
        codecArgs: ["-c:a", "flac"],
        supportsCover: true,
      };
    default:
      return {
        extension: "wav",
        mimeType: "audio/wav",
        codecArgs: ["-c:a", "pcm_s16le"],
        supportsCover: false,
      };
  }
}

/**
 * The volume envelope of one clip as an ffmpeg `volume` expression. The
 * points are [msInsideTheClip, gain 0..1] and the curve is linear between
 * them, flat before the first and after the last, exactly what the editor
 * draws. `t` in the expression is seconds into the clip file, so the caller
 * applies this while the clip is still on its own timeline (right after the
 * cut, before adelay places it).
 */
export function envelopeVolumeExpression(
  points: Array<[number, number]>,
): string | null {
  const clean = points
    .filter(
      (p) =>
        Array.isArray(p) &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        p[0] >= 0,
    )
    .map(([ms, gain]) => [ms / 1000, clamp(gain, 0, 4)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0][1].toFixed(4);

  // Build nested if() so each segment interpolates between its two points.
  // The tail value holds after the last point; the head value holds before
  // the first, which the outermost lt() covers.
  let expr = clean[clean.length - 1][1].toFixed(4);
  for (let i = clean.length - 2; i >= 0; i--) {
    const [t0, g0] = clean[i];
    const [t1, g1] = clean[i + 1];
    const span = Math.max(0.001, t1 - t0);
    const slope = (g1 - g0) / span;
    const segment = `(${g0.toFixed(4)}+(t-${t0.toFixed(4)})*${slope.toFixed(6)})`;
    expr = `if(lt(t,${t1.toFixed(4)}),${segment},${expr})`;
  }
  return `if(lt(t,${clean[0][0].toFixed(4)}),${clean[0][1].toFixed(4)},${expr})`;
}
