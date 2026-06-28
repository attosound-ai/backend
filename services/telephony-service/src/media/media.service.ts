import { Injectable, Logger } from '@nestjs/common';
import { WaveFile } from 'wavefile';
import { AudioStorageService } from './audio-storage.service';
import { AnalyticsService } from '../analytics/analytics.service';

/** Represents a single active audio capture session. */
interface CaptureSession {
  streamSid: string;
  callSid: string;
  callId: string;
  userId: string;
  track: string;
  inboundChunks: Buffer[];
  outboundChunks: Buffer[];
  startTimestamp: number;
  lastTimestamp: number;
  // Per-track frame-label accounting. Twilio normally labels every both_tracks
  // frame 'inbound'/'outbound'; counting missing/other labels separates a
  // genuine one-track fork (no remote at source) from a mislabel that would
  // otherwise be silently bucketed as inbound.
  framesLabeledInbound: number;
  framesLabeledOutbound: number;
  framesMissingLabel: number;
  framesLabeledOther: number;
  /** Twilio timestamp of the first outbound (remote) frame, or null if none. */
  firstOutboundTs: number | null;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  /** Active capture sessions keyed by streamSid. */
  private readonly sessions = new Map<string, CaptureSession>();

  constructor(
    private readonly storage: AudioStorageService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Initialize a new capture session when a Media Stream connects. */
  startSession(
    streamSid: string,
    callSid: string,
    callId: string,
    userId: string,
    track: string,
  ): void {
    this.sessions.set(streamSid, {
      streamSid,
      callSid,
      callId,
      userId,
      track,
      inboundChunks: [],
      outboundChunks: [],
      startTimestamp: 0,
      lastTimestamp: 0,
      framesLabeledInbound: 0,
      framesLabeledOutbound: 0,
      framesMissingLabel: 0,
      framesLabeledOther: 0,
      firstOutboundTs: null,
    });

    this.logger.log(
      'Capture session started: stream=%s call=%s',
      streamSid,
      callSid,
    );
  }

  /**
   * Append a media chunk (base64 mulaw audio) to the session buffer.
   * `track` is the raw label from the Twilio media frame — may be undefined
   * if Twilio omits it. We bucket outbound→remote, everything else→local
   * (preserving prior behaviour) but COUNT each label class so a mislabeled
   * remote can't masquerade as "no outbound" in the telemetry.
   */
  appendChunk(
    streamSid: string,
    payload: string,
    timestamp: number,
    track: string | undefined,
  ): void {
    const session = this.sessions.get(streamSid);
    if (!session) return;

    const chunk = Buffer.from(payload, 'base64');
    if (track === 'outbound') {
      session.outboundChunks.push(chunk);
      session.framesLabeledOutbound += 1;
      if (session.firstOutboundTs === null) {
        session.firstOutboundTs = timestamp;
      }
    } else if (track === 'inbound') {
      session.inboundChunks.push(chunk);
      session.framesLabeledInbound += 1;
    } else if (!track) {
      // Missing label — buffer as inbound (prior behaviour) but flag it.
      session.inboundChunks.push(chunk);
      session.framesMissingLabel += 1;
    } else {
      // Unknown label value — buffer as inbound, count separately.
      session.inboundChunks.push(chunk);
      session.framesLabeledOther += 1;
    }

    if (session.startTimestamp === 0) {
      session.startTimestamp = timestamp;
    }
    session.lastTimestamp = timestamp;
  }

  /** Finalize a capture session: convert mulaw→WAV and upload to MinIO. */
  async finalizeSession(
    streamSid: string,
    segmentIndex: number,
  ): Promise<{
    storageBucket: string;
    storageKey: string;
    durationMs: number;
    fileSizeBytes: number;
    startMs: number;
    endMs: number;
  } | null> {
    const session = this.sessions.get(streamSid);
    if (!session) {
      this.logger.warn('No session found for stream=%s', streamSid);
      return null;
    }

    this.sessions.delete(streamSid);

    const hasInbound = session.inboundChunks.length > 0;
    const hasOutbound = session.outboundChunks.length > 0;
    if (!hasInbound && !hasOutbound) {
      this.logger.warn('Empty session for stream=%s — skipping', streamSid);
      return null;
    }

    // Decode each track from mulaw → PCM16 separately
    const decodeMulaw = (chunks: Buffer[]): Int16Array => {
      if (chunks.length === 0) return new Int16Array(0);
      const raw = Buffer.concat(chunks);
      const wav = new WaveFile();
      wav.fromScratch(1, 8000, '8m', raw);
      wav.fromMuLaw();
      // toBuffer() returns the full WAV file; extract PCM data after 44-byte header
      const fullBuf = Buffer.from(wav.toBuffer());
      const pcmData = fullBuf.subarray(44);
      return new Int16Array(
        pcmData.buffer,
        pcmData.byteOffset,
        pcmData.byteLength / 2,
      );
    };

    const inboundPcm = decodeMulaw(session.inboundChunks);
    const outboundPcm = decodeMulaw(session.outboundChunks);

    // Mix both tracks into mono (average the two channels)
    const maxLen = Math.max(inboundPcm.length, outboundPcm.length);
    const mixed = new Int16Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      const a = i < inboundPcm.length ? inboundPcm[i] : 0;
      const b = i < outboundPcm.length ? outboundPcm[i] : 0;
      // Average and clamp to Int16 range
      mixed[i] = Math.max(-32768, Math.min(32767, Math.round((a + b) / 2)));
    }

    // Create final WAV from mixed PCM16
    const finalWav = new WaveFile();
    finalWav.fromScratch(1, 8000, '16', mixed);
    const wavBuffer = Buffer.from(finalWav.toBuffer());

    // Duration from the longer track
    const durationMs = Math.round((maxLen / 8000) * 1000);

    // Upload to MinIO. Previously this had no try/catch — a MinIO failure threw,
    // the segment never saved, kafka never fired, and the client's poll loop
    // exhausted into a generic "recording not found" with zero server reason.
    // Now we capture the upload outcome so "not found" splits cleanly into
    // empty-stream / finalize-crash / upload-fail, and return null on failure
    // (the gateway still emits backend_recording_segment with saved=false).
    const storageKey = this.storage.buildStorageKey(
      session.callSid,
      segmentIndex,
      session.track,
    );

    const uploadStart = Date.now();
    let bucket: string;
    let size: number;
    try {
      const r = await this.storage.upload(storageKey, wavBuffer);
      bucket = r.bucket;
      size = r.size;
    } catch (err) {
      const e = err as {
        name?: string;
        Code?: string;
        message?: string;
        $metadata?: { httpStatusCode?: number };
      };
      this.analytics.capture(
        session.userId || null,
        'backend_recording_upload',
        {
          call_sid: session.callSid,
          stream_sid: streamSid,
          storage_key: storageKey,
          file_size_bytes: wavBuffer.length,
          upload_latency_ms: Date.now() - uploadStart,
          outcome: 'failed',
          s3_error_code: e?.Code ?? e?.name ?? null,
          http_status: e?.$metadata?.httpStatusCode ?? null,
          error_message: e?.message ?? String(err),
        },
      );
      this.logger.error(
        'Segment upload failed for stream=%s key=%s: %s',
        streamSid,
        storageKey,
        e?.message ?? String(err),
      );
      return null;
    }

    this.analytics.capture(session.userId || null, 'backend_recording_upload', {
      call_sid: session.callSid,
      stream_sid: streamSid,
      storage_key: storageKey,
      file_size_bytes: size,
      upload_latency_ms: Date.now() - uploadStart,
      outcome: 'success',
    });

    this.logger.log(
      'Segment saved: stream=%s key=%s duration=%dms size=%d',
      streamSid,
      storageKey,
      durationMs,
      size,
    );

    return {
      storageBucket: bucket,
      storageKey,
      durationMs,
      fileSizeBytes: size,
      startMs: session.startTimestamp,
      endMs: session.lastTimestamp,
    };
  }

  /** Check if a session exists. */
  hasSession(streamSid: string): boolean {
    return this.sessions.has(streamSid);
  }

  /** Get session info (for the call ID lookup). */
  getSession(streamSid: string): CaptureSession | undefined {
    return this.sessions.get(streamSid);
  }
}
