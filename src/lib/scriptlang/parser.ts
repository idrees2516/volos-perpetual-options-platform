// ─────────────────────────────────────────────────────────────────────────────
// VolScript — parser. Recursive descent over Pine-v5-style syntax with
// INDENTED blocks (4 spaces / tabs), `if`/`else if`/`else`, `var` declarations,
// tuple destructuring `[a, b] = ta.macd(...)`, named call args (title=, stop=).
// ─────────────────────────────────────────────────────────────────────────────

import { tokenize, type Token } from './lexer';

export type ExprNode =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; name: string }
  | { t: 'un'; op: string; e: ExprNode }
  | { t: 'bin'; op: string; l: ExprNode; r: ExprNode }
  | { t: 'tern'; c: ExprNode; a: ExprNode; b: ExprNode }
  | { t: 'hist'; e: ExprNode; off: ExprNode }
  | { t: 'call'; name: string; args: Array<{ name?: string; value: ExprNode }>; line: number }
  | { t: 'list'; items: ExprNode[] };

export interface AssignStmt {
  t: 'assign';
  name: string;
  expr: ExprNode;
  decl: 'new' | 'var' | 're';
  line: number;
}
export type StmtNode =
  | AssignStmt
  | { t: 'tuple'; names: string[]; expr: ExprNode; decl: 'new' | 'var' | 're'; line: number }
  | { t: 'expr'; expr: ExprNode; line: number }
  | { t: 'if'; cond: ExprNode; then: StmtNode[]; els: StmtNode[] | null; line: number };

export class ParseError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number,
  ) {
    super(message);
  }
}

const CMP_OPS = ['==', '!=', '<', '<=', '>', '>='];

class Parser {
  private toks: Token[];
  private pos = 0;
  /** indent of the line the NEXT statement starts on (from the last NEWLINE) */
  private pendingIndent: number | null = null;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  private peek(off = 0): Token {
    return this.toks[Math.min(this.pos + off, this.toks.length - 1)];
  }
  private next(): Token {
    const t = this.toks[this.pos];
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }
  private isOp(t: Token, v: string): boolean {
    return t.type === 'OP' && t.value === v;
  }
  private err(msg: string, t: Token = this.peek()): never {
    throw new ParseError(msg, t.line, t.col);
  }

  private skipSeparators(): void {
    while (true) {
      const t = this.peek();
      if (t.type === 'NEWLINE') {
        this.pendingIndent = t.indent;
        this.pos++;
        continue;
      }
      if (this.isOp(t, ';')) {
        this.pos++;
        continue;
      }
      break;
    }
  }

  parse(): StmtNode[] {
    const out = this.parseStatements(0);
    this.skipSeparators();
    if (this.peek().type !== 'EOF') this.err(`unexpected token '${this.peek().value}'`);
    return out;
  }

  /** statements whose lines sit at indent >= level; returns on dedent. */
  private parseStatements(level: number): StmtNode[] {
    const out: StmtNode[] = [];
    this.skipSeparators();
    while (this.peek().type !== 'EOF') {
      const ind = this.pendingIndent ?? level;
      if (ind < level) return out; // dedent — the parent re-examines
      out.push(this.parseStatement(ind));
      this.skipSeparators();
    }
    return out;
  }

  private parseStatement(level: number): StmtNode {
    const t = this.peek();
    if (t.type === 'IDENT') {
      if (t.value === 'else') this.err("'else' without a matching 'if'");
      if (t.value === 'if') return this.parseIf(level);
      if (t.value === 'var') {
        this.next(); // consume 'var' — the next token is the variable name
        return this.parseAssign('var');
      }
      const nxt = this.peek(1);
      if (this.isOp(nxt, '=') || this.isOp(nxt, ':=')) return this.parseAssign(this.isOp(nxt, ':=') ? 're' : 'new');
    }
    if (this.isOp(t, '[')) return this.parseTupleAssign();
    const e = this.parseExpr();
    return { t: 'expr', expr: e, line: t.line };
  }

  private parseAssign(decl: 'new' | 'var' | 're'): AssignStmt {
    const nameTok = this.next(); // IDENT
    if (nameTok.value === 'else') this.err("'else' is a reserved word", nameTok);
    this.next(); // '=' / ':='
    const expr = this.parseExpr();
    return { t: 'assign', name: nameTok.value, expr, decl, line: nameTok.line };
  }

  private parseTupleAssign(): StmtNode {
    this.next(); // '['
    const names: string[] = [];
    for (;;) {
      const t = this.next();
      if (t.type !== 'IDENT') this.err('expected variable name in tuple destructuring', t);
      names.push(t.value);
      if (this.isOp(this.peek(), ',')) {
        this.next();
        continue;
      }
      break;
    }
    if (!this.isOp(this.next(), ']')) this.err('expected ] after tuple names');
    const op = this.next();
    if (!this.isOp(op, '=') && !this.isOp(op, ':=')) this.err('expected = after tuple names', op);
    const expr = this.parseExpr();
    return { t: 'tuple', names, expr, decl: this.isOp(op, ':=') ? 're' : 'new', line: names.length ? this.toks[this.pos - names.length - 2]?.line ?? 0 : 0 };
  }

