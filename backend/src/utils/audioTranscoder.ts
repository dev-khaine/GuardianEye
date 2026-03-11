/**
 * AudioTranscoder
 *
 * Spawns a persistent ffmpeg process per session to transcode the browser's
 * MediaRecorder output (audio/webm;codecs=opus) into the raw PCM format that
 * Gemini Live API requires (s16le, 16 kHz, mono).
 *
 * Why persistent process?
 *   MediaRecorder sends the webm container header ONLY in the first chunk.
 *   Subsequent chunks are raw webm "clusters" with no header. If you tried to
 *   transcode each chunk independently, every chunk after the first would fail
 *   because ffmpeg wouldn't have the codec context. Keeping stdin open solves
 *   this — ffmpeg maintains its decoder state for the whole session.
 *
 * Data flow:
 *   Browser (webm/opus) → base64 → WS → backend
 *     → AudioTranscoder.write(buffer)   [feeds ffmpeg stdin]
 *     → ffmpeg transcodes               [s16le 16 kHz mono on stdout]
 *     → onPCMChunk callback             [re-encoded as base64 → Gemini Live]
 */

import { spawn, ChildProcess } from 'child_process';
import { logger } from './logger';

// ffmpeg-static ships a pre-built binary; fall back to PATH for Docker/Cloud Run
let ffmpegBinary: string;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ffmpegBinary = require('ffmpeg-static') as string;
} catch {
  ffmpegBinary = 'ffmpeg';   // assume it's on PATH (Cloud Run base image)
}

export type PCMChunkCallback = (pcmBase64: string) => void;

export class AudioTranscoder {
  private process: ChildProcess | null = null;
  private readonly sessionId: string;
  private readonly onPCMChunk: PCMChunkCallback;
  private started = false;
  private destroyed = false;

  // Minimum output bytes before we forward a chunk to Gemini.
  // 16 kHz × 2 bytes × 0.1 s = 3 200 bytes ≈ 100 ms of audio
  private static readonly MIN_CHUNK_BYTES = 3200;
  private outputBuffer: Buffer = Buffer.alloc(0);

  constructor(sessionId: string, onPCMChunk: PCMChunkCallback) {
    this.sessionId = sessionId;
    this.onPCMChunk = onPCMChunk;
  }

  /** Call once when the session starts and mic data begins arriving. */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;

    this.process = spawn(ffmpegBinary, [
      // ── Input ────────────────────────────────────────────────────────────
      '-f',       'webm',       // container coming from MediaRecorder
      '-i',       'pipe:0',     // read from our stdin pipe

      // ── Output ───────────────────────────────────────────────────────────
      '-f',       's16le',      // raw signed 16-bit little-endian PCM
      '-ar',      '16000',      // 16 kHz — Gemini Live requirement
      '-ac',      '1',          // mono
      '-acodec',  'pcm_s16le',

      // Extra flags for low-latency streaming
      '-flush_packets', '1',
      '-fflags',  'nobuffer',
      '-flags',   'low_delay',

      'pipe:1',                 // write to our stdout pipe
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // ── stdout → collect PCM, flush in ~100 ms chunks ─────────────────────
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.outputBuffer = Buffer.concat([this.outputBuffer, chunk]);

      if (this.outputBuffer.length >= AudioTranscoder.MIN_CHUNK_BYTES) {
        const pcmBase64 = this.outputBuffer.toString('base64');
        this.outputBuffer = Buffer.alloc(0);
        this.onPCMChunk(pcmBase64);
      }
    });

    // Flush any remaining buffered PCM when ffmpeg finishes
    this.process.stdout?.on('end', () => {
      if (this.outputBuffer.length > 0) {
        this.onPCMChunk(this.outputBuffer.toString('base64'));
        this.outputBuffer = Buffer.alloc(0);
      }
    });

    // ── stderr → log warnings but don't treat as fatal ────────────────────
    let stderrBuf = '';
    this.process.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      // Only log actual errors, not the normal ffmpeg banner
      if (stderrBuf.includes('Error') || stderrBuf.includes('Invalid')) {
        logger.warn(`[AudioTranscoder:${this.sessionId}] ffmpeg: ${stderrBuf.trim()}`);
        stderrBuf = '';
      }
    });

    this.process.on('error', (err) => {
      logger.error(`[AudioTranscoder:${this.sessionId}] spawn error:`, err);
    });

    this.process.on('exit', (code, signal) => {
      if (!this.destroyed) {
        logger.warn(`[AudioTranscoder:${this.sessionId}] ffmpeg exited unexpectedly: code=${code} signal=${signal}`);
      }
    });

    logger.debug(`[AudioTranscoder:${this.sessionId}] ffmpeg started (binary: ${ffmpegBinary})`);
  }

  /**
   * Feed a raw webm buffer into ffmpeg.
   * Call this for every audio chunk received from the browser.
   */
  write(webmBuffer: Buffer): void {
    if (this.destroyed || !this.process?.stdin?.writable) return;

    try {
      this.process.stdin.write(webmBuffer);
    } catch (err) {
      logger.warn(`[AudioTranscoder:${this.sessionId}] write error:`, err);
    }
  }

  /**
   * Gracefully shut down the transcoder.
   * Call this when the session ends or the client disconnects.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    try {
      this.process?.stdin?.end();     // signal EOF → ffmpeg flushes and exits
    } catch { /* ignore */ }

    // Give ffmpeg 500 ms to flush, then force-kill
    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill('SIGTERM');
      }
    }, 500);

    logger.debug(`[AudioTranscoder:${this.sessionId}] destroyed`);
  }

  get isRunning(): boolean {
    return this.started && !this.destroyed && (this.process?.exitCode === null ?? false);
  }
}
