import type * as monaco from "monaco-editor";

/**
 * Syntax highlighting for x86/x86-64 assembly: NASM (Intel syntax, the default) and GNU as (AT&T syntax). One shared
 * register/mnemonic vocabulary, two tokenizers, so MASM/FASM can be added the same way later.
 */

const GENERAL_REGISTERS = [
  "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp", "rip",
  "eax", "ebx", "ecx", "edx", "esi", "edi", "ebp", "esp", "eip",
  "ax", "bx", "cx", "dx", "si", "di", "bp", "sp",
  "al", "ah", "bl", "bh", "cl", "ch", "dl", "dh", "sil", "dil", "bpl", "spl",
  "cs", "ds", "es", "fs", "gs", "ss",
];

/** r8-r15 with their d/w/b forms, xmm/ymm/zmm 0-31, st0-7, mm0-7, cr/dr0-7, k0-7. */
function numberedRegisters(): string[] {
  const names: string[] = [];
  for (let n = 8; n <= 15; n++) names.push(`r${n}`, `r${n}d`, `r${n}w`, `r${n}b`);
  for (let n = 0; n <= 31; n++) names.push(`xmm${n}`, `ymm${n}`, `zmm${n}`);
  for (let n = 0; n <= 7; n++) names.push(`st${n}`, `mm${n}`, `cr${n}`, `dr${n}`, `k${n}`);
  return names;
}

export const REGISTERS: readonly string[] = [...GENERAL_REGISTERS, ...numberedRegisters()];

const MNEMONICS = [
  "mov", "movzx", "movsx", "movsxd", "lea", "push", "pop", "xchg", "cmpxchg", "bswap", "cmov", "cmove", "cmovne",
  "cmovz", "cmovnz", "cmovl", "cmovg", "cmovle", "cmovge", "cmova", "cmovb", "add", "adc", "sub", "sbb", "inc", "dec",
  "neg", "mul", "imul", "div", "idiv", "and", "or", "xor", "not", "shl", "shr", "sal", "sar", "rol", "ror", "rcl", "rcr",
  "test", "cmp", "jmp", "je", "jne", "jz", "jnz", "jg", "jge", "jl", "jle", "ja", "jae", "jb", "jbe", "jc", "jnc", "jo",
  "jno", "js", "jns", "jp", "jnp", "jcxz", "jecxz", "jrcxz", "loop", "loope", "loopne", "call", "ret", "retn", "retf",
  "enter", "leave", "int", "int3", "into", "iret", "iretq", "syscall", "sysret", "sysenter", "nop", "hlt", "cpuid",
  "rdtsc", "cbw", "cwd", "cdq", "cqo", "cwde", "cdqe", "sete", "setne", "setz", "setnz", "setg", "setl", "setge", "setle",
  "seta", "setb", "movs", "movsb", "movsw", "movsd", "movsq", "stos", "stosb", "stosw", "stosd", "stosq", "lods", "lodsb",
  "scas", "scasb", "cmps", "cmpsb", "rep", "repe", "repne", "repz", "repnz", "lock", "cld", "std", "clc", "stc", "cmc",
  "pushf", "popf", "pushfq", "popfq", "bt", "bts", "btr", "btc", "bsf", "bsr", "popcnt", "lzcnt", "tzcnt",
  "movd", "movq", "movaps", "movups", "movapd", "movupd", "movss", "movdqa", "movdqu", "addss", "addsd", "subss",
  "subsd", "mulss", "mulsd", "divss", "divsd", "sqrtss", "sqrtsd", "cvtsi2sd", "cvtsi2ss", "cvttsd2si", "cvtss2sd",
  "cvtsd2ss", "pxor", "xorps", "xorpd", "andps", "orps", "paddd", "psubd", "pmulld", "fld", "fst", "fstp", "fadd",
  "fsub", "fmul", "fdiv", "fild", "fistp", "fxch",
];

/** AT&T spells the operand size into the mnemonic: `movq`, `pushl`, `addb`. */
const GAS_MNEMONICS = MNEMONICS.flatMap((name) => [name, ...["b", "w", "l", "q"].map((suffix) => name + suffix)]);

