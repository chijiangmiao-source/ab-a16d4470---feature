'use strict';

/**
 * Web Worker 入口：所有匹配计算（Edmonds 缩花 / Tutte 证书）均在此线程执行，
 * 页面主线程只负责收发消息与渲染，绝不参与图算法。
 *
 * 两种请求模式（结果均原样回带 mode，由主线程按 seq 防过期覆盖）：
 *  - mode 缺省 / 'general'：一般复核配对，原图上求覆盖全部通道的完美匹配；
 *  - mode 'fixed'：固定配对预演。先校验固定边（已录入、两端不同），
 *    再仅在删去这两个端点后的剩余图上继续按一般图求完整配对；
 *    剩余图失败时给出的 Tutte 证书只描述剩余通道，绝非原图的失败证书。
 */
/* global importScripts, perfectMatching, reviewFixedPair, parseInput, presentPairs, verifyCertificate, resolveFixedPair */
importScripts('matching.js', 'parse.js');

self.onmessage = function (event) {
  const { seq, mode, channelsText, edgesText, fixedA, fixedB } = event.data || {};
  const isFixed = mode === 'fixed';
  const started = (self.performance && self.performance.now()) ? self.performance.now() : Date.now();

  try {
    const parsed = parseInput(channelsText, edgesText);
    if (parsed.errors.length > 0) {
      // 本次输入校验失败：连同模式一起回传，页面据此清除对应旧结论
      self.postMessage({ seq, mode: isFixed ? 'fixed' : 'general', type: 'invalid', errors: parsed.errors });
      return;
    }

    const { channels, edges } = parsed;
    const elapsed = () =>
      ((self.performance && self.performance.now()) ? self.performance.now() : Date.now()) - started;

    if (!isFixed) {
      runGeneral(seq, channels, edges, elapsed);
    } else {
      runFixed(seq, channels, edges, fixedA, fixedB, elapsed);
    }
  } catch (err) {
    self.postMessage({
      seq,
      mode: isFixed ? 'fixed' : 'general',
      type: 'error',
      errors: ['Worker 内部错误：' + (err && err.message ? err.message : String(err))],
    });
  }
};

/** 一般复核配对：原图上的 Edmonds 完美匹配 / Tutte 失败证书。 */
function runGeneral(seq, channels, edges, elapsed) {
  const result = perfectMatching(channels.length, edges);

  if (result.matched) {
    self.postMessage({
      seq,
      mode: 'general',
      type: 'matched',
      channels,
      pairs: presentPairs(channels, result.matching),
      elapsed: elapsed(),
    });
    return;
  }

  const cert = result.certificate;
  // 在 Worker 内以原图为唯一依据独立复核证书，逐项随结果返回页面展示
  const checks = verifyCertificate(channels.length, edges, cert.removed, cert.oddComponents);
  self.postMessage({
    seq,
    mode: 'general',
    type: 'unmatched',
    channels,
    elapsed: elapsed(),
    certificate: {
      removed: cert.removed.map((i) => channels[i]),
      oddComponents: cert.oddComponents.map((comp) => comp.map((i) => channels[i])),
      checks,
    },
  });
}

/** 固定配对预演：校验固定边 → 删两端 → 仅对剩余图求完整配对。 */
function runFixed(seq, channels, edges, fixedA, fixedB, elapsed) {
  const rule = resolveFixedPair(channels, edges, fixedA, fixedB);
  if (rule.errors.length > 0) {
    // 固定约束本身非法（未知通道 / 两端相同 / 边不存在）：不得保留旧的固定结论
    self.postMessage({ seq, mode: 'fixed', type: 'fixed-invalid', errors: rule.errors });
    return;
  }

  const [ia, ib] = rule.fixed;
  const fixedPair = [channels[ia], channels[ib]].sort();
  const review = reviewFixedPair(channels.length, edges, [ia, ib]);
  const residualNames = review.remaining.map((i) => channels[i]);
  const result = review.result;

  if (result.matched) {
    // 剩余配对（剩余图局部下标）先转回原图下标，再与固定组合合并统一排序
    const remainingPairs = result.matching.map(([x, y]) => [review.remaining[x], review.remaining[y]]);
    const allPairs = presentPairs(channels, [[ia, ib], ...remainingPairs]);
    self.postMessage({
      seq,
      mode: 'fixed',
      type: 'fixed-matched',
      channels,
      fixedPair,
      edgeLine: rule.edgeLine,
      pairs: allPairs,
      remainingCount: review.remaining.length,
      elapsed: elapsed(),
    });
    return;
  }

  // 剩余图不可配对：证书仅针对删去固定两端后的剩余通道，核对也只在剩余图上进行
  const cert = result.certificate;
  const checks = verifyCertificate(
    review.remaining.length,
    review.residualEdges,
    cert.removed,
    cert.oddComponents,
    '剩余图（删去固定两端后的通道）'
  );
  self.postMessage({
    seq,
    mode: 'fixed',
    type: 'fixed-unmatched',
    channels,
    fixedPair,
    edgeLine: rule.edgeLine,
    residualChannels: residualNames,
    elapsed: elapsed(),
    certificate: {
      removed: cert.removed.map((k) => residualNames[k]),
      oddComponents: cert.oddComponents.map((comp) => comp.map((k) => residualNames[k])),
      checks,
    },
  });
}
