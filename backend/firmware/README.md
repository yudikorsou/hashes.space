# Firmware plugins

Add support for your own mining firmware with one JavaScript file in this folder.

The backend already reads every miner that speaks the **cgminer API** on TCP port 4028 (Bitmain, Braiins OS, Vnish, LuxOS, Goldshell intminer, iBeLink, Canaan and most others). A plugin is for firmware that talks differently, or to name miners and say what can be changed on them remotely.

## How it works

1. Copy [`_example.js`](_example.js) to a new file, for example `my-firmware.js`. Files starting with `_` are not loaded.
2. Fill in `name` and `match`, and only the hooks your firmware needs.
3. Restart the backend. It prints `[firmware] loaded My firmware (my-firmware.js)`, or why it skipped the file.
4. Check `GET /api/v1/firmware?token=<api key>` for the list of loaded plugins.

Another folder: set `FIRMWARE_DIR=/path/to/plugins`.

## The plugin

```js
module.exports = {
  name: 'My firmware',                         // required, shown on Miner settings
  match: (miner) => /myfw/i.test(miner.firmwareVersion || ''), // required
  capabilities: { pools: true, reboot: true },  // what Miner settings may change
  async read(miner, tools) { … },               // optional
  async applySettings(miner, group, tools) { … }, // optional
  async runAction(miner, action, payload, tools) { … }, // optional
};
```

| Part | What it does | Left out |
|---|---|---|
| `name` | The plugin's name. In `miners.json`, `"firmware": "My firmware"` forces this plugin for a miner. | required |
| `match(miner)` | `true` for the miners this plugin handles. The miner has `host`, `port`, `name`, `model`, `firmwareVersion`. The first plugin that matches wins. | required |
| `capabilities` | Which settings groups (`pools`, `performance`, `cooling`, `network`, `security`, `system`) and actions (`locate`, `reboot`, `power-off`, `power-on`, `factory-reset`, `password`) can be changed remotely. The page shows *Saved only* for the rest. | pools and reboot |
| `read(miner, tools)` | Reads the miner, every `MINER_POLL_MS` (5 s). Returns a reading, see below. | cgminer API |
| `applySettings(miner, group, tools)` | *Save & apply* on Miner settings. The new values are on `miner.pools` and `miner.settings[group]`. Returns `{ ok, message }`. | cgminer API (pools only) |
| `runAction(miner, action, payload, tools)` | The Maintenance buttons. Returns `{ ok, message }`. | cgminer API (reboot only) |

### The reading `read()` returns

```js
{
  hashrateThs: 11.2,          // required: what the miner hashes now, in TH/s
  sharesAccepted: 11371,      // total accepted shares; every increase flies into the block on the dashboard
  sharesRejected: 4,
  shareDifficulty: 16384,     // the pool's share difficulty, in Bitcoin units (1 = 2^32 hashes); divide a Monero pool's difficulty by 2^32
  poolUrl: 'stratum+tcp://192.168.1.10:23335', // the pool it works for now: decides "connected to your node"
  pools: [{ url, user }],     // the pools set on the miner
  temperatureC: 89,
  fanRpm: 3260,
  model: 'Goldshell SC Pro',
  firmwareVersion: 'myfw 1.2',
  // CPU miners: shown by their processor and cores instead of an ASIC model
  kind: 'cpu',
  cpu: { brand: 'AMD Ryzen 9 7950X', cores: 16, threads: 32, miningThreads: 32 },
  algo: 'randomx',   // the hash function the miner reports
  paused: false,
}
```

Leave out what your firmware doesn't report. `sharesAccepted` and `poolUrl` matter most: they decide whether the miner shows **Connected and hashing** and whether its shares fly on the dashboard.

### `tools`

Plugins need no dependencies. Every hook gets:

- `tools.cgminer(host, port, command)`: one cgminer API command, e.g. `'summary'`, `'pools'`, `'restart'`.
- `tools.readCgminer(host, port)`: a complete reading through the cgminer API, to start from and adjust.
- `tools.applyPoolsToRig(host, port, pools)`: write pools through the cgminer API.
- `tools.fetch(url, options)`: HTTP requests to the miner's own web API.
- `tools.log(...)`: log lines prefixed with the plugin's name.

## Safety

A plugin runs inside the backend with the same rights as the backend: it can reach your network and your files. Only install plugins you have read or trust. Miners are only changed through `applySettings` and `runAction`, which run when a logged-in user clicks *Save & apply* or a Maintenance button.

## Examples

- [`_example.js`](_example.js): the commented template.
- [`intminer.js`](intminer.js): Goldshell miners on intminer firmware. It names the miners and allows only reboot remotely, because stock intminer keeps its API read-only.
- [`xmrig.js`](xmrig.js): CPU miners running XMRig. It reads XMRig's HTTP API instead of the cgminer API, reports the processor's cores and threads (`kind: 'cpu'`, `cpu: {...}`), converts XMRig's share difficulty to Bitcoin units, and can pause, resume and change pools.

## Teaching with plugins

Writing a plugin is a small, real exercise in how computers talk to machines: open a TCP connection or an HTTP request, read the answer, and turn it into a few numbers the dashboard understands. Students can start from `_example.js`, print what the miner answers with `tools.log`, and watch their plugin's numbers appear on the dashboard.
