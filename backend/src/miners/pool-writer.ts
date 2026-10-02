import { cgminerCommand } from './cgminer-poller';
import { PoolConfig } from '../types';

export interface ApplyResult {
  ok: boolean;
  message: string;
}

/**
 * Pushes pool settings to a rig through the cgminer-compatible API (TCP 4028),
 * the same way the "Save & Apply" button on a Bitmain / Goldshell page does.
 *
 *   addpool   url,user,pass   – for each new pool
 *   switchpool N              – make the new primary active
 *   removepool N              – drop the old pools (highest index first)
 *
 * These are privileged commands. Braiins OS, Vnish, LuxOS and cgminer builds
 * started with --api-allow W:<dashboard-ip> accept them. Bitmain / Goldshell
 * stock firmware usually keeps the API read-only and only accepts changes
 * through its own web page; the result message says so when the rig refuses.
 */
export async function applyPoolsToRig(host: string, port: number, pools: PoolConfig[]): Promise<ApplyResult> {
  if (!pools.length) return { ok: false, message: 'Add at least one pool before applying.' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before: any = await cgminerCommand(host, port, 'pools');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldIndexes: number[] = (before?.POOLS ?? []).map((p: any) => Number(p.POOL));

    for (const p of pools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await cgminerRaw(host, port, 'addpool', `${esc(p.url)},${esc(p.user)},${esc(p.pass)}`);
      if (r?.STATUS?.[0]?.STATUS === 'E') return refused(r.STATUS[0].Msg);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after: any = await cgminerCommand(host, port, 'pools');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const primary = (after?.POOLS ?? []).find((p: any) => !oldIndexes.includes(Number(p.POOL)) && p.URL === pools[0].url);
    if (primary) await cgminerRaw(host, port, 'switchpool', String(primary.POOL));

    for (const i of [...oldIndexes].sort((a, b) => b - a)) await cgminerRaw(host, port, 'removepool', String(i));

    return { ok: true, message: `Applied to ${host}. The rig switches to ${pools[0].url} within a few seconds.` };
  } catch (e) {
    return { ok: false, message: `Could not reach ${host}:${port} (${(e as Error).message}). Settings are saved; check the IP address and that the rig is on.` };
  }
}

function refused(msg?: string): ApplyResult {
  return {
    ok: false,
    message: `The rig refused the change${msg ? ` ("${msg}")` : ''}. Settings are saved. Its API is probably read-only: enable API write access in the firmware, or enter the same pools on the rig's own web page.`,
  };
}

/** cgminer uses "," as separator inside the parameter; escape it (and backslashes) per the API spec. */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

function cgminerRaw(host: string, port: number, command: string, parameter: string): Promise<unknown> {
  return cgminerCommand(host, port, JSON.stringify({ command, parameter }), 4000, true);
}
