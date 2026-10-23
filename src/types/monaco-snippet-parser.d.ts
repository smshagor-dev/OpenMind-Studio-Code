/** Narrow declaration for the snippet parser shipped by the installed Monaco version. */
declare module "monaco-editor/editor/contrib/snippet/browser/snippetParser.js" {
  export class Variable { readonly name: string }
  export class SnippetParser {
    parse(value: string): { walk(visitor: (marker: unknown) => boolean): void };
  }
}
