'use client';

// Lightweight markdown renderer for agent reports — terminal styled.
// Uses react-markdown with a component map (no typography plugin needed).

import ReactMarkdown from 'react-markdown';
import type { ReactNode } from 'react';

export function MarkdownLite({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div
      className={
        compact
          ? 'space-y-1.5 text-[11px] leading-relaxed text-zinc-300'
          : 'space-y-2.5 text-[12px] leading-relaxed text-zinc-300'
      }
    >
      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className="mt-3 border-b border-zinc-800/70 pb-1 text-sm font-bold tracking-tight text-teal-300">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3 text-[13px] font-semibold uppercase tracking-wide text-teal-300/90">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2 text-[12px] font-semibold text-amber-300/90">{children}</h3>
          ),
          p: ({ children }) => <p className="text-zinc-300">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
          em: ({ children }) => <em className="text-zinc-400">{children}</em>,
          ul: ({ children }) => <ul className="ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="text-zinc-300">{children}</li>,
          hr: () => <hr className="my-2 border-zinc-800" />,
          a: ({ children, href }) => (
            <a href={href} className="text-teal-400 underline decoration-teal-800" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-teal-800 pl-2 text-zinc-400">{children}</blockquote>
          ),
          code: ({ children, className }) =>
            className ? (
              <code className={`${className} block overflow-x-auto rounded-md bg-zinc-900/80 p-2 font-mono text-[10.5px] text-teal-200`}>
                {children}
              </code>
            ) : (
              <code className="rounded bg-zinc-900/80 px-1 py-0.5 font-mono text-[10.5px] text-amber-200">{children}</code>
            ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[11px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-zinc-700/70">{children}</thead>,
          th: ({ children }) => <th className="px-1.5 py-1 text-left font-semibold text-zinc-400">{children}</th>,
          td: ({ children }) => <td className="border-t border-zinc-800/60 px-1.5 py-1 font-mono text-zinc-300">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
