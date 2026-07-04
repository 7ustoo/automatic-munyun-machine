#!/usr/bin/env node
/**
 * Minimal .xlsx writer with native hyperlink support (v2.4.1). Zero deps.
 *
 * WHY THIS EXISTS: CSV is plain text (RFC 4180) — it cannot mark a cell as
 * a hyperlink, so the .csv export shows apply links as inert text in Excel.
 * A real .xlsx can: it's a ZIP of XML parts, and hyperlinks are first-class
 * (worksheet <hyperlinks> + external relationship targets). Rather than pull
 * in a spreadsheet library (exceljs is ~10 MB of deps), we write the five
 * XML parts + a STORED (uncompressed) ZIP container by hand — Excel,
 * LibreOffice, and Google Sheets all open it.
 *
 * Scope is deliberately tiny: one sheet, string/number cells, one optional
 * hyperlink column styled blue+underline. That's everything the apply-links
 * export needs. Not a general spreadsheet engine.
 *
 * ZIP notes: entries are STORED (method 0, no compression) so we don't need
 * zlib streams — sizes here are tiny (a 100-job sheet is ~40 KB). CRC-32 is
 * the standard reflected polynomial (0xEDB88320), table-driven.
 */

// ---- CRC-32 (ZIP flavor) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- STORED-entry ZIP container ----
// files: [{ name, data: Buffer }]. Returns the complete .zip/.xlsx Buffer.
export function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header signature
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // flags: UTF-8 names
    local.writeUInt16LE(0, 8);               // method: STORED
    local.writeUInt16LE(0, 10);              // mod time
    local.writeUInt16LE(0x21, 12);           // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);    // compressed size (== raw, STORED)
    local.writeUInt32LE(data.length, 22);    // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // extra length
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);    // central directory signature
    central.writeUInt16LE(20, 4);            // version made by
    central.writeUInt16LE(20, 6);            // version needed
    central.writeUInt16LE(0x0800, 8);        // flags: UTF-8 names
    central.writeUInt16LE(0, 10);            // method: STORED
    central.writeUInt16LE(0, 12);            // mod time
    central.writeUInt16LE(0x21, 14);         // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs all zero
    central.writeUInt32LE(offset, 42);       // local header offset
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);         // end-of-central-directory signature
  eocd.writeUInt16LE(files.length, 8);       // entries on this disk
  eocd.writeUInt16LE(files.length, 10);      // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---- XML helpers ----
export function xmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Strip control chars that are illegal in XML 1.0 (scraped titles can
    // carry stray control bytes; Excel refuses the whole file over one).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// Column index (0-based) → A1-style letter(s).
export function colLetter(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

/**
 * Build a single-sheet .xlsx.
 *
 * @param opts.sheetName    Tab name (default "Sheet1")
 * @param opts.columns      [{ header, width?, hyperlink? }] — at most one
 *                          hyperlink column; its cell text becomes a native
 *                          clickable link to the cell's own URL value.
 * @param opts.rows         Array of arrays, one per row, same order as columns.
 *                          Numbers become numeric cells; everything else text.
 * @returns Buffer — the .xlsx file.
 */
export function buildXlsx({ sheetName = 'Sheet1', columns = [], rows = [] } = {}) {
  const linkCol = columns.findIndex(c => c.hyperlink);

  // Column widths
  const colsXml = columns.length
    ? '<cols>' + columns.map((c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${Number(c.width) || 18}" customWidth="1"/>`
      ).join('') + '</cols>'
    : '';

  // Header row (bold, style 2) then data rows. Inline strings — a shared-
  // strings table is an optimization we don't need at this size.
  const headerXml = '<row r="1">' + columns.map((c, i) =>
    `<c r="${colLetter(i)}1" t="inlineStr" s="2"><is><t>${xmlEsc(c.header)}</t></is></c>`
  ).join('') + '</row>';

  const hyperlinks = [];
  const rels = [];
  const rowXml = rows.map((row, ri) => {
    const r = ri + 2; // 1-based, after header
    const cells = row.map((v, ci) => {
      const ref = `${colLetter(ci)}${r}`;
      if (ci === linkCol && v) {
        const rid = `rId${hyperlinks.length + 1}`;
        hyperlinks.push(`<hyperlink ref="${ref}" r:id="${rid}"/>`);
        rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(v)}" TargetMode="External"/>`);
        // s="1": the blue+underline hyperlink style from styles.xml
        return `<c r="${ref}" t="inlineStr" s="1"><is><t>${xmlEsc(v)}</t></is></c>`;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        return `<c r="${ref}"><v>${v}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');

  const hyperlinksXml = hyperlinks.length ? `<hyperlinks>${hyperlinks.join('')}</hyperlinks>` : '';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${colsXml}<sheetData>${headerXml}${rowXml}</sheetData>${hyperlinksXml}</worksheet>`;

  const sheetRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;

  // Styles: font 0 default · font 1 hyperlink blue+underline · font 2 bold.
  // cellXfs: xf 0 default · xf 1 hyperlink · xf 2 header.
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><sz val="11"/><name val="Calibri"/><color rgb="FF0563C1"/><u/></font>
<font><sz val="11"/><name val="Calibri"/><b/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf fontId="2" applyFont="1"/></cellXfs>
</styleSheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const B = (s) => Buffer.from(s, 'utf8');
  return buildZip([
    { name: '[Content_Types].xml', data: B(contentTypesXml) },
    { name: '_rels/.rels', data: B(rootRelsXml) },
    { name: 'xl/workbook.xml', data: B(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: B(workbookRelsXml) },
    { name: 'xl/styles.xml', data: B(stylesXml) },
    { name: 'xl/worksheets/sheet1.xml', data: B(sheetXml) },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: B(sheetRelsXml) }
  ]);
}
