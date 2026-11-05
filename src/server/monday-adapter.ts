import { z } from "zod";
const field = z.object({
  column: z.string(),
  type: z.enum(["text", "number", "boolean"]).default("text"),
  values: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});
export const mappingSchema = z.object({
  source: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  columns: z.record(z.string(), field),
  defaults: z.record(z.string(), z.unknown()).default({}),
});
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      if (cell || closed) throw new Error("Invalid CSV quoting.");
      quoted = true;
    } else if (ch === "," || ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (ch !== ",") {
        if (ch === "\r" && csv[i + 1] === "\n") i++;
        if (row.some((v) => v !== "")) rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw new Error("Unexpected text after a CSV quote.");
      cell += ch;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  if (cell || row.length || closed) {
    row.push(cell);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}
export function prepareMonday(csv: string, config: unknown) {
  const mapping = mappingSchema.parse(config),
    rows = parseCsv(csv.replace(/^\uFEFF/, "")),
    headers = rows.shift();
  if (!headers?.length || new Set(headers).size !== headers.length)
    throw new Error(
      "The CSV needs a unique header row. Remove export title/group rows before preparation.",
    );
  for (const field of Object.values(mapping.columns))
    if (!headers.includes(field.column))
      throw new Error(`Mapped column is absent: ${field.column}`);
  const errors: { row: number; field: string; issue: string }[] = [],
    normalized: Record<string, unknown>[] = [];
  for (const [index, cells] of rows.entries()) {
    const out: Record<string, unknown> = { ...mapping.defaults },
      sourceFields = Object.fromEntries(
        headers.map((h, i) => [h, cells[i] || ""]),
      );
    if (cells.length !== headers.length) {
      errors.push({
        row: index + 2,
        field: "row",
        issue: "Column count differs from the header.",
      });
      continue;
    }
    for (const [name, definition] of Object.entries(mapping.columns)) {
      const raw = sourceFields[definition.column].trim();
      if (definition.values) {
        if (Object.hasOwn(definition.values, raw))
          out[name] = definition.values[raw];
        else
          errors.push({
            row: index + 2,
            field: name,
            issue: `No reviewed mapping for ${JSON.stringify(raw)}.`,
          });
      } else if (definition.type === "number") {
        if (!/^-?\d+(?:\.\d+)?$/.test(raw))
          errors.push({
            row: index + 2,
            field: name,
            issue:
              "Expected a plain decimal number. Review currency/percent formatting explicitly.",
          });
        else out[name] = Number(raw);
      } else if (definition.type === "boolean") {
        if (raw === "true" || raw === "false") out[name] = raw === "true";
        else
          errors.push({
            row: index + 2,
            field: name,
            issue: "Boolean requires true/false or an explicit values map.",
          });
      } else out[name] = raw;
    }
    out.sourceFields = sourceFields;
    normalized.push(out);
  }
  if (!mapping.columns.externalId && !mapping.defaults.externalId)
    errors.push({
      row: 1,
      field: "externalId",
      issue:
        "Map the stable Monday item ID; row position and name are not IDs.",
    });
  if (
    mapping.columns.discount &&
    !mapping.columns.discountType &&
    !["amount", "percent"].includes(String(mapping.defaults.discountType))
  )
    errors.push({
      row: 1,
      field: "discountType",
      issue: "Declare whether the source discount is percent or amount.",
    });
  return {
    batch: { source: mapping.source, rows: normalized },
    errors,
    sourceRows: rows.length,
  };
}
