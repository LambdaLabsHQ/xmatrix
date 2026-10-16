import assert from 'node:assert/strict';
import test from 'node:test';
import { dropHtmlElements, stripHtmlTags } from '../dist/html-text.js';
import { trimEdges, trimEnd } from '../dist/field-validation.js';
import { parseHandoffInstanceTarget } from '../dist/agent-mention.js';

test('tags and comments become the replacement while an unclosed < stays text', () => {
  assert.equal(stripHtmlTags('<p>a<br/>b</p><!-- x > y -->c'), 'abc');
  assert.equal(stripHtmlTags('<p>a</p>b', ' '), ' a b');
  assert.equal(stripHtmlTags('1 < 2 and <!-- open'), '1 < 2 and <!-- open');
  assert.equal(stripHtmlTags('a <!--b>c'), 'a c');
});

test('named elements drop with their content, case-insensitively, and only whole names match', () => {
  assert.equal(dropHtmlElements('a<SCRIPT x>b</script >c<style>d</STYLE>e', ['script', 'style']), 'ace');
  assert.equal(dropHtmlElements('<scripts>a</scripts><script>b', ['script']), '<scripts>a</scripts><script>b');
  assert.equal(dropHtmlElements('<head>a</head><script>b</script>', ['script', 'head']), '');
});

test('hostile input stays linear', () => {
  const lots = 200_000;
  const started = performance.now();
  stripHtmlTags('<'.repeat(lots));
  dropHtmlElements('<script'.repeat(lots), ['script', 'style']);
  trimEnd(`${'/'.repeat(lots)}x`, '/');
  parseHandoffInstanceTarget(`a${':1:handoff:@a'.repeat(lots / 10)}\n`);
  assert.ok(performance.now() - started < 2_000);
});

test('trimEnd and trimEdges remove only edge runs of the given characters', () => {
  assert.equal(trimEnd('https://x///', '/'), 'https://x');
  assert.equal(trimEnd('a \t \t', ' \t'), 'a');
  assert.equal(trimEdges('--a-b--', '-'), 'a-b');
  assert.equal(trimEdges('---', '-'), '');
});
