'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewMatching } = require('../src/review');

const BLOSSOM_CHANNELS = 'A1 A2 A3 B1 B2 B3';
const BLOSSOM_EDGES = 'A1 A2\nA2 A3\nA3 A1\nB1 B2\nB2 B3\nB3 B1\nA1 B1';
const STAR_CHANNELS = 'C0 C1 C2 C3';
const STAR_EDGES = 'C0 C1\nC0 C2\nC0 C3';

test('普通复核：可配对返回稳定排序配对（原语义不变）', () => {
  const r = reviewMatching(BLOSSOM_CHANNELS, BLOSSOM_EDGES, null);
  assert.equal(r.kind, 'matched');
  assert.equal(r.pairs.length, 3);
  assert.deepEqual(r.pairs, [['A1', 'B1'], ['A2', 'A3'], ['B2', 'B3']]);
});

test('普通复核：失败返回可凭原图核对的 Tutte 证书', () => {
  const r = reviewMatching(STAR_CHANNELS, STAR_EDGES, null);
  assert.equal(r.kind, 'unmatched');
  assert.deepEqual(r.certificate.removed, ['C0']);
  assert.deepEqual(r.certificate.oddComponents, [['C1'], ['C2'], ['C3']]);
  assert.ok(r.certificate.checks.every((c) => c.ok));
});

test('普通复核：非法输入返回 invalid', () => {
  const r = reviewMatching('A B C', 'A B', null);
  assert.equal(r.kind, 'invalid');
  assert.ok(r.errors.length > 0);
  assert.equal(r.pairs, undefined);
  assert.equal(r.certificate, undefined);
});

test('固定预演可行：合并配对覆盖全部通道且各出现一次', () => {
  const r = reviewMatching(BLOSSOM_CHANNELS, BLOSSOM_EDGES, { a: 'B1', b: 'A1' });
  assert.equal(r.kind, 'fixed-matched');
  assert.deepEqual(r.fixedPair, ['A1', 'B1']);
  assert.equal(r.pairs.length, 3);
  assert.ok(r.pairs.some(([a, b]) => a === 'A1' && b === 'B1'), '合并配对未包含固定组合');
  const ids = r.pairs.flat();
  assert.equal(new Set(ids).size, 6, '存在通道重复或遗漏');
  assert.deepEqual([...ids].sort(), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
});

test('固定预演不可行：证书仅覆盖剩余通道且逐项核对通过', () => {
  const r = reviewMatching(STAR_CHANNELS, STAR_EDGES, { a: 'C0', b: 'C1' });
  assert.equal(r.kind, 'fixed-unmatched');
  assert.deepEqual(r.fixedPair, ['C0', 'C1']);
  assert.deepEqual(r.remainingChannels, ['C2', 'C3']);
  const covered = new Set([...r.certificate.removed, ...r.certificate.oddComponents.flat()]);
  assert.deepEqual([...covered].sort(), ['C2', 'C3'], '证书应恰好覆盖剩余通道');
  assert.ok(!covered.has('C0') && !covered.has('C1'), '证书不得涉及固定组合端点');
  assert.ok(r.certificate.oddComponents.length > r.certificate.removed.length);
  assert.ok(r.certificate.checks.every((c) => c.ok));
});

test('固定预演：剩余图含奇环时仍在一般图语义下求解（双三角花）', () => {
  const r = reviewMatching(
    'F1 F2 A1 A2 A3 B1 B2 B3',
    'F1 F2\n' + BLOSSOM_EDGES,
    { a: 'F1', b: 'F2' }
  );
  assert.equal(r.kind, 'fixed-matched');
  assert.equal(r.pairs.length, 4);
  assert.ok(r.pairs.some(([a, b]) => a === 'F1' && b === 'F2'));
});

test('固定组合校验失败返回 invalid，不携带任何结论字段', () => {
  for (const [a, b, expect] of [
    ['C1', 'C2', '不在已录入'],
    ['C0', 'XX', '未录入'],
    ['C0', 'C0', '必须不同'],
    ['', 'C1', '两个通道标识'],
  ]) {
    const r = reviewMatching(STAR_CHANNELS, STAR_EDGES, { a, b });
    assert.equal(r.kind, 'invalid', `固定组合 (${a}, ${b}) 应被拒绝`);
    assert.ok(r.errors.some((e) => e.includes(expect)), `缺少反馈「${expect}」`);
    assert.equal(r.pairs, undefined);
    assert.equal(r.certificate, undefined);
    assert.equal(r.fixedPair, undefined);
  }
});

test('固定预演：畸形 fixedPair 载荷按校验失败处理', () => {
  const r = reviewMatching(STAR_CHANNELS, STAR_EDGES, 'C0-C1');
  assert.equal(r.kind, 'invalid');
  assert.ok(r.errors.length > 0);
});
