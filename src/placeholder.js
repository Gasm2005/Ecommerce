'use strict';

/**
 * Deterministic SVG placeholder art in the brand palette.
 *
 * Products/hero/occasion tiles fall back to this whenever `images` is empty in
 * data/products.json or config/site.config.json — so the template looks finished
 * before a client has uploaded a single photograph. Drop in real URLs and these
 * disappear automatically.
 */

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function escapeXml(s) {
  return String(s || '').replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

function pairs(theme) {
  const c = theme.colors;
  return [
    [c.cream, c.maroon],
    [c.sand, c.maroonDark],
    [c.ivory, c.gold],
    [c.cream, c.goldLight],
    [c.sand, c.gold],
    [c.ivory, c.maroon]
  ];
}

function svg({ seed = 'x', w = 900, h = 1200, label = '', kind = 'product', monogram = 'A', theme }) {
  const W = Math.max(80, Math.min(2400, parseInt(w, 10) || 900));
  const H = Math.max(80, Math.min(2400, parseInt(h, 10) || 1200));
  const n = hash(String(seed));
  const palette = pairs(theme);
  const [bg, accent] = palette[n % palette.length];
  const ink = theme.colors.ink;
  const heading = theme.fonts.heading;

  const cx = W * (0.32 + ((n >> 3) % 40) / 100);
  const cy = H * (0.3 + ((n >> 7) % 35) / 100);
  const r = Math.min(W, H) * (0.42 + ((n >> 11) % 20) / 100);
  const rot = (n >> 5) % 45;

  const isWide = W / H > 1.2;
  const titleSize = kind === 'hero' ? Math.round(W * 0.045) : Math.round(Math.min(W, H) * 0.062);
  const pad = Math.round(Math.min(W, H) * 0.06);

  const arcs = [0.62, 0.78, 0.94].map((k, i) => `
    <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * k).toFixed(1)}"
            fill="none" stroke="${accent}" stroke-width="${(Math.min(W, H) * 0.0022).toFixed(2)}"
            opacity="${0.16 - i * 0.04}" />`).join('');

  const petals = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4 + (rot * Math.PI) / 180;
    const rr = r * 0.34;
    return `<ellipse cx="${(cx + Math.cos(a) * rr).toFixed(1)}" cy="${(cy + Math.sin(a) * rr).toFixed(1)}"
              rx="${(rr * 0.52).toFixed(1)}" ry="${(rr * 0.2).toFixed(1)}"
              transform="rotate(${((a * 180) / Math.PI).toFixed(1)} ${(cx + Math.cos(a) * rr).toFixed(1)} ${(cy + Math.sin(a) * rr).toFixed(1)})"
              fill="none" stroke="${accent}" stroke-width="${(Math.min(W, H) * 0.0022).toFixed(2)}" opacity="0.28" />`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(label)}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${bg}"/>
      <stop offset="1" stop-color="${theme.colors.ivory}"/>
    </linearGradient>
    <radialGradient id="v" cx="${(cx / W).toFixed(3)}" cy="${(cy / H).toFixed(3)}" r="0.75">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.20"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse">
      <circle cx="1.2" cy="1.2" r="0.7" fill="${ink}" opacity="0.06"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect width="${W}" height="${H}" fill="url(#dots)"/>
  <rect width="${W}" height="${H}" fill="url(#v)"/>
  ${arcs}
  ${petals}
  <rect x="${pad}" y="${pad}" width="${W - pad * 2}" height="${H - pad * 2}"
        fill="none" stroke="${accent}" stroke-width="1" opacity="0.35"/>

  <text x="${pad + 6}" y="${pad + titleSize * 0.9}" font-family="${heading}, Georgia, serif"
        font-size="${Math.round(titleSize * 0.9)}" fill="${accent}" opacity="0.75">${escapeXml(monogram)}</text>

  <text x="${isWide ? pad + 6 : W / 2}" y="${H - pad - titleSize * 0.9}"
        text-anchor="${isWide ? 'start' : 'middle'}"
        font-family="${heading}, Georgia, serif" font-size="${titleSize}" fill="${ink}" opacity="0.82">${escapeXml(label).slice(0, 34)}</text>
  <text x="${isWide ? pad + 6 : W / 2}" y="${H - pad + titleSize * 0.05}"
        text-anchor="${isWide ? 'start' : 'middle'}"
        font-family="Inter, system-ui, sans-serif" font-size="${Math.round(titleSize * 0.32)}"
        letter-spacing="${(titleSize * 0.06).toFixed(1)}" fill="${ink}" opacity="0.45">IMAGE PLACEHOLDER</text>
</svg>`;
}

module.exports = { svg };
