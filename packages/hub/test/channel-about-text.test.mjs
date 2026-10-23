import assert from 'node:assert/strict';
import test from 'node:test';
import { mangledChannelAboutText } from '../src/channel-about-text.ts';

test('text whose characters were already replaced is refused', () => {
  // 2026-10-05: About text from a Windows shell arrived as runs of "?".
  for (const value of ['????', '??', '?? xmatrix CLI ? Windows ?????', '??????????Windows?????????',
    'Release �� notes', '项目�']) assert.equal(mangledChannelAboutText(value), true, value);
});

test('ordinary text with question marks is kept', () => {
  for (const value of ['', '?', 'Why does the build fail?', 'Open questions: rollout? owner? date???',
    '讨论发布计划：下一步做什么？', 'Is the API stable??', 'Release notes for 2.0 — what changed??? Everything in the CLI.',
    'Summary of the incident and the follow-up work assigned to each owner. Unknowns: ???'])
    assert.equal(mangledChannelAboutText(value), false, value);
});
