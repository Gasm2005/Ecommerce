'use strict';

/**
 * Uploads for review photos/video and admin images.
 *
 * Key UX decision: files upload and compress the moment they're chosen, in the
 * background, while the customer is still typing their review (which takes ~30s).
 * Each finished file gets a short-lived token; the review form carries the tokens
 * as hidden inputs and submitting is instant because the work is already done.
 *
 * Files land in public/uploads/… and are served from /static/uploads/…, so
 * nothing outside the public directory is ever writable.
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const media = require('./media');

const ROOT = path.join(__dirname, '..', 'public', 'uploads');
const DIRS = {
  reviews: { abs: path.join(ROOT, 'reviews'), base: '/static/uploads/reviews' },
  products: { abs: path.join(ROOT, 'products'), base: '/static/uploads/products' },
  journal: { abs: path.join(ROOT, 'journal'), base: '/static/uploads/journal' }
};

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];

/* Generous limits, because everything is compressed on arrival. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 6;
const PENDING_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours to finish writing a review

function ensure(kind) {
  const dir = DIRS[kind] || DIRS.reviews;
  if (!fs.existsSync(dir.abs)) fs.mkdirSync(dir.abs, { recursive: true });
  return dir;
}

function makeUploader(kind) {
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      cb(null, ensure(kind).abs);
    },
    filename(req, file, cb) {
      // Never trust the client filename — keep a safe extension only.
      const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.bin'])[0];
      cb(null, `${kind.slice(0, 3)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: MAX_VIDEO_BYTES, files: MAX_FILES, fields: 25 },
    fileFilter(req, file, cb) {
      const ok = IMAGE_TYPES.includes(file.mimetype) || VIDEO_TYPES.includes(file.mimetype);
      if (!ok) return cb(new Error('Only JPG/PNG/WebP/HEIC photos and MP4/WebM/MOV video are accepted.'));
      cb(null, true);
    }
  });
}

const uploaders = {
  reviews: makeUploader('reviews'),
  products: makeUploader('products'),
  journal: makeUploader('journal')
};

/** Multer middleware that reports failures on req.uploadError instead of throwing. */
function accept(kind, field = 'media', count = MAX_FILES) {
  return (req, res, next) => {
    uploaders[kind].array(field, count)(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large (photos up to 25 MB, video up to 200 MB).'
          : err.message;
      }
      next();
    });
  };
}

/* ---------------------------------------------------------------- pending ---- */
/* token → descriptor, so a review can reference files uploaded minutes earlier. */

const pending = new Map();

function stash(kind, descriptor) {
  const token = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  pending.set(token, { kind, descriptor, at: Date.now() });
  return token;
}

function peek(token) {
  const row = pending.get(token);
  return row ? row.descriptor : null;
}

/** Consumes tokens, returning their descriptors in order. */
function claim(tokens) {
  const list = [].concat(tokens || []).filter(Boolean);
  const out = [];
  list.forEach((t) => {
    const row = pending.get(t);
    if (!row) return;
    out.push(row.descriptor);
    pending.delete(t);
  });
  return out;
}

function discard(token) {
  const row = pending.get(token);
  if (!row) return false;
  removeMedia([row.descriptor]);
  pending.delete(token);
  return true;
}

/** Deletes files whose review was never submitted. */
function sweepOrphans() {
  const now = Date.now();
  [...pending.entries()].forEach(([token, row]) => {
    if (now - row.at < PENDING_TTL_MS) return;
    removeMedia([row.descriptor]);
    pending.delete(token);
  });
}

setInterval(sweepOrphans, 30 * 60 * 1000).unref();

/* ---------------------------------------------------------------- process ---- */

/**
 * Compresses one uploaded file (images → WebP, video → MP4 720p) and returns
 * { descriptor, token }. Runs while the customer is still typing.
 */
async function processOne(kind, file) {
  const dir = ensure(kind);
  const isImage = IMAGE_TYPES.includes(file.mimetype);

  if (isImage && file.size > MAX_IMAGE_BYTES) {
    remove(kind, file.filename);
    return { error: `${file.originalname} is larger than 25 MB.` };
  }

  const descriptor = await media.process(file, dir.base);
  descriptor.originalName = file.originalname;
  return { descriptor, token: stash(kind, descriptor) };
}

async function processAll(kind, files) {
  const out = [];
  for (const f of files || []) {
    out.push(await processOne(kind, f)); // sequential: ffmpeg is CPU-hungry
  }
  return out;
}

/* ----------------------------------------------------------------- delete ---- */

function remove(kind, filename) {
  try {
    const dir = DIRS[kind] || DIRS.reviews;
    const target = path.join(dir.abs, path.basename(filename));
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch { /* a missing file isn't worth failing a request over */ }
}

/** Removes every file a set of descriptors points at (original + thumb/poster). */
function removeMedia(list) {
  (list || []).forEach((m) => {
    ['src', 'thumb'].forEach((key) => {
      if (!m[key]) return;
      const kind = String(m[key]).includes('/products') ? 'products'
        : String(m[key]).includes('/journal') ? 'journal' : 'reviews';
      remove(kind, String(m[key]).split('/').pop());
    });
  });
}

module.exports = {
  DIRS, IMAGE_TYPES, VIDEO_TYPES, MAX_FILES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES,
  accept, processOne, processAll, stash, peek, claim, discard, remove, removeMedia, sweepOrphans
};
