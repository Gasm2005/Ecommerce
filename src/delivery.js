'use strict';

/**
 * Delivery zones and who actually carries the parcel.
 *
 * A boutique in Lucknow can put a piece in a customer's hands in Lucknow the same
 * afternoon, on their own scooter, for nothing — and paying a courier ₹199 to do
 * it in three days would be worse for everyone. So delivery is decided by ZONE,
 * not by one flat rule for the whole country.
 *
 * Two things a zone decides:
 *   what is OFFERED   same-day, next-day, standard, or store pickup
 *   who FULFILS it    'own'  — the shop delivers it themselves, never handed to a
 *                              courier, and no courier integration must ever pick
 *                              it up automatically
 *                     'courier' — normal dispatch
 *
 * That `fulfilment` flag is the important one. It is written onto the order, so
 * when courier integration arrives later it can skip these orders instead of
 * booking a shipment the shop already delivered by hand.
 *
 * Cut-off times are honoured: "same-day" stops being offered at 2pm, because
 * promising it at 6pm is how a shop earns a one-star review.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/* -------------------------------------------------------------- matching ---- */

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Does this pincode fall in the zone?
 *
 * Three ways to say so, because clients think in all three:
 *   pincodes  ['226001', '226010']   exact
 *   prefixes  ['2260']               a whole range of a city
 *   cities    ['Lucknow']            when the pincode came back with a city
 */
function matchesZone(zone, { pincode, city } = {}) {
  const pin = digits(pincode);

  if (pin && Array.isArray(zone.pincodes) && zone.pincodes.some((p) => digits(p) === pin)) return true;
  if (pin && Array.isArray(zone.prefixes) && zone.prefixes.some((p) => digits(p) && pin.startsWith(digits(p)))) return true;
  if (city && Array.isArray(zone.cities)) {
    const needle = String(city).trim().toLowerCase();
    if (zone.cities.some((c) => String(c).trim().toLowerCase() === needle)) return true;
  }
  return false;
}

/** The first matching zone, or null for "anywhere else". */
function zoneFor(config, where) {
  const zones = (config.shipping || {}).zones;
  if (!Array.isArray(zones)) return null;
  return zones.find((z) => matchesZone(z, where || {})) || null;
}

/* -------------------------------------------------------------- cut-offs ---- */

/**
 * Is a same-day promise still honest at this moment?
 *
 * `cutoff` is "14:00" in the store's own local time, and `days` optionally limits
 * it to the days someone is actually there to deliver.
 */
function withinCutoff(method, now = new Date()) {
  if (!method.cutoff) return true;

  const [h, m] = String(method.cutoff).split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(h)) return true;

  if (Array.isArray(method.days) && method.days.length) {
    const today = DAY_NAMES[now.getDay()];
    if (!method.days.some((d) => String(d).toLowerCase().startsWith(today.slice(0, 3)))) return false;
  }

  const cutoffMinutes = h * 60 + (Number.isFinite(m) ? m : 0);
  return now.getHours() * 60 + now.getMinutes() < cutoffMinutes;
}

/** Human "order in the next 3 hours" style note, so the cut-off is visible. */
function cutoffNote(method, now = new Date()) {
  if (!method.cutoff) return null;
  const [h, m] = String(method.cutoff).split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(h)) return null;

  const mins = (h * 60 + (Number.isFinite(m) ? m : 0)) - (now.getHours() * 60 + now.getMinutes());
  if (mins <= 0) return `Ordering window closed for today (cut-off ${method.cutoff})`;
  if (mins < 60) return `Order within ${mins} min`;
  return `Order before ${method.cutoff}`;
}

/* --------------------------------------------------------------- methods ---- */

/**
 * The delivery options actually available for this destination, right now.
 *
 * Falls back to the store-wide `shipping.methods` when the address is outside
 * every zone (or not entered yet), so an empty pincode never means "no way to
 * buy this".
 */
function methodsFor(config, { pincode, city, subtotal, makeDays, now } = {}) {
  const ship = config.shipping || {};
  const when = now || new Date();
  const zone = zoneFor(config, { pincode, city });

  const base = Array.isArray(ship.methods) && ship.methods.length
    ? ship.methods
    : [{ id: 'standard', title: 'Standard', note: '{metro}-{other} working days after dispatch', charge: null }];

  // A zone can replace the list entirely, or add to it.
  const source = zone && Array.isArray(zone.methods) && zone.methods.length
    ? (zone.replacesDefaults === false ? [...zone.methods, ...base] : zone.methods)
    : base;

  return source
    .map((m) => ({
      id: m.id,
      title: m.title,
      note: String(m.note || '')
        .replace('{metro}', ship.estimateDaysMetro)
        .replace('{other}', ship.estimateDaysOther),
      charge: Number.isFinite(m.charge) ? m.charge : null,
      // Only a zone method can be self-delivered; the default list is courier.
      fulfilment: m.fulfilment === 'own' ? 'own' : (m.fulfilment === 'pickup' ? 'pickup' : 'courier'),
      cutoff: m.cutoff || null,
      days: m.days || null,
      slots: Array.isArray(m.slots) ? m.slots : null,
      minOrder: Number.isFinite(m.minOrder) ? m.minOrder : 0,
      /* A piece that takes three weeks to stitch cannot be delivered this
         afternoon. maxMakeDays is how a same-day option says "ready stock only",
         so the shop never promises today on a made-to-order lehenga. */
      maxMakeDays: Number.isFinite(m.maxMakeDays) ? m.maxMakeDays : null,
      zone: zone ? zone.id : null,
      zoneLabel: zone ? zone.label : null,
      available: true,
      unavailableReason: null,
      cutoffNote: cutoffNote(m, when)
    }))
    // A method whose cut-off has passed, or whose minimum isn't met, is REMOVED
    // rather than shown greyed out: an option that cannot be chosen is noise.
    .filter((m) => {
      if (!withinCutoff(m, when)) return false;
      if (m.minOrder && Number.isFinite(subtotal) && subtotal < m.minOrder) return false;
      // Made-to-order pieces cannot take a ready-stock-only option.
      if (m.maxMakeDays !== null && Number.isFinite(makeDays) && makeDays > m.maxMakeDays) return false;
      return true;
    });
}

/** What the chosen method means for the order — charge, who carries it, promise. */
function resolve(config, { pincode, city, subtotal, makeDays, chosenId, now } = {}) {
  const methods = methodsFor(config, { pincode, city, subtotal, makeDays, now });
  const chosen = methods.find((m) => m.id === chosenId) || methods[0] || null;
  return { methods, chosen, zone: zoneFor(config, { pincode, city }) };
}

/**
 * The promise printed on the order and told to the customer.
 * Kept as text, because "today by 8pm" is what a person understands and no date
 * arithmetic can make "3–6 working days" into a single honest date.
 */
function promiseFor(method, config, now = new Date()) {
  if (!method) return null;
  if (method.fulfilment === 'pickup') return method.note || 'Ready for collection';
  return method.note || null;
}

/** For the admin: orders the shop delivers itself must never reach a courier. */
function isSelfDelivered(order) {
  return order && (order.fulfilment === 'own' || order.fulfilment === 'pickup');
}

module.exports = {
  matchesZone, zoneFor, methodsFor, resolve, withinCutoff, cutoffNote, promiseFor, isSelfDelivered
};
