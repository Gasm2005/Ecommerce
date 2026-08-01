'use strict';

/**
 * HTMX response headers.
 *
 * HTTP header values must be ASCII. A toast like "Refunded Rs 50,000" written
 * with the rupee sign, or one containing a typographic quote, crashes
 * res.setHeader with ERR_INVALID_CHAR — and because the header is set before the
 * body is sent, the whole request dies rather than degrading. Everything that
 * emits HX-Trigger goes through here so that cannot happen: any non-ASCII
 * character is escaped to a JSON unicode escape, which is valid inside a JSON
 * string and decodes back to the original character in the browser.
 */

const NON_ASCII = /[^\x00-\x7F]/g;

function asciiJson(value) {
  return JSON.stringify(value).replace(NON_ASCII, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

/** Emit one or more HTMX events: trigger(res, { 'cart:open': true }) */
function trigger(res, events) {
  res.set('HX-Trigger', asciiJson(events));
}

/** Admin toast. Messages routinely contain currency symbols and curly quotes. */
function toast(res, message, tone) {
  trigger(res, { 'admin:toast': { message: String(message), tone: tone || 'good' } });
}

module.exports = { trigger, toast, asciiJson };
