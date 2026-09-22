(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GbaCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ROM_BASE = 0x08000000;

  function hex(value, width = 8) {
    return "0x" + (Number(value) >>> 0).toString(16).toUpperCase().padStart(width, "0");
  }

  function parseNumber(value, fallback = null) {
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    const number = /^0x/i.test(text) ? parseInt(text, 16) : Number(text);
    return Number.isFinite(number) ? number : fallback;
  }

  function bytesToHex(bytes, limit = Infinity) {
    const shown = bytes.slice(0, limit);
    const text = Array.from(shown, b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    return bytes.length > limit ? text + " …" : text;
  }

  function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function writeU32(bytes, offset, value) {
    bytes[offset] = value & 0xFF;
    bytes[offset + 1] = (value >>> 8) & 0xFF;
    bytes[offset + 2] = (value >>> 16) & 0xFF;
    bytes[offset + 3] = (value >>> 24) & 0xFF;
  }

  function headerChecksum(bytes) {
    if (bytes.length < 0xBE) return null;
    let checksum = 0;
    for (let i = 0xA0; i <= 0xBC; i++) checksum = (checksum - bytes[i] - 1) & 0xFF;
    return checksum;
  }

  function repairHeaderChecksum(bytes) {
    if (bytes.length < 0xBE) throw new Error("File is too small for a GBA header.");
    bytes[0xBD] = headerChecksum(bytes);
    return bytes[0xBD];
  }

  function isSjisLead(byte) {
    return (byte >= 0x81 && byte <= 0x9F) || (byte >= 0xE0 && byte <= 0xFC);
  }

  function isSjisTrail(byte) {
    return (byte >= 0x40 && byte <= 0x7E) || (byte >= 0x80 && byte <= 0xFC);
  }

  function decodeSjis(bytes) {
    try { return new TextDecoder("shift_jis").decode(bytes); }
    catch (_) { return ""; }
  }

  function scanPointers(bytes, options = {}) {
    const base = parseNumber(options.base, ROM_BASE) >>> 0;
    let start = Math.max(0, parseNumber(options.start, 0));
    let end = Math.min(bytes.length, parseNumber(options.end, bytes.length));
    const alignedOnly = options.alignedOnly !== false;
    const step = alignedOnly ? 4 : 1;
    if (alignedOnly) start = (start + 3) & ~3;
    const results = [];
    const byTarget = new Map();
    for (let location = start; location <= end - 4; location += step) {
      const value = readU32(bytes, location);
      if (value >= base && value < base + bytes.length) {
        const target = value - base;
        const item = { location, value, target };
        results.push(item);
        if (!byTarget.has(target)) byTarget.set(target, []);
        byTarget.get(target).push(location);
      }
    }
    return { base, results, byTarget };
  }

  function looksLikeTextByte(bytes, pos) {
    const byte = bytes[pos];
    if (isSjisLead(byte) && pos + 1 < bytes.length && isSjisTrail(bytes[pos + 1])) return 2;
    if (byte >= 0xA1 && byte <= 0xDF) return 1;
    if ((byte >= 0x20 && byte <= 0x7E) || byte === 0x0A || byte === 0x0D || byte === 0x09) return 1;
    return 0;
  }

  function scanText(bytes, pointerIndex, options = {}) {
    const start = Math.max(0, parseNumber(options.start, 0));
    const end = Math.min(bytes.length, parseNumber(options.end, bytes.length));
    const minJapanese = Math.max(1, parseNumber(options.minJapanese, 3));
    const maxLength = Math.max(16, parseNumber(options.maxLength, 1024));
    const maxResults = Math.max(1, parseNumber(options.maxResults, 10000));
    const results = [];
    let pos = start;

    while (pos < end - 1) {
      if (!isSjisLead(bytes[pos]) || !isSjisTrail(bytes[pos + 1])) { pos++; continue; }
      const offset = pos;
      let japaneseChars = 0;
      let asciiChars = 0;
      let invalid = 0;
      let terminated = false;
      while (pos < end && pos - offset < maxLength) {
        if (bytes[pos] === 0x00) { pos++; terminated = true; break; }
        const width = looksLikeTextByte(bytes, pos);
        if (!width) { invalid++; break; }
        if (width === 2 || (bytes[pos] >= 0xA1 && bytes[pos] <= 0xDF)) japaneseChars++;
        else asciiChars++;
        pos += width;
      }
      const length = pos - offset;
      if (japaneseChars >= minJapanese) {
        const contentLength = terminated ? length - 1 : length;
        const raw = bytes.slice(offset, offset + contentLength);
        const pointerRefs = pointerIndex?.byTarget?.get(offset) || [];
        const totalChars = Math.max(1, japaneseChars + asciiChars);
        const density = japaneseChars / totalChars;
        const readable = decodeSjis(raw).replace(/\uFFFD/g, "");
        const score = Math.min(100, Math.round(
          20 + density * 35 + (terminated ? 10 : 0) + Math.min(30, pointerRefs.length * 15) - invalid * 10
        ));
        results.push({
          id: `text_${offset.toString(16).padStart(8, "0")}`,
          offset,
          length,
          contentLength,
          japaneseChars,
          asciiChars,
          terminated,
          terminatorHex: terminated ? "00" : "",
          pointerRefs,
          confidence: score,
          text: readable,
          rawHex: bytesToHex(bytes.slice(offset, offset + length), 96)
        });
      }
      if (pos === offset) pos++;
    }

    return results
      .sort((a, b) => (b.pointerRefs.length - a.pointerRefs.length) || (b.confidence - a.confidence) || (a.offset - b.offset))
      .slice(0, maxResults);
  }

  function parseTable(text) {
    const entries = [];
    String(text || "").replace(/\r/g, "").split("\n").forEach(raw => {
      const trimmed = raw.trimStart();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return;
      const eq = raw.indexOf("=");
      if (eq < 1) return;
      const key = raw.slice(0, eq).replace(/\s+/g, "").toUpperCase();
      if (!/^[0-9A-F]+$/.test(key) || key.length % 2) return;
      const value = raw.slice(eq + 1);
      const token = [];
      for (let i = 0; i < key.length; i += 2) token.push(parseInt(key.slice(i, i + 2), 16));
      entries.push({ hex: key, bytes: Uint8Array.from(token), value });
    });
    return entries;
  }

  function decodeWithTable(bytes, entries, options = {}) {
    const sorted = [...entries].sort((a, b) => b.bytes.length - a.bytes.length);
    const terminators = new Set(options.terminators || ["00"]);
    const start = Math.max(0, options.offset || 0);
    const end = Math.min(bytes.length, start + (options.maxLength || 4096));
    let pos = start;
    let text = "";
    while (pos < end) {
      const match = sorted.find(entry => {
        if (pos + entry.bytes.length > end) return false;
        return entry.bytes.every((byte, index) => bytes[pos + index] === byte);
      });
      if (match) {
        text += match.value;
        pos += match.bytes.length;
        if (terminators.has(match.hex)) break;
      } else {
        text += `{${bytes[pos].toString(16).toUpperCase().padStart(2, "0")}}`;
        if (terminators.has(bytes[pos].toString(16).toUpperCase().padStart(2, "0"))) { pos++; break; }
        pos++;
      }
    }
    return { text, bytesConsumed: pos - start, endOffset: pos };
  }

  function encodeWithTable(text, entries) {
    const candidates = entries
      .filter(entry => entry.value !== "")
      .sort((a, b) => b.value.length - a.value.length || b.bytes.length - a.bytes.length);
    const out = [];
    let pos = 0;
    while (pos < text.length) {
      const raw = text.slice(pos).match(/^\{([0-9A-Fa-f]{2}(?:\s+[0-9A-Fa-f]{2})*)\}/);
      if (raw) {
        raw[1].split(/\s+/).forEach(value => out.push(parseInt(value, 16)));
        pos += raw[0].length;
        continue;
      }
      const match = candidates.find(entry => text.startsWith(entry.value, pos));
      if (!match) throw new Error(`No table mapping for ${JSON.stringify(text[pos])} at character ${pos + 1}.`);
      out.push(...match.bytes);
      pos += match.value.length;
    }
    return Uint8Array.from(out);
  }

  function detectLz77(bytes, options = {}) {
    const start = Math.max(0, parseNumber(options.start, 0));
    const end = Math.min(bytes.length - 4, parseNumber(options.end, bytes.length));
    const maxResults = Math.max(1, parseNumber(options.maxResults, 5000));
    const results = [];
    for (let offset = start; offset <= end && results.length < maxResults; offset += 4) {
      if (bytes[offset] !== 0x10) continue;
      const decompressedSize = bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16);
      if (!decompressedSize || decompressedSize > 0x1000000) continue;
      try {
        const decoded = decompressLz77(bytes, offset);
        results.push({ offset, decompressedSize, compressedSize: decoded.bytesRead });
      } catch (_) { /* false signature */ }
    }
    return results;
  }

  function decompressLz77(bytes, offset = 0) {
    if (bytes[offset] !== 0x10) throw new Error("Not a GBA LZ77 (0x10) stream.");
    const size = bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16);
    if (!size) throw new Error("Invalid decompressed size.");
    const out = new Uint8Array(size);
    let src = offset + 4;
    let dst = 0;
    while (dst < size) {
      if (src >= bytes.length) throw new Error("Compressed stream ends early.");
      const flags = bytes[src++];
      for (let bit = 7; bit >= 0 && dst < size; bit--) {
        if (flags & (1 << bit)) {
          if (src + 1 >= bytes.length) throw new Error("Compressed token ends early.");
          const token = (bytes[src] << 8) | bytes[src + 1];
          src += 2;
          const length = (token >>> 12) + 3;
          const distance = (token & 0x0FFF) + 1;
          if (distance > dst) throw new Error("Invalid LZ77 back-reference.");
          for (let i = 0; i < length && dst < size; i++) out[dst] = out[dst++ - distance];
        } else {
          if (src >= bytes.length) throw new Error("Literal ends early.");
          out[dst++] = bytes[src++];
        }
      }
    }
    return { bytes: out, bytesRead: src - offset };
  }

  function compressLz77(input) {
    if (input.length > 0xFFFFFF) throw new Error("GBA LZ77 supports at most 16,777,215 decompressed bytes.");
    const out = [0x10, input.length & 0xFF, (input.length >>> 8) & 0xFF, (input.length >>> 16) & 0xFF];
    let pos = 0;
    while (pos < input.length) {
      const flagPos = out.length;
      out.push(0);
      let flags = 0;
      for (let bit = 7; bit >= 0 && pos < input.length; bit--) {
        let bestLength = 0;
        let bestDistance = 0;
        const windowStart = Math.max(0, pos - 0x1000);
        for (let candidate = pos - 1; candidate >= windowStart; candidate--) {
          let length = 0;
          while (length < 18 && pos + length < input.length && input[candidate + length] === input[pos + length]) length++;
          if (length >= 3 && length > bestLength) {
            bestLength = length;
            bestDistance = pos - candidate;
            if (length === 18) break;
          }
        }
        if (bestLength >= 3) {
          flags |= 1 << bit;
          const token = ((bestLength - 3) << 12) | (bestDistance - 1);
          out.push(token >>> 8, token & 0xFF);
          pos += bestLength;
        } else out.push(input[pos++]);
      }
      out[flagPos] = flags;
    }
    while (out.length % 4) out.push(0);
    return Uint8Array.from(out);
  }

  function findFreeSpace(bytes, needed, options = {}) {
    const start = Math.max(0, parseNumber(options.start, 0));
    const end = Math.min(bytes.length, parseNumber(options.end, bytes.length));
    const fill = new Set(options.fill || [0x00, 0xFF]);
    const alignment = Math.max(1, options.alignment || 4);
    let runStart = -1;
    for (let pos = start; pos <= end; pos++) {
      if (pos < end && fill.has(bytes[pos])) {
        if (runStart < 0) runStart = pos;
        const aligned = Math.ceil(runStart / alignment) * alignment;
        if (pos + 1 - aligned >= needed) return aligned;
      } else runStart = -1;
    }
    return -1;
  }

  function applyTranslations(source, items, entries, options = {}) {
    const output = new Uint8Array(source);
    const base = parseNumber(options.base, ROM_BASE) >>> 0;
    const freeStart = parseNumber(options.freeStart, Math.max(0, source.length - 0x100000));
    const freeEnd = parseNumber(options.freeEnd, source.length);
    const padByte = parseNumber(options.padByte, 0) & 0xFF;
    let searchStart = freeStart;
    const log = [];

    for (const item of items) {
      if (!item.translation) continue;
      let encoded = encodeWithTable(item.translation, entries);
      const terminator = item.terminatorHex
        ? Uint8Array.from(item.terminatorHex.match(/../g).map(value => parseInt(value, 16)))
        : new Uint8Array();
      const complete = new Uint8Array(encoded.length + terminator.length);
      complete.set(encoded);
      complete.set(terminator, encoded.length);
      const oldLength = item.length;
      let target = item.offset;
      let relocated = false;
      if (complete.length > oldLength) {
        if (!item.pointerRefs?.length) throw new Error(`${item.id || hex(item.offset)} is too long and has no confirmed pointer to update.`);
        target = findFreeSpace(output, complete.length, { start: searchStart, end: freeEnd, alignment: 4 });
        if (target < 0) throw new Error(`No ${complete.length}-byte free-space block found for ${item.id || hex(item.offset)}.`);
        searchStart = target + complete.length;
        relocated = true;
      }
      output.set(complete, target);
      if (!relocated) output.fill(padByte, target + complete.length, target + oldLength);
      else {
        for (const pointer of item.pointerRefs) writeU32(output, pointer, (base + target) >>> 0);
      }
      log.push({ id: item.id, oldOffset: item.offset, newOffset: target, oldLength, newLength: complete.length, relocated, pointersUpdated: relocated ? item.pointerRefs.length : 0 });
    }
    repairHeaderChecksum(output);
    return { bytes: output, log };
  }

  function applyBinaryAsset(source, asset, offset, maximumLength = asset.length) {
    if (offset < 0 || offset + maximumLength > source.length) throw new Error("Asset region is outside ROM bounds.");
    if (asset.length > maximumLength) throw new Error(`Asset is ${asset.length} bytes; the reserved region is ${maximumLength} bytes.`);
    const output = new Uint8Array(source);
    output.set(asset, offset);
    repairHeaderChecksum(output);
    return output;
  }

  function createIpsPatch(source, target) {
    if (source.length !== target.length) throw new Error("IPS export currently requires the same source and target size.");
    const out = [0x50, 0x41, 0x54, 0x43, 0x48];
    let pos = 0;
    while (pos < target.length) {
      if (source[pos] === target[pos]) { pos++; continue; }
      const start = pos;
      while (pos < target.length && source[pos] !== target[pos] && pos - start < 0xFFFF) pos++;
      const length = pos - start;
      out.push((start >>> 16) & 0xFF, (start >>> 8) & 0xFF, start & 0xFF, (length >>> 8) & 0xFF, length & 0xFF);
      for (let i = start; i < pos; i++) out.push(target[i]);
    }
    out.push(0x45, 0x4F, 0x46);
    return Uint8Array.from(out);
  }

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function bpsNumber(out, value) {
    while (true) {
      let byte = value & 0x7F;
      value >>>= 7;
      if (value === 0) { out.push(byte | 0x80); break; }
      out.push(byte);
      value--;
    }
  }

  function appendU32(out, value) {
    out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
  }

  function createBpsPatch(source, target, metadata = "GBA Translation Lab") {
    const out = [0x42, 0x50, 0x53, 0x31];
    bpsNumber(out, source.length);
    bpsNumber(out, target.length);
    const meta = new TextEncoder().encode(metadata);
    bpsNumber(out, meta.length);
    out.push(...meta);
    let pos = 0;
    while (pos < target.length) {
      const same = pos < source.length && source[pos] === target[pos];
      const start = pos;
      if (same) while (pos < target.length && pos < source.length && source[pos] === target[pos]) pos++;
      else while (pos < target.length && !(pos < source.length && source[pos] === target[pos])) pos++;
      bpsNumber(out, ((pos - start - 1) << 2) | (same ? 0 : 1));
      if (!same) for (let i = start; i < pos; i++) out.push(target[i]);
    }
    appendU32(out, crc32(source));
    appendU32(out, crc32(target));
    appendU32(out, crc32(Uint8Array.from(out)));
    return Uint8Array.from(out);
  }

  return {
    ROM_BASE, hex, parseNumber, bytesToHex, readU32, writeU32,
    headerChecksum, repairHeaderChecksum, decodeSjis,
    scanPointers, scanText, parseTable, decodeWithTable, encodeWithTable,
    detectLz77, decompressLz77, compressLz77, findFreeSpace,
    applyTranslations, applyBinaryAsset, createIpsPatch, createBpsPatch, crc32
  };
});
