/** Parser CSV (RFC 4180): aspas, aspas escapadas (""), quebras de linha dentro de aspas, CRLF/LF, BOM. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("CSV: aspas sem fechamento");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export interface CsvTable {
  columns: string[];
  rows: Record<string, string>[];
}

export function csvToTable(text: string, delimiter = ","): CsvTable {
  const [header, ...body] = parseCsv(text, delimiter);
  if (!header || !header.length)
    throw new Error("CSV vazio: a primeira linha deve ter os nomes das colunas");
  const columns = header.map((h) => h.trim());
  const bad = columns.find((c) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
  if (bad !== undefined) {
    throw new Error(`coluna "${bad}" inválida: use letras, números e _ (começando por letra ou _)`);
  }
  const rows = body.map((cells, n) => {
    if (cells.length !== columns.length) {
      throw new Error(
        `linha ${n + 2}: ${cells.length} valores, mas o cabeçalho tem ${columns.length} colunas`,
      );
    }
    return Object.fromEntries(columns.map((c, i) => [c, cells[i]!]));
  });
  if (!rows.length) throw new Error("CSV sem linhas de dados");
  return { columns, rows };
}
