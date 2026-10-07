// XMRig: CPU (and GPU) miner for RandomX (Monero) and other algorithms. https://github.com/xmrig/xmrig
//
// XMRig has no cgminer API; it has an HTTP API. Turn it on in the miner's config.json:
//
//   "http": { "enabled": true, "host": "0.0.0.0", "port": 18088,
//             "access-token": "a-long-random-token", "restricted": false }
//
// - port: the dashboard's default is 18088; put the port in miners.json ("port": 18088) or SCAN_XMRIG_PORTS.
// - access-token: give the backend the same token in XMRIG_ACCESS_TOKEN (one for all rigs), or per IP in
//   XMRIG_TOKENS='{"192.168.1.40":"token"}'.
// - restricted: false lets the dashboard pause / resume the miner and change its pool. Keep a token set then.
//
// The dashboard shows a CPU miner by its processor and cores instead of an ASIC model, and lights up one
// core for every thread the miner runs on.

const ALGO = (a) => {
  const s = String(a || '').toLowerCase();
  if (s.startsWith('rx/')) return 'randomx';
  if (s.startsWith('cn')) return 'cryptonight';
  if (s.startsWith('kawpow')) return 'kawpow';
  if (s.startsWith('ghostrider')) return 'ghostrider';
  return undefined;
};

function token(miner) {
  try {
    const map = JSON.parse(process.env.XMRIG_TOKENS || '{}');
    if (map[miner.host]) return map[miner.host];
  } catch {
    /* ignore a broken XMRIG_TOKENS */
  }
  return process.env.XMRIG_ACCESS_TOKEN || '';
}

async function call(miner, tools, path, init = {}) {
  const t = token(miner);
  const res = await tools.fetch(`http://${miner.host}:${miner.port || 18088}${path}`, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(t && { authorization: `Bearer ${t}` }), ...(init.headers || {}) },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(t ? 'XMRig refused the access token. Check XMRIG_ACCESS_TOKEN.' : 'XMRig needs its access token. Set XMRIG_ACCESS_TOKEN on the backend.');
  }
  if (!res.ok) throw new Error(`XMRig answered HTTP ${res.status}${res.status === 404 ? ' (is the HTTP API on and restricted set to false?)' : ''}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** turn an XMRig summary into the dashboard's reading */
function reading(s) {
  const hr = s.hashrate || {};
  const hs = Number((hr.total || [])[0] ?? (hr.total || [])[1] ?? 0) || 0; // 10 s, then 60 s average, H/s
  const conn = s.connection || {};
  const res = s.results || {};
  const cpu = s.cpu || {};
  const threads = Array.isArray(hr.threads) ? hr.threads : [];
  const pool = conn.pool ? `${conn.tls ? 'stratum+ssl' : 'stratum+tcp'}://${conn.pool}` : undefined;
  const diff = Number(conn.diff ?? res.diff_current ?? 0) || 0;
  return {
    hashrateThs: s.paused ? 0 : hs / 1e12,
    sharesAccepted: Number(conn.accepted ?? res.shares_good ?? 0),
    sharesRejected: Number(conn.rejected ?? Math.max(0, Number(res.shares_total ?? 0) - Number(res.shares_good ?? 0))),
    // XMRig counts difficulty in hashes; the dashboard in Bitcoin units of 2^32 hashes
    shareDifficulty: diff / 2 ** 32,
    poolUrl: pool,
    pools: pool ? [{ url: pool, user: String(s.worker_id || '') }] : undefined,
    kind: 'cpu',
    model: cpu.brand ? String(cpu.brand).replace(/\s+/g, ' ').trim() : 'CPU miner',
    firmwareVersion: `XMRig ${s.version || ''}`.trim(),
    cpu: {
      brand: String(cpu.brand || 'CPU').replace(/\s+/g, ' ').trim(),
      cores: Number(cpu.cores) || threads.length || 1,
      threads: Number(cpu.threads) || Number(cpu.cores) || threads.length || 1,
      miningThreads: s.paused ? 0 : threads.length,
      threadHashrates: threads.map((t) => Number((t || [])[0] ?? 0) || 0),
    },
    algo: ALGO(s.algo || conn.algo),
    paused: !!s.paused,
  };
}

module.exports = {
  name: 'XMRig',

  match: (miner) => /xmrig/i.test(miner.firmwareVersion || '') || miner.kind === 'cpu',

  // XMRig can change its pool and pause / resume over its HTTP API (restricted: false)
  capabilities: { pools: true, 'power-off': true, 'power-on': true },

  async read(miner, tools) {
    let s;
    try {
      s = await call(miner, tools, '/2/summary');
    } catch (e) {
      if (/HTTP 404/.test(e.message)) s = await call(miner, tools, '/1/summary'); // XMRig 5 and older
      else throw e;
    }
    return reading(s);
  },

  async applySettings(miner, group, tools) {
    if (group !== 'pools') return { ok: false, message: `Saved. XMRig sets ${group} in its own config.json; change it there.` };
    const pools = (miner.pools || []).filter((p) => p.url);
    if (!pools.length) return { ok: false, message: 'Add at least one pool before applying.' };
    try {
      const cfg = await call(miner, tools, '/1/config');
      cfg.pools = pools.map((p, i) => ({
        ...((cfg.pools || [])[i] || {}),
        url: p.url.replace(/^stratum\+(tcp|ssl|tls):\/\//i, ''),
        tls: /^stratum\+(ssl|tls):\/\//i.test(p.url),
        user: p.user,
        pass: p.pass || 'x',
        enabled: true,
      }));
      await call(miner, tools, '/1/config', { method: 'PUT', body: JSON.stringify(cfg) });
      return { ok: true, message: `Applied. XMRig now mines on ${pools[0].url.replace(/^stratum\+(tcp|ssl|tls):\/\//i, '')}${pools[1] ? ', with a failover pool' : ''}.` };
    } catch (e) {
      return { ok: false, message: `${e.message} Pools are saved here; set them in XMRig's config.json too.` };
    }
  },

  async runAction(miner, action, payload, tools) {
    const method = action === 'power-off' ? 'pause' : action === 'power-on' ? 'resume' : null;
    if (!method) return { ok: false, message: `XMRig can't ${action} through its API.` };
    try {
      await call(miner, tools, '/json_rpc', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
      return { ok: true, message: method === 'pause' ? 'XMRig paused: all mining threads stopped. Turn it on to resume.' : 'XMRig resumed: the mining threads start again.' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  },

  // exported for the scanner and tests
  reading,
};
