import { Injectable, Logger } from '@nestjs/common';
import { WaveFile } from 'wavefile';
import { AudioStorageService } from './audio-storage.service';

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
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  /** Active capture sessions keyed by streamSid. */
  private readonly sessions = new Map<string, CaptureSession>();

  constructor(private readonly storage: AudioStorageService) {}

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
    });

    this.logger.log(
      'Capture session started: stream=%s call=%s',
      streamSid,
      callSid,
    );
  }

  /** Append a media chunk (base64 mulaw audio) to the session buffer. */
  appendChunk(
    streamSid: string,
    payload: string,
    timestamp: number,
    track: string,
  ): void {
    const session = this.sessions.get(streamSid);
    if (!session) return;

    const chunk = Buffer.from(payload, 'base64');
    if (track === 'outbound') {
      session.outboundChunks.push(chunk);
    } else {
      session.inboundChunks.push(chunk);
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

    // Upload to MinIO
    const storageKey = this.storage.buildStorageKey(
      session.callSid,
      segmentIndex,
      session.track,
    );
    const { bucket, size } = await this.storage.upload(storageKey, wavBuffer);

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
