// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — server-side WebSocket + REST transport
//
// Node 24 / Bun both expose a WHATWG WebSocket global, so no external ws
// dependency is required. Text frames arrive as strings; binary frames are
// coerced to text defensively.
// ─────────────────────────────────────────────────────────────────────────────

export interface SocketHandlers {
  open: () => void;
  text: (data: string) => void;
  close: () => void;
  error?: (err: unknown) => void;
}

export interface SocketHandle {
  send(data: string): void;
  close(): void;
}

async function toText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data && typeof (data as Blob).text === 'function') return await (data as Blob).text();
  return String(data);
}

/**
 * Open a WebSocket using the runtime's native global. Returns a handle; the
 * caller owns reconnection policy (adapters implement their own backoff).
 */
export function openSocket(url: string, handlers: SocketHandlers): SocketHandle {
  const WS = (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) {
    handlers.error?.(new Error('No WebSocket global in this runtime'));
    handlers.close();
    return { send: () => undefined, close: () => undefined };
  }
  const ws = new WS(url);
  ws.onopen = () => handlers.open();
  ws.onmessage = async (ev: MessageEvent) => {
    try {
      handlers.text(await toText(ev.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  ws.onerror = () => handlers.error?.(new Error(`ws error: ${url}`));
  ws.onclose = () => handlers.close();
  return {
    send: (data: string) => {
      if (ws.readyState === 1) {
        try {
          ws.send(data);
        } catch {
          /* socket closing mid-send */
        }
      }
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** JSON fetch with a timeout; null on any failure (callers poll again). */
export async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Parse an exchange numeric field; undefined when missing/not finite. */
export function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
