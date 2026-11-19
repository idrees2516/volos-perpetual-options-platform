// ─────────────────────────────────────────────────────────────────────────────
// VolScript — lexer. Pine-style: `//` comments, NEWLINE tokens carry the
// indentation of the FOLLOWING content line (so the parser can build indented
// blocks), identifiers may be dotted (`ta.sma`, `color.teal`, `strategy.long`).
// ─────────────────────────────────────────────────────────────────────────────

export type TokenType = 'NEWLINE' | 'IDENT' | 'NUMBER' | 'STRING' | 'OP' | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
  /** NEWLINE only: indentation (spaces, tab = 4) of the next content line */
  indent: number;
}

export class LexError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number,
  ) {
    super(message);
  }
}

const OPS = [
  '==', '!=', '<=', '>=', '&&', '||', ':=',
  '+', '-', '*', '/', '%', '^', '<', '>', '=', '?', ':', '!', '(', ')', '[', ']', ',', ';',
];

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

/** Tokenize VolScript source. Throws LexError with line/col. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type: TokenType, value: string) => {
    tokens.push({ type, value, line, col, indent: 0 });
  };

  /** Indentation (in spaces) of the next content line starting at j; skips
   *  blank and comment-only lines. Returns {indent, end} where end indexes
   *  the first real content character. */
  const nextContent = (start: number): { indent: number; end: number } => {
    let j = start;
    let ind = 0;
    for (;;) {
      ind = 0;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) {
        ind += src[j] === '\t' ? 4 : 1;
        j++;
      }
      if (j >= src.length) return { indent: 0, end: j };
      if (src[j] === '\r' && src[j + 1] === '\n') {
        j += 2;
        continue;
      }
      if (src[j] === '\n') {
        j++;
        continue;
      }
      if (src[j] === '/' && src[j + 1] === '/') {
        while (j < src.length && src[j] !== '\n') j++;
        continue;
      }
      return { indent: ind, end: j };
    }
  };

  while (i < src.length) {
    const ch = src[i];

    // ── newlines (each emits a NEWLINE carrying the NEXT content indent) ──
    if (ch === '\n' || ch === '\r') {
      const skip = ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      const { indent } = nextContent(i + skip);
      tokens.push({ type: 'NEWLINE', value: '\n', line, col, indent });
      i += skip;
      line++;
      col = 1;
      continue;
    }

    // ── comments (line comments end before '\n', which emits the NEWLINE) ──
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        i++;
        col++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      i += 2;
      col += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++;
          col = 1;
        } else col++;
        i++;
      }
      if (i >= src.length) throw new LexError('unterminated block comment', startLine, startCol);
      i += 2;
      col += 2;
      continue;
    }

    // ── whitespace ─────────────────────────────────────────────────────────
    if (ch === ' ' || ch === '\t') {
      i++;
      col++;
      continue;
    }

    // ── numbers ────────────────────────────────────────────────────────────
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] ?? '')) {
          j = k;
          while (j < src.length && /[0-9]/.test(src[j])) j++;
        }
      }
      push('NUMBER', src.slice(i, j));
      col += j - i;
      i = j;
      continue;
    }

    // ── strings ────────────────────────────────────────────────────────────
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length || src[j] === '\n') throw new LexError('unterminated string', line, col);
      push('STRING', out);
      col += j + 1 - i;
      i = j + 1;
      continue;
    }

    // ── identifiers — dotted chains allowed: ta.sma, strategy.long ────────
    if (isIdentStart(ch)) {
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j++;
      while (
        j < src.length &&
        src[j] === '.' &&
        j + 1 < src.length &&
        isIdentStart(src[j + 1])
      ) {
        let k = j + 1;
        while (k < src.length && isIdentPart(src[k])) k++;
        j = k;
      }
      push('IDENT', src.slice(i, j));
      col += j - i;
      i = j;
      continue;
    }

    // ── operators ──────────────────────────────────────────────────────────
    let matched = '';
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      push('OP', matched);
      i += matched.length;
      col += matched.length;
      continue;
    }

    throw new LexError(`unexpected character '${ch}'`, line, col);
  }

  tokens.push({ type: 'EOF', value: '', line, col, indent: 0 });
  return tokens;
}
