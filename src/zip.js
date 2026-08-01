'use strict';

/**
 * Minimal ZIP writer.
 *
 * Written by hand rather than pulling in `archiver` because this ships to every
 * client server, and a dependency there is a thing that can break, need patching,
 * or disappear from npm. The format is stable since 1989 and this is 80 lines.
 *
 * Supports what a data export needs: deflated entries, correct CRCs, no
 * encryption, no ZIP64 (an export of a boutique's orders is nowhere near 4 GB —
 * if it ever were, the export should be streaming, not bigger).
 *
 * Produced archives open in Windows Explorer, macOS Archive Utility, 7-Zip and
 * `unzip`.
 */

const zlib = require('zlib');

/* CRC-32, table built once. ZIP will not accept an entry without it. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** ZIP stores time as two 16-bit DOS fields, in local time, 2-second precision. */
function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const day = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, day };
}

/**
 * Builds a ZIP from [{ name, data }]. `data` may be a string or Buffer;
 * `name` may contain forward slashes to create folders.
 */
function zip(entries, when) {
  const { time, day } = dosDateTime(when);
  const parts = [];
  const central = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });

    // Only claim compression when it actually helped; tiny files often grow.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    parts.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk number
    dir.writeUInt16LE(0, 36);             // internal attrs
    dir.writeUInt32LE(0, 38);             // external attrs
    dir.writeUInt32LE(offset, 42);        // offset of local header

    central.push(dir, name);
    offset += local.length + name.length + body.length;
  });

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);                // this disk
  end.writeUInt16LE(0, 6);                // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...parts, dirBuf, end]);
}

/**
 * CSV that survives Excel.
 *  · a leading BOM, or Excel mangles ₹ and Devanagari
 *  · CRLF line endings
 *  · a value starting with = + - @ is prefixed with a quote, so a cell of text
 *    can never execute as a formula in someone's spreadsheet
 */
function csv(headers, rows) {
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(cell).join(',')];
  rows.forEach((row) => lines.push(row.map(cell).join(',')));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { zip, csv, crc32 };
