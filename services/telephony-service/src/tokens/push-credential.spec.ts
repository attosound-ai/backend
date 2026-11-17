import { choosePushCredential, normalizePlatform } from "./push-credential";

const full = { apns: "CRapns", android: "CRandroid", fcmLegacy: "CRfcm" };

describe("push credential by platform", () => {
  it("iOS keeps the APNs credential (current apps unchanged)", () => {
    expect(choosePushCredential("ios", full)).toEqual({
      sid: "CRapns",
      source: "apns",
      missingReason: null,
    });
  });

  it("Android uses its own FCM credential, never the APNs one", () => {
    expect(choosePushCredential("android", full)).toEqual({
      sid: "CRandroid",
      source: "android",
      missingReason: null,
    });
  });

  it("Android without the variable gets a token with no credential, and says why", () => {
    expect(choosePushCredential("android", { ...full, android: "" })).toEqual({
      sid: null,
      source: "none",
      missingReason: "android_env_missing",
    });
  });

  it("Android never falls back to the old FCM credential", () => {
    const choice = choosePushCredential("android", { ...full, android: "   " });
    expect(choice.sid).toBeNull();
  });

  it("iOS without APNs says so instead of borrowing another credential", () => {
    expect(choosePushCredential("ios", { ...full, apns: "" })).toEqual({
      sid: null,
      source: "none",
      missingReason: "apns_env_missing",
    });
  });

  it("an unknown platform keeps what it got before (the old FCM credential)", () => {
    expect(choosePushCredential(undefined, full).source).toBe("fcm_legacy");
    expect(choosePushCredential("web", full).sid).toBe("CRfcm");
    expect(choosePushCredential("", { ...full, fcmLegacy: "" }).missingReason).toBe(
      "fcm_legacy_env_missing",
    );
  });

  it("platform matching ignores case and spaces", () => {
    expect(normalizePlatform(" Android ")).toBe("android");
    expect(choosePushCredential("IOS", full).source).toBe("apns");
    expect(normalizePlatform(null)).toBe("unknown");
  });
});