  private parseIf(level: number): StmtNode {
    const ifTok = this.next(); // 'if'
    if (ifTok.value !== 'if') this.err('internal: parseIf on non-if', ifTok);
    const cond = this.parseExpr();
    const nl = this.peek();
    if (nl.type !== 'NEWLINE') this.err('expected a newline after the if condition — put the body on the next line, indented', nl);
    if (nl.indent <= level) this.err(`if body must be indented further than the if line (body indent ${nl.indent})`, nl);
    this.pos++; // consume the block-opening NEWLINE
    this.pendingIndent = nl.indent; // the first body statement sits at this level
    const then = this.parseStatements(nl.indent);

    let els: StmtNode[] | null = null;
    const t = this.peek();
    if (t.type === 'IDENT' && t.value === 'else' && (this.pendingIndent ?? -1) === level) {
      this.pos++; // 'else'
      const nt = this.peek();
      if (nt.type === 'IDENT' && nt.value === 'if') {
        els = [this.parseIf(level)];
      } else if (nt.type === 'NEWLINE') {
        if (nt.indent <= level) this.err('else body must be indented further than the else line', nt);
        this.pos++;
        this.pendingIndent = nt.indent;
        els = this.parseStatements(nt.indent);
      } else {
        this.err('expected if or an indented block after else', nt);
      }
    }
    return { t: 'if', cond, then, els, line: ifTok.line };
  }

  // ── expressions (precedence climbing) ───────────────────────────────────

  parseExpr(): ExprNode {
    return this.parseTernary();
  }

  private parseTernary(): ExprNode {
    const c = this.parseOr();
    if (this.isOp(this.peek(), '?')) {
      this.next();
      const a = this.parseTernary();
      if (!this.isOp(this.next(), ':')) this.err('expected : in ternary');
      const b = this.parseTernary();
      return { t: 'tern', c, a, b };
    }
    return c;
  }

  private parseOr(): ExprNode {
    let l = this.parseAnd();
    for (;;) {
      const t = this.peek();
      if ((t.type === 'OP' && t.value === '||') || (t.type === 'IDENT' && t.value === 'or')) {
        this.next();
        l = { t: 'bin', op: '||', l, r: this.parseAnd() };
      } else return l;
    }
  }

  private parseAnd(): ExprNode {
    let l = this.parseCmp();
    for (;;) {
      const t = this.peek();
      if ((t.type === 'OP' && t.value === '&&') || (t.type === 'IDENT' && t.value === 'and')) {
        this.next();
        l = { t: 'bin', op: '&&', l, r: this.parseCmp() };
      } else return l;
    }
  }

  private parseCmp(): ExprNode {
    let l = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t.type === 'OP' && CMP_OPS.includes(t.value)) {
        this.next();
        l = { t: 'bin', op: t.value, l, r: this.parseAdd() };
      } else return l;
    }
  }

  private parseAdd(): ExprNode {
    let l = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.type === 'OP' && (t.value === '+' || t.value === '-')) {
        this.next();
        l = { t: 'bin', op: t.value, l, r: this.parseMul() };
      } else return l;
    }
  }

  private parseMul(): ExprNode {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'OP' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        l = { t: 'bin', op: t.value, l, r: this.parseUnary() };
      } else return l;
    }
  }

  private parseUnary(): ExprNode {
    const t = this.peek();
    if (this.isOp(t, '-')) {
      this.next();
      return { t: 'un', op: '-', e: this.parseUnary() };
    }
    if (this.isOp(t, '!')) {
      this.next();
      return { t: 'un', op: '!', e: this.parseUnary() };
    }
    if (t.type === 'IDENT' && t.value === 'not') {
      this.next();
      return { t: 'un', op: '!', e: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExprNode {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp(this.peek(), '[')) {
        this.next();
        const off = this.parseExpr();
        if (!this.isOp(this.next(), ']')) this.err('expected ] after history offset');
        e = { t: 'hist', e, off };
        continue;
      }
      return e;
    }
  }

  private parsePrimary(): ExprNode {
    const t = this.peek();
    if (t.type === 'NUMBER') {
      this.next();
      return { t: 'num', v: Number(t.value) };
    }
    if (t.type === 'STRING') {
      this.next();
      return { t: 'str', v: t.value };
    }
    if (t.type === 'IDENT') {
      if (this.isOp(this.peek(1), '(')) return this.parseCall();
      this.next();
      return { t: 'ident', name: t.value };
    }
    if (this.isOp(t, '(')) {
      this.next();
      const e = this.parseExpr();
      if (!this.isOp(this.next(), ')')) this.err('expected )');
      return e;
    }
    if (this.isOp(t, '[')) {
      this.next();
      const items: ExprNode[] = [];
      if (!this.isOp(this.peek(), ']')) {
        items.push(this.parseExpr());
        while (this.isOp(this.peek(), ',')) {
          this.next();
          items.push(this.parseExpr());
        }
      }
      if (!this.isOp(this.next(), ']')) this.err('expected ] after list');
      return { t: 'list', items };
    }
    this.err(`unexpected token '${t.value || t.type}'`);
  }

  private parseCall(): ExprNode {
    const nameTok = this.next(); // IDENT (possibly dotted)
    this.next(); // '('
    const args: Array<{ name?: string; value: ExprNode }> = [];
    if (!this.isOp(this.peek(), ')')) {
      for (;;) {
        // named arg? IDENT '=' (but not '==' — lexer handles)
        let name: string | undefined;
        if (this.peek().type === 'IDENT' && this.isOp(this.peek(1), '=')) {
          name = this.next().value;
          this.next(); // '='
        }
        args.push({ name, value: this.parseExpr() });
        if (this.isOp(this.peek(), ',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    if (!this.isOp(this.next(), ')')) this.err(`expected ) to close ${nameTok.value}(...)`);
    return { t: 'call', name: nameTok.value, args, line: nameTok.line };
  }
}

export function parseProgram(src: string): StmtNode[] {
  return new Parser(src).parse();
}
