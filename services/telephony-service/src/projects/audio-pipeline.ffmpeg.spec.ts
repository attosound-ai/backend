/**
 * The audio pipeline with the real ffmpeg: what every kind of upload is
 * stored as, how long it lasts, and that an export mixing an old 8 kHz call
 * segment with a new 48 kHz stereo take keeps speed and pitch. Skipped when
 * ffmpeg is not on the machine (the service image has it).
 */
import { spawnSync } from "child_process";
import { mkdtempSync, promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AudioProcessorService } from "./audio-processor.service";

const hasFfmpeg =
  spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;
const maybe = hasFfmpeg ? describe : describe.skip;

const dir = mkdtempSync(join(tmpdir(), "atto-audio-spec-"));

function ff(args: string[]): void {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

function probe(path: string): { rate: number; channels: number; codec: string; ms: number } {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
    "-of", "json", path,
  ]);
  const j = JSON.parse(r.stdout.toString());
  return {
    rate: Number(j.streams[0].sample_rate),
    channels: Number(j.streams[0].channels),
    codec: String(j.streams[0].codec_name),
    ms: Math.round(Number(j.format.duration) * 1000),
  };
}

/** Frequency of the loudest tone in a stretch, from zero crossings. */
function toneHz(path: string, fromSec: number, lenSec: number, channel = 0): number {
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-ss", String(fromSec), "-t", String(lenSec), "-i", path,
    "-af", `pan=mono|c0=c${channel}`, "-ar", "48000", "-f", "s16le", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  const buf = r.stdout as Buffer;
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i);
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  return crossings / 2 / lenSec;
}

const tone = (hz: number, rate: number, sec: number) =>
  `sine=frequency=${hz}:sample_rate=${rate}:duration=${sec}`;

function makeService(segments: Record<string, unknown>) {
  const uploads: { key: string; data: Buffer; type: string }[] = [];
  const svc = new AudioProcessorService(
    { findOne: async ({ where }: { where: { id: string } }) => segments[where.id] ?? null } as never,
    {
      upload: async (key: string, data: Buffer, type: string) => {
        uploads.push({ key, data, type });
        return { bucket: "b", key, size: data.length };
      },
      getPresignedUrl: async (_b: string, key: string) => `https://s3.test/${key}`,
    } as never,
    { get: (_k: string, def: unknown) => def } as never,
    { get: async () => null, set: async () => undefined, jitterTtl: (n: number) => n } as never,
  );
  // The bucket is the local disk: the key is the path.
  (svc as unknown as { descargarA: unknown }).descargarA = async (_b: string, key: string, path: string) =>
    fs.copyFile(key, path);
  return { svc, uploads };
}

