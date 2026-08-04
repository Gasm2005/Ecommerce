'use strict';

/**
 * Is this shop a made-to-order atelier, or a retail store?
 *
 * The template shipped assuming couture: "made to order", "stitched to your
 * measurements", "free size customisation", "your order is with our atelier", and
 * a Measurements field at checkout. That is right for a bridal house and a lie for
 * a retail shop selling ready-made kurtis to men and women — and a template that
 * makes a false promise on a client's behalf is worse than one that says less.
 *
 * Two switches, in config.features:
 *
 *   madeToOrder     the shop stitches pieces after the order is placed
 *   customisation   size/measurement customisation is included free
 *
 * Both default to FALSE, so a new client is a retail shop until someone says
 * otherwise. That is the safer default: forgetting to switch a promise ON costs a
 * feature, forgetting to switch one OFF costs a refund.
 *
 * Per product: even in a made-to-order shop, some pieces are ready stock, and
 * `product.deliveryDays` already says which. So the flag is the ceiling and the
 * product is the detail — one switch cannot be overridden into promising something
 * the shop doesn't do, and a ready piece is never described as stitched to order.
 *
 * Every string a customer reads about this lives here. Scattering ternaries
 * through eight views is how the checkout ends up disagreeing with the product
 * page.
 */

function flags(config) {
  const f = (config && config.features) || {};
  return {
    madeToOrder: f.madeToOrder === true,
    customisation: f.customisation === true,
    // A retail shop still wants a delivery-instructions box; it just isn't about
    // measurements. Defaults on because an optional note field harms nobody.
    orderNotes: f.orderNotes !== false
  };
}

/** Is THIS piece made after the order? Needs both the shop model and the product. */
function isMadeToOrder(product, config) {
  if (!flags(config).madeToOrder) return false;
  return (Number(product && product.deliveryDays) || 0) > 1;
}

/**
 * The delivery sentence on the product page.
 * A made-to-order piece states the make time AND the total, because "ships in 21
 * days" alone reads as a warning rather than as craft.
 */
function deliveryPromise(product, config) {
  const ship = (config && config.shipping) || {};
  const metro = Number(ship.estimateDaysMetro) || 0;
  const other = Number(ship.estimateDaysOther) || 0;
  const makeDays = Number(product && product.deliveryDays) || 0;

  if (isMadeToOrder(product, config)) {
    return {
      lead: 'Made to order',
      text: `stitched to your measurements in ${makeDays} days, in your hands in about ${makeDays + metro}–${makeDays + other} days`
    };
  }
  // Ready stock — including a made-to-order shop's off-the-rack pieces.
  return {
    lead: 'Ready to ship',
    text: `delivered in ${metro}–${other} days`
  };
}

/** The line under the size picker, or null when the shop promises nothing there. */
function sizeNote(config) {
  const f = flags(config);
  if (f.madeToOrder && f.customisation) {
    return 'Made to order — free customisation to your exact measurements at checkout.';
  }
  if (f.customisation) {
    return 'Free size customisation — tell us your measurements at checkout.';
  }
  if (f.madeToOrder) {
    return 'Made to order in our atelier.';
  }
  return null;
}

/** The optional notes field at checkout: what it is called and what it asks for. */
function notesField(config) {
  const f = flags(config);
  if (f.customisation) {
    return {
      show: true,
      label: 'Measurements / stitching notes',
      placeholder: 'Bust 34, waist 28, blouse length 15 — anything we should know'
    };
  }
  if (f.orderNotes) {
    return {
      show: true,
      label: 'Order notes (optional)',
      placeholder: 'Delivery instructions, gift message, anything we should know'
    };
  }
  return { show: false, label: null, placeholder: null };
}

/** Where an order goes next, in the confirmation page and email. */
function orderStatusLine(config) {
  return flags(config).madeToOrder
    ? 'is with our atelier'
    : 'is confirmed and being packed';
}

/** What happens next, for the confirmation email. */
function nextStepLine(config) {
  return flags(config).madeToOrder
    ? "Made to order — we'll email you the moment it ships."
    : "We'll email you as soon as it ships.";
}

/** Category/listing subtitle, when the shop has something to say about how it makes things. */
function listingNote(config) {
  const f = flags(config);
  if (f.madeToOrder && f.customisation) return 'made to order in our atelier, with free size customisation';
  if (f.madeToOrder) return 'made to order in our atelier';
  if (f.customisation) return 'with free size customisation';
  return null;
}

/** Size-guide copy: only promises customisation when the shop offers it. */
function sizeGuideNote(config) {
  const f = flags(config);
  if (f.customisation) {
    return 'If your measurements fall between two sizes, choose the larger and note your exact numbers at checkout. Free customisation is included.';
  }
  return 'If your measurements fall between two sizes, choose the larger.';
}

module.exports = {
  flags, isMadeToOrder, deliveryPromise, sizeNote, notesField,
  orderStatusLine, nextStepLine, listingNote, sizeGuideNote
};
