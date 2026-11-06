import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { validateFile, fileMimes } from "./file-validation";
import { parseCsv } from "./monday-adapter";
import { HttpError } from "./auth";
import {
  retailerFields,
  type RetailerMapping,
  type RetailerRow,
  type RetailerSheet,
} from "../lib/retailers";

const aliases: Record<string, string[]> = {
  name: [
    "storename",
    "customername",
    "accountnameaccountname",
    "retailercompanynamedba",
    "company",
    "companyname",
    "store",
    "retailer",
  ],
  contactName: ["fullname", "contactperson", "contactname"],
  firstName: ["firstname"],
  lastName: ["lastname"],
  ownerName: ["ownername"],
  email: ["email", "primaryemail", "pubemailadd"],
  phone: ["phone", "phone1", "storephone"],
  address: ["address1", "accountnamebillingstreet", "address"],
  address2: ["address2"],
  city: ["city", "accountnamebillingcity"],
  state: ["state", "accountnamebillingstateprovince"],
  postal: ["zip", "postal", "accountnamebillingzippostalcode"],
  country: ["country", "accountnamebillingcountry"],
  website: ["website"],
  category: ["retailerexhibitorsponsorguest"],
  notes: ["notes"],
};
export const normalizeRetailer = (v: string) =>
  v
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
export function guessMapping(headers: string[]): RetailerMapping {
  const out: RetailerMapping = {};
  for (const field of retailerFields) {
    const i = headers.findIndex((h) =>
      aliases[field]?.includes(normalizeRetailer(h)),
    );
    if (i >= 0) out[field] = i;
  }
  return out;
}
export async function readRetailerFile(file: { name: string; data: string }) {
  const mime = file.name.toLowerCase().endsWith(".xlsx")
    ? fileMimes[3]
    : fileMimes[0];
  // ExcelJS reads cells only; embedded printer settings are retained in the original file but never executed.
  const { content } = validateFile(
    { ...file, mime },
    { allowPrinterSettings: true },
  );
  const sheets: RetailerSheet[] = [];
  if (file.name.toLowerCase().endsWith(".csv"))
    sheets.push({
      name: "CSV",
      rows: parseCsv(content.toString("utf8").replace(/^\uFEFF/, "")),
      headerRow: 0,
      mapping: {},
    });
  else {
    const book = new ExcelJS.Workbook();
    try {
      await book.xlsx.load(content as unknown as ExcelJS.Buffer);
    } catch {
      throw new HttpError(
        400,
        "Unable to read this workbook. Save it as an unencrypted XLSX or CSV.",
      );
    }
    for (const sheet of book.worksheets) {
      if (sheet.rowCount > 10000 || sheet.columnCount > 100)
        throw new HttpError(
          400,
          "Use at most 10,000 rows and 100 columns per sheet.",
        );
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: true }, (row) => {
        const values: string[] = [];
        for (let c = 1; c <= sheet.columnCount; c++) {
          const cell = row.getCell(c);
          values.push(
            cell.value == null ||
              (cell.isMerged && cell.master.address !== cell.address)
              ? ""
              : cell.text.trim().slice(0, 10000),
          );
        }
        rows.push(values);
      });
      sheets.push({ name: sheet.name, rows, headerRow: 0, mapping: {} });
    }
  }
  if (
    sheets.length > 20 ||
    sheets.reduce((n, s) => n + s.rows.length, 0) > 20000
  )
    throw new HttpError(400, "Split this workbook into smaller lists.");
  for (const s of sheets) {
    const header = s.rows
      .slice(0, 20)
      .findIndex((r) => guessMapping(r).name !== undefined);
    s.headerRow = Math.max(0, header);
    s.mapping = guessMapping(s.rows[s.headerRow] || []);
  }
  return {
    fingerprint: createHash("sha256").update(content).digest("hex"),
    sheets,
  };
}
export function mapRetailerRows(
  sheet: RetailerSheet,
  mapping: RetailerMapping,
  headerRow: number,
) {
  if (mapping.name === undefined)
    throw new HttpError(400, "Map the retailer/company name column.");
  const rows: RetailerRow[] = [],
    skipped: { row: number; reason: string }[] = [];
  const headers = sheet.rows[headerRow] || [];
  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    const cells = sheet.rows[i];
    if (!cells.some((c) => c.trim())) continue;
    const get = (k: keyof RetailerMapping) =>
      mapping[k] === undefined ? "" : (cells[mapping[k]!] || "").trim();
    let name = get("name"),
      city = get("city"),
      state = get("state");
    if (!name) {
      skipped.push({
        row: i + 1,
        reason: "No retailer name (blank/footer row)",
      });
      continue;
    }
    // CBG places the name and location in one cell; keep the complete original in provenance.
    if (name.includes("\n")) {
      const lines = name.split(/\r?\n/);
      name = lines[0].trim();
      const place = lines
        .slice(1)
        .join(" ")
        .match(/^(.+?),\s*([A-Z]{2})\b/);
      if (place) {
        city ||= place[1];
        state ||= place[2];
      }
    }
    const category = get("category");
    if (category && !/retailer/i.test(category)) {
      skipped.push({
        row: i + 1,
        reason: `Non-retailer category: ${category}`,
      });
      continue;
    }
    const raw = Object.fromEntries(
      headers.map((h, j) => [`${j + 1}: ${h || "Unlabelled"}`, cells[j] || ""]),
    );
    rows.push({
      row: i + 1,
      name,
      city,
      state,
      country: get("country"),
      address: [get("address"), get("address2")].filter(Boolean).join(", "),
      postal: get("postal"),
      website: get("website"),
      contactName:
        get("contactName") ||
        [get("firstName"), get("lastName")].filter(Boolean).join(" "),
      ownerName: get("ownerName"),
      email: get("email"),
      phone: get("phone"),
      notes: get("notes"),
      category,
      raw,
    });
  }
  if (rows.length > 5000)
    throw new HttpError(400, "Import at most 5,000 retailer rows at a time.");
  return { rows, skipped };
}
