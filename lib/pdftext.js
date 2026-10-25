// Minimal, dependency-free PDF text extraction.
//
// Why not a library: pdf-parse and friends pull in native or heavyweight deps and
// this app already fights native-module pain when packaging for Windows. CVs are
// almost always text-based (exported from Word/Docs/LaTeX), and for that case the
// extraction is tractable: find content streams, inflate the FlateDecode ones with
// Node's built-in zlib, and read the text-showing operators.
//
// What this does NOT handle: scanned/image PDFs (no OCR), encrypted PDFs, and exotic
// CID font encodings. Those return little or no text — callers must treat a short
// result as "extraction failed" and fall back to the paste-your-CV field.

import zlib from 'node:zlib';

/** Decode a PDF string literal, handling escapes and octal codes. */
function decodeLiteral(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === '(' || n === ')' || n === '\\') out += n;
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n;
  }
  return out;
}

/** Decode a <hex> string. */
function decodeHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    // Skip control chars that show up when the PDF uses 2-byte CIDs we can't map.
    if (code >= 32 || code === 10 || code === 13) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Pull readable text out of one decoded content stream by walking the text-showing
 * operators: (str) Tj, <hex> Tj, [ ... ] TJ, and the quote variants.
 */
function textFromContentStream(content) {
  let out = '';
  // Match: literal strings, hex strings, array-show operators, and line breaks.
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[Jj]\b|\bTd\b|\bTD\b|\bT\*\b|\bTL\b|'|"/g;
  let pendingLineBreak = false;
  let m;
  while ((m = re.exec(content)) !== null) {
    const tok = m[0];
    if (tok.startsWith('(')) {
      if (pendingLineBreak) { out += '\n'; pendingLineBreak = false; }
      out += decodeLiteral(tok.slice(1, -1));
    } else if (tok.startsWith('<')) {
      if (pendingLineBreak) { out += '\n'; pendingLineBreak = false; }
      out += decodeHex(tok.slice(1, -1));
    } else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === "'" || tok === '"') {
      pendingLineBreak = true;
    } else if (tok === 'TJ' || tok === 'Tj') {
      // End of a show operation — a space keeps words from running together.
      out += ' ';
    }
  }
  return out;
}

/**
 * Extract text from a PDF buffer.
 * @returns { text, ok, reason } — ok=false when the result is too short to be a real CV.
 */
export function extractPdfText(buffer) {
  if (!buffer || !buffer.length) return { text: '', ok: false, reason: 'empty file' };

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { text: '', ok: false, reason: 'not a PDF' };
  }

  const raw = buf.toString('latin1');
  let collected = '';

  // Walk every `stream ... endstream` block. Inflate when it looks compressed.
  const streamRe = /stream\r?\n?/g;
  let sm;
  while ((sm = streamRe.exec(raw)) !== null) {
    const start = sm.index + sm[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    streamRe.lastIndex = end;

    const slice = buf.subarray(start, end);
    let content = null;

    // zlib streams start with 0x78 (and the dictionary usually says FlateDecode).
    if (slice.length > 2 && slice[0] === 0x78) {
      try { content = zlib.inflateSync(slice).toString('latin1'); } catch { /* not flate */ }
      if (content === null) {
        try { content = zlib.inflateRawSync(slice).toString('latin1'); } catch { /* give up */ }
      }
    }
    if (content === null) {
      const asText = slice.toString('latin1');
      // Only treat as plain content if it actually looks like PDF text operators.
      if (/\bT[Jj]\b/.test(asText)) content = asText;
    }
    if (content && /\bT[Jj]\b/.test(content)) collected += textFromContentStream(content) + '\n';
  }

  const text = collected
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ ?\n ?/g, '\n')
    .trim();

  // A real CV has meaningful prose. Anything shorter is almost certainly a scanned
  // PDF or an encoding we can't read — the caller should ask the user to paste.
  if (text.replace(/\s/g, '').length < 200) {
    return { text, ok: false, reason: 'little or no extractable text (scanned or image-based PDF?)' };
  }

  // PDFs with custom/CID font maps can produce thousands of glyph codes that
  // look like symbols. Counting characters alone previously marked this as a
  // successful CV extraction and polluted fit scoring. Refuse unreadable text.
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const words = (text.match(/[A-Za-z]{3,}/g) || []).length;
  if (letters / Math.max(1, text.length) < 0.45 || words < 30) {
    return {
      text: '',
      ok: false,
      reason: 'PDF uses an unsupported font encoding. Paste readable CV text into the profile instead.',
    };
  }
  return { text, ok: true };
}
