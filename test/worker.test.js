'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 在模拟的浏览器 Worker 全局环境中加载 worker.js 及其 importScripts 依赖 */
function loadWorker() {
  const messages = [];
  const sandbox = {
    console,
    performance: { now: () => 0 },
    Date,
    postMessage(msg) {
      messages.push(msg);
    },
  };
  sandbox.self = sandbox;
  sandbox.importScripts = (...names) => {
    for (const name of names) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
      vm.runInContext(code, sandbox, { filename: name });
    }
  };
  vm.createContext(sandbox);
  const workerCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');
  vm.runInContext(workerCode, sandbox, { filename: 'worker.js' });
  return {
    post: (data) => sandbox.self.onmessage({ data }),
    messages,
  };
}

/** vm 上下文产生的数组跨 realm，原型不同，按 JSON 结构比较 */
function sameStruct(actual, expected) {
  return JSON.parse(JSON.stringify(actual));
}

test('Worker：缩花成功输入返回按标识排序的配对', () => {
  const w = loadWorker();
  w.post({
    seq: 1,
    channelsText: 'A1 A2 A3 B1 B2 B3',
    edgesText: 'A1 A2\nA2 A3\nA3 A1\nB1 B2\nB2 B3\nB3 B1\nA1 B1',
  });
  assert.equal(w.messages.length, 1);
  const msg = w.messages[0];
  assert.equal(msg.seq, 1);
  assert.equal(msg.type, 'matched');
  assert.equal(msg.pairs.length, 3);
  assert.deepEqual(sameStruct(msg.pairs), [
    ['A1', 'B1'],
    ['A2', 'A3'],
    ['B2', 'B3'],
  ]);
});

test('Worker：失败输入返回 Tutte 证书且核对项全过', () => {
  const w = loadWorker();
  w.post({ seq: 2, channelsText: 'C0 C1 C2 C3', edgesText: 'C0 C1\nC0 C2\nC0 C3' });
  const msg = w.messages[0];
  assert.equal(msg.type, 'unmatched');
  assert.deepEqual(sameStruct(msg.certificate.removed), ['C0']);
  assert.deepEqual(sameStruct(msg.certificate.oddComponents), [['C1'], ['C2'], ['C3']]);
  assert.ok(msg.certificate.checks.every((c) => c.ok));
});

test('Worker：非法输入（自环+奇数量）回 invalid，不含任何旧配对数据', () => {
  const w = loadWorker();
  w.post({ seq: 3, channelsText: 'A B C', edgesText: 'A A' });
  const msg = w.messages[0];
  assert.equal(msg.type, 'invalid');
  assert.ok(msg.errors.length >= 2);
  assert.ok(msg.errors.some((e) => e.includes('自环')));
  assert.ok(msg.errors.some((e) => e.includes('偶数')));
  assert.equal(msg.pairs, undefined);
  assert.equal(msg.certificate, undefined);
});

test('Worker：空边图被拒绝', () => {
  const w = loadWorker();
  w.post({ seq: 4, channelsText: 'A B C D', edgesText: '' });
  const msg = w.messages[0];
  assert.equal(msg.type, 'invalid');
  assert.ok(msg.errors.some((e) => e.includes('空边图')));
});

test('前端脚本语法检查（app.js / worker.js）', () => {
  for (const f of ['app.js', 'worker.js', 'matching.js', 'parse.js']) {
    execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'src', f)]);
  }
});

const BLOSSOM_CHANNELS = 'A1 A2 A3 B1 B2 B3';
const BLOSSOM_EDGES = 'A1 A2\nA2 A3\nA3 A1\nB1 B2\nB2 B3\nB3 B1\nA1 B1';

test('Worker 固定预演：回带 mode=fixed 与 seq，固定桥成功时合并配对、每通道仅一次', () => {
  const w = loadWorker();
  w.post({ seq: 10, mode: 'fixed', channelsText: BLOSSOM_CHANNELS, edgesText: BLOSSOM_EDGES, fixedA: 'B1', fixedB: 'A1' });
  const msg = w.messages[0];
  assert.equal(msg.seq, 10);
  assert.equal(msg.mode, 'fixed');
  assert.equal(msg.type, 'fixed-matched');
  assert.deepEqual(sameStruct(msg.fixedPair), ['A1', 'B1']); // 对内排序
  assert.equal(msg.edgeLine, 7);
  assert.equal(msg.remainingCount, 4);
  assert.equal(msg.pairs.length, 3);
  // 合并固定组合与剩余配对后按标识升序稳定展示
  assert.deepEqual(sameStruct(msg.pairs), [
    ['A1', 'B1'],
    ['A2', 'A3'],
    ['B2', 'B3'],
  ]);
  // 所有通道只出现一次
  const seen = new Set();
  for (const [a, b] of msg.pairs) {
    assert.ok(!seen.has(a) && !seen.has(b));
    seen.add(a);
    seen.add(b);
  }
  assert.equal(seen.size, 6);
});

