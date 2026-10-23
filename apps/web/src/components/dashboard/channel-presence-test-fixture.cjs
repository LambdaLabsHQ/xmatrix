const { decodeChannelSnapshot, encodeChannelSnapshot } = require("@xmatrix/protocol");
const channelInstances = channel => [...(channel.presence?.instances.values() ?? [])];
const firstChannelInstance = channel => channelInstances(channel)[0];
const legacyChannelMembers = channel => encodeChannelSnapshot(channel).memberPresence ?? {};
module.exports = { decodeChannelSnapshot, channelInstances, firstChannelInstance, legacyChannelMembers };
module.exports.FIXTURE_AGENT_REGISTRATION = { ownerUserId: "owner-1", machineId: "machine-1", harness: "codex" };
