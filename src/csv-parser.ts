const PROJECT_PATTERN = /^(\d+)-([A-Za-z])(?:-(.+))?$/;

function detectColumns(
  headers: string[],
  synonyms: Record<string, string[]>,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const headersLower: Record<string, string> = {};
  for (const h of headers) headersLower[h.trim().toLowerCase()] = h;

  for (const [canonical, syns] of Object.entries(synonyms)) {
    for (const syn of syns) {
      if (syn.toLowerCase() in headersLower) {
        mapping[canonical] = headersLower[syn.toLowerCase()];
        break;
      }
    }
  }
  return mapping;
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

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = parseRows(lines, headers);
  const colMap = detectColumns(headers, synonyms);

  const rawPreview = rows.slice(0, 5);
  const projectCol = colMap.project;
  const superprojectCol = colMap.superproject;
  const batchCol = colMap.batch;
  const phaseCol = colMap.phase;

  const projectGroups: Record<string, { rows: Record<string, string>[]; batches: (number | string)[]; phases: Set<string> }> = {};

  for (const row of rows) {
    const projVal = (projectCol ? row[projectCol] ?? "" : "").trim();
    if (!projVal) continue;
    if (!projectGroups[projVal]) projectGroups[projVal] = { rows: [], batches: [], phases: new Set() };
    projectGroups[projVal].rows.push(row);

    if (batchCol) {
      const bv = (row[batchCol] ?? "").trim();
      if (bv) {
        const num = parseInt(bv, 10);
        projectGroups[projVal].batches.push(isNaN(num) ? bv : num);
      }
    }
    if (phaseCol) {
      const pv = (row[phaseCol] ?? "").trim();
      if (pv) projectGroups[projVal].phases.add(pv);
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

    const phases = [...data.phases];
    const suggestedPhase = phases.length === 1 ? phases[0] : phases[0] ?? null;
    const batchNums = [...new Set(data.batches)].sort((a, b) => {
      if (typeof a === "number" && typeof b === "number") return a - b;
      return String(a).localeCompare(String(b));
    });

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

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = parseRows(lines, headers);
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

function parseRows(lines: string[], headers: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
