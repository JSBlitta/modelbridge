import { suggestCanonicals } from "./lib/column-match.ts";

const PROJECT_PATTERN = /^(\d+)-([A-Za-z])(?:-(.+))?$/;

// Detect comma vs semicolon delimiter from the header line (outside quotes)
export function detectDelimiter(headerLine: string): "," | ";" {
  let commas = 0;
  let semis = 0;
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === ",") commas++;
    else if (!inQuotes && ch === ";") semis++;
  }
  return semis > commas ? ";" : ",";
}

// canonical -> header, through the matcher the Trimble flow uses.
function detectColumns(
  headers: string[],
  synonyms: Record<string, string[]>,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [header, canonical] of Object.entries(suggestCanonicals(headers, synonyms))) mapping[canonical] = header;
  return mapping;
}

// A stdlib cell holds a JSON array, one value (name, project number or uuid), or
// several separated by , or |.
export function parseStdlibCell(cell: unknown): string[] {
  const s = String(cell ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((v) => String(v).trim()).filter(Boolean);
    } catch { /* not JSON: split below */ }
  }
  return s.split(/[,|]/).map((v) => v.trim()).filter(Boolean);
}

export function parseProjectCsv(
  text: string,
  synonyms: Record<string, string[]>,
  descToSuffix: Record<string, string>,
): {
  detected_columns: { headers: string[]; mapped: Record<string, string> };
  project_groups: string[];
  phase_suggestions: unknown[];
  raw_preview: Record<string, string>[];
} {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return { detected_columns: { headers: [], mapped: {} }, project_groups: [], phase_suggestions: [], raw_preview: [] };

  const delim = detectDelimiter(lines[0]);
  const headers = lines[0].split(delim).map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = parseRows(lines, headers, delim);
  const colMap = detectColumns(headers, synonyms);

  const rawPreview = rows.slice(0, 5);
  const projectCol = colMap.project;
  const superprojectCol = colMap.superproject;
  const batchCol = colMap.batch;
  const phaseCol = colMap.phase;
  const stdlibCol = colMap.stdlib;

  const projectGroups: Record<string, { rows: Record<string, string>[]; batches: { number: number | string; stdlibs: string[]; phase: string }[]; phases: Set<string> }> = {};

  for (const row of rows) {
    const projVal = (projectCol ? row[projectCol] ?? "" : "").trim();
    if (!projVal) continue;
    if (!projectGroups[projVal]) projectGroups[projVal] = { rows: [], batches: [], phases: new Set() };
    projectGroups[projVal].rows.push(row);

    const rowPhase = (phaseCol ? (row[phaseCol] ?? "").trim() : "");
    if (rowPhase) projectGroups[projVal].phases.add(rowPhase);

    if (batchCol) {
      const bv = (row[batchCol] ?? "").trim();
      if (bv) {
        const num = parseInt(bv, 10);
        const batchNum = (!isNaN(num) && String(num) === bv) ? num : bv;
        const stdlibs = stdlibCol ? parseStdlibCell(row[stdlibCol]) : [];
        projectGroups[projVal].batches.push({ number: batchNum, stdlibs, phase: rowPhase });
      }
    }
  }

  const phaseSuggestions = Object.entries(projectGroups).map(([projKey, data]) => {
    const m = PROJECT_PATTERN.exec(projKey);
    const number = m?.[1] ?? "";
    const letter = m ? m[2].toUpperCase() : "";
    const description = m?.[3] ?? null;

    let suggestedSuffix = letter;
    if (description) {
      const descLower = description.toLowerCase();
      for (const [keyword, suffix] of Object.entries(descToSuffix)) {
        if (descLower.includes(keyword)) { suggestedSuffix = suffix; break; }
      }
    }

    let superproject = "";
    if (superprojectCol) {
      const spVals = data.rows.map((r) => (r[superprojectCol] ?? "").trim()).filter(Boolean);
      superproject = spVals[0] ?? number;
    } else {
      superproject = number;
    }

    const suggestedPhase = [...data.phases][0] ?? null;
    const seenNums = new Map<number | string, { stdlibs: string[]; phase: string }>();
    for (const b of data.batches) {
      const seen = seenNums.get(b.number);
      // Every row of a batch counts: the first one may leave the stdlib cell empty.
      if (seen) seen.stdlibs = [...new Set([...seen.stdlibs, ...b.stdlibs])];
      else seenNums.set(b.number, { stdlibs: [...b.stdlibs], phase: b.phase });
    }
    const batchNums = [...seenNums.entries()]
      .sort(([a], [b]) => {
        if (typeof a === "number" && typeof b === "number") return a - b;
        return String(a).localeCompare(String(b));
      })
      .map(([number, info]) => ({ number, stdlibs: info.stdlibs, phase: info.phase }));

    return {
      project_key: projKey,
      superproject,
      letter,
      description,
      suggested_suffix: suggestedSuffix,
      suggested_phase: suggestedPhase,
      batches: batchNums,
      status: "new",
    };
  });

  return {
    detected_columns: { headers, mapped: colMap },
    project_groups: Object.keys(projectGroups),
    phase_suggestions: phaseSuggestions,
    raw_preview: rawPreview,
  };
}

