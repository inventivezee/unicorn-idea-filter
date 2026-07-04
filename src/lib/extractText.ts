"use client";

// Client-side text extraction for CV uploads. All parsers are dynamically
// imported so they never enter the server bundle or the initial page load.

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "),
    );
  }
  return pages.join("\n\n");
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

/**
 * Extract plain text from an uploaded CV. Supports .pdf, .docx, and any
 * plain-text format (.txt, .md, ...). Throws with a user-readable message.
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  let text: string;
  if (name.endsWith(".pdf")) {
    text = await extractPdf(file);
  } else if (name.endsWith(".docx")) {
    text = await extractDocx(file);
  } else if (name.endsWith(".doc")) {
    throw new Error(
      "Legacy .doc files aren't supported — save it as .docx, .pdf, or .txt and try again.",
    );
  } else {
    text = await file.text();
  }
  const cleaned = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) {
    throw new Error(
      "No text could be extracted from that file (it may be a scanned image). Paste your background as text instead.",
    );
  }
  return cleaned;
}
