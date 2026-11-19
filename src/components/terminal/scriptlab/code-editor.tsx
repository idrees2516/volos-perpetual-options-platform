'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — CodeEditor. A dependency-free Pine-flavored code editor:
// textarea + syntax-highlight overlay (namespace calls, keywords, strings,
// numbers, comments) + line-number gutter, tab-indent, Ctrl/Cmd+Enter run.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef } from 'react';

const KEYWORDS = new Set(['if', 'else', 'var', 'and', 'or', 'not', 'true', 'false', 'na']);
const NAMESPACES = ['ta', 'math', 'input', 'strategy', 'color', 'plot', 'shape', 'location', 'hline'];

interface Token {
  text: string;
  cls: string;
}

/** Tokenize one line for highlighting — order matters. */
function highlightLine(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (text: string, cls: string) => {
    if (text) out.push({ text, cls });
  };
  while (i < line.length) {
    const rest = line.slice(i);
    // comments
    const cIdx = rest.indexOf('//');
    if (cIdx === 0) {
      push(line.slice(i), 'cmt');
      break;
    }
    // strings
    if (rest[0] === '"' || rest[0] === "'") {
      const q = rest[0];
      let j = 1;
      while (j < rest.length && rest[j] !== q) {
        if (rest[j] === '\\') j++;
        j++;
      }
      push(rest.slice(0, Math.min(j + 1, rest.length)), 'str');
      i += Math.min(j + 1, rest.length);
      continue;
    }
    // numbers
    const numMatch = rest.match(/^[0-9]+\.?[0-9]*(e[+-]?[0-9]+)?/i);
    if (numMatch) {
      push(numMatch[0], 'num');
      i += numMatch[0].length;
      continue;
    }
    // identifiers / dotted names
    const idMatch = rest.match(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/);
    if (idMatch) {
      const id = idMatch[0];
      if (KEYWORDS.has(id)) push(id, 'kw');
      else if (id.includes('.')) {
        const ns = id.split('.')[0];
        if (NAMESPACES.includes(ns)) push(id, 'ns');
        else push(id, 'id');
      } else push(id, 'id');
      i += id.length;
      continue;
    }
    // operators
    const opMatch = rest.match(/^(==|!=|<=|>=|:=|&&|\|\||[+\-*/%<>=!?:()\[\],])/);
    if (opMatch) {
      push(opMatch[0], 'op');
      i += opMatch[0].length;
      continue;
    }
    push(rest[0], 'id');
    i += 1;
  }
  return out;
}

const CLS: Record<string, string> = {
  cmt: 'text-zinc-600 italic',
  str: 'text-amber-300',
  num: 'text-sky-300',
  kw: 'text-violet-300 font-semibold',
  ns: 'text-teal-300',
  id: 'text-zinc-200',
  op: 'text-zinc-500',
};

interface Props {
  code: string;
  onChange: (code: string) => void;
  onRun?: () => void;
  errorLine?: number;
}

/** Read-only highlighted VolScript block (AI chat messages). */
export function CodeBlock({ code, maxH = 260 }: { code: string; maxH?: number }) {
  const lines = code.split('\n');
  return (
    <pre
      className="overflow-auto rounded-md border border-zinc-800 bg-[#07090d] px-3 py-2 font-mono text-[10px] leading-[17px] whitespace-pre"
      style={{ maxHeight: maxH }}
    >
      {lines.map((line, i) => (
        <div key={i} className="min-h-[17px]">
          {highlightLine(line).map((t, j) => (
            <span key={j} className={CLS[t.cls]}>
              {t.text}
            </span>
          ))}
        </div>
      ))}
    </pre>
  );
}

export function CodeEditor({ code, onChange, onRun, errorLine }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => code.split('\n'), [code]);
  const highlighted = useMemo(() => lines.map(highlightLine), [lines]);

  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  useEffect(() => {
    syncScroll();
  }, [code]);

  const jumpToError = () => {
    const ta = taRef.current;
    if (!ta || !errorLine) return;
    const pos = code.split('\n').slice(0, errorLine - 1).join('\n').length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const lineH = 19;
    ta.scrollTop = Math.max(0, (errorLine - 6) * lineH);
    syncScroll();
  };
  useEffect(() => {
    if (errorLine) jumpToError();
  }, [errorLine]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = `${code.slice(0, start)}    ${code.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 4;
      });
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onRun?.();
      return;
    }
    // auto-indent after if-blocks
    if (e.key === 'Enter' && !e.shiftKey) {
      const start = ta.selectionStart;
      const lineStart = code.lastIndexOf('\n', start - 1) + 1;
      const curLine = code.slice(lineStart, start);
      const indentMatch = curLine.match(/^(\s*)/);
      let indent = indentMatch ? indentMatch[1] : '';
      const isBlock = /\b(if|else)\b[^:]*$/.test(curLine.trim()) && !curLine.trim().startsWith('//');
      if (isBlock) indent += '    ';
      if (indent) {
        e.preventDefault();
        const end = ta.selectionEnd;
        const insert = `\n${indent}`;
        const next = `${code.slice(0, start)}${insert}${code.slice(end)}`;
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + insert.length;
        });
      }
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-zinc-800 bg-[#07090d]">
        {/* line numbers */}
        <div
          ref={gutterRef}
          aria-hidden
          className="w-10 shrink-0 overflow-hidden border-r border-zinc-800/80 bg-zinc-950/60 py-2 text-right font-mono text-[11px] leading-[19px] text-zinc-700 select-none"
        >
          {lines.map((_, i) => (
            <div
              key={i}
              className={`pr-2 ${errorLine === i + 1 ? 'rounded-sm bg-rose-950/60 text-rose-400' : ''}`}
            >
              {i + 1}
            </div>
          ))}
        </div>
        {/* code + highlight overlay */}
        <div className="relative min-w-0 flex-1">
          <pre
            ref={preRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-auto whitespace-pre px-3 py-2 font-mono text-[11px] leading-[19px]"
          >
            {highlighted.map((toks, i) => (
              <div key={i} className="min-h-[19px]">
                {toks.map((t, j) => (
                  <span key={j} className={CLS[t.cls]}>
                    {t.text}
                  </span>
                ))}
              </div>
            ))}
          </pre>
          <textarea
            ref={taRef}
            value={code}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onScroll={syncScroll}
            spellCheck={false}
            aria-label="VolScript code"
            className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre bg-transparent px-3 py-2 font-mono text-[11px] leading-[19px] text-transparent caret-teal-300 outline-none"
            style={{ tabSize: 4 }}
          />
        </div>
      </div>
    </div>
  );
}
