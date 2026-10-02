// Template for a firmware plugin. Copy it to my-firmware.js (no "_" in front), change it, restart the backend.
// The backend loads every .js file in this folder whose name doesn't start with "_".
//
// Only `name` and `match` are required. Leave out read / applySettings / runAction and the backend uses the
// standard cgminer API (TCP 4028) for that part, which most mining firmware speaks.

module.exports = {
  // Shown on Miner settings. In miners.json you can also pick this plugin by name: "firmware": "My firmware".
  name: 'My firmware',

  // Which miners this plugin talks to. The miner has: host, port, model, firmwareVersion, name.
  match: (miner) => /myfirmware/i.test(miner.firmwareVersion || ''),

  // What the Miner settings page may change on these miners. The rest shows "Saved only".
  // Groups: pools, performance, cooling, network, security, system
  // Actions: locate, reboot, power-off, power-on, factory-reset, password
  capabilities: { pools: true, reboot: true },

  // Read the miner. Called every few seconds (MINER_POLL_MS). Return what you know; leave out what you don't.
  // `tools` has: cgminer(host, port, command), readCgminer(host, port), applyPoolsToRig(host, port, pools), fetch, log.
  async read(miner, tools) {
    // Example for firmware with its own HTTP API:
    //   const res = await tools.fetch(`http://${miner.host}/api/status`);
    //   const s = await res.json();
    //   return { hashrateThs: s.hashrate / 1e12, sharesAccepted: s.accepted, sharesRejected: s.rejected,
    //            shareDifficulty: s.difficulty, poolUrl: s.pool, temperatureC: s.temp, fanRpm: s.fan };
    return tools.readCgminer(miner.host, miner.port || 4028);
  },

  // "Save & apply" on Miner settings. group is 'pools' or a settings group; the values are on the miner:
  // miner.pools = [{ url, user, pass }], miner.settings.performance / cooling / network / security / system.
  async applySettings(miner, group, tools) {
    if (group === 'pools') return tools.applyPoolsToRig(miner.host, miner.port || 4028, miner.pools || []);
    return { ok: false, message: `Saved. This firmware can't change ${group} remotely yet.` };
  },

  // Maintenance buttons: locate, reboot, power-off, power-on, factory-reset.
  async runAction(miner, action, payload, tools) {
    if (action === 'reboot') {
      await tools.cgminer(miner.host, miner.port || 4028, 'restart');
      return { ok: true, message: 'The miner is restarting.' };
    }
    return { ok: false, message: `This firmware can't ${action} remotely yet.` };
  },
};