test('Worker 固定预演：原图可配对但绑定花内边后剩余图失败，证书仅覆盖剩余通道', () => {
  const w = loadWorker();
  w.post({ seq: 11, mode: 'fixed', channelsText: BLOSSOM_CHANNELS, edgesText: BLOSSOM_EDGES, fixedA: 'A1', fixedB: 'A2' });
  const msg = w.messages[0];
  assert.equal(msg.type, 'fixed-unmatched');
  assert.equal(msg.mode, 'fixed');
  assert.deepEqual(sameStruct(msg.fixedPair), ['A1', 'A2']);
  // 只涉及删去固定两端后的 4 个通道
  assert.deepEqual(sameStruct(msg.residualChannels), ['A3', 'B1', 'B2', 'B3']);
  const c = msg.certificate;
  assert.deepEqual(sameStruct(c.removed), []);
  const comps = sameStruct(c.oddComponents).map((x) => x.join(',')).sort();
  assert.deepEqual(comps, ['A3', 'B1,B2,B3']);
  // 核对项全部针对剩余图逐项通过
  assert.ok(c.checks.every((k) => k.ok), JSON.stringify(c.checks));
  assert.ok(c.checks.some((k) => k.label.includes('剩余图')));
  // 证书中绝不出现被固定的两个通道，且没有任何“原图”措辞被误用
  const certText = JSON.stringify(c);
  assert.ok(!certText.includes('A1') && !certText.includes('A2'));
});

test('Worker 固定预演：星型固定一条边后，剩余两个孤立点给出仅含剩余通道的证书', () => {
  const w = loadWorker();
  w.post({ seq: 12, mode: 'fixed', channelsText: 'C0 C1 C2 C3', edgesText: 'C0 C1\nC0 C2\nC0 C3', fixedA: 'C0', fixedB: 'C1' });
  const msg = w.messages[0];
  assert.equal(msg.type, 'fixed-unmatched');
  assert.deepEqual(sameStruct(msg.certificate.removed), []);
  assert.deepEqual(sameStruct(msg.certificate.oddComponents), [['C2'], ['C3']]);
  assert.ok(msg.certificate.checks.every((k) => k.ok));
});

test('Worker 固定预演：选择不存在的边 → fixed-invalid，明确反馈且不带任何结论数据', () => {
  const w = loadWorker();
  w.post({ seq: 13, mode: 'fixed', channelsText: BLOSSOM_CHANNELS, edgesText: BLOSSOM_EDGES, fixedA: 'A2', fixedB: 'B2' });
  const msg = w.messages[0];
  assert.equal(msg.type, 'fixed-invalid');
  assert.equal(msg.mode, 'fixed');
  assert.ok(msg.errors[0].includes('不存在已录入的兼容边'));
  assert.equal(msg.pairs, undefined);
  assert.equal(msg.certificate, undefined);
});

test('Worker 固定预演：未知通道 → fixed-invalid 并点名', () => {
  const w = loadWorker();
  w.post({ seq: 14, mode: 'fixed', channelsText: BLOSSOM_CHANNELS, edgesText: BLOSSOM_EDGES, fixedA: 'A1', fixedB: 'CH-X' });
  const msg = w.messages[0];
  assert.equal(msg.type, 'fixed-invalid');
  assert.ok(msg.errors[0].includes('未录入通道') && msg.errors[0].includes('CH-X'));
});

test('Worker 固定预演：两端相同 → fixed-invalid', () => {
  const w = loadWorker();
  w.post({ seq: 15, mode: 'fixed', channelsText: BLOSSOM_CHANNELS, edgesText: BLOSSOM_EDGES, fixedA: 'A1', fixedB: 'A1' });
  const msg = w.messages[0];
  assert.equal(msg.type, 'fixed-invalid');
  assert.ok(msg.errors[0].includes('不同通道'));
});

test('Worker 固定预演：本次输入本身校验失败（奇数通道）→ invalid 且回带 fixed 模式，无结论数据', () => {
  const w = loadWorker();
  w.post({ seq: 16, mode: 'fixed', channelsText: 'A B C', edgesText: 'A B', fixedA: 'A', fixedB: 'B' });
  const msg = w.messages[0];
  assert.equal(msg.mode, 'fixed');
  assert.equal(msg.type, 'invalid');
  assert.ok(msg.errors.some((e) => e.includes('偶数')));
  assert.equal(msg.pairs, undefined);
  assert.equal(msg.certificate, undefined);
});

test('Worker 一般复核不受固定模式影响：消息回带 mode=general，成功语义不变', () => {
  const w = loadWorker();
  w.post({ seq: 17, mode: 'general', channelsText: BLOSSOM_CHANNELS, edgesText: BLOSSOM_EDGES });
  const msg = w.messages[0];
  assert.equal(msg.type, 'matched');
  assert.equal(msg.mode, 'general');
  assert.equal(msg.fixedPair, undefined);
  assert.deepEqual(sameStruct(msg.pairs), [
    ['A1', 'B1'],
    ['A2', 'A3'],
    ['B2', 'B3'],
  ]);
});

test('主线程防过期：app.js 以 seq 比对丢弃旧响应，并在发新请求时 terminate 旧 Worker', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.ok(appSrc.includes('data.seq !== seq'), '缺少 seq 过期响应丢弃逻辑');
  assert.ok(/spawnWorker[\s\S]*worker\.terminate\(\)/.test(appSrc), '发新请求前未 terminate 旧 Worker');
  // 两类复核共享同一单调 seq，固定结果不会被较早请求覆盖
  assert.ok(appSrc.includes("mode: 'fixed'") && appSrc.includes("mode: 'general'"));
});
