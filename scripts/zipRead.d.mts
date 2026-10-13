export function zipEntries(zip: Buffer): { name: string; data(): Buffer }[];
export function zipEntry(zip: Buffer, wanted: (name: string) => boolean): { name: string; data: Buffer } | null;
