import assert from 'node:assert/strict';
import test from 'node:test';
import { channelAboutTextRefusal, mangledChannelAboutText } from '../src/channel-about-text.ts';

test('text a code-page shell turned into question marks is refused', () => {
  // 2026-10-05: `xmatrix channel about --summary "…中文…"` from a Windows shell arrived as runs of "?".
  for (const value of ['????', '??', '?? xmatrix CLI ? Windows ?????', '??????????Windows?????????',
    'Release �� notes', '项目�']) assert.equal(mangledChannelAboutText(value), true, value);
});

test('ordinary text with question marks is kept', () => {
  for (const value of ['', '?', 'Why does the build fail?', 'Open questions: rollout? owner? date???',
    '讨论发布计划：下一步做什么？', 'Is the API stable??', 'Release notes for 2.0 — what changed??? Everything in the CLI.',
    'Summary of the incident and the follow-up work assigned to each owner. Unknowns: ???'])
    assert.equal(mangledChannelAboutText(value), false, value);
});

test('the refusal names the damaged field and the code an Agent retries on', () => {
  assert.equal(channelAboutTextRefusal({ summary: '频道摘要', name: '发布' }), undefined);
  assert.equal(channelAboutTextRefusal({ summary: '频道摘要' }), undefined);
  const summary = channelAboutTextRefusal({ summary: '????? ??', name: '发布' });
  assert.equal(summary.code, 'channel_about_text_mangled');
  assert.equal(summary.field, 'summary');
  assert.match(summary.error, /UTF-8/u);
  assert.equal(channelAboutTextRefusal({ summary: '频道摘要', name: '????' }).field, 'name');
});
