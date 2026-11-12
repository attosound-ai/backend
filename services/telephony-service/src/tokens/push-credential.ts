/**
 * Which Twilio Push Credential goes into a voice token, by client platform.
 *
 * iOS uses the APNs credential, exactly as before. Android uses its own FCM
 * credential (TWILIO_PUSH_CREDENTIAL_SID_ANDROID), created from the service
 * account of the Firebase project the app ships with (atto-sound-eb8f9). The
 * older TWILIO_PUSH_CREDENTIAL_SID_FCM (Feb 2026, never used by a real Android
 * build) keeps serving only clients that send no known platform, which is what
 * they got before this change.
 *
 * A missing credential never breaks the token: it goes out without one (outgoing
 * calls still work, incoming pushes cannot) and the reason is reported.
 */
export interface PushCredentialConfig {
  apns: string;
  android: string;
  fcmLegacy: string;
}

export type PushCredentialSource = "apns" | "android" | "fcm_legacy" | "none";

export interface PushCredentialChoice {
  sid: string | null;
  source: PushCredentialSource;
  /** Why there is no credential, null when there is one. */
  missingReason: string | null;
}

function clean(value: string | undefined | null): string {
  return (value ?? "").trim();
}

export function normalizePlatform(platform: string | undefined | null): string {
  const p = clean(platform).toLowerCase();
  return p || "unknown";
}

export function choosePushCredential(
  platform: string | undefined | null,
  config: PushCredentialConfig,
): PushCredentialChoice {
  const p = normalizePlatform(platform);
  if (p === "ios") {
    const sid = clean(config.apns);
    return sid
      ? { sid, source: "apns", missingReason: null }
      : { sid: null, source: "none", missingReason: "apns_env_missing" };
  }
  if (p === "android") {
    const sid = clean(config.android);
    return sid
      ? { sid, source: "android", missingReason: null }
      : { sid: null, source: "none", missingReason: "android_env_missing" };
  }
  const legacy = clean(config.fcmLegacy);
  return legacy
    ? { sid: legacy, source: "fcm_legacy", missingReason: null }
    : { sid: null, source: "none", missingReason: "fcm_legacy_env_missing" };
}