maybe("audio pipeline with ffmpeg", () => {
  jest.setTimeout(60_000);

  const wav8k = join(dir, "call-8k.wav");
  const wav16k = join(dir, "wide-16k.wav");
  const wav44 = join(dir, "song-44k-stereo.wav");
  const wav96 = join(dir, "master-96k.wav");
  const m4a48 = join(dir, "take-48k-stereo.m4a");
  const mp3 = join(dir, "beat-22k.mp3");
  const movie = join(dir, "clip.mp4");

  beforeAll(() => {
    ff(["-f", "lavfi", "-i", tone(440, 8000, 2), "-ac", "1", "-c:a", "pcm_s16le", wav8k]);
    ff(["-f", "lavfi", "-i", tone(440, 16000, 2), "-ac", "1", "-c:a", "pcm_s16le", wav16k]);
    ff([
      "-f", "lavfi", "-i", tone(440, 44100, 3), "-f", "lavfi", "-i", tone(1000, 44100, 3),
      "-filter_complex", "[0][1]amerge=inputs=2", "-c:a", "pcm_s16le", wav44,
    ]);
    ff(["-f", "lavfi", "-i", tone(440, 96000, 2), "-ac", "2", "-c:a", "pcm_s24le", wav96]);
    // Left 1000 Hz, right silent: proves the channels survive.
    ff([
      "-f", "lavfi", "-i", tone(1000, 48000, 2), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=2",
      "-filter_complex", "[0][1]amerge=inputs=2", "-t", "2", "-c:a", "aac", "-b:a", "256k", m4a48,
    ]);
    ff(["-f", "lavfi", "-i", tone(440, 22050, 2), "-ac", "1", "-c:a", "libmp3lame", "-q:a", "4", mp3]);
    ff([
      "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=2", "-f", "lavfi", "-i", tone(440, 48000, 2),
      "-c:v", "mpeg4", "-c:a", "aac", "-shortest", movie,
    ]);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const cases: [string, () => string, { rate: number; channels: number; codec: string; action: string; ms: number }][] = [
    ["an old app's 8 kHz mono WAV is kept untouched", () => wav8k, { rate: 8000, channels: 1, codec: "pcm_s16le", action: "keep", ms: 2000 }],
    ["16 kHz wideband call audio stays PCM at 16 kHz", () => wav16k, { rate: 16000, channels: 1, codec: "pcm_s16le", action: "keep", ms: 2000 }],
    ["a 44.1 kHz stereo WAV becomes 44.1 kHz stereo AAC", () => wav44, { rate: 44100, channels: 2, codec: "aac", action: "encode", ms: 3000 }],
    ["a 96 kHz 24 bit WAV comes down to 48 kHz", () => wav96, { rate: 48000, channels: 2, codec: "aac", action: "encode", ms: 2000 }],
    ["the new app's 48 kHz stereo AAC is copied, not encoded again", () => m4a48, { rate: 48000, channels: 2, codec: "aac", action: "remux", ms: 2000 }],
    ["a 22 kHz MP3 keeps its rate (never raised)", () => mp3, { rate: 22050, channels: 1, codec: "aac", action: "encode", ms: 2000 }],
    ["a movie keeps only its sound", () => movie, { rate: 48000, channels: 1, codec: "aac", action: "remux", ms: 2000 }],
  ];

  it.each(cases)("%s", async (_name, path, want) => {
    const { svc } = makeService({});
    const input = path();
    const p = await svc.probeAudio(input);
    const out = await svc.prepareForStorage(input, p);
    expect(out.plan.action).toBe(want.action);
    const real = probe(out.path);
    expect(real.rate).toBe(want.rate);
    expect(real.channels).toBe(want.channels);
    expect(real.codec).toBe(want.codec);
    expect(Math.abs(real.ms - want.ms)).toBeLessThanOrEqual(30);
    expect(Math.abs(out.stored.durationMs - want.ms)).toBeLessThanOrEqual(30);
    if (want.codec === "aac") {
      const streams = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out.path]);
      expect(streams.stdout.toString().trim()).toBe("audio");
    }
  });

  async function stored(source: string): Promise<string> {
    const { svc } = makeService({});
    const out = await svc.prepareForStorage(source, await svc.probeAudio(source));
    return out.path;
  }

  it("mixes an old 8 kHz segment with a new 44.1 kHz stereo take without changing speed or pitch", async () => {
    const take = await stored(wav44); // 440 left, 1000 right, 3 s
    const segments = {
      old: { id: "old", storageBucket: "b", storageKey: wav8k, format: "wav", durationMs: 2000 },
      take: { id: "take", storageBucket: "b", storageKey: take, format: "m4a", durationMs: 3000 },
    };
    const { svc, uploads } = makeService(segments);
    const res = await svc.exportProject(
      [
        { segmentId: "old", startInSegment: 0, endInSegment: 2000, order: 0, laneIndex: 0, positionInTimeline: 0 },
        { segmentId: "take", startInSegment: 500, endInSegment: 2500, order: 0, laneIndex: 1, positionInTimeline: 3000 },
      ],
      "p1",
    );
    // The best clip is the 44.1 kHz take: the mix goes out at 44.1 kHz
    // stereo (never raised to 48), the old call clip is lifted to it.
    expect(res).toMatchObject({ sampleRate: 44100, channels: 2, format: "m4a" });
    const file = join(dir, "mix.m4a");
    await fs.writeFile(file, uploads[0].data);
    const real = probe(file);
    expect(real).toMatchObject({ rate: 44100, channels: 2, codec: "aac" });
    expect(Math.abs(real.ms - 5000)).toBeLessThanOrEqual(40);
    // The old call clip: 440 Hz, the same on both sides.
    expect(toneHz(file, 0.3, 1.2, 0)).toBeGreaterThan(430);
    expect(toneHz(file, 0.3, 1.2, 0)).toBeLessThan(450);
    expect(toneHz(file, 0.3, 1.2, 1)).toBeGreaterThan(430);
    expect(toneHz(file, 0.3, 1.2, 1)).toBeLessThan(450);
    // The new take, trimmed by half a second: left 440, right 1000.
    expect(toneHz(file, 3.3, 1.2, 0)).toBeGreaterThan(430);
    expect(toneHz(file, 3.3, 1.2, 0)).toBeLessThan(450);
    expect(toneHz(file, 3.3, 1.2, 1)).toBeGreaterThan(985);
    expect(toneHz(file, 3.3, 1.2, 1)).toBeLessThan(1015);
  });

  it("a project of old 8 kHz segments still exports an 8 kHz mono WAV", async () => {
    const { svc, uploads } = makeService({
      old: { id: "old", storageBucket: "b", storageKey: wav8k, format: "wav", durationMs: 2000 },
    });
    const res = await svc.exportProject(
      [{ segmentId: "old", startInSegment: 0, endInSegment: 2000, order: 0, laneIndex: 0, positionInTimeline: 0 }],
      "p2",
    );
    expect(res).toMatchObject({ sampleRate: 8000, channels: 1, format: "wav" });
    const file = join(dir, "old.wav");
    await fs.writeFile(file, uploads[0].data);
    expect(probe(file)).toMatchObject({ rate: 8000, channels: 1, codec: "pcm_s16le" });
  });

  it("a WAV picked on purpose stays WAV at full quality", async () => {
    const take = await stored(m4a48);
    const { svc, uploads } = makeService({
      take: { id: "take", storageBucket: "b", storageKey: take, format: "m4a", durationMs: 2000 },
    });
    const res = await svc.exportProject(
      [{ segmentId: "take", startInSegment: 0, endInSegment: 2000, order: 0, laneIndex: 0, positionInTimeline: 0 }],
      "p3",
      undefined,
      { format: "wav" },
    );
    expect(res).toMatchObject({ sampleRate: 48000, channels: 2, format: "wav" });
    const file = join(dir, "full.wav");
    await fs.writeFile(file, uploads[0].data);
    const real = probe(file);
    expect(real).toMatchObject({ rate: 48000, channels: 2 });
    expect(Math.abs(real.ms - 2000)).toBeLessThanOrEqual(30);
  });

  it("draws the waveform of an m4a segment, whole and by window", async () => {
    const take = await stored(wav44);
    const { svc } = makeService({
      s: { id: "s", storageBucket: "b", storageKey: take, format: "m4a", durationMs: 3000 },
    });
    const whole = await svc.generateWaveformData("s", 300);
    expect(whole).toHaveLength(300);
    expect(Math.max(...whole)).toBeGreaterThan(0.1);
    expect(Math.max(...whole)).toBeLessThanOrEqual(1);
    const window = await svc.generateWaveformData("s", 2048, 0.5, 0.6);
    expect(window.length).toBeGreaterThan(1000);
    expect(Math.max(...window)).toBeGreaterThan(0.1);
  });
});
