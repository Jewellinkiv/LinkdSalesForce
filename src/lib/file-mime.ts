export function fileMime(name: string): string {
  return (
    (
      {
        csv: "text/csv",
        txt: "text/plain",
        pdf: "application/pdf",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      } as Record<string, string>
    )[name.split(".").at(-1)?.toLowerCase() || ""] || "application/octet-stream"
  );
}
