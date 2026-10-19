// Offline video export: renders every frame of the match timeline and encodes it with mediabunny.
// MP4/H.264 when the browser can encode it, otherwise WebM/VP9 (or VP8).
import { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, canEncodeVideo, QUALITY_MEDIUM, QUALITY_HIGH } from 'mediabunny';
import { W, H } from './renderer.js';

async function pickFormat(width, height, quality) {
  const opts = { width, height, quality };
  if (await canEncodeVideo('avc', opts)) return { codec: 'avc', format: new Mp4OutputFormat({ fastStart: 'in-memory' }), extension: 'mp4' };
  if (await canEncodeVideo('vp9', opts)) return { codec: 'vp9', format: new WebMOutputFormat(), extension: 'webm' };
  if (await canEncodeVideo('vp8', opts)) return { codec: 'vp8', format: new WebMOutputFormat(), extension: 'webm' };
  if (await canEncodeVideo('av1', opts)) return { codec: 'av1', format: new WebMOutputFormat(), extension: 'webm' };
  throw new Error('This browser cannot encode video (WebCodecs unavailable). Try a recent Chrome, Edge or Safari.');
}

const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * @param match  object from createMatch()
 * @param {{fps?: number, onProgress?: (p:number)=>void, signal?: AbortSignal, start?: number, end?: number, quality?: 'medium'|'high'}} opts
 *   start/end (ms) optionally export a slice of the timeline. quality 'medium' (default, ~1.4 Mbps) or 'high'.
 * @returns {Promise<{blob: Blob, mimeType: string, extension: string, codec: string, frames: number, ms: number}>}
 */
export async function exportVideo(match, { fps = 30, onProgress, signal, start = 0, end, quality = 'medium' } = {}) {
  const q = quality === 'high' ? QUALITY_HIGH : QUALITY_MEDIUM;
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser cannot encode video (WebCodecs unavailable). Try a recent Chrome, Edge or Safari.');
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const stop = Math.min(end ?? match.duration, match.duration);
  const from = Math.max(0, Math.min(start, stop));
  const frames = Math.max(1, Math.ceil(((stop - from) / 1000) * fps));
  const { codec, format, extension } = await pickFormat(W, H, q);

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d', { alpha: false });

  const output = new Output({ format, target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec, quality: q, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const abort = async () => { try { await output.cancel(); } catch { /* ignore */ } throw new DOMException('Export cancelled', 'AbortError'); };
  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) await abort();
      match.render(ctx, from + (i * 1000) / fps);
      await source.add(i / fps, 1 / fps);
      if (i % 10 === 0) {
        onProgress?.(i / frames);
        await tick(); // keep the UI responsive
      }
    }
    if (signal?.aborted) await abort();
    source.close?.();
    await output.finalize();
  } catch (e) {
    if (output.state !== 'canceled' && output.state !== 'finalized') { try { await output.cancel(); } catch { /* ignore */ } }
    throw e;
  }
  onProgress?.(1);
  const mimeType = format.mimeType || (extension === 'mp4' ? 'video/mp4' : 'video/webm');
  const blob = new Blob([output.target.buffer], { type: mimeType });
  const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return { blob, mimeType, extension, codec, frames, ms };
}
