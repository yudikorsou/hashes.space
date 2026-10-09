# hashes.space

**Dashboard for local proof-of-work mining setups with visualization of bit, byte and hex communication.**

Connect your ASIC miners on a local network, run the backend on a computer in that network and watch what normally stays invisible:

- **Miners find each other on the network:** *Find ASIC* scans the local network and lists every ASIC that answers, like a network discovery tool; *Find CPUs* does the same for CPU mining rigs (XMRig).
- **A computer talks to a miner:** the dashboard asks each miner over its API (port 4028) how fast it hashes, how hot it runs and which pool it works for.
- **Proof of work becomes visible:** every share a miner submits flies from its fan into the block being mined, as a string of 0s and 1s. The leading zeros are the proof of work: harder shares carry more zeros.
- **Right or wrong setup shows at a glance:** a miner's fan only spins when it is configured correctly and its shares really reach the node. A wrong pool, a wrong port or the wrong blockchain stops it, with a plain-language reason.
- **The blockchain keeps moving:** a mempool-style strip shows the blocks being mined live, from mempool.space, litecoinspace.org, mempool.guide or your own node.
- **CPU mining too:** Monero (RandomX) with blocks from xmrchain.net, and CPU miners running [XMRig](https://github.com/xmrig/xmrig). A CPU miner is shown as a processor chip with one square per thread instead of a fan, and as "16 cores · 32 threads" instead of an ASIC model: the class sees how many cores it keeps busy, and every mining thread lights up.
- **Bring your own firmware:** support for another miner firmware is one JavaScript file in [`backend/firmware/`](backend/firmware/README.md). See *Add your own mining firmware* below.

The page connects to **one miner at a time** by its IP address; *Generate fleet* shows several miners side by side.

- **Any proof of work.** hashes.space is not tied to one hash function. The networks it shows are listed in [`backend/networks.json`](backend/networks.json): it ships with **BLAKE2b** (Bitcoin BLAKE2b, mempool.guide) and **RandomX** (Monero, xmrchain.net), and you add others (SHA-256 from mempool.space, Scrypt from litecoinspace.org, kHeavyHash, …) with one entry each. Every miner has its own hash function, and it only counts as connected and hashing on a network of that same hash function. Demo miners: **Goldshell SC Box II** and **Goldshell SC Pro** (BLAKE2b), and two CPU miners running XMRig on Monero: an **AMD Ryzen 9 7950X** (16 cores, 32 threads) and a **Raspberry Pi 5** (4 cores).
- **Top:** a mempool-style blockchain strip with mempool's block colours. The data comes from any mempool.space-style explorer (mempool.space, litecoinspace.org, mempool.guide, a self-hosted mempool), a node's RPC, or **your own node**.
- **PoW dropdown** above the blockchain: one entry per network in `networks.json`, each with its hash function badge. **Connect your own node and Electrum server** adds "Your node", for the hash function you pick.
- **Below:** the connected miner, shown in one of **three modes** that the backend decides every time the miner reports in:

  | Mode | Colour | Fan | Shares |
  |---|---|---|---|
  | **Connected and hashing** | green | white, spinning | every share flies into the block being mined as a string of 0s and 1s |
  | **Hashing, not submitting shares** | orange | white, standing still | none reach your node (wrong pool, wrong port, …) |
  | **Not hashing, go to miner settings** | red (label links to settings) | white, stopped | none |

  A fan only starts spinning after you **Manage** the miner (log in on Find ASIC) and it is configured correctly. Until then every fan stands still, also on Find ASIC.

- **Miner settings (`/settings`):** a main pool and a failover pool (URL, worker, password) for the connected miner, like the configuration page of Bitmain or Goldshell firmware. "Use my node as main pool" fills in your node, and "Save & apply to miner" sends the pools to the miner.

```
ASIC rigs ──cgminer API (4028)──┐
XMRig CPU miners ──HTTP API─────┤
firmware ──POST /api/v1/telemetry┤
stratum / DATUM ──POST /api/v1/shares┤
                                 ▼
mempool WS(s)    ─┐    ┌──────────────────┐    WebSocket /ws?token=…    ┌──────────────────┐
xmrchain API     ─┤
node RPC         ─┼──▶ │ backend (Node+TS) │ ─────────────────────────▶ │ Angular frontend │
Electrum server  ┘    └──────────────────┘   chain · 1 miner · shares   └──────────────────┘
```

## Quick start

```bash
git clone https://github.com/yudikorsou/hashes.space.git
cd hashes.space
./start.sh          # demo miners, no hardware needed
./start.sh home     # your own miners (see "Your own miners" below)
```

Needs Node.js 20 or newer. The first start builds the backend and the web app; the browser then opens the dashboard. The single-file demo in `demo/hashes-space-live-demo.html` runs without any install.

## Layout

```
backend/                     Node.js + TypeScript (one runtime dependency: ws)
  src/networks.ts                 the networks from networks.json: any proof-of-work hash function
  src/sources/chain-hub.ts        one stream per network + each account's own node
  src/sources/mempool-source.ts   relays the mempool WebSocket (init + want blocks/mempool-blocks)
  src/sources/electrum-source.ts  Electrum server: tip, headers, fee histogram → projected blocks
  src/sources/own-source.ts       merges your node's RPC and Electrum into one stream
  src/sources/node-source.ts      node RPC (Core/Knots-style): getblocktemplate = the block being mined
  src/sources/simulated-source.ts offline chain for development
  src/miners/registry.ts          miners by IP + the three modes + share hashes
  src/miners/cgminer-poller.ts    polls Antminer/Braiins/Vnish/LuxOS/Avalon on TCP 4028
  src/miners/simulator.ts         demo miners .101–.104: Antminer S21 (SHA-256), Antminer L9 (Scrypt), SC Box II, SC Pro (BLAKE2b)
  src/miners/hashrate-history.ts  reported + submitted hashrate per miner (live, 1 h, 24 h), for the health chart
  src/miners/auth.ts              miner login: scrypt-hashed passwords, 12 h sessions, lockout after 5 wrong tries
  src/miners/scanner.ts           Find ASIC: finds every miner powered on in the local network (TCP 4028)
  src/miners/pool-writer.ts       "Save & apply": addpool / switchpool / removepool over the cgminer API
  src/sources/xmrchain-source.ts  Monero from xmrchain.net (or your own explorer): blocks, transaction pool, fees in nXMR/B
  src/miners/drivers.ts           per-brand drivers: what each can apply remotely (cgminer API included)
  src/miners/firmware-plugins.ts  loads firmware plugins from backend/firmware/ (read, settings, actions)
  firmware/                       one .js file per firmware: _example.js template, intminer.js (Goldshell), xmrig.js (CPU miners)
  src/settings-schema.ts          copy of the shared settings schema, used to validate
  src/ws-server.ts                tenant-scoped WebSocket push (shares batched every 150 ms)
  src/api.ts                      REST API for firmware, agents and the manufacturer
frontend/                    Angular 19 standalone components + TypeScript
  src/app/lib/share-stream-renderer.ts  canvas engine for the flying 0/1 streams
  src/app/components/fan.component.ts   SVG fan (frame still; the rotor only spins once you manage the miner (log in) and it is connected and hashing, speed follows the hashrate)
  src/app/components/chain-strip.*      3D block cubes, #mining-block target, pulse on hit
  src/app/components/network-bar.*      PoW dropdown (the networks / your node) + own node dialog
  src/app/pages/asic.page.ts            Find ASIC (route /asic): ASICs found in the local network + Generate fleet;
                                        Find CPUs (route /cpu): CPU rigs (XMRig), managed the same way
  src/app/pages/fleet.page.ts           fleet dashboard (route /fleet): every fleet miner as a tile, shares into the block
  src/app/components/fleet-stream.*     fleet share animation, scaled to the fleet size
  src/app/components/miner-login.*      "Log in to 192.168.1.101" on the dashboard (after Manage)
  src/app/components/login-settings.*   Miner settings → Login: change username and password
  src/app/lib/ip-list.ts                parses pasted IP lists and ranges for the fleet (shared with backend + demo)
  src/app/components/miner-panel.*      the connected miner in its mode
  src/app/components/hashrate-chart.*   Hashrate health: live / 1 h / 24 h chart of reported vs submitted hashrate
  src/app/lib/hashrate-health.ts        health rules + chart geometry (shared with the demo)
  src/app/components/share-stream.*     overlay that connects shares$ to the renderer
  src/app/pages/dashboard.page.*        the dashboard (route /)
  src/app/pages/miner-settings.page.*   Miner settings for the connected miner (route /settings)
  src/app/lib/status.ts                 status labels shared by both pages
  src/app/lib/settings-schema.ts        every miner setting: fields, defaults, checks (shared with backend + demo)
  src/app/components/settings-group.*   draws one settings section from the schema
  src/app/components/miner-actions.*    locate, reboot, turn off / on, factory reset
demo/fleet-dashboard-demo.html   standalone demo (same animation code, simulated miners)
demo/hashes-space-live-demo.html same demo as a normal page: open it in your browser for the live
                                 every network's stream (CHAIN_SOURCE=simulated for offline classrooms)
```

## Run it

```bash
# backend
cd backend
cp .env.example .env          # pick CHAIN_SOURCE=mempool | node | simulated
npm install
npm run build && npm start    # :8080, WebSocket at /ws?token=<tenant apiKey>

# frontend (dev, proxies /api and /ws to :8080)
cd ../frontend
npm install
npm start                     # http://localhost:4200/?token=demo-key, then connect to 192.168.1.101

# production: one process serves both
cd frontend && npm run build  # backend serves frontend/dist/frontend/browser automatically
```

### Chain sources

Each network in `networks.json` has its own `source`:

| `source` | Settings | "Mining now" block comes from |
|---|---|---|
| `mempool` | `wsUrl`, e.g. `wss://mempool.space/api/v1/ws` (any mempool.space-style explorer, or your own instance) | mempool's projected block 0 |
| `node` | `rpcUrl`, `rpcUser`/`rpcPassword` or `cookieFile` (default: `BITCOIN_RPC_*`) | `getblocktemplate` on **your** node: the exact template your miners or DATUM Gateway are working on |
| `xmrchain` | `apiUrl`, e.g. `https://xmrchain.net/api` (any [onion-monero-blockchain-explorer](https://github.com/moneroexamples/onion-monero-blockchain-explorer), or your own next to your monerod) | Monero's transaction pool, best fee per byte first, filled into blocks of the median block size |
| `simulated` | `blockSeconds` (optional) | made-up blocks, for chains without an explorer |

`CHAIN_SOURCE=simulated` makes every network simulated, for a classroom without internet.

## Tenants (manufacturers)

`backend/tenants.json` holds one entry per manufacturer. Each entry has a brand name, an accent colour, an API key, and `expectedPoolHosts`, the hosts a rig must point at to count as "connected to your node". Give each customer the link `https://your-host/?token=<apiKey>`. Everything is tenant-scoped: a page only receives its own account's miner and its shares.

## Miner settings: a general interface for any ASIC

The settings page covers what the web interfaces of Bitmain (Antminer), MicroBT (WhatsMiner), Goldshell, iBeLink and Canaan (Avalon) have in common: everything a miner needs to run.

| Section | Settings |
|---|---|
| **Pools** | Main pool + failover pool (URL, worker, password); the miner switches to the failover pool only if the main pool goes down; "Use my node as main pool" |
| **Miner** | name, hash function (any; the networks' ones first), rated hashrate, API port; the IP address identifies the miner |
| **Performance** | work mode: sleep, low power, normal, high performance or custom (power target W, chip frequency MHz, hashboard voltage V, autotuning) |
| **Cooling** | automatic (target chip temperature), fixed fan speed or immersion / hydro; fans required to hash; throttle and shutdown temperatures |
| **Network** | DHCP or static IP, subnet mask, gateway, DNS 1 and 2, hostname |
| **Security** | miner API access (read and write / read only / off) and allowed IPs, SSH, web interface password |
| **System** | time zone, time server (NTP) |
| **Maintenance** | find this miner (blink LED), reboot, **turn off** (hashboards and fans off, the control board stays reachable; the button then becomes **Turn on**), restore factory settings (reboot, turn off and factory reset ask for a confirmation on the page) |

- **One definition for everything:** `frontend/src/app/lib/settings-schema.ts` (a copy lives in `backend/src/settings-schema.ts`) defines every field, its default, its limits and its checks. The backend uses it to validate, and the Angular page and the demo use it to draw the forms, so all three always agree.
- **Save or Save & apply:** each section saves on its own. "Save & apply" also sends it to the miner.
- **Drivers** (`backend/src/miners/drivers.ts`): every brand's firmware has a different write API. A driver says which sections it can apply (`capabilities`), and each section on the page shows "Applies to the miner" or "Saved here only". The generic **cgminer API** driver can apply pools and restart the mining software. The **simulator** driver can do everything, so the whole page can be tried out. Add a driver per brand (Bitmain CGI, MicroBT API, Goldshell REST, LuxOS, Braiins OS, …) and pick it in `index.ts`.
- API: `PUT /api/v1/miners/:id/settings/:group` with `{values, apply}` and `POST /api/v1/miners/:id/actions/:action` (`locate`, `reboot`, `power-off`, `power-on`, `factory-reset`, `password`).
- The mode logic knows about the new states: a miner that is **rebooting**, **turned off** or in **sleep mode** shows as "Not hashing" with that reason.

## Networks: any proof-of-work hash function

`backend/networks.json` (or the file in `NETWORKS_FILE`) lists the networks the PoW dropdown offers:

```json
[
  { "id": "sha256", "algo": "sha256", "label": "SHA-256", "chain": "Bitcoin", "ticker": "BTC",
    "source": "mempool", "wsUrl": "wss://mempool.space/api/v1/ws", "sourceLabel": "mempool.space", "explorer": "https://mempool.space/block/" },
  { "id": "kaspa", "algo": "kheavyhash", "label": "kHeavyHash", "chain": "Kaspa", "ticker": "KAS",
    "source": "simulated", "blockSeconds": 1 }
]
```

| Field | Meaning |
|---|---|
| `id` | unique id of the network (`own` is reserved for "Your node") |
| `algo` | the hash function, e.g. `sha256`, `scrypt`, `blake2b`, `kheavyhash`, `equihash`, `randomx` |
| `label`, `chain`, `ticker` | how the page writes it: "SHA-256", "Bitcoin", "BTC" |
| `source` | `mempool`, `node` or `simulated` (see *Chain sources*) |

- The first network is where a page starts, and the hash function of miners that don't set one (`DEFAULT_ALGO` overrides it). `GET /api/v1/algorithms` lists every hash function a miner can be set to.
- **One hash function only:** a `networks.json` with a single entry gives a single-algorithm dashboard, e.g. only BLAKE2b with mempool.guide.
- **Your node:** `PUT /api/v1/own-node` with `{algo, rpcUrl, rpcUser, rpcPassword, electrumHost, electrumPort, electrumTls}`; the page asks which hash function your node's chain uses. The server **tests** the node (`getblockchaininfo`, `getnetworkinfo`, and it recognises Core- and Knots-based nodes) and the Electrum server (`server.version`, `blockchain.headers.subscribe`) before it saves anything, and says what's wrong if either fails (refused, no answer, wrong password).
  - Node RPC gives the mined blocks with full detail and **the block being mined from your node's own `getblocktemplate`**, which is the template your miners get.
  - Electrum adds the later projected blocks from `mempool.get_fee_histogram` and new blocks the moment they arrive. With Electrum only, mined blocks show height and time only.
  - The RPC password stays on the server and is never sent back to the page.
- Security: this feature makes the server connect to addresses users type in. On a public server, put it behind an allowlist or VPN, or turn it off with `ALLOW_OWN_NODE=false`.
- **Miners:** every miner has a hash function (Miner settings → Miner). Each page picks a stream with `{"type":"network","id":"<network id>"|"own"}`; the choice is remembered in the browser.

## Hashrate health

Under the connected miner, a chart shows two lines, like the hashrate graph on a miner's own manage page:

- **Reported:** the hashrate the miner says it runs at.
- **Submitted to your node:** the hashrate proven by the shares that actually reached your node: sum of share difficulty × 2^32 ÷ seconds, averaged over a sliding window (1 min in Live, 5 min for 1 hour, 10 min for 24 hours). A miner pointed at the wrong pool or port shows a healthy reported line and a flat submitted line.

Ranges: **Live** (last 5 minutes, 10-second points, refreshed every 3 s, pulsing dot on the newest reading), **1 hour** (30-second points) and **24 hours** (10-minute points), with a line at the rated hashrate. Hover or use the arrow keys for both values at any time.

The badge sums it up, using the same rules in the app and the demo (`lib/hashrate-health.ts`):

| Badge | When |
|---|---|
| Healthy | average at least 95 % of rated, no drops, no gaps, and its hashrate reaches your node |
| Below rated | steady, but averaging 80–95 % of rated |
| Unstable | drops below 80 % of rated, or time without a reading (miner off or unreachable) |
| Not reaching your node | submitted is under half of reported: check the pool |
| Low hashrate | averaging under 80 % of rated |
| Not hashing | the miner reports 0 hashrate right now |

Data: `GET /api/v1/miners/:id/hashrate?range=live|1h|24h` returns `[time, reported, submitted]` points. Every reading (poller, telemetry push or simulator) and every accepted share is recorded; shares from the poller are credited with the pool difficulty × the accepted-share count since the last poll. History lives in memory, so move it to a time-series database for production. The demo miners start with a day of history (Rig 01 had a power cut and a dip, Rig 02 never reaches your node, Rig 03 lost its pool 3 hours ago).

## Find ASIC: pick a miner from your local network

There is no IP address field. Before connecting, you visit **Find ASIC** (route `/asic`, also the start page when no miner was connected before, or when the site is opened as `asic.<your domain>`). It lists every miner that is powered on in your local network with its IP, model and pool, and a blue **Manage** button that connects the page to that miner. Every row is clickable: click a miner's box and the dashboard shows that miner (after its login). The box of the miner the dashboard shows is outlined in cyan. Once you're logged in, the row shows its status bar (**Connected**, **Not submitting** or **Not hashing**) and a blue **Manage** button that opens its Miner settings.

- The scan runs in the backend: `GET /api/v1/scan` (add `?refresh=1` for a new scan; results are reused for 15 s). For each private /24 network of the computer it runs on, it tries TCP port 4028 (the cgminer-compatible API of Antminer, Whatsminer, Avalon, Braiins, Vnish, LuxOS and most others) on every address, then asks the ones that answer for `version`, `summary`, `pools` and `stats`.
- **The backend must run on a computer in the same local network as the miners.** A web browser can't scan a local network, and a cloud server can't see it. For a hosted hashes.space, run the backend (or a small agent with the same scanner) on a machine at the mining site.
- Miners in another subnet: `SCAN_SUBNETS=192.168.2,10.0.5` (extra /24 networks). Other API port: `SCAN_PORT`. Turn the scan off: `ALLOW_SCAN=false`.
- In demo mode the four demo miners (192.168.1.101–104) always show up as powered on.

## Miner login

Every miner is protected by its own username and password, so nobody else on the network (or with the dashboard link) can open it and change its pool or settings.

- **Manage** on Find ASIC takes you to the dashboard, which first asks for that miner's login. New miners have the default login **admin / 123456789**, shown in the fields so you can log in right away, with a reminder to change it. While a miner still has the default login, the dashboard shows a "Default login" warning.
- Every miner you're logged in to shows a green **Connected** button on Find ASIC and in the fleet (click it, or anywhere on the box, to show that miner on the dashboard) and a **Manage** button for its Miner settings. **Miner settings → Login → Log out of this miner** ends that login. The dashboard itself still shows one miner at a time.
- Change the login under **Miner settings → Login** (current password required; at least 8 characters, not the default). Where the firmware allows, the new password is also set on the miner's own web page. Other devices logged in to that miner are signed out. **Restore factory settings** sets the login back to admin / 123456789.
- Security: passwords are stored as salted scrypt hashes and never sent to the page; a correct login gives a 12-hour session token for that one miner (`x-miner-session` header, and in the WebSocket `watch` message). Without it the backend refuses to open the miner (`login-required`) and refuses changes (401). Five wrong passwords in five minutes lock that miner's login for a minute. A changed username is never shown in the login form.
- API: `POST /api/v1/miners/:id/login {username, password}` → `{token, expiresAt}`, `POST /api/v1/miners/:id/logout`, `PUT /api/v1/miners/:id/login {username, currentPassword, newPassword}`, `POST /api/v1/sessions {tokens}` (which are still valid). Logins live in memory, like the rest of the registry: move them to your database for production, and serve the dashboard over HTTPS so passwords and tokens are never sent in the clear.

## Generate fleet and the fleet dashboard

Under Find ASIC, **Generate fleet** takes a pasted list of IP addresses and makes a **fleet dashboard** (`/fleet`, "Fleet" in the header) with all those miners, including miners in another subnet that the scan can't see.

- Separate addresses with commas, spaces, semicolons or new lines. Ranges work too: `192.168.1.110-120` or `192.168.1.110-192.168.1.120` (within one x.x.x.0–255 block). `:4028` ports and `http://` are ignored. The page checks the list as you type ("4 addresses ready · 1 given twice · not an IP: banana"); at most 512 per Generate.
- **Only set-up miners join a fleet.** Every listed miner must first be managed on Find ASIC: click **Manage**, log in, and configure it until it is **Connected and hashing** (submitting accepted shares to your node, on the right port and blockchain). Under the IP box, a checklist shows each miner's step: **1 Log in first**, **2 Set it up** (with the reason, e.g. "No pool is set up on this miner"), or **✓ Ready**, each with a Manage button. **Generate** stays disabled until every listed miner is ready, and the backend checks again (`POST /api/v1/fleet` answers 409 with the checks otherwise). The pasted list is kept while you go and Manage the miners.
- "Use the N found miners" puts every miner the scan found into the box. **Generate** adds them and opens the fleet dashboard.
- **Fleet dashboard:** the blockchain on top, a summary (per mode, and the hashrate per hash function of the miners that are connected and hashing), then one tile per miner with its own fan, mode (Connected / Not submitting / Not hashing), hashrate and a Manage link (which asks for that miner's login). Every share a fleet miner submits flies from its tile's fan into the block being mined.
- **Clean at any size:** the animation scales with the fleet. Bigger fleets get smaller glyphs, shorter strings and denser tiles; each miner launches at most one string every so often, and the whole fleet only a few per second. Shares without their own string still count: the block pulses for each one.
- The list on Find ASIC still manages the fleet (rename, ✕ to remove). The fleet overview is visible with the account link; opening or changing a miner needs its login.
- API: `GET /api/v1/fleet`, `POST /api/v1/fleet/check {ips, sessions}` → per miner `login | setup | ready`, `POST /api/v1/fleet {ips, name?, sessions}` → `{added, already, invalid, duplicates, fleet}` (409 + checks when a miner isn't ready), `PUT /api/v1/fleet {name}`, `DELETE /api/v1/fleet/:ip`. WebSocket: `{"type":"watch-fleet"}` makes the server push `fleet-miners` (updates) and `fleet-shares` (at most 80 per 150 ms batch) for every fleet miner. The IP parser is shared: `frontend/src/app/lib/ip-list.ts` (copy in `backend/src/miners/ip-list.ts`). Fleets live in memory, like the rest of the registry.

## One miner per page, identified by its IP address

- The page sends `{"type":"watch","host":"192.168.1.101"}` over the WebSocket. Connecting to another IP **replaces** the current miner; `{"type":"unwatch"}` disconnects. You can also open `/?miner=192.168.1.101`. The last IP is remembered in the browser.
- The server only sends that page the updates and shares of its own miner.
- The IP address is the miner's identity and **must be unique** on an account: registering or connecting a second miner on an IP that's already taken is refused.
- A new IP is registered the moment a page connects to it, and the backend reads it straight away (cgminer API on port 4028), picking up its model and pools.

## How the mode is decided

`MinerRegistry.evaluate()` in the backend runs every time the miner reports in (and every 5 s). **Connected and hashing** (green) is only shown when the miner is really hashing, sends its shares the right way, and does so for the right blockchain:

1. **Not hashing:** no answer within `MINER_OFFLINE_MS`, rebooting, turned off, in sleep mode, or it reports 0 hashrate (with no recent shares). The reason says which: "No response from 192.168.1.150", "No pool is set up on this miner" or "reports 0 hashrate".
2. **Hashing, not submitting shares**, when any of these is true:
   - its pool is someone else's (not one of `expectedPoolHosts`);
   - it points at your node's host, but on a port none of your nodes listens on;
   - your node rejects most of its latest shares (more than half of the last 10+), so check the worker name and password;
   - no accepted share reached your node within `MINER_IDLE_MS`.
3. **Connected and hashing:** everything above is fine. The reason reads e.g. "Hashing SHA-256 for Bitcoin, and your node accepts its shares."

**The network the miner is on.** The PoW dropdown also sets the network the connected miner is on (`miner.network`, via `MinerRegistry.setNetwork`), and the mode is re-evaluated straight away. A miner on a network of another hash function turns **Not hashing**: "A SHA-256 miner can't hash on the BLAKE2b network (Bitcoin BLAKE2b). Switch the network to SHA-256, or connect a BLAKE2b miner." A good moment in class to explain why a hash function and a blockchain belong together.

Your node is set in `tenants.json`, one per hash function: `"nodes": { "sha256": "stratum+tcp://datum.local:23334", "blake2b": "stratum+tcp://datum.local:23335" }`. A miner must point at the node for **its** hash function. Miner settings offers it under "Use my node as main pool". Shares sent anywhere else are not counted and don't fly into the block.

Each miner also carries a one-line `statusReason` that the page shows under the status.

Demo miners (`SIMULATE_MINERS=true`), three hash functions:

| IP | Miner | Hash function | Rated | Mode |
|---|---|---|---|---|
| 192.168.1.103 | Goldshell SC Box II | BLAKE2b | 1.4 TH/s | Not hashing (powered on, no pool set up) |
| 192.168.1.104 | Goldshell SC Pro | BLAKE2b | 11 TH/s | Connected and hashing |
| 192.168.1.105 | AMD Ryzen 9 7950X (XMRig, 16 cores / 32 threads) | RandomX | 22 kH/s | Connected and hashing |
| 192.168.1.106 | Raspberry Pi 5 (XMRig, 4 cores) | RandomX | 600 H/s | Hashing, not submitting shares (pool on the wrong port) |

Any other IP shows as not hashing, because nothing answers there.

**The bar after you log in.** On Find ASIC and in the fleet, every miner you logged in to (Manage → login) gets a bar that follows its mode, updated every few seconds: green **Connected** (connected and hashing), orange **Not submitting** (hashing, not submitting shares) or red **Not hashing**. Hover it for the reason; click it to open the miner. `GET /api/v1/scan` now includes each miner's `status` and `statusReason`.

## Miner settings and "Save & apply"

- `tenants.json` → `nodes` holds your node address per hash function; "Use my node as main pool" offers the one for the miner's hash function.
- **Save** stores the pools in the backend. **Save & apply to miner** also sends them to the miner at its IP address and API port:
  `addpool` for each pool, `switchpool` to the new Pool 1, then `removepool` for the old ones.
- These are privileged cgminer API commands. Braiins OS, Vnish, LuxOS and cgminer builds started with `--api-allow W:<dashboard-ip>` accept them. Bitmain and Goldshell stock firmware usually keep the API read-only; the page then shows that the rig refused the change, and the owner enters the same pools on the rig's own web page. A driver for Bitmain's web API (`/cgi-bin/set_miner_conf.cgi`) can be added next to `pool-writer.ts`.
- Saved pools live in memory, like the rest of the registry. Move them to your database for production.

## Feeding in miner data (use any combination)

1. **Polling (no firmware change).** Connect to the miner's IP on the page, or list miners up front in `miners.json` (see `miners.example.json`). The poller reads `summary`, `pools` and `stats`, and turns every increase in the accepted-share counter into share events.
2. **Firmware push.** Firmware can send `POST /api/v1/telemetry` with header `x-api-key` and body `{ minerId, poolUrl, hashrateThs, nominalThs, fanRpm, temperatureC }`.
3. **Pool-side shares (most accurate).** Your stratum server, DATUM Gateway or ckpool log can send `POST /api/v1/shares` with `{ minerId, difficulty, hash?, accepted? }` or a batch array. With this source a share only appears after it has really reached your node's template. If you send the real 64-hex share `hash`, the dashboard shows its actual bits.

## The animation

- The **fan** is inline SVG. The frame and four mounting holes stay still. The rotor (5 blades and a pentagon hub) turns with a CSS `rotate` animation, and its duration is `0.55 s × nominal / actual hashrate`.
- **Share streams** use one full-screen `<canvas>` with `pointer-events: none`, driven outside Angular's zone.
  - Each share is drawn along a cubic Bézier curve from the rig's fan (`[data-fan="<id>"]`) to `#mining-block`.
  - The bits shown are the share hash itself: its **leading zeros**, the proof of work, stay fixed, and the bits after the first `1` flicker.
  - A share at difficulty D has about 32 + log₂D leading zero bits. When firmware does not report the real hash, one with that property is generated.
  - The head glyph glows and the tail fades. Rejected shares turn red and crumble halfway. Lucky shares (at least 16× the rig's usual difficulty) get an orange head.
  - When a stream lands, the block pulses and its "your shares" counter goes up.
- `prefers-reduced-motion` turns all motion off, and nothing is queued while the tab is hidden.

## Production checklist

- Swap the in-memory registry for Postgres or Redis. Hash the API keys and give dashboard viewers read-only tokens separate from the firmware keys.
- Put the backend behind TLS (nginx or Caddy) so the frontend connects over `wss://`.
- Whatsminer uses a token-based API; add a driver next to `cgminer-poller.ts`.


## CPU miners: XMRig and Monero

[XMRig](https://github.com/xmrig/xmrig) mines Monero (RandomX) on an ordinary computer. It has no cgminer API, so the dashboard reads its **HTTP API** through the firmware plugin [`backend/firmware/xmrig.js`](backend/firmware/xmrig.js). Turn the API on in XMRig's `config.json`:

```json
"http": { "enabled": true, "host": "0.0.0.0", "port": 18088, "access-token": "a-long-random-token", "restricted": false }
```

- **Token:** give the backend the same token: `XMRIG_ACCESS_TOKEN=a-long-random-token` (one for all rigs), or per IP: `XMRIG_TOKENS='{"192.168.1.40":"token"}'`.
- **Find CPUs** (route `/cpu`, "Find CPUs" in the header) lists the XMRig rigs the scan finds on the ports in `SCAN_XMRIG_PORTS` (default `18088`), registered with the XMRig plugin. It works exactly like Find ASIC: every row is clickable, **Manage** asks for the rig's login, then shows the **Connected** / **Not submitting** / **Not hashing** bar and a **Manage** button for its Miner settings (pools, Turn off / Turn on = pause / resume). Find ASIC lists only the ASICs. To put CPU rigs in a fleet, add their IPs under Generate fleet on Find ASIC. Or add a rig to `miners.json`: `{ "id": "home:192.168.1.40", "tenantId": "home", "host": "192.168.1.40", "port": 18088, "firmware": "XMRig", "algo": "randomx" }`.
- **What the dashboard reads** (`GET /2/summary`): hashrate (10 s), accepted and rejected shares, the pool, the share difficulty, and the processor: model, cores, threads and how many threads mine.
- **What it can change** (`restricted: false`): the pools (`PUT /1/config`), and **Turn off / Turn on** under Maintenance, which pause and resume XMRig (`POST /json_rpc`).
- **How it looks:** instead of a fan, a processor chip with one square per hardware thread. Squares light up for every thread XMRig runs on, and pulse only while the miner is connected and hashing. Find ASIC, the fleet and the dashboard show "16 cores · 32 threads" instead of an ASIC model, and the dashboard adds **Mining threads** and the hashrate **per thread**. Set the work mode to *Low power* in the demo and fewer cores light up.
- **Your node:** a Monero miner needs your RandomX node, e.g. P2Pool: `"nodes": { "randomx": "stratum+tcp://192.168.1.10:3333" }` in `tenants.json`.
- **Units:** hashrates go down to H/s; Monero fees are shown in nXMR/B (nanonero per byte) and coloured by how many times the base fee they pay.

## Your own miners

`backend/tenants.example-home.json` and `backend/miners.example-home.json` show how to connect the backend to real miners on your network. Copy them to `tenants.home.json` / `miners.home.json` (ignored by git) and fill in your own IP addresses:

- A node that takes shares on several ports gets a list: `"nodes": { "blake2b": ["stratum+tcp://192.168.1.10:23340", "stratum+tcp://192.168.1.10:23339"] }`. A miner pointed at any of them counts as connected to your node.
- Start the backend with `TENANTS_FILE=tenants.home.json MINERS_FILE=miners.home.json SIMULATE_MINERS=false node dist/index.js` and open `http://localhost:8080/asic?token=<your api key>`.

## Add your own mining firmware

Every miner firmware talks a little differently. The backend reads any miner that speaks the standard **cgminer API** (TCP 4028); for everything else, add a **firmware plugin**: one `.js` file in `backend/firmware/`, no build step, no dependencies.

```js
// backend/firmware/my-firmware.js
module.exports = {
  name: 'My firmware',
  match: (miner) => /myfirmware/i.test(miner.firmwareVersion || ''),
  capabilities: { pools: true, reboot: true },
  async read(miner, tools) {
    const s = await (await tools.fetch(`http://${miner.host}/api/status`)).json();
    return { hashrateThs: s.hashrate / 1e12, sharesAccepted: s.accepted, shareDifficulty: s.difficulty, poolUrl: s.pool, temperatureC: s.temp };
  },
};
```

Restart the backend and the plugin is loaded (`GET /api/v1/firmware` lists what loaded and why a file was skipped). The full guide with every hook is in [`backend/firmware/README.md`](backend/firmware/README.md); [`_example.js`](backend/firmware/_example.js) is a commented template and [`intminer.js`](backend/firmware/intminer.js) a working plugin for Goldshell miners on intminer firmware.

## License and credits

hashes.space is free software under the **GNU Affero General Public License v3.0** ([LICENSE](LICENSE)). If you run a modified version for others over a network, you must offer them its source code.

The blockchain strip builds on the visual language of **[The Mempool Open Source Project®](https://github.com/mempool/mempool)** (AGPL-3.0): the 3D block style, the projected and mined block colours and the fee-rate colour scale. Block data comes from mempool-compatible explorers through their public WebSocket API. Thank you to the mempool contributors.

hashes.space is an independent project and is not affiliated with or endorsed by Mempool Holdings S.A. de C.V. mempool.space® and the mempool logos are trademarks of Mempool Holdings; they are used here only to name the data sources.


## Find Mempool page and themes

[`demo/mempool.html`](demo/mempool.html) is a stand-alone page with only the blockchain: pick **Bitcoin BLAKE2b** or **Monero** and watch the mempool and the last blocks, with mining pools and hashrate & difficulty from mempool.guide under the blocks (BLAKE2b).

**Themes** (top right) changes the background. **Space**, a slow starfield, is the default; **Plain** is the dark background without animation. Add your own theme in a `<script>` after the page's scripts:

```js
HashesThemes.register({
  id: 'aurora', label: 'Aurora', note: 'Green northern lights',
  swatch: '#0b2a2a',          // the colour dot in the Themes menu
  background: '#05100f',      // page colour behind the animation
  setup(ctx, width, height) { // draw on a full-page canvas behind everything
    return { frame(dt, t) { /* draw one frame; dt and t in seconds */ } };
  },
});
```

The visitor's choice is remembered in their browser, and visitors who ask their device to reduce motion get a still frame.

## DATUM Compatible and DATUM Verified blocks

Mined blocks of pools that work with [DATUM Gateway](https://github.com/OCEAN-xyz/datum_gateway) glow:

- **DATUM Compatible** (orange glow): a pool that accepts miners with their own node and DATUM Gateway. For now **OCEAN** on Bitcoin SHA-256 and **CONVOY** on Bitcoin BLAKE2b, set per network in `networks.json` with `"datumPools"`.
- **DATUM Verified** (green glow): only DATUM Gateway verified solominers of 100% DATUM pools, listed per network in `networks.json` with `"datumVerified"` (pool or miner names as mempool shows them). None are listed yet.

Other blocks, and Monero blocks, get neither.
