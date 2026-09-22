"use strict";

const assert = require("node:assert/strict");
const C = require("./gba-core.js");

function testLz77() {
  const source = Uint8Array.from(Array.from({ length: 2048 }, (_, i) => (i % 37 < 20 ? i % 7 : i & 0xFF)));
  const packed = C.compressLz77(source);
  const unpacked = C.decompressLz77(packed).bytes;
  assert.deepEqual(unpacked, source);
}

function testTable() {
  const table = C.parseTable("00=[END]\n20= \n41=A\n42=B\n0A=[NL]");
  const encoded = C.encodeWithTable("A B[NL]", table);
  assert.deepEqual([...encoded], [0x41, 0x20, 0x42, 0x0A]);
  assert.equal(C.decodeWithTable(encoded, table, { terminators: [] }).text, "A B[NL]");
}

function testPointerBackedTranslation() {
  const rom = new Uint8Array(0x400).fill(0xFF);
  rom.fill(0, 0xA0, 0xC0);
  rom.set([0x82, 0xA0, 0x82, 0xA2, 0], 0x100);
  C.writeU32(rom, 0x40, C.ROM_BASE + 0x100);
  const table = C.parseTable("00=[END]\n20= \n41=A\n42=B\n43=C\n44=D");
  const result = C.applyTranslations(rom, [{
    id: "test", offset: 0x100, length: 5, terminatorHex: "00", pointerRefs: [0x40], translation: "ABCDABCD"
  }], table, { freeStart: 0x200, freeEnd: 0x400 });
  const target = C.readU32(result.bytes, 0x40) - C.ROM_BASE;
  assert.equal(target, 0x200);
  assert.deepEqual([...result.bytes.slice(target, target + 9)], [0x41, 0x42, 0x43, 0x44, 0x41, 0x42, 0x43, 0x44, 0]);
  assert.equal(result.bytes[0xBD], C.headerChecksum(result.bytes));
}

function testScansAndPatches() {
  const rom = new Uint8Array(0x300).fill(0xFF);
  rom.set([0x82, 0xA0, 0x82, 0xA2, 0x82, 0xA4, 0], 0x180);
  C.writeU32(rom, 0x20, C.ROM_BASE + 0x180);
  const pointers = C.scanPointers(rom);
  const text = C.scanText(rom, pointers, { minJapanese: 3 });
  assert.equal(text[0].offset, 0x180);
  assert.deepEqual(text[0].pointerRefs, [0x20]);
  const changed = new Uint8Array(rom);
  changed[0x180] ^= 1;
  assert.equal(new TextDecoder().decode(C.createIpsPatch(rom, changed).slice(0, 5)), "PATCH");
  assert.equal(new TextDecoder().decode(C.createBpsPatch(rom, changed).slice(0, 4)), "BPS1");
}

testLz77();
testTable();
testPointerBackedTranslation();
testScansAndPatches();
console.log("All GBA core tests passed.");
