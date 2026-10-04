'use strict';

/**
 * Web Worker 入口：所有匹配计算（Edmonds 缩花 / Tutte 证书 / 固定边预演）
 * 均在此线程执行，页面主线程只负责收发消息与渲染，绝不参与图算法。
 *
 * 消息契约：
 *  - 请求 { seq, channelsText, edgesText, fixedPair? }
 *    fixedPair 为 { a, b } 时执行固定配对预演（仅在剩余图上求解），
 *    缺省为普通全图复核，两种模式互不影响；
 *  - 响应 { seq, type, elapsed, ... }，type 取自 reviewMatching 的 kind：
 *    invalid / error / matched / unmatched / fixed-matched / fixed-unmatched。
 *    响应原样回传 seq，主线程据此丢弃较早请求的过期结果。
 */
/* global importScripts, reviewMatching */
importScripts('matching.js', 'parse.js', 'review.js');

const now = () => (self.performance && self.performance.now() ? self.performance.now() : Date.now());

self.onmessage = function (event) {
  const { seq, channelsText, edgesText, fixedPair } = event.data || {};
  const started = now();

  try {
    const outcome = reviewMatching(channelsText, edgesText, fixedPair ?? null);
    const elapsed = now() - started;
    const { kind, ...rest } = outcome;
    self.postMessage({ seq, type: kind, elapsed, ...rest });
  } catch (err) {
    self.postMessage({ seq, type: 'error', errors: ['Worker 内部错误：' + (err && err.message ? err.message : String(err))] });
  }
};