const NASM_DIRECTIVES = [
  "section", "segment", "global", "extern", "common", "bits", "default", "org", "align", "alignb", "absolute",
  "times", "equ", "incbin", "struc", "endstruc", "istruc", "iend", "at", "cpu", "use16", "use32", "use64",
  "db", "dw", "dd", "dq", "dt", "do", "dy", "dz", "resb", "resw", "resd", "resq", "rest", "reso", "resy", "resz",
  "rel", "abs", "wrt", "seg", "strict", "nosplit",
];
const NASM_SIZES = ["byte", "word", "dword", "qword", "tword", "oword", "yword", "zword", "ptr", "near", "far", "short"];

/** NASM (Intel syntax): `;` comments, `%` preprocessor lines, `label:`, `[rbp - 8]` memory operands. */
export const NASM_TOKENS: monaco.languages.IMonarchLanguage = {
  ignoreCase: true,
  defaultToken: "",
  directives: NASM_DIRECTIVES,
  sizes: NASM_SIZES,
  instructions: MNEMONICS,
  registers: REGISTERS,
  tokenizer: {
    root: [
      [/;.*$/, "comment"],
      [/^\s*%\s*[a-z_]+/, "keyword.directive"],
      [/%%?[a-z_.$?@][\w.$?@#~]*/, "variable"],
      [/^\s*[a-z_.$?@][\w.$?@#~]*:/, "type.identifier"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/'[^']*'/, "string"],
      [/`([^`\\]|\\.)*`/, "string"],
      [/\b0[xh][0-9a-f_]+\b|\b[0-9][0-9a-f_]*h\b|\$0[0-9a-f_]*\b/, "number.hex"],
      [/\b0[by][01_]+\b|\b[01_]+[by]\b/, "number.binary"],
      [/\b\d[\d_]*(\.\d+)?(e[+-]?\d+)?\b/, "number"],
      [
        /[a-z_.$?@][\w.$?@#~]*/,
        {
          cases: {
            "@instructions": "keyword",
            "@registers": "variable.predefined",
            "@directives": "keyword.directive",
            "@sizes": "keyword.type",
            "@default": "identifier",
          },
        },
      ],
      [/[[\]]/, "delimiter.square"],
      [/[(),+\-*/:]/, "delimiter"],
    ],
  },
};

/** GNU as (AT&T syntax): `#` and C comments, `.directives`, `%registers`, `$immediates`. */
export const GAS_TOKENS: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  ignoreCase: true,
  instructions: GAS_MNEMONICS,
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/^\s*[a-zA-Z_.$][\w.$]*:/, "type.identifier"],
      [/\.[a-zA-Z_][\w.]*/, "keyword"],
      [/%[a-zA-Z][\w]*/, "variable.predefined"],
      [/\$0x[0-9a-fA-F]+|\$-?\d+/, "number"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/\b0x[0-9a-fA-F]+\b/, "number.hex"],
      [/\b\d+\b/, "number"],
      [/[a-zA-Z_][\w.$]*/, { cases: { "@instructions": "keyword", "@default": "identifier" } }],
      [/[(),+\-*]/, "delimiter"],
    ],
    comment: [
      [/\*\//, "comment", "@pop"],
      [/[^*]+/, "comment"],
      [/\*/, "comment"],
    ],
  },
};

/** The editor language of a `.inc` file: NASM when the text looks like assembly, else `null` (left as it is). */
export function assemblyIncludeLanguage(text: string): "nasm" | null {
  const lines = text.split(/\r?\n/).slice(0, 200);
  for (const raw of lines) {
    const line = raw.trim().toLowerCase();
    if (line.startsWith("<?")) return null;
    if (/^%\s*(macro|endmacro|define|xdefine|assign|include|ifdef|ifndef|if|endif|rep|endrep)\b/.test(line)) return "nasm";
    if (/^[a-z_.$?@][\w.$?@]*\s+(equ|db|dw|dd|dq|resb|resw|resd|resq|times)\b/.test(line)) return "nasm";
    if (/^(section|segment|global|extern|bits|default)\b/.test(line)) return "nasm";
  }
  return null;
}
