import { invoke } from "@tauri-apps/api/core";
export interface AgentAttachment {
  id: string;
  name: string;
  text?: string;
  data?: string;
}
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
async function image(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error("Image exceeds 40 megapixels");
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image decoder unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.8);
    if (data.length > 680000)
      throw new Error("Image is too detailed; resize it before attaching (500 KB limit)");
    return data;
  } finally {
    bitmap.close();
  }
}
async function pdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({
    data: bytes,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: "/pdf/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdf/standard_fonts/",
    wasmUrl: "/pdf/wasm/",
    iccUrl: "/pdf/iccs/",
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > 50) throw new Error("PDF exceeds 50 pages; attach a smaller extract");
    const pages: string[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
      if (pages.join("\n").length > 80000) throw new Error("PDF text exceeds 80,000 characters");
    }
    if (!pages.join("").trim())
      throw new Error("Scanned PDF has no text. Attach page images for vision analysis.");
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}
export async function readAttachment(file: File): Promise<AgentAttachment> {
  if (!file.size || file.size > 10 * 1024 * 1024)
    throw new Error("Files must be between 1 byte and 10 MB");
  const result = { id: crypto.randomUUID(), name: Array.from(file.name).slice(0, 75).join("") };
  if (/^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name))
    return { ...result, data: await image(file) };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  if (/\.pdf$/i.test(file.name)) text = await pdf(bytes);
  else if (/\.docx$/i.test(file.name))
    text = await invoke<string>("agent_document_read", { data: base64(bytes) });
  else {
    if (bytes.includes(0))
      throw new Error(
        "This binary file is not supported; attach text, PDF, DOCX, PNG, JPEG or WebP",
      );
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (new TextEncoder().encode(text).length > 100000)
    throw new Error("Extracted text exceeds 100 KB; attach a smaller extract");
  return { ...result, text };
}
