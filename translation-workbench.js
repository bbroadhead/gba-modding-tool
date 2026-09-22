(() => {
  "use strict";

  const C = window.GbaCore;
  if (!C) throw new Error("gba-core.js did not load.");
  const $ = id => document.getElementById(id);
  const state = {
    fileName: "", original: null, staged: null, sha256: "", pointers: null,
    workspace: [], lz: [], selectedLz: null, asset: null, graphicsCancelled: false
  };

  function status(id, message, kind = "") {
    const element = $(id);
    element.textContent = message;
    element.className = `status ${kind}`;
  }

  function safeName(name) {
    return (name || "gba_rom").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_");
  }

  function download(name, data, type = "application/octet-stream") {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function digest(bytes) {
    if (!crypto?.subtle) return "unavailable";
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
  }

  function ensureAsciiMappings() {
    const table = $("tblInput");
    const existing = new Set(C.parseTable(table.value).map(entry => `${entry.hex}=${entry.value}`));
    const additions = [];
    for (let code = 0x20; code <= 0x7E; code++) {
      const value = String.fromCharCode(code);
      const row = `${code.toString(16).toUpperCase().padStart(2, "0")}=${value}`;
      if (!existing.has(row)) additions.push(row);
    }
    if (additions.length) table.value += `\n${additions.join("\n")}`;
  }

  async function loadRom(file) {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.fileName = file.name;
    state.original = bytes;
    state.staged = null;
    state.workspace = [];
    state.pointers = null;
    state.lz = [];
    state.asset = null;
    state.sha256 = await digest(bytes);
    ["buildWorkspaceBtn", "scanLzBtn", "renderTilesBtn", "extractGraphicsBtn"].forEach(id => $(id).disabled = false);
    ["validateBuildBtn", "buildRomBtn"].forEach(id => $(id).disabled = false);
    renderWorkspace();
    status("workspaceStatus", `Ready to analyze ${file.name}. SHA-256: ${state.sha256}`, "good");
    status("lzStatus", "ROM loaded. Scan when ready.");
    status("tileStatus", "ROM loaded. Enter an offset and render.");
    status("graphicsStatus", "ROM loaded. The full-ROM default may create hundreds of PNG sheets.", "warn");
    updateAssetButton();
  }

  function candidateVisible(item) {
    const minimum = C.parseNumber($("confidenceFilter").value, 0);
    return item.confidence >= minimum && (!$('pointerOnly').checked || item.pointerRefs.length > 0);
  }

  function renderWorkspace() {
    const body = $("workspaceBody");
    const visible = state.workspace.filter(candidateVisible);
    if (!visible.length) {
      body.innerHTML = `<tr><td colspan="6" class="muted">No entries match the current filter.</td></tr>`;
      return;
    }
    body.innerHTML = "";
    for (const item of visible) {
      const row = document.createElement("tr");
      const refs = item.pointerRefs.length
        ? item.pointerRefs.slice(0, 6).map(C.hex).join(", ") + (item.pointerRefs.length > 6 ? " …" : "")
        : "none";
      row.innerHTML = `
        <td><input type="checkbox" class="use-entry" ${item.use ? "checked" : ""}></td>
        <td><code>${C.hex(item.offset)}</code><br><span class="badge ${item.confidence >= 70 ? "good" : "warn"}">${item.confidence}%</span></td>
        <td><span class="badge">${item.pointerRefs.length}</span><br><span class="small muted">${refs}</span></td>
        <td lang="ja">${escapeHtml(item.text)}</td>
        <td><textarea class="translation" placeholder="Enter English…">${escapeHtml(item.translation || "")}</textarea></td>
        <td class="size-cell">${item.length} B available</td>`;
      row.querySelector(".use-entry").addEventListener("change", event => item.use = event.target.checked);
      const editor = row.querySelector(".translation");
      editor.addEventListener("input", () => {
        item.translation = editor.value;
        updateSize(item, row.querySelector(".size-cell"));
      });
      updateSize(item, row.querySelector(".size-cell"));
      body.appendChild(row);
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function tableEntries() { return C.parseTable($("tblInput").value); }

  function encodedLength(item) {
    if (!item.translation) return 0;
    return C.encodeWithTable(item.translation, tableEntries()).length + (item.terminatorHex ? item.terminatorHex.length / 2 : 0);
  }

  function updateSize(item, cell) {
    try {
      const size = encodedLength(item);
      const overflow = Math.max(0, size - item.length);
      cell.innerHTML = `${size}/${item.length} B${overflow ? `<br><span class="badge warn">relocate +${overflow}</span>` : ""}`;
    } catch (error) {
      cell.innerHTML = `<span class="badge warn" title="${escapeHtml(error.message)}">unmapped</span>`;
    }
  }

  async function buildWorkspace() {
    if (!state.original) return;
    status("workspaceStatus", "Indexing every 32-bit ROM pointer…");
    $("analysisProgress").style.width = "25%";
    await nextFrame();
    state.pointers = C.scanPointers(state.original, {
      base: $("pointerBase").value,
      start: 0,
      end: state.original.length,
      alignedOnly: true
    });
    status("workspaceStatus", `Found ${state.pointers.results.length.toLocaleString()} in-ROM pointers. Scanning mixed Shift-JIS strings…`);
    $("analysisProgress").style.width = "60%";
    await nextFrame();
    const previous = new Map(state.workspace.map(item => [item.id, item]));
    state.workspace = C.scanText(state.original, state.pointers, {
      start: $("workTextStart").value,
      end: $("workTextEnd").value || state.original.length,
      minJapanese: $("workMinJapanese").value,
      maxResults: $("workMaxResults").value
    }).map(item => ({
      ...item,
      translation: previous.get(item.id)?.translation || "",
      use: previous.get(item.id)?.use ?? item.pointerRefs.length > 0
    }));
    $("analysisProgress").style.width = "100%";
    renderWorkspace();
    const backed = state.workspace.filter(item => item.pointerRefs.length).length;
    status("workspaceStatus", `Workspace created: ${state.workspace.length.toLocaleString()} candidates; ${backed.toLocaleString()} pointer-backed. Review source text and verify candidates in-game before translating.`, backed ? "good" : "warn");
    $("exportProjectBtn").disabled = false;
    $("exportCsvBtn").disabled = false;
  }

  function projectData() {
    return {
      format: "gba-translation-lab-project",
      version: 2,
      savedAt: new Date().toISOString(),
      rom: { fileName: state.fileName, size: state.original?.length || null, sha256: state.sha256 || null },
      pointerBase: $("buildPointerBase").value,
      table: $("tblInput").value,
      entries: state.workspace,
      asset: state.asset ? { name: state.asset.name, offset: state.asset.offset, maxLength: state.asset.maxLength, embedded: false } : null,
      notes: [
        "Pointer and text candidates require in-game validation.",
        "The project does not contain copyrighted ROM data.",
        "Binary assets are intentionally not embedded."
      ]
    };
  }

  function exportProject() {
    download(`${safeName(state.fileName)}_translation_project.json`, JSON.stringify(projectData(), null, 2), "application/json");
  }

  function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

  function exportCsv() {
    const header = ["id", "offset", "confidence", "pointer_references", "source_japanese", "translation_english", "use"];
    const rows = state.workspace.map(item => [item.id, C.hex(item.offset), item.confidence, item.pointerRefs.map(C.hex).join(" "), item.text, item.translation || "", item.use]);
    download(`${safeName(state.fileName)}_translations.csv`, [header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  }

  async function importProject(file) {
    const project = JSON.parse(await file.text());
    if (project.format !== "gba-translation-lab-project" || !Array.isArray(project.entries)) throw new Error("This is not a Translation Lab project.");
    if (state.original && project.rom?.sha256 && state.sha256 !== project.rom.sha256) {
      if (!confirm("This project was created for a different ROM hash. Import it anyway for review?")) return;
    }
    state.workspace = project.entries;
    if (project.table) $("tblInput").value = project.table;
    if (project.pointerBase) $("buildPointerBase").value = project.pointerBase;
    renderWorkspace();
    $("exportProjectBtn").disabled = false;
    $("exportCsvBtn").disabled = false;
    status("workspaceStatus", `Imported ${state.workspace.length.toLocaleString()} project entries.`, "good");
  }

  function scanLz() {
    if (!state.original) return;
    status("lzStatus", "Scanning aligned 0x10 signatures and validating each stream…");
    setTimeout(() => {
      state.lz = C.detectLz77(state.original, { start: $("lzStart").value, end: $("lzEnd").value || state.original.length });
      renderLz();
      status("lzStatus", `Found ${state.lz.length.toLocaleString()} valid standard LZ77 stream(s).`, state.lz.length ? "good" : "warn");
    }, 10);
  }

  function renderLz() {
    const body = $("lzBody");
    if (!state.lz.length) { body.innerHTML = `<tr><td colspan="3" class="muted">No results.</td></tr>`; return; }
    body.innerHTML = "";
    for (const item of state.lz) {
      const row = document.createElement("tr");
      row.innerHTML = `<td><code>${C.hex(item.offset)}</code></td><td>${item.compressedSize.toLocaleString()} B</td><td>${item.decompressedSize.toLocaleString()} B</td>`;
      row.addEventListener("click", () => {
        body.querySelectorAll("tr").forEach(element => element.classList.remove("selected"));
        row.classList.add("selected");
        state.selectedLz = item;
        $("downloadLzBtn").disabled = false;
      });
      body.appendChild(row);
    }
  }

  function downloadSelectedLz() {
    const item = state.selectedLz;
    if (!item) return;
    const data = C.decompressLz77(state.original, item.offset).bytes;
    download(`${safeName(state.fileName)}_${item.offset.toString(16).padStart(8, "0")}_decompressed.bin`, data);
  }

  function tilePixel(bytes, tileOffset, x, y, bpp) {
    if (bpp === 1) return (bytes[tileOffset + y] >>> (7 - x)) & 1;
    if (bpp === 2) {
      const byte = bytes[tileOffset + y * 2 + (x >>> 2)];
      return (byte >>> ((3 - (x & 3)) * 2)) & 3;
    }
    if (bpp === 4) {
      const byte = bytes[tileOffset + y * 4 + (x >>> 1)];
      return (byte >>> ((x & 1) * 4)) & 15;
    }
    return bytes[tileOffset + y * 8 + x];
  }

  function renderTileSheet(bytes, offset, tileCount, bpp, columns, canvas) {
    const bytesPerTile = bpp * 8;
    const available = Math.max(0, Math.floor((bytes.length - offset) / bytesPerTile));
    const count = Math.min(tileCount, available);
    const rows = Math.max(1, Math.ceil(count / columns));
    canvas.width = columns * 8;
    canvas.height = rows * 8;
    const context = canvas.getContext("2d", { alpha: false });
    const image = context.createImageData(canvas.width, canvas.height);
    const maximum = (1 << bpp) - 1;
    for (let tile = 0; tile < count; tile++) {
      const tileX = (tile % columns) * 8;
      const tileY = Math.floor(tile / columns) * 8;
      const tileOffset = offset + tile * bytesPerTile;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const value = tilePixel(bytes, tileOffset, x, y, bpp);
        const shade = Math.round(value / maximum * 255);
        const pixel = ((tileY + y) * canvas.width + tileX + x) * 4;
        image.data[pixel] = shade;
        image.data[pixel + 1] = shade;
        image.data[pixel + 2] = shade;
        image.data[pixel + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return count;
  }

  function renderTiles() {
    if (!state.original) return;
    const offset = C.parseNumber($("tileOffset").value, 0);
    const bpp = Number($("tileBpp").value);
    const count = Number($("tileCount").value);
    const columns = Number($("tileColumns").value);
    const rendered = renderTileSheet(state.original, offset, count, bpp, columns, $("tileCanvas"));
    status("tileStatus", `Rendered ${rendered} ${bpp}bpp tile(s) from ${C.hex(offset)} using a neutral grayscale palette.`, rendered ? "good" : "bad");
  }

  function updateAssetButton() {
    $("applyAssetBtn").disabled = !(state.original && $("assetFile").files?.[0]);
  }

  async function stageAsset() {
    const file = $("assetFile").files?.[0];
    if (!file || !state.original) return;
    const data = new Uint8Array(await file.arrayBuffer());
    const offset = C.parseNumber($("assetOffset").value, -1);
    const maxLength = C.parseNumber($("assetMaxLength").value, data.length);
    if (offset < 0 || maxLength <= 0 || offset + maxLength > state.original.length) throw new Error("Enter a valid destination offset and reserved length.");
    if (data.length > maxLength) throw new Error(`The asset is ${data.length} bytes but the reserved region is ${maxLength} bytes.`);
    state.asset = { name: file.name, data, offset, maxLength };
    status("assetStatus", `Staged ${file.name}: ${data.length.toLocaleString()} bytes at ${C.hex(offset)} within a ${maxLength.toLocaleString()}-byte region.`, "good");
  }

  function selectedTranslations() {
    return state.workspace.filter(item => item.use && item.translation);
  }

  function buildOptions() {
    return {
      base: $("buildPointerBase").value,
      padByte: $("buildPadByte").value,
      freeStart: $("freeStart").value || Math.max(0, state.original.length - 0x100000),
      freeEnd: $("freeEnd").value || state.original.length
    };
  }

  function validateBuild() {
    if (!state.original) throw new Error("Load the source ROM first.");
    const items = selectedTranslations();
    const errors = [];
    const warnings = [];
    for (const item of items) {
      try {
        const length = encodedLength(item);
        if (length > item.length && !item.pointerRefs.length) errors.push(`${item.id}: ${length} bytes will not fit and no pointer is known.`);
        for (const line of item.translation.split(/\[NL\]|\n/)) if (line.length > 32) warnings.push(`${item.id}: line exceeds 32 characters; verify text-box width.`);
      } catch (error) { errors.push(`${item.id}: ${error.message}`); }
    }
    if (!items.length) warnings.push("No enabled entries contain translations.");
    if (state.asset && state.asset.data.length > state.asset.maxLength) errors.push("The staged binary asset exceeds its reserved region.");
    const message = [`${items.length} translated entries selected.`, ...errors.map(value => `ERROR: ${value}`), ...warnings.map(value => `WARNING: ${value}`)].join("\n");
    $("buildLog").textContent = message;
    status("buildStatus", errors.length ? `Validation failed with ${errors.length} error(s).` : `Validation passed with ${warnings.length} warning(s). Candidate free space and layout still require emulator testing.`, errors.length ? "bad" : warnings.length ? "warn" : "good");
    return errors.length === 0;
  }

  function buildRom() {
    if (!validateBuild()) return;
    const result = C.applyTranslations(state.original, selectedTranslations(), tableEntries(), buildOptions());
    let output = result.bytes;
    if (state.asset) output = C.applyBinaryAsset(output, state.asset.data, state.asset.offset, state.asset.maxLength);
    state.staged = output;
    const lines = result.log.map(item => `${item.id}: ${C.hex(item.oldOffset)} → ${C.hex(item.newOffset)}, ${item.oldLength} → ${item.newLength} bytes${item.relocated ? `; relocated; ${item.pointersUpdated} pointer(s) updated` : "; in place"}`);
    if (state.asset) lines.push(`Asset ${state.asset.name}: ${state.asset.data.length} bytes → ${C.hex(state.asset.offset)}`);
    lines.push(`Header checksum repaired: ${C.hex(C.headerChecksum(output), 2)}`);
    $("buildLog").textContent = lines.join("\n") || "No changes were staged.";
    ["downloadRomBtn", "downloadIpsBtn", "downloadBpsBtn"].forEach(id => $(id).disabled = false);
    status("buildStatus", `Build complete. ${result.log.length} text change(s) and ${state.asset ? 1 : 0} asset change(s) staged. Test the patch in an emulator.`, "good");
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer))) : reject(new Error("PNG encoding failed.")), "image/png"));
  }

  function u16(out, value) { out.push(value & 0xFF, (value >>> 8) & 0xFF); }
  function u32(out, value) { out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF); }

  function makeZip(files) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const name = new TextEncoder().encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : new TextEncoder().encode(String(file.data));
      const crc = C.crc32(data);
      const record = [];
      u32(record, 0x04034B50); u16(record, 20); u16(record, 0x0800); u16(record, 0); u16(record, 0); u16(record, 0);
      u32(record, crc); u32(record, data.length); u32(record, data.length); u16(record, name.length); u16(record, 0);
      record.push(...name);
      local.push(Uint8Array.from(record), data);
      const directory = [];
      u32(directory, 0x02014B50); u16(directory, 20); u16(directory, 20); u16(directory, 0x0800); u16(directory, 0); u16(directory, 0); u16(directory, 0);
      u32(directory, crc); u32(directory, data.length); u32(directory, data.length); u16(directory, name.length); u16(directory, 0); u16(directory, 0); u16(directory, 0); u16(directory, 0); u32(directory, 0); u32(directory, offset);
      directory.push(...name);
      central.push(Uint8Array.from(directory));
      offset += record.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = [];
    u32(end, 0x06054B50); u16(end, 0); u16(end, 0); u16(end, files.length); u16(end, files.length); u32(end, centralSize); u32(end, offset); u16(end, 0);
    return new Blob([...local, ...central, Uint8Array.from(end)], { type: "application/zip" });
  }

  async function extractGraphics() {
    if (!state.original) return;
    state.graphicsCancelled = false;
    $("extractGraphicsBtn").disabled = true;
    $("cancelGraphicsBtn").disabled = false;
    const start = Math.max(0, C.parseNumber($("gfxStart").value, 0));
    const end = Math.min(state.original.length, C.parseNumber($("gfxEnd").value, state.original.length));
    const bpp = Number($("gfxBpp").value);
    const bytesPerTile = bpp * 8;
    const tilesPerSheet = Number($("gfxTilesPerSheet").value);
    const columns = Number($("gfxColumns").value);
    const totalTiles = Math.floor((end - start) / bytesPerTile);
    const sheetCount = Math.ceil(totalTiles / tilesPerSheet);
    const files = [];
    const manifest = {
      tool: "GBA Translation Lab Graphics Extractor", generatedAt: new Date().toISOString(),
      rom: { fileName: state.fileName, sha256: state.sha256, size: state.original.length },
      raw: { start, end, bpp, bytesPerTile, totalTiles, tilesPerSheet, columns, sheets: [] },
      lz77: [],
      limitations: [
        "Raw sheets exhaustively interpret the selected bytes as tiles and therefore include false positives.",
        "Neutral grayscale indices are used because palette and tilemap relationships are game-specific.",
        "Nonstandard compression and runtime-generated graphics require game-specific reverse engineering."
      ]
    };
    const canvas = document.createElement("canvas");
    for (let sheet = 0; sheet < sheetCount; sheet++) {
      if (state.graphicsCancelled) throw new Error("Graphics extraction cancelled.");
      const tileOffset = sheet * tilesPerSheet;
      const byteOffset = start + tileOffset * bytesPerTile;
      const count = Math.min(tilesPerSheet, totalTiles - tileOffset);
      renderTileSheet(state.original, byteOffset, count, bpp, columns, canvas);
      const name = `raw_${bpp}bpp/sheet_${sheet.toString().padStart(4, "0")}_${byteOffset.toString(16).padStart(8, "0")}.png`;
      files.push({ name, data: await canvasBlob(canvas) });
      manifest.raw.sheets.push({ file: name, offset: byteOffset, tileCount: count });
      const completed = sheet + 1;
      $("graphicsProgress").style.width = `${Math.round(completed / Math.max(1, sheetCount + 1) * 80)}%`;
      status("graphicsStatus", `Rendering raw sheet ${completed.toLocaleString()} of ${sheetCount.toLocaleString()}…`);
      await nextFrame();
    }
    if ($("gfxIncludeLz").checked) {
      const streams = C.detectLz77(state.original, { start, end, maxResults: 10000 });
      for (let index = 0; index < streams.length; index++) {
        if (state.graphicsCancelled) throw new Error("Graphics extraction cancelled.");
        const stream = streams[index];
        const decoded = C.decompressLz77(state.original, stream.offset).bytes;
        const stem = `lz77/${stream.offset.toString(16).padStart(8, "0")}`;
        files.push({ name: `${stem}.bin`, data: decoded });
        const count = Math.floor(decoded.length / bytesPerTile);
        const previews = [];
        for (let first = 0, page = 0; first < count; first += tilesPerSheet, page++) {
          renderTileSheet(decoded, first * bytesPerTile, Math.min(tilesPerSheet, count - first), bpp, columns, canvas);
          const name = `${stem}_${bpp}bpp_${page.toString().padStart(3, "0")}.png`;
          files.push({ name, data: await canvasBlob(canvas) });
          previews.push(name);
        }
        manifest.lz77.push({ ...stream, binary: `${stem}.bin`, previews });
        $("graphicsProgress").style.width = `${80 + Math.round((index + 1) / Math.max(1, streams.length) * 18)}%`;
        status("graphicsStatus", `Processed LZ77 stream ${index + 1} of ${streams.length}…`);
        await nextFrame();
      }
    }
    files.push({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });
    $("graphicsProgress").style.width = "99%";
    status("graphicsStatus", `Packaging ${files.length.toLocaleString()} files into a ZIP…`);
    await nextFrame();
    const archive = makeZip(files);
    download(`${safeName(state.fileName)}_graphics.zip`, archive);
    $("graphicsProgress").style.width = "100%";
    status("graphicsStatus", `Graphics archive created: ${manifest.raw.sheets.length} raw sheet(s), ${manifest.lz77.length} LZ77 stream(s), ${files.length} total file(s).`, "good");
  }

  function nextFrame() { return new Promise(resolve => requestAnimationFrame(() => resolve())); }

  function guard(action, statusId = "workspaceStatus") {
    return async (...args) => {
      try { await action(...args); }
      catch (error) { console.error(error); status(statusId, error.message, "bad"); }
    };
  }

  ensureAsciiMappings();
  $("romFile").addEventListener("change", event => guard(() => loadRom(event.target.files?.[0]), "workspaceStatus")());
  $("buildWorkspaceBtn").addEventListener("click", guard(buildWorkspace));
  $("confidenceFilter").addEventListener("input", renderWorkspace);
  $("pointerOnly").addEventListener("change", renderWorkspace);
  $("exportProjectBtn").addEventListener("click", exportProject);
  $("exportCsvBtn").addEventListener("click", exportCsv);
  $("importProjectBtn").addEventListener("click", () => $("projectFile").click());
  $("projectFile").addEventListener("change", event => guard(() => importProject(event.target.files?.[0]))());
  $("scanLzBtn").addEventListener("click", scanLz);
  $("downloadLzBtn").addEventListener("click", downloadSelectedLz);
  $("renderTilesBtn").addEventListener("click", guard(renderTiles, "tileStatus"));
  $("assetFile").addEventListener("change", updateAssetButton);
  $("applyAssetBtn").addEventListener("click", guard(stageAsset, "assetStatus"));
  $("validateBuildBtn").addEventListener("click", guard(validateBuild, "buildStatus"));
  $("buildRomBtn").addEventListener("click", guard(buildRom, "buildStatus"));
  $("downloadRomBtn").addEventListener("click", () => download(`${safeName(state.fileName)}_English.gba`, state.staged));
  $("downloadIpsBtn").addEventListener("click", guard(() => download(`${safeName(state.fileName)}_English.ips`, C.createIpsPatch(state.original, state.staged)), "buildStatus"));
  $("downloadBpsBtn").addEventListener("click", guard(() => download(`${safeName(state.fileName)}_English.bps`, C.createBpsPatch(state.original, state.staged)), "buildStatus"));
  $("extractGraphicsBtn").addEventListener("click", guard(async () => {
    try { await extractGraphics(); }
    finally { $("extractGraphicsBtn").disabled = !state.original; $("cancelGraphicsBtn").disabled = true; }
  }, "graphicsStatus"));
  $("cancelGraphicsBtn").addEventListener("click", () => { state.graphicsCancelled = true; });
})();
