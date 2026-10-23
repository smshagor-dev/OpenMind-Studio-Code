/** A provider write preserves the URI components and UTF-8 content across the host boundary. */
export function virtualDocumentWrite(uri: string, content: string) {
  const resource = new URL(uri);
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Virtual document content exceeds 32 MB.");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return {
    op: "writeFile",
    scheme: resource.protocol.slice(0, -1),
    authority: decodeURIComponent(resource.host),
    path: decodeURIComponent(resource.pathname),
    query: decodeURIComponent(resource.search.slice(1)),
    fragment: decodeURIComponent(resource.hash.slice(1)),
    base64: btoa(binary),
  };
}
