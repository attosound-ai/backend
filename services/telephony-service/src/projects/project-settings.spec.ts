import { exportRangeFilters, rememberedExportPrefs } from "./project-settings";

describe("exportRangeFilters", () => {
  it("cuts the mix to the range, in seconds", () => {
    expect(exportRangeFilters({ rangeStartMs: 1500, rangeEndMs: 75250 })).toEqual([
      "atrim=start=1.500:end=75.250",
      "asetpts=PTS-STARTPTS",
    ]);
  });

  it("accepts a range drawn right to left", () => {
    expect(exportRangeFilters({ rangeStartMs: 9000, rangeEndMs: 3000 })[0]).toBe(
      "atrim=start=3.000:end=9.000",
    );
  });

  it("clamps a negative start to zero", () => {
    expect(exportRangeFilters({ rangeStartMs: -40, rangeEndMs: 1000 })[0]).toBe(
      "atrim=start=0.000:end=1.000",
    );
  });

  it("ignores a missing, partial, broken or tiny range", () => {
    expect(exportRangeFilters(undefined)).toEqual([]);
    expect(exportRangeFilters({})).toEqual([]);
    expect(exportRangeFilters({ rangeStartMs: 1000 })).toEqual([]);
    expect(exportRangeFilters({ rangeStartMs: NaN, rangeEndMs: 5000 })).toEqual([]);
    expect(exportRangeFilters({ rangeStartMs: 1000, rangeEndMs: 1005 })).toEqual([]);
  });
});

describe("rememberedExportPrefs", () => {
  it("keeps the exporter picks and drops the range", () => {
    expect(
      rememberedExportPrefs({ format: "aac", quality: "low", rangeStartMs: 1, rangeEndMs: 2 }),
    ).toEqual({ format: "aac", quality: "low" });
  });
});
