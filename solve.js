// csv-reader-speed-01 — a fast drop-in for csv-reader 1.0.0 (make.fun).
//
// One left-to-right pass over the text. Fields are found by scanning for
// their delimiters with charCodeAt and sliced out in one piece; a field is
// never built a character at a time. Only a quoted field that holds a doubled
// quote or a line break, or an unquoted field that loses a stray CR, pays for
// a second piece. Error objects keep one shape per error kind, and rows are
// pre-allocated at the first record's width, so the hot path stays on packed
// arrays. Semantics follow csv-reader 1.0.0 exactly (BOM, stray CR, doubled
// quotes, quote junk, unterminated quotes, short and long rows).

const COMMA = 44; // ','
const QUOTE = 34; // '"'
const LF = 10; // '\n'
const CR = 13; // '\r'
const BOM = 0xFEFF;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === BOM) pos = 1;

  for (;;) {
    // A line left with no characters is no record: skip LF and CRLF lines.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) { pos += 1; line += 1; }
      else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    // The record being read: the line it starts on, and the index in rows it
    // takes (null while the header is still unread).
    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // The record's fields: packed from the start once the width is known.
    let fields;
    let extra = null;
    if (width < 0) fields = [];
    else fields = new Array(width);
    let f = 0;
    let lastQuoted = false;
    let endedComma = false;

    for (;;) {
      let value;
      let parts = null;
      let start = pos;
      let runUnquoted = false;
      let junkBase = null;
      lastQuoted = text.charCodeAt(pos) === QUOTE;

      if (lastQuoted) {
        // A field that opens with a quote runs to the next quote that is not
        // doubled; "" inside it is one quote, and each CRLF or lone CR inside
        // it reads as LF.
        const open = pos;
        const openLine = line;
        pos += 1;
        start = pos;
        let closed = false;
        let end = pos;
        for (;;) {
          while (pos < n) {
            const c = text.charCodeAt(pos);
            if (c === QUOTE || c === CR || c === LF) break;
            pos += 1;
          }
          end = pos;
          if (pos >= n) break;
          const c = text.charCodeAt(pos);
          if (c === QUOTE) {
            if (pos + 1 < n && text.charCodeAt(pos + 1) === QUOTE) {
              if (parts === null) parts = [];
              if (pos > start) parts.push(text.slice(start, pos));
              parts.push('"');
              pos += 2;
              start = pos;
              continue;
            }
            closed = true;
            pos += 1;
            break;
          }
          if (parts === null) parts = [];
          if (pos > start) parts.push(text.slice(start, pos));
          parts.push('\n');
          line += 1;
          if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) pos += 2;
          else pos += 1;
          start = pos;
        }

        if (!closed) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          parts = ['"'];
          start = pos;
          runUnquoted = true;
        } else {
          if (parts === null) value = text.slice(start, end);
          else {
            if (end > start) parts.push(text.slice(start, end));
            value = parts.join('');
            parts = null;
          }
          if (pos >= n) {
            endedComma = false;
          } else {
            const c = text.charCodeAt(pos);
            if (c === COMMA) { pos += 1; endedComma = true; }
            else if (c === LF) { pos += 1; line += 1; endedComma = false; }
            else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) { pos += 2; line += 1; endedComma = false; }
            else {
              // What follows the closing quote is appended as it stands, up
              // to the next comma or line break.
              junkBase = value;
              start = pos;
              runUnquoted = true;
            }
          }
        }
      } else {
        runUnquoted = true;
      }

      if (runUnquoted) {
        // Unquoted characters up to the next comma or line break; a CR not
        // followed by LF is dropped (stray_cr).
        let added = 0;
        if (junkBase !== null && junkBase !== '') parts = [junkBase];
        let end = pos;
        for (;;) {
          while (pos < n) {
            const c = text.charCodeAt(pos);
            if (c === COMMA || c === LF || c === CR) break;
            pos += 1;
          }
          end = pos;
          if (pos >= n) { endedComma = false; break; }
          const c = text.charCodeAt(pos);
          if (c === COMMA) { pos += 1; endedComma = true; break; }
          if (c === LF) { pos += 1; line += 1; endedComma = false; break; }
          if (pos + 1 < n && text.charCodeAt(pos + 1) === LF) { pos += 2; line += 1; endedComma = false; break; }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (parts === null) parts = [];
          if (pos > start) { parts.push(text.slice(start, pos)); added += pos - start; }
          pos += 1;
          start = pos;
        }
        if (parts === null) {
          value = text.slice(start, end);
          added = end - start;
        } else {
          if (end > start) { parts.push(text.slice(start, end)); added += end - start; }
          value = parts.join('');
        }
        if (junkBase !== null && added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      if (width < 0) fields.push(value);
      else if (f < width) fields[f] = value;
      else {
        if (extra === null) extra = [];
        extra.push(value);
      }
      f += 1;
      if (!endedComma) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (f === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = f;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (f < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: f });
      for (let i = f; i < width; i += 1) fields[i] = '';
    } else if (f > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: extra });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
