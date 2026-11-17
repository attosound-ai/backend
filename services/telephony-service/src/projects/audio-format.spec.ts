import {
  aacBitrateKbps,
  deliveryDefaults,
  mixFormat,
  mixInputFilters,
  planStorage,
  storageFfmpegArgs,
  storedContainerOf,
  storedSampleRate,
} from "./audio-format";

const MP4 = "mov,mp4,m4a,3gp,3g2,mj2";

describe("storedSampleRate", () => {
  it("never raises the rate and never passes 48 kHz", () => {
    expect(storedSampleRate(8000)).toBe(8000);
    expect(storedSampleRate(22050)).toBe(22050);
    expect(storedSampleRate(44100)).toBe(44100);
    expect(storedSampleRate(48000)).toBe(48000);
    expect(storedSampleRate(96000)).toBe(48000);
    expect(storedSampleRate(192000)).toBe(48000);
  });

  it("drops an odd rate to the AAC rate just below it", () => {
    expect(storedSampleRate(37800)).toBe(32000);
    expect(storedSampleRate(47999)).toBe(44100);
  });
});

describe("aacBitrateKbps", () => {
  it("is 256 kbps for 48 kHz stereo and 128 for mono", () => {
    expect(aacBitrateKbps(48000, 2)).toBe(256);
    expect(aacBitrateKbps(44100, 2)).toBe(256);
    expect(aacBitrateKbps(48000, 1)).toBe(128);
  });

  it("spends less on narrower bands", () => {
    expect(aacBitrateKbps(24000, 1)).toBe(64);
    expect(aacBitrateKbps(32000, 2)).toBe(192);
  });
});

describe("planStorage", () => {
  it("keeps an old app's 8 kHz mono WAV exactly as today", () => {
    expect(
      planStorage({ sampleRate: 8000, channels: 1, codecName: "pcm_s16le", formatName: "wav", durationMs: 1000 }),
    ).toEqual({ action: "keep", container: "wav", sampleRate: 8000, channels: 1 });
  });

  it("keeps telephone grade audio as PCM at the rate it arrives", () => {
    const plan = planStorage({ sampleRate: 16000, channels: 1, codecName: "mp3", formatName: "mp3", durationMs: 1 });
    expect(plan).toMatchObject({ action: "encode", container: "wav", sampleRate: 16000, channels: 1 });
  });

  it("copies AAC that already fits into an m4a without encoding again", () => {
    expect(
      planStorage({ sampleRate: 48000, channels: 2, codecName: "aac", formatName: MP4, durationMs: 1 }),
    ).toEqual({ action: "remux", container: "m4a", sampleRate: 48000, channels: 2 });
    expect(
      planStorage({ sampleRate: 44100, channels: 1, codecName: "aac", formatName: MP4, durationMs: 1 }),
    ).toEqual({ action: "remux", container: "m4a", sampleRate: 44100, channels: 1 });
  });

  it("encodes a 44.1 kHz stereo WAV to 44.1 kHz stereo AAC at 256 kbps", () => {
    expect(
      planStorage({ sampleRate: 44100, channels: 2, codecName: "pcm_s16le", formatName: "wav", durationMs: 1 }),
    ).toEqual({ action: "encode", container: "m4a", sampleRate: 44100, channels: 2, bitrateKbps: 256 });
  });

  it("brings a 96 kHz 24 bit file down to 48 kHz and 5.1 down to stereo", () => {
    expect(
      planStorage({ sampleRate: 96000, channels: 6, codecName: "pcm_s24le", formatName: "wav", durationMs: 1 }),
    ).toEqual({ action: "encode", container: "m4a", sampleRate: 48000, channels: 2, bitrateKbps: 256 });
  });

  it("encodes MP3, ALAC and FLAC (never stored as is)", () => {
    for (const codecName of ["mp3", "alac", "flac"]) {
      expect(
        planStorage({ sampleRate: 44100, channels: 2, codecName, formatName: "mp3", durationMs: 1 }).action,
      ).toBe("encode");
    }
  });

  it("an unreadable file is decoded to WAV without forcing a rate", () => {
    expect(planStorage(null)).toMatchObject({ action: "encode", container: "wav", sampleRate: null });
  });
});

describe("storageFfmpegArgs", () => {
  it("writes faststart m4a so players can seek without the tail", () => {
    const args = storageFfmpegArgs({ action: "encode", container: "m4a", sampleRate: 48000, channels: 2, bitrateKbps: 256 });
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart"]));
    expect(args.slice(-2)).toEqual(["-f", "ipod"]);
  });

  it("remux copies the AAC stream", () => {
    expect(storageFfmpegArgs({ action: "remux", container: "m4a", sampleRate: 48000, channels: 2 })).toEqual(
      expect.arrayContaining(["-c:a", "copy"]),
    );
  });
});

describe("storedContainerOf", () => {
  it("reads the format column, then the key", () => {
    expect(storedContainerOf({ format: "m4a", storageKey: "x.m4a" })).toBe("m4a");
    expect(storedContainerOf({ format: "wav", storageKey: "imports/a.wav" })).toBe("wav");
    expect(storedContainerOf({ format: null, storageKey: "imports/a.m4a" })).toBe("m4a");
    expect(storedContainerOf({})).toBe("wav");
  });
});

describe("mixFormat and mixInputFilters", () => {
  it("a phone only project still mixes at 8 kHz mono", () => {
    expect(mixFormat([{ sampleRate: 8000, channels: 1 }, { sampleRate: 8000, channels: 1 }])).toEqual({
      sampleRate: 8000,
      channels: 1,
    });
  });

  it("one full quality take lifts the mix to 48 kHz stereo", () => {
    expect(mixFormat([{ sampleRate: 8000, channels: 1 }, { sampleRate: 48000, channels: 2 }])).toEqual({
      sampleRate: 48000,
      channels: 2,
    });
  });

  it("an old 8 kHz clip is resampled and panned to both sides at the same level", () => {
    expect(mixInputFilters({ sampleRate: 8000, channels: 1 }, { sampleRate: 48000, channels: 2 })).toEqual([
      "pan=stereo|c0=c0|c1=c0",
      "aresample=48000",
      "aformat=sample_rates=48000:channel_layouts=stereo",
    ]);
  });

  it("an input already in the mix format only pins it", () => {
    expect(mixInputFilters({ sampleRate: 48000, channels: 2 }, { sampleRate: 48000, channels: 2 })).toEqual([
      "aformat=sample_rates=48000:channel_layouts=stereo",
    ]);
  });
});

describe("deliveryDefaults", () => {
  it("keeps WAV for phone grade mixes and whatever the person chose", () => {
    expect(deliveryDefaults({}, 8000)).toEqual({});
    expect(deliveryDefaults({ format: "wav" }, 48000)).toEqual({ format: "wav" });
  });

  it("delivers a full quality mix as AAC 256 kbps when nobody chose", () => {
    expect(deliveryDefaults(undefined, 48000)).toEqual({ format: "aac", quality: "high" });
    expect(deliveryDefaults({ quality: "medium" }, 44100)).toEqual({ format: "aac", quality: "medium" });
  });
});
