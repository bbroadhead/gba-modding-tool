# GBA Translation Lab

A browser-only workbench for investigating and translating legally obtained Game Boy Advance ROM backups. All ROM processing happens locally in the browser; the site does not upload ROM data.

## Features

- GBA header metadata, checksum validation, and SHA-256 identification
- mixed Shift-JIS text discovery with confidence scoring
- complete aligned ROM-pointer indexing and text/pointer cross-references
- editable translation workspace with project JSON and CSV export
- `.tbl` decoding and encoding, including multi-byte tokens and control codes
- safe in-place text replacement or free-space relocation with pointer updates
- GBA header checksum repair
- patched ROM, IPS, and BPS output
- standard GBA LZ77 (`0x10`) detection, decompression, and recompression core
- 1bpp, 2bpp, 4bpp, and 8bpp tile/font inspection
- guarded binary font, tile, and asset insertion
- exhaustive graphics ZIP export containing PNG tile sheets, decompressed LZ77 blocks, previews, and a manifest

## Translation workflow

1. Load the original `.gba` file and record its SHA-256 hash.
2. Build the validated script workspace. Start with pointer-backed, high-confidence entries.
3. Confirm candidates against visible text in an emulator.
4. Refine the `.tbl` mapping and control codes for the game.
5. Enter translations. `{AB CD}` syntax inserts literal bytes when a mapped token is not available.
6. Set a free-space range only after verifying that the range is unused by the game.
7. Validate and build. Short strings remain in place; longer pointer-backed strings are relocated.
8. Test the generated patch throughout the game before sharing it.

## Graphics export

The Graphics Archive Extractor interprets every byte in the selected range as raw tiles and exports lossless grayscale PNG sheets. It also validates every standard LZ77 stream, saves its decompressed bytes, and creates tile previews. `manifest.json` records all offsets and formats.

GBA games do not share a universal graphics directory. Raw extraction therefore includes false positives, while game-specific palettes, tilemaps, sprite assembly, nonstandard compression, and runtime-generated graphics may need emulator-assisted reverse engineering.

## Development

No build step or third-party runtime dependency is required. Open `index.html` through a local HTTP server or deploy the repository with GitHub Pages.

Run the core regression tests with:

```sh
node test-core.js
```

## Safety and distribution

Keep an untouched source ROM and distribute translation patches rather than copyrighted ROM images. Candidate pointers, free space, text-box widths, font behavior, and reconstructed graphics must be verified in an emulator and, ideally, on hardware.
