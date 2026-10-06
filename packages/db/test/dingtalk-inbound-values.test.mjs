import assert from "node:assert/strict";
import test from "node:test";
import { dingtalkInboundCandidate } from "../dist/index.js";
const candidate = { memberId: 'MemberCase',robotId: '$:RobotFixture',conversationId: 'ConversationFixture',conversationType: 'direct',
  verifierDigest: 'b'.repeat(64),corpId: 'dingCompanyFixture',appId: 123,providerMessageId: 'MessageFixture',
  createdAtMs: 123456789,text: 'Untrusted text 😀',mentioned: false };
test('DingTalk normalized candidate rejects missing identities, caller authority, capabilities and unbounded content',() => {
  assert.deepEqual(dingtalkInboundCandidate(candidate),candidate);
  for (const extra of [{ memberId: '@all' },{ memberId: '' },{ robotId: '' },{ corpId: 'foreign' },{ appId: 0 },
    { conversationId: 'x\nInjected' },{ conversationType: 'external' },{ verifierDigest: '' },{ providerMessageId: '' },
    { createdAtMs: Number.MAX_SAFE_INTEGER+1 },{ text: '😀'.repeat(2049) },{ text: '\u0000private' },{ text: '\ud800' },
    { mentioned: 'true' },{ spaceId: 'caller-space' },{ actorUserId: 'caller-owner' },{ sessionWebhook: 'https://private.example' },
    { isAdmin: true },{ nativeToken: 'private-token' }]) assert.throws(() => dingtalkInboundCandidate({ ...candidate,...extra }),e => e.status===400);
  for (const k of ['memberId','corpId','robotId','verifierDigest']) { const value = { ...candidate };delete value[k];
    assert.throws(() => dingtalkInboundCandidate(value),e => e.status===400); }
});
test('DingTalk internal group candidates require a mention; normalization never authenticates or selects a transport',() => {
  assert.throws(() => dingtalkInboundCandidate({ ...candidate,conversationType: 'group' }),e => e.status===400);
  assert.equal(dingtalkInboundCandidate({ ...candidate,conversationType: 'group',mentioned: true }).memberId,'MemberCase');
  assert.equal(dingtalkInboundCandidate({ ...candidate,memberId: 'membercase' }).memberId,'membercase');
});
