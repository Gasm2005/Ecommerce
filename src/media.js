'use strict';

/**
 * Automatic media compression — one pipeline for every upload in the app
 * (customer review photos/video, admin product images, journal covers).
 *
 *  images → WebP, auto-rotated, resized to a max long edge
 *  video  → H.264/AAC MP4, max 720p, faststart (streams before fully loaded)
 *
 * Both degrade gracefully: if sharp or ffmpeg is unavailable, the original file
 * is kept and the reason is reported, so an upload never fails outright.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IMAGE_MAX_EDGE = 1800;   // plenty for a full-bleed product shot
const IMAGE_QUALITY = 78;
const THUMB_EDGE = 480;
const VIDEO_MAX_HEIGHT = 720;
const VIDEO_CRF = 28;          // visually fine, roughly 1/4 the bitrate
const VIDEO_AUDIO_KBPS = 96;
const VIDEO_TIMEOUT_MS = 5 * 60 * 1000;

let sharp = null;
let sharpError = null;
try {
  sharp = require('sharp');
} catch (err) {
  sharpError = err.message;
}

let ffmpegPath = null;
let ffmpegError = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    ffmpegError = 'ffmpeg binary missing';
    ffmpegPath = null;
  }
} catch (err) {
  ffmpegError = err.message;
}

function available() {
  return {
    images: !!sharp,
    imagesError: sharpError,
    video: !!ffmpegPath,
    videoError: ffmpegError,
    settings: {
      imageMaxEdge: IMAGE_MAX_EDGE,
      imageQuality: IMAGE_QUALITY,
      videoMaxHeight: VIDEO_MAX_HEIGHT,
      videoCrf: VIDEO_CRF
    }
  };
}

function bytes(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function unlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

function swapExt(file, ext) {
  return path.join(path.dirname(file), path.basename(file, path.extname(file)) + ext);
}

/**
 * Compresses an image to WebP in place (writes a .webp sibling, removes the
 * original) and also writes a small `-thumb.webp` for grids and admin tables.
 */
async function compressImage(absPath) {
  const before = bytes(absPath);
  if (!sharp) return { ok: false, reason: 'sharp unavailable: ' + sharpError, path: absPath, before, after: before };

  const target = swapExt(absPath, '.webp');
  const thumb = swapExt(absPath, '-thumb.webp');
  const tmp = target + '.tmp';

  try {
    const meta = await sharp(absPath).metadata();

    await sharp(absPath)
      .rotate()                                   // honour EXIF orientation
      .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: IMAGE_QUALITY, effort: 4 })
      .toFile(tmp);

    await sharp(absPath)
      .rotate()
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70, effort: 4 })
      .toFile(thumb);

    // Only replace the original once both writes succeeded.
    fs.renameSync(tmp, target);
    if (path.resolve(target) !== path.resolve(absPath)) unlink(absPath);

    const after = bytes(target);
    const outMeta = await sharp(target).metadata();

    return {
      ok: true,
      path: target,
      thumbPath: thumb,
      before,
      after,
      width: outMeta.width,
      height: outMeta.height,
      sourceFormat: meta.format
    };
  } catch (err) {
    unlink(tmp);
    unlink(thumb);
    return { ok: false, reason: err.message, path: absPath, before, after: before };
  }
}

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).split('\n').slice(-4).join(' ').trim()));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Transcodes video to a web-friendly MP4 and extracts a poster frame.
 * Slow by nature — fine for a handful of uploads, move to a queue at volume.
 */
async function compressVideo(absPath) {
  const before = bytes(absPath);
  if (!ffmpegPath) return { ok: false, reason: 'ffmpeg unavailable: ' + ffmpegError, path: absPath, before, after: before };

  const target = swapExt(absPath, '.mp4');
  const tmp = swapExt(absPath, '-c.mp4');
  const poster = swapExt(absPath, '-poster.webp');

  try {
    await run(ffmpegPath, [
      '-y', '-i', absPath,
      '-vf', `scale='min(iw,trunc(iw*${VIDEO_MAX_HEIGHT}/ih/2)*2)':'min(ih,${VIDEO_MAX_HEIGHT})'`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF),
      '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', `${VIDEO_AUDIO_KBPS}k`, '-ac', '2',
      '-movflags', '+faststart',
      '-max_muxing_queue_size', '1024',
      tmp
    ], VIDEO_TIMEOUT_MS);

    // Poster frame at 1s (or the first frame for very short clips).
    try {
      await run(ffmpegPath, ['-y', '-ss', '00:00:01', '-i', tmp, '-frames:v', '1', '-vf', `scale=${THUMB_EDGE}:-2`, poster], 60000);
    } catch {
      await run(ffmpegPath, ['-y', '-i', tmp, '-frames:v', '1', '-vf', `scale=${THUMB_EDGE}:-2`, poster], 60000).catch(() => {});
    }

    const compressed = bytes(tmp);
    // If the "compressed" file came out bigger (already-optimised source), keep
    // the original rather than shipping something worse.
    if (compressed >= before && path.extname(absPath).toLowerCase() === '.mp4') {
      unlink(tmp);
      return { ok: true, path: absPath, posterPath: fs.existsSync(poster) ? poster : null, before, after: before, skipped: true };
    }

    if (path.resolve(target) !== path.resolve(absPath)) unlink(absPath);
    fs.renameSync(tmp, target);

    return {
      ok: true,
      path: target,
      posterPath: fs.existsSync(poster) ? poster : null,
      before,
      after: bytes(target)
    };
  } catch (err) {
    unlink(tmp);
    return { ok: false, reason: err.message, path: absPath, before, after: before };
  }
}

/**
 * Processes one uploaded file and returns a media descriptor ready to store.
 * `publicBase` maps the upload directory to its /static URL.
 */
async function process(file, publicBase) {
  const isVideo = String(file.mimetype || '').startsWith('video/');
  const result = isVideo ? await compressVideo(file.path) : await compressImage(file.path);

  const rel = (abs) => (abs ? `${publicBase}/${path.basename(abs)}` : null);
  const saved = result.before && result.after ? Math.max(0, result.before - result.after) : 0;

  return {
    type: isVideo ? 'video' : 'image',
    src: rel(result.path),
    thumb: rel(result.thumbPath || result.posterPath),
    mime: isVideo ? (result.path && result.path.endsWith('.mp4') ? 'video/mp4' : file.mimetype) : 'image/webp',
    width: result.width || null,
    height: result.height || null,
    bytes: result.after || result.before,
    originalBytes: result.before,
    savedBytes: saved,
    savedPercent: result.before ? Math.round((saved / result.before) * 100) : 0,
    compressed: !!result.ok && !result.skipped,
    note: result.ok ? null : result.reason
  };
}

/** Every file a descriptor points at, for cleanup on delete. */
function filesOf(media) {
  const out = [];
  (media || []).forEach((m) => {
    if (m.src) out.push(path.basename(m.src));
    if (m.thumb) out.push(path.basename(m.thumb));
  });
  return out;
}

module.exports = { available, process, compressImage, compressVideo, filesOf, IMAGE_MAX_EDGE, VIDEO_MAX_HEIGHT };