export function parseAssemblyCsv(
  text: string,
  synonyms: Record<string, string[]>,
  clientMetaDefaults: Record<string, string[]>,
): {
  headers: string[];
  col_map: Record<string, string>;
  meta_suggestions: Record<string, string>;
  unmapped_columns: string[];
  rows: Record<string, string>[];
  preview: Record<string, string>[];
} {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return { headers: [], col_map: {}, meta_suggestions: {}, unmapped_columns: [], rows: [], preview: [] };

  const delim = detectDelimiter(lines[0]);
  const headers = lines[0].split(delim).map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = parseRows(lines, headers, delim);
  const colMap = detectColumns(headers, synonyms);

  const metaSuggestions: Record<string, string> = {};
  const headersLower: Record<string, string> = {};
  for (const h of headers) headersLower[h.trim().toLowerCase()] = h;

  for (const [metaKey, metaSyns] of Object.entries(clientMetaDefaults)) {
    for (const syn of metaSyns) {
      if (syn.toLowerCase() in headersLower) {
        metaSuggestions[headersLower[syn.toLowerCase()]] = `client_meta.${metaKey}`;
        break;
      }
    }
  }

  const mappedCols = new Set(Object.values(colMap));
  const metaCols = new Set(Object.keys(metaSuggestions));
  const unmapped = headers.filter((h) => !mappedCols.has(h) && !metaCols.has(h));

  return {
    headers,
    col_map: colMap,
    meta_suggestions: metaSuggestions,
    unmapped_columns: unmapped,
    rows,
    preview: rows.slice(0, 10),
  };
}

function parseRows(lines: string[], headers: string[], delim: "," | ";"): Record<string, string>[] {
  // lines[0] is the header; re-join the remainder so splitCsvDocument can see
  // record boundaries that fall inside quoted fields.
  const body = lines.slice(1).join("\n");
  return splitCsvDocument(body, delim).map((values) => {
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = values[j] ?? "";
    return row;
  });
}

// Split a whole CSV body into records. Splitting on newlines first (the previous
// approach) corrupted any row containing a quoted newline — common in
// description columns — because half the field became a phantom record.
export function splitCsvDocument(text: string, delim: "," | ";"): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let current = "";
  let inQuotes = false;
  // Whether the field being built was quoted. Quoted content is taken verbatim;
  // unquoted content is trimmed. The old parser trimmed unconditionally, so a
  // deliberately quoted "  padded  " silently lost its padding.
  let fieldQuoted = false;
  // Where the quoted run ended, so whitespace typed after the closing quote
  // ("value" , next) is discarded rather than becoming part of the value.
  let quotedEnd = -1;
  let sawContent = false;

  const endField = () => {
    const value = fieldQuoted
      ? current.slice(0, quotedEnd < 0 ? current.length : quotedEnd)
      : current.trim();
    record.push(value);
    current = "";
    fieldQuoted = false;
    quotedEnd = -1;
  };
  const endRecord = () => {
    endField();
    if (sawContent) records.push(record);
    record = [];
    sawContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
      else if (inQuotes) { inQuotes = false; quotedEnd = current.length; }
      else {
        inQuotes = true;
        fieldQuoted = true;
        // Whitespace before the opening quote is not part of the value.
        if (!current.trim()) current = "";
      }
      sawContent = true;
    } else if (ch === delim && !inQuotes) {
      endField();
      sawContent = true;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else {
      current += ch;
      if (ch.trim()) sawContent = true;
    }
  }
  if (current.length || record.length) endRecord();
  return records;
}

export function splitCsvLine(line: string, delim: "," | ";"): string[] {
  return splitCsvDocument(line, delim)[0] ?? [];
}
