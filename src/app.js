'use strict';

/**
 * 页面主线程：仅负责输入采集、Web Worker 调度与结果渲染。
 * 任何图计算都不允许出现在此文件中。
 */
(function () {
  const channelsEl = document.getElementById('channels');
  const edgesEl = document.getElementById('edges');
  const fixedAEl = document.getElementById('fixed-a');
  const fixedBEl = document.getElementById('fixed-b');
  const channelOptionsEl = document.getElementById('channel-options');
  const runBtn = document.getElementById('run');
  const runFixedBtn = document.getElementById('run-fixed');
  const sampleBtn = document.getElementById('sample');
  const sampleBlossomBtn = document.getElementById('sample-blossom');
  const clearBtn = document.getElementById('clear');
  const statusEl = document.getElementById('status');
  const errorsEl = document.getElementById('errors');
  const resultEl = document.getElementById('result');
  const resultHeadEl = document.getElementById('result-head');
  const resultBodyEl = document.getElementById('result-body');

  let seq = 0;
  let worker = null;

  function spawnWorker() {
    if (worker) worker.terminate();
    worker = new Worker('worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      setRunning(false);
      showErrors(['匹配 Worker 启动或运行失败：' + (e.message || '未知错误') + '（请通过 HTTP 访问本页面，file:// 下 Worker 不可用）']);
    };
  }

  function setRunning(running) {
    runBtn.disabled = running;
    runFixedBtn.disabled = running;
    runBtn.textContent = running ? '复核中…' : '复核配对';
    runFixedBtn.textContent = running ? '复核中…' : '固定配对复核';
  }

  function onWorkerMessage(event) {
    const data = event.data;
    // 丢弃过期响应：以最后一次提交为准，较早请求（含固定约束请求）不得覆盖最新结论
    if (data.seq !== seq) return;
    setRunning(false);

    if (data.type === 'invalid' || data.type === 'error') {
      // 失败提交：清空上一次结论（含固定配对预演结论），绝不保留旧结果
      clearResult();
      showErrors(data.errors);
      setStatus('idle', '');
      return;
    }

    errorsEl.innerHTML = '';
    if (data.type === 'matched') {
      renderMatched(data);
    } else if (data.type === 'unmatched') {
      // 同样清除“配对展示区”，改为展示失败证书
      renderUnmatched(data);
    } else if (data.type === 'fixed-matched') {
      renderFixedMatched(data);
    } else if (data.type === 'fixed-unmatched') {
      renderFixedUnmatched(data);
    }
  }

  function renderMatched(data) {
    setStatus('ok', `复核通过：全部 ${data.channels.length} 个通道已两两配对，共 ${data.pairs.length} 对（耗时 ${data.elapsed.toFixed(2)} ms）`);
    resultEl.hidden = false;
    resultHeadEl.innerHTML = '<h2>覆盖全部通道的配对方案</h2>';
    const rows = data.pairs
      .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p[0])}</td><td>${esc(p[1])}</td></tr>`)
      .join('');
    resultBodyEl.innerHTML =
      `<table class="pairs"><thead><tr><th>#</th><th>通道 A</th><th>通道 B</th></tr></thead><tbody>${rows}</tbody></table>` +
      note('配对已按通道标识升序稳定排序；每一对均为录入的无向兼容边。');
  }

  function renderUnmatched(data) {
    const c = data.certificate;
    setStatus('fail', `无法完整配对：存在 Tutte 阻塞集合（耗时 ${data.elapsed.toFixed(2)} ms）`);
    resultEl.hidden = false;
    resultHeadEl.innerHTML =
      '<h2>阻止完整配对的通道集合（Tutte 证书）</h2>' +
      `<p class="explain">移除下方集合 S 后，原图剩余部分的<strong>奇数连通分量数（${c.oddComponents.length}）` +
      `严格大于移除集合大小（${c.removed.length}）</strong>：每个奇分量至多向 S 内部消化一个通道，` +
      `其余通道必然孤立，因此不存在覆盖全部通道的配对。</p>`;
    resultBodyEl.innerHTML = certificateHtml(c, {
      checksTitle: '凭原图逐项核对',
      verifyNote: '证书全部核对项通过，可直接在录入的原图上复验。',
    });
  }

  function renderFixedMatched(data) {
    const total = data.channels.length;
    const covered = new Set();
    for (const [a, b] of data.pairs) {
      covered.add(a);
      covered.add(b);
    }
    setStatus('ok', `固定配对预演通过：固定组合 ${data.fixedPair[0]} — ${data.fixedPair[1]} 与其余 ${total - 2} 个通道可构成完整配对，共 ${data.pairs.length} 对（耗时 ${data.elapsed.toFixed(2)} ms）`);
    resultEl.hidden = false;
    resultHeadEl.innerHTML =
      '<h2>固定组合与剩余通道的完整配对</h2>' +
      `<p class="explain">固定组合 <strong>${esc(data.fixedPair[0])} — ${esc(data.fixedPair[1])}</strong> 被指定必须共同接管；` +
      `删去这两个端点后，剩余 ${total - 2} 个通道在剩余图上仍存在完整配对，合并后的方案如下。</p>`;
    const fixedKey = `${data.fixedPair[0]}${data.fixedPair[1]}`;
    const rows = data.pairs
      .map((p, i) => {
        const isFixed = `${p[0]}${p[1]}` === fixedKey;
        return (
          `<tr${isFixed ? ' class="pair-fixed"' : ''}><td>${i + 1}</td><td>${esc(p[0])}</td><td>${esc(p[1])}</td>` +
          `<td>${isFixed ? '<span class="badge">固定组合</span>' : '<span class="muted">剩余图配对</span>'}</td></tr>`
        );
      })
      .join('');
    resultBodyEl.innerHTML =
      `<table class="pairs"><thead><tr><th>#</th><th>通道 A</th><th>通道 B</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table>` +
      note(`全部 ${total} 个通道在方案中各出现且仅出现一次（实际覆盖 ${covered.size} 个）；` +
        '固定组合为指定必须共同接管的录入边，其余各对均为剩余图上的录入边；整体按通道标识升序稳定排序。');
  }

  function renderFixedUnmatched(data) {
    const c = data.certificate;
    const rest = data.remainingChannels.length;
    setStatus('fail', `固定配对预演不可行：删去固定组合后，剩余 ${rest} 个通道不存在完整配对（耗时 ${data.elapsed.toFixed(2)} ms）`);
    resultEl.hidden = false;
    resultHeadEl.innerHTML =
      '<h2>固定组合预演失败：剩余通道的 Tutte 阻塞证书</h2>' +
      `<p class="explain">固定组合 <strong>${esc(data.fixedPair[0])} — ${esc(data.fixedPair[1])}</strong> 被指定必须共同接管；` +
      `删去这两个端点后，剩余 ${rest} 个通道构成的剩余图不存在完整配对。</p>` +
      '<p class="warn-box">以下阻塞集合与奇数分量<strong>仅针对剩余通道</strong>（在删去固定端点后的剩余图上核对），' +
      '不能视为原图的失败证书——不绑定该固定组合时，原图仍可能完整配对。</p>';
    const remainingHtml =
      `<details class="comp"><summary>参与本次预演的剩余通道（${rest} 个，固定组合已排除）</summary>` +
      `<ul>${data.remainingChannels.map((id) => `<li>${esc(id)}</li>`).join('')}</ul></details>`;
    resultBodyEl.innerHTML =
      remainingHtml +
      certificateHtml(c, {
        checksTitle: '凭剩余图逐项核对（仅覆盖剩余通道）',
        verifyNote: '证书全部核对项通过，可直接在删去固定端点后的剩余图上复验。',
      });
  }

  /** 阻塞集合 + 奇分量 + 逐项核对的共用展示（普通失败作用于原图，固定预演作用于剩余图） */
  function certificateHtml(c, { checksTitle, verifyNote }) {
    const removedHtml = c.removed.length
      ? `<ul class="removed">${c.removed.map((id) => `<li>${esc(id)}</li>`).join('')}</ul>`
      : '<p class="muted">（空集，S = ∅）</p>';

    const compsHtml = c.oddComponents
      .map(
        (comp, i) =>
          `<details class="comp" ${i < 3 ? 'open' : ''}><summary>奇分量 #${i + 1}：${comp.length} 个通道</summary>` +
          `<ul>${comp.map((id) => `<li>${esc(id)}</li>`).join('')}</ul></details>`
      )
      .join('');

    const allChecksOk = c.checks.every((k) => k.ok);
    const checksHtml =
      `<h3>${esc(checksTitle)}</h3>` +
      '<ul class="checks">' +
      c.checks
        .map((k) => `<li class="${k.ok ? 'ok' : 'bad'}">${k.ok ? '✓' : '✗'} ${esc(k.label)}</li>`)
        .join('') +
      '</ul>' +
      (allChecksOk ? `<p class="verify-ok">${esc(verifyNote)}</p>` : '');

    return (
      `<div class="cert-grid"><div><h3>移除集合 S（${c.removed.length} 个）</h3>${removedHtml}</div>` +
      `<div><h3>移除后的奇数连通分量（${c.oddComponents.length} 个）</h3><div class="comps">${compsHtml}</div></div></div>` +
      checksHtml
    );
  }

  function showErrors(errors) {
    errorsEl.innerHTML =
      '<div class="error-box"><strong>输入无法复核：</strong><ul>' +
      errors.map((m) => `<li>${esc(m)}</li>`).join('') +
      '</ul></div>';
  }

  function clearResult() {
    resultEl.hidden = true;
    resultHeadEl.innerHTML = '';
    resultBodyEl.innerHTML = '';
  }

  function setStatus(kind, text) {
    statusEl.className = 'status ' + kind;
    statusEl.textContent = text;
  }

  function note(text) {
    return `<p class="muted">${esc(text)}</p>`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
    );
  }

  /** 依据当前通道录入刷新固定组合的候选下拉（仅作录入辅助，校验仍在 Worker 内完成） */
  function refreshChannelOptions() {
    const tokens = channelsEl.value
      .split(/[\s,;，；]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const unique = Array.from(new Set(tokens));
    channelOptionsEl.innerHTML = unique.map((t) => `<option value="${esc(t)}"></option>`).join('');
  }

  runBtn.addEventListener('click', () => {
    seq++;
    setRunning(true);
    errorsEl.innerHTML = '';
    setStatus('running', '正在 Web Worker 中按一般图语义执行 Edmonds 缩花…');
    spawnWorker();
    worker.postMessage({
      seq,
      channelsText: channelsEl.value,
      edgesText: edgesEl.value,
    });
  });

  runFixedBtn.addEventListener('click', () => {
    seq++;
    setRunning(true);
    errorsEl.innerHTML = '';
    setStatus('running', '正在 Web Worker 中预演固定组合：删去固定端点后对剩余图执行 Edmonds 缩花…');
    spawnWorker();
    worker.postMessage({
      seq,
      channelsText: channelsEl.value,
      edgesText: edgesEl.value,
      fixedPair: { a: fixedAEl.value, b: fixedBEl.value },
    });
  });

  clearBtn.addEventListener('click', () => {
    channelsEl.value = '';
    edgesEl.value = '';
    fixedAEl.value = '';
    fixedBEl.value = '';
    refreshChannelOptions();
    seq++;
    clearResult();
    errorsEl.innerHTML = '';
    setStatus('idle', '');
  });

  sampleBtn.addEventListener('click', () => {
    // 星型 K1,3：4 个通道仅经中心兼容。Tutte 证书 S={中心}，
    // 删除后得到 3 个单点奇分量，3 > 1，无法完整配对。
    channelsEl.value = 'CH-0 CH-1 CH-2 CH-3';
    edgesEl.value = 'CH-0 CH-1\nCH-0 CH-2\nCH-0 CH-3';
    refreshChannelOptions();
  });

  sampleBlossomBtn.addEventListener('click', () => {
    // 含两个奇环（三角花）的一般图：必须真正执行缩花才能找到完美匹配，
    // 二分图语义无法处理此类图。
    channelsEl.value = 'CH-A1 CH-A2 CH-A3 CH-B1 CH-B2 CH-B3';
    edgesEl.value =
      'CH-A1 CH-A2\nCH-A2 CH-A3\nCH-A3 CH-A1\n' +
      'CH-B1 CH-B2\nCH-B2 CH-B3\nCH-B3 CH-B1\n' +
      'CH-A1 CH-B1';
    refreshChannelOptions();
  });

  channelsEl.addEventListener('input', refreshChannelOptions);

  spawnWorker();
})();
