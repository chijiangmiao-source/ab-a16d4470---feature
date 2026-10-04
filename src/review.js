'use strict';

/**
 * 复核编排（同构模块）：解析输入 → （可选）固定边校验 → 一般图求解 → 展示数据。
 *
 * Web Worker 与 HTTP 服务端共用本入口，保证浏览器预演与外部核验
 * 走的是同一份规则代码；本模块本身不含图算法，只组合
 * parse.js（解析/校验/证书复核）与 matching.js（Edmonds 缩花求解）。
 *
 * 返回的 kind 即 Worker 消息 type：
 *  - invalid          输入或固定组合校验失败（errors）
 *  - matched          普通复核：全图可完整配对（channels, pairs）
 *  - unmatched        普通复核：全图不可完整配对（channels, certificate）
 *  - fixed-matched    固定预演可行（channels, fixedPair, pairs）
 *  - fixed-unmatched  固定预演不可行（channels, fixedPair, remainingChannels, certificate）
 */
(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./parse') : root,
    typeof module === 'object' && module.exports ? require('./matching') : root
  );
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    // 浏览器 Worker：parse.js / matching.js 已把 API 挂到全局
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (parseApi, matchingApi) {
  const { parseInput, parseFixedPair, presentPairs, verifyCertificate } = parseApi;
  const { perfectMatching, perfectMatchingWithFixedEdge } = matchingApi;

  /**
   * 统一复核入口。
   *
   * @param {string} channelsText 通道清单原文
   * @param {string} edgesText 兼容边原文
   * @param {{a: string, b: string}|null} fixedPair
   *        为 null 时按原语义复核全图；否则先校验固定边，
   *        再仅在删去其两个端点后的剩余图上求完整配对。
   */
  function reviewMatching(channelsText, edgesText, fixedPair) {
    const parsed = parseInput(channelsText, edgesText);
    if (parsed.errors.length > 0) {
      return { kind: 'invalid', errors: parsed.errors };
    }
    const { channels, edges } = parsed;

    if (fixedPair == null) {
      return reviewWholeGraph(channels, edges);
    }
    return reviewWithFixedPair(channels, edges, fixedPair);
  }

  /** 普通复核：对整张录入图求完整配对，语义与既往一致。 */
  function reviewWholeGraph(channels, edges) {
    const result = perfectMatching(channels.length, edges);
    if (result.matched) {
      return { kind: 'matched', channels, pairs: presentPairs(channels, result.matching) };
    }
    const cert = result.certificate;
    return {
      kind: 'unmatched',
      channels,
      certificate: {
        removed: cert.removed.map((i) => channels[i]),
        oddComponents: cert.oddComponents.map((comp) => comp.map((i) => channels[i])),
        // 以原图为唯一依据独立复核证书，逐项随结果返回
        checks: verifyCertificate(channels.length, edges, cert.removed, cert.oddComponents),
      },
    };
  }

  /** 固定配对预演：固定边必须存在且端点不同，随后只在剩余图上求解。 */
  function reviewWithFixedPair(channels, edges, fixedPair) {
    const raw = fixedPair && typeof fixedPair === 'object' ? fixedPair : {};
    const check = parseFixedPair(channels, edges, raw.a, raw.b);
    if (check.errors.length > 0) {
      return { kind: 'invalid', errors: check.errors };
    }

    const [u, v] = check.pair;
    const result = perfectMatchingWithFixedEdge(channels.length, edges, u, v);
    const fixedIds = [channels[u], channels[v]].sort();

    if (result.matched) {
      // 固定组合与剩余配对合并，按现有稳定顺序展示
      return {
        kind: 'fixed-matched',
        channels,
        fixedPair: fixedIds,
        pairs: presentPairs(channels, result.matching),
      };
    }

    // 证书仅针对剩余通道：在删去固定端点后的剩余图上独立复核
    const remainingChannels = result.remaining.map((i) => channels[i]);
    const cert = result.certificate;
    return {
      kind: 'fixed-unmatched',
      channels,
      fixedPair: fixedIds,
      remainingChannels,
      certificate: {
        removed: cert.removed.map((i) => remainingChannels[i]),
        oddComponents: cert.oddComponents.map((comp) => comp.map((i) => remainingChannels[i])),
        checks: verifyCertificate(result.remaining.length, result.remainingEdges, cert.removed, cert.oddComponents),
      },
    };
  }

  return { reviewMatching };
});
