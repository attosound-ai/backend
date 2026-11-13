import { PicosEnFlujo } from "./peak-stream";
import { lectorDeFotogramas, picosDeMuestras } from "./wav-window";

function pcm(frames: number, channels: number, value: (f: number, c: number) => number): Buffer {
  const buf = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) buf.writeInt16LE(value(f, c), (f * channels + c) * 2);
  }
  return buf;
}

function feed(acc: PicosEnFlujo, buf: Buffer, sizes: number[]): void {
  let at = 0;
  let i = 0;
  while (at < buf.length) {
    const n = sizes[i++ % sizes.length];
    acc.push(buf.subarray(at, Math.min(buf.length, at + n)));
    at += n;
  }
}

describe("PicosEnFlujo", () => {
  it("matches the WAV reader exactly when every frame is its own block", () => {
    const frames = 1000;
    const buf = pcm(frames, 2, (f, c) => Math.round(Math.sin(f / 7 + c) * 20000));
    const acc = new PicosEnFlujo(frames, 1000, 2);
    // Chunks that cut in the middle of a sample and of a frame.
    feed(acc, buf, [3, 7, 1, 513, 64]);
    const lector = lectorDeFotogramas(buf, {
      dataOffset: 0,
      dataBytes: buf.length,
      bitsPerSample: 16,
      channels: 2,
      sampleRate: 48000,
    });
    expect(acc.frames).toBe(frames);
    expect(acc.terminar()).toEqual(picosDeMuestras(lector.leer, lector.frames, 1000, lector.maximo));
  });

  it("keeps a one sample click in its bucket on a long file", () => {
    const frames = 48000 * 60; // a minute at 48 kHz
    const click = 1_000_000;
    const buf = pcm(frames, 1, (f) => (f === click ? 32000 : 100));
    const acc = new PicosEnFlujo(frames, 200, 1);
    feed(acc, buf, [65536]);
    const picos = acc.terminar();
    expect(picos).toHaveLength(200);
    const bucket = Math.floor((click / frames) * 200);
    expect(picos[bucket]).toBeCloseTo(32000 / 32768, 2);
    expect(Math.max(...picos.filter((_, i) => i !== bucket))).toBeCloseTo(100 / 32768, 3);
  });

  it("spreads the blocks over the frames that really arrived", () => {
    const acc = new PicosEnFlujo(48000, 100, 1);
    feed(acc, pcm(24000, 1, () => 16384), [4096]);
    const picos = acc.terminar();
    expect(picos).toHaveLength(100);
    expect(picos.every((p) => p === 0.5)).toBe(true);
  });

  it("takes the louder channel, like the WAV reader", () => {
    const acc = new PicosEnFlujo(10, 10, 2);
    acc.push(pcm(10, 2, (_f, c) => (c === 1 ? -30000 : 10)));
    expect(acc.terminar()[0]).toBeCloseTo(30000 / 32768, 3);
  });
});
