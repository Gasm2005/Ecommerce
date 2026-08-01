'use strict';

/**
 * Colour-name → hex, used for filter swatches and the product colourway picker.
 * Add client-specific colour names here (or extend from data/products.json).
 */
const SWATCHES = {
  'Rani Pink': '#C2185B', 'Maroon': '#6B1B2B', 'Red': '#B3121F', 'Rust': '#9C4A1A',
  'Gold': '#B8912F', 'Champagne': '#E4D3AE', 'Ivory': '#F6F1E7', 'White': '#FFFFFF',
  'Blush Pink': '#EDC7C7', 'Peach': '#F2C6A8', 'Mustard': '#D3A02A', 'Marigold': '#E9A825',
  'Emerald': '#0F6B4F', 'Bottle Green': '#14452F', 'Mint': '#BFE3D0', 'Turquoise': '#1F9B9B',
  'Powder Blue': '#BBD3E8', 'Navy': '#1E2A48', 'Silver': '#C9CBCF', 'Grey': '#8B8D91',
  'Black': '#151515', 'Wine': '#5B1930', 'Purple': '#5B2A6B'
};

const FALLBACK = '#D8CFC0';

function swatch(name) {
  return SWATCHES[name] || FALLBACK;
}

module.exports = { SWATCHES, swatch };
