/**
 * Cómo se guarda el audio de un proyecto, decidido a partir de lo que de
 * verdad trae el archivo (ffprobe), nunca del mime que manda el cliente.
 *
 * Hasta el 12 nov 2026 todo se bajaba a 8 kHz mono WAV al subirlo, y por eso
 * el estudio sonaba apagado: una toma de 48 kHz o una canción importada
 * perdían todo lo que pasa de 4 kHz para siempre (promesa al cliente del
 * 28 sep). Ahora:
 *
 *  - Lo que llega a 16 kHz o menos es audio de teléfono (las grabaciones de
 *    Twilio, las apps viejas que ya convierten a 8 kHz, una llamada de banda
 *    ancha). Se guarda en WAV PCM a la frecuencia que llega: sin pérdida,
 *    pesa poco (16 kB por segundo a 8 kHz) y lo lee todo lo que ya existía,
 *    incluida la lectura de ventanas por rango del zoom profundo.
 *  - Lo demás se guarda en AAC dentro de m4a, a la frecuencia original hasta
 *    48 kHz (nunca se sube) y en estéreo si la fuente lo es: 256 kbps en
 *    estéreo a 44,1 o 48 kHz, 1,92 MB por minuto. El mismo audio en WAV de
 *    48 kHz estéreo pesa 11,5 MB por minuto, seis veces más, y no cabría ni
 *    en el tope de importación ni en el de los posts.
 *  - Si ya viene en AAC (lo que manda la app nueva, o una grabación del
 *    iPhone) no se vuelve a codificar: se copia al m4a tal cual, con el índice
 *    al principio para que el reproductor pueda buscar sin bajarse el final.
 */

export interface ProbedAudio {
  sampleRate: number;
  channels: number;
  /** codec_name de ffprobe: pcm_s16le, aac, mp3, alac, flac... */
  codecName: string;
  /** format_name de ffprobe: wav, "mov,mp4,m4a,3gp,3g2,mj2", mp3, aiff... */
  formatName?: string;
  durationMs: number;
}

/** Nunca se guarda por encima de esto. */
export const MAX_STORED_SAMPLE_RATE = 48000;
/** A esta frecuencia o menos el audio es de teléfono y se guarda en PCM. */
export const PCM_CEILING_HZ = 16000;
/** Frecuencias que acepta el codificador AAC (el de ffmpeg y el del iPhone). */
export const AAC_SAMPLE_RATES = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
] as const;

export type StoredContainer = "wav" | "m4a";

export type StoragePlan =
  /** El archivo ya está en una forma que se guarda tal cual. */
  | { action: "keep"; container: StoredContainer; sampleRate: number; channels: number }
  /** AAC que solo cambia de envoltorio (copia sin pérdida). */
  | { action: "remux"; container: "m4a"; sampleRate: number; channels: number }
  /** Hay que decodificar y volver a codificar. sampleRate null: la de la fuente. */
  | {
      action: "encode";
      container: StoredContainer;
      sampleRate: number | null;
      channels: number;
      bitrateKbps: number | null;
    };

const isPcm = (codec: string) => codec.startsWith("pcm_");
const isWavContainer = (format: string | undefined) =>
  !!format && format.split(",").includes("wav");
const isMp4Container = (format: string | undefined) =>
  !!format && format.split(",").some((f) => f === "mov" || f === "mp4" || f === "m4a");

/**
 * La frecuencia a la que se guarda: la mayor que acepta AAC sin pasar de la
 * de la fuente ni de 48 kHz. Nunca sube: 22,05 kHz se queda en 22,05 kHz.
 */
export function storedSampleRate(sourceRate: number): number {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) return MAX_STORED_SAMPLE_RATE;
  const cap = Math.min(sourceRate, MAX_STORED_SAMPLE_RATE);
  let best: number = AAC_SAMPLE_RATES[0];
  for (const r of AAC_SAMPLE_RATES) if (r <= cap) best = r;
  return best;
}

/** Uno o dos canales: más de dos se mezclan a estéreo. */
export function storedChannels(sourceChannels: number): 1 | 2 {
  return Number.isFinite(sourceChannels) && sourceChannels >= 2 ? 2 : 1;
}

/**
 * kbps de AAC para una frecuencia y unos canales. 128 por canal a 44,1 y
 * 48 kHz (256 en estéreo, transparente para música), y menos cuando la banda
 * es más estrecha, porque el codificador no puede gastar bits en lo que no
 * existe.
 */
export function aacBitrateKbps(sampleRate: number, channels: number): number {
  const perChannel =
    sampleRate >= 44100 ? 128 : sampleRate >= 32000 ? 96 : sampleRate >= 22050 ? 64 : 48;
  return perChannel * storedChannels(channels);
}

