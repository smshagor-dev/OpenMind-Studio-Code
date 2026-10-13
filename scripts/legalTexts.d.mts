export function markdownToText(markdown: string): string;
export function agreementText(texts: { eula: string; privacy: string; license: string }): string;
export function checkAgreement(text: string): string[];
export const LEGAL_FILES: Record<string, "agreement" | "privacy" | "terms" | "eula" | "license">;
