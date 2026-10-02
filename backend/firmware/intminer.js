// intminer firmware (Goldshell miners). Speaks the cgminer API on port 4028, read-only for pools on stock firmware.
// It reports no model "Type", no "MHS 5s" and its chip temperatures as tstemp-N under "devs";
// readCgminer already handles that, so this plugin only names the miners and says what they can do remotely.

module.exports = {
  name: 'intminer (Goldshell)',

  match: (miner) => /intminer/i.test(miner.firmwareVersion || '') || /intminer/i.test(miner.model || ''),

  // Stock intminer keeps the API read-only: pools and settings are changed on the miner's own web page.
  capabilities: { reboot: true },

  async read(miner, tools) {
    const r = await tools.readCgminer(miner.host, miner.port || 4028);
    return { ...r, model: r.model && /intminer/i.test(r.model) ? 'Goldshell (intminer firmware)' : r.model };
  },

  async runAction(miner, action, payload, tools) {
    if (action !== 'reboot') return { ok: false, message: `intminer can't ${action} through its API. Use the miner's own web page.` };
    const r = await tools.cgminer(miner.host, miner.port || 4028, 'restart');
    if (r && r.STATUS && r.STATUS[0] && r.STATUS[0].STATUS === 'E') return { ok: false, message: `The miner refused the restart${r.STATUS[0].Msg ? ` ("${r.STATUS[0].Msg}")` : ''}. Its API is probably read-only: restart it on its own web page.` };
    return { ok: true, message: 'The miner is restarting. Hashing resumes in about a minute.' };
  },
};
