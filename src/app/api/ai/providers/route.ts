// GET /api/ai/providers — desk AI backend + memory status (no secrets).
//
// Powers the copilot header badge: which backend answers (omniroute / GLM),
// which model, whether the failover layer is armed, how much conversation
// memory exists. Optionally probes the gateway's /v1/models (2.5s budget) so
// the user can verify an OmniRoute key actually works from the UI.

import { NextResponse } from 'next/server';
import { providerStatus } from '@/lib/ai/model-router';
import { memoryStats } from '@/lib/ai/memory/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ModelsReply {
  data?: Array<{ id?: string }>;
}

export async function GET() {
  const status = providerStatus();
  const memory = await memoryStats();

  let gatewayReachable: boolean | null = null;
  let gatewayModels: number | null = null;
  if (status.gateway) {
    // Each gateway tier authenticates with its own env key — never leak them.
    const gatewayKeyById: Record<string, string | undefined> = {
      omniroute: process.env.OMNIROUTE_API_KEY,
      respan: process.env.RESPAN_API_KEY,
      'openai-compat': process.env.OPENAI_COMPAT_API_KEY,
    };
    const bearer = gatewayKeyById[status.gateway.id] ?? '';
    try {
      const res = await fetch(`${status.gateway.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(2500),
      });
      gatewayReachable = res.ok;
      if (res.ok) {
        const json = (await res.json()) as ModelsReply;
        gatewayModels = Array.isArray(json.data) ? json.data.length : null;
      }
    } catch {
      gatewayReachable = false;
    }
  }

  return NextResponse.json(
    { ...status, gatewayReachable, gatewayModels, memory },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