/** Qué hacer con un archivo subido, según lo que de verdad contiene. */
export function planStorage(probe: ProbedAudio | null): StoragePlan {
  if (!probe || !(probe.sampleRate > 0) || !(probe.channels > 0)) {
    // Sin poder leerlo no hay plan fino: se decodifica a WAV sin tocar la
    // frecuencia (ffmpeg decide) y como mucho en estéreo.
    return { action: "encode", container: "wav", sampleRate: null, channels: 2, bitrateKbps: null };
  }
  const channels = storedChannels(probe.channels);
  const rate = storedSampleRate(probe.sampleRate);

  // Audio de teléfono: PCM a la frecuencia que llega.
  if (probe.sampleRate <= PCM_CEILING_HZ) {
    if (
      isPcm(probe.codecName) &&
      probe.codecName === "pcm_s16le" &&
      isWavContainer(probe.formatName ?? "wav") &&
      probe.channels <= 2
    ) {
      return { action: "keep", container: "wav", sampleRate: probe.sampleRate, channels };
    }
    return {
      action: "encode",
      container: "wav",
      sampleRate: Math.round(probe.sampleRate),
      channels,
      bitrateKbps: null,
    };
  }

  // AAC que ya cumple: solo se copia al m4a.
  if (
    probe.codecName === "aac" &&
    isMp4Container(probe.formatName ?? "mov,mp4,m4a") &&
    (AAC_SAMPLE_RATES as readonly number[]).includes(probe.sampleRate) &&
    probe.sampleRate <= MAX_STORED_SAMPLE_RATE &&
    probe.channels <= 2
  ) {
    return { action: "remux", container: "m4a", sampleRate: probe.sampleRate, channels };
  }

  return {
    action: "encode",
    container: "m4a",
    sampleRate: rate,
    channels,
    bitrateKbps: aacBitrateKbps(rate, channels),
  };
}

/** Argumentos de salida de ffmpeg para un plan que no sea "keep". */
export function storageFfmpegArgs(plan: StoragePlan): string[] {
  const base = ["-map", "0:a:0", "-vn"];
  if (plan.action === "remux") {
    return [...base, "-c:a", "copy", "-movflags", "+faststart", "-f", "ipod"];
  }
  if (plan.container === "m4a") {
    const args = [...base, "-c:a", "aac"];
    if (plan.action === "encode" && plan.bitrateKbps) args.push("-b:a", `${plan.bitrateKbps}k`);
    if (plan.sampleRate) args.push("-ar", String(plan.sampleRate));
    args.push("-ac", String(plan.channels), "-movflags", "+faststart", "-f", "ipod");
    return args;
  }
  const args = [...base, "-c:a", "pcm_s16le"];
  if (plan.sampleRate) args.push("-ar", String(plan.sampleRate));
  args.push("-ac", String(plan.channels), "-f", "wav");
  return args;
}

export function containerMime(container: StoredContainer): string {
  return container === "m4a" ? "audio/mp4" : "audio/wav";
}

/** El contenedor de un segmento guardado, por su columna format o su clave. */
export function storedContainerOf(segment: {
  format?: string | null;
  storageKey?: string | null;
}): StoredContainer {
  const f = (segment.format ?? "").toLowerCase();
  if (f === "m4a" || f === "mp4" || f === "aac") return "m4a";
  if ((segment.storageKey ?? "").toLowerCase().endsWith(".m4a")) return "m4a";
  return "wav";
}

// ─── La mezcla de la exportación ────────────────────────────────────────────

export interface MixInputFormat {
  sampleRate: number;
  channels: number;
}

/**
 * El formato de la mezcla: el mejor de sus clips, sin pasar de 48 kHz. Un
 * proyecto solo de llamadas a 8 kHz sigue saliendo a 8 kHz mono, igual que
 * antes; uno con una toma de 48 kHz estéreo sale a 48 kHz estéreo, y sus
 * clips viejos de 8 kHz se convierten a ese formato antes de sumarse.
 */
export function mixFormat(inputs: MixInputFormat[]): { sampleRate: number; channels: 1 | 2 } {
  let rate = 0;
  let channels: 1 | 2 = 1;
  for (const i of inputs) {
    if (Number.isFinite(i.sampleRate) && i.sampleRate > rate) rate = i.sampleRate;
    if (storedChannels(i.channels) === 2) channels = 2;
  }
  if (rate <= 0) rate = 8000;
  return { sampleRate: Math.min(Math.round(rate), MAX_STORED_SAMPLE_RATE), channels };
}

/**
 * Filtros que llevan una entrada de la mezcla al formato común. Sin esto
 * amix negociaba una frecuencia por su cuenta, y un clip de 8 kHz junto a uno
 * de 48 kHz podía arrastrar la mezcla entera a 8 kHz. El mono pasa a estéreo
 * con el mismo nivel en los dos lados (pan explícito): la conversión
 * automática lo bajaba 3 dB.
 */
export function mixInputFilters(
  input: MixInputFormat,
  target: { sampleRate: number; channels: 1 | 2 },
): string[] {
  const out: string[] = [];
  const inCh = storedChannels(input.channels);
  if (target.channels === 2 && inCh === 1) out.push("pan=stereo|c0=c0|c1=c0");
  if (input.sampleRate !== target.sampleRate) out.push(`aresample=${target.sampleRate}`);
  out.push(
    `aformat=sample_rates=${target.sampleRate}:channel_layouts=${target.channels === 2 ? "stereo" : "mono"}`,
  );
  return out;
}

/**
 * El formato de entrega cuando nadie lo eligió. Una mezcla de teléfono sigue
 * saliendo en WAV (lo de siempre). Una de calidad completa sale en AAC a
 * 256 kbps, porque en WAV de 48 kHz estéreo un post de dos minutos ya no
 * cabría en los 20 MB que admite Cloudinary.
 */
export function deliveryDefaults<T extends { format?: string; quality?: string }>(
  options: T | undefined,
  mixRate: number,
): T {
  const base = (options ?? {}) as T;
  if (base.format || mixRate <= PCM_CEILING_HZ) return base;
  return { ...base, format: "aac", quality: base.quality ?? "high" };
}
