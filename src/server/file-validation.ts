import { HttpError } from "./auth";

export const fileMimes = [
  "text/csv",
  "text/plain",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
export function validateFile(file: {
  name: string;
  mime: string;
  data: string;
}) {
  const content = Buffer.from(file.data, "base64");
  if (!content.length || content.length > 2000000)
    throw new HttpError(400, "Each file must be between 1 byte and 2 MB.");
  const extension = file.name.toLowerCase().split(".").pop();
  const expected = {
    csv: fileMimes[0],
    txt: fileMimes[1],
    pdf: fileMimes[2],
    xlsx: fileMimes[3],
    docx: fileMimes[4],
  }[extension || ""];
  if (!expected || expected !== file.mime)
    throw new HttpError(
      400,
      "Choose a CSV, TXT, PDF, XLSX or DOCX file with a matching file type.",
    );
  if (extension === "pdf") {
    if (!content.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new HttpError(400, "The PDF is not valid.");
  } else if (extension === "xlsx" || extension === "docx") {
    // Inspect ZIP metadata only; never execute, render or extract uploaded Office documents.
    const end = content.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (
      end < 0 ||
      end + 22 > content.length ||
      !content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    )
      throw new HttpError(400, "Invalid Office document.");
    const count = content.readUInt16LE(end + 10);
    let offset = content.readUInt32LE(end + 16),
      total = 0;
    const names = new Set<string>();
    if (count > 1000 || count === 0)
      throw new HttpError(400, "Office document has too many entries.");
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || content.readUInt32LE(offset) !== 0x02014b50)
        throw new HttpError(400, "Invalid Office archive.");
      const length = content.readUInt16LE(offset + 28),
        extra = content.readUInt16LE(offset + 30),
        comment = content.readUInt16LE(offset + 32);
      if (
        offset + 46 + length + extra + comment > end ||
        content.readUInt16LE(offset + 8) & 1
      )
        throw new HttpError(400, "Encrypted or invalid Office document.");
      const name = content
        .subarray(offset + 46, offset + 46 + length)
        .toString("utf8");
      total += content.readUInt32LE(offset + 24);
      if (
        total > 20000000 ||
        /(?:vbaProject|\.exe$|\.js$|\.vbs$|\.bin$|\.\.\/)/i.test(name)
      )
        throw new HttpError(
          400,
          "Macro or oversized Office documents are not supported.",
        );
      names.add(name);
      offset += 46 + length + extra + comment;
    }
    if (
      !names.has("[Content_Types].xml") ||
      !names.has(extension === "xlsx" ? "xl/workbook.xml" : "word/document.xml")
    )
      throw new HttpError(
        400,
        "Office document type does not match its extension.",
      );
  } else if (
    content.includes(0) ||
    /<(?:script|html|svg)\b/i.test(content.toString("utf8"))
  )
    throw new HttpError(400, "Use plain-text CSV/TXT files.");
  return { ...file, name: file.name.replace(/[^\w. ()-]/g, "_"), content };
}
