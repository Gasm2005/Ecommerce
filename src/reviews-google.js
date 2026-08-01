'use strict';

/**
 * Live Google reviews.
 *
 * Important distinction, because it decides what you can build:
 *
 *  · Google Business Profile reviews (this file) are attached to the BUSINESS,
 *    not to a product. Fetched through the Places API, capped at 5 reviews plus
 *    the aggregate rating. Perfect for a store-rating badge and a testimonials
 *    rail; impossible to show "reviews for this lehenga".
 *
 *  · Per-product star ratings in Google Shopping go the other way: you EXPORT
 *    your own reviews to Google in the Merchant Center product-reviews schema
 *    (see marketing.merchantReviewFeed / /feeds/product-reviews.xml).
 *
 *  · Per-product review widgets from a third party (Judge.me, Yotpo, Okendo,
 *    Trustpilot) drop in as a script tag — see README.
 *
 * Setup: put the place id in config.reviews.googlePlaceId and the API key in the
 * GOOGLE_PLACES_API_KEY environment variable (never in the config file — it is
 * served to the browser as part of the theme).
 */

const CACHE = { at: 0, data: null, error: null, placeId: null };

function isConfigured(config) {
  const r = config.reviews || {};
  return !!(r.googlePlaceId && process.env.GOOGLE_PLACES_API_KEY);
}

function status(config) {
  const r = config.reviews || {};
  if (!r.googlePlaceId) return { ok: false, reason: 'No Google place id set in Settings → Reviews.' };
  if (!process.env.GOOGLE_PLACES_API_KEY) return { ok: false, reason: 'GOOGLE_PLACES_API_KEY is not set in the environment.' };
  return {
    ok: true,
    cachedAt: CACHE.at ? new Date(CACHE.at).toISOString() : null,
    count: CACHE.data ? CACHE.data.reviews.length : 0,
    error: CACHE.error
  };
}

/** Normalises a Google review into the same shape as a local one. */
function normalise(r) {
  return {
    id: 'GOOGLE-' + (r.time || Math.random().toString(36).slice(2)),
    source: 'google',
    rating: r.rating,
    title: null,
    body: (r.text || '').trim(),
    author: r.author_name,
    authorPhoto: r.profile_photo_url || null,
    location: null,
    relative: r.relative_time_description || '',
    createdAt: r.time ? new Date(r.time * 1000).toISOString() : null,
    url: r.author_url || null,
    status: 'approved',
    verified: false,
    reply: null
  };
}

/**
 * Fetches (and caches) the place rating + up to 5 reviews. Never throws — on
 * failure it returns the last good payload, or null with an error message, so a
 * Google outage can't take the storefront down.
 */
async function fetchStore(config) {
  if (!isConfigured(config)) return null;

  const r = config.reviews || {};
  const ttl = (r.cacheMinutes || 180) * 60 * 1000;
  const placeId = r.googlePlaceId;
  const fresh = CACHE.data && CACHE.placeId === placeId && (Date.now() - CACHE.at) < ttl;
  if (fresh) return CACHE.data;

  const params = new URLSearchParams({
    place_id: placeId,
    fields: 'name,rating,user_ratings_total,reviews,url',
    reviews_sort: 'newest',
    key: process.env.GOOGLE_PLACES_API_KEY
  });

  try {
    const res = await fetch('https://maps.googleapis.com/maps/api/place/details/json?' + params, {
      signal: AbortSignal.timeout(6000)
    });
    const json = await res.json();

    if (json.status !== 'OK') {
      CACHE.error = json.error_message || json.status;
      return CACHE.data; // serve stale rather than nothing
    }

    const result = json.result || {};
    CACHE.data = {
      name: result.name,
      rating: result.rating || 0,
      total: result.user_ratings_total || 0,
      profileUrl: result.url || null,
      reviews: (result.reviews || []).map(normalise).filter((x) => x.body)
    };
    CACHE.at = Date.now();
    CACHE.placeId = placeId;
    CACHE.error = null;
    return CACHE.data;
  } catch (err) {
    CACHE.error = err.message;
    return CACHE.data;
  }
}

function clearCache() {
  CACHE.at = 0;
  CACHE.data = null;
  CACHE.error = null;
}

module.exports = { isConfigured, status, fetchStore, clearCache };
