'use strict';

/**
 * 页面主线程：仅负责输入采集、Web Worker 调度与结果渲染。
 * 任何图计算都不允许出现在此文件中。
 *
 * 两类相互独立的复核共用同一个单调递增 seq 与同一个 Worker 句柄：
 *  - 一般「复核配对」：原图求完美匹配；
 *  - 「固定配对复核」：指定一条已录入兼容边为固定组合，仅在剩余图上求完整配对。
 * 先发请求的 Worker 在新请求发出时即被 terminate，过期 seq 的回包也一律丢弃，
 * 因此固定约束结果绝不会被较早的请求覆盖；两类结论各自渲染、互不清除。
 */
(function () {
  const channelsEl = document.getElementById('channels');
  const edgesEl = document.getElementById('edges');
  const runBtn = document.getElementById('run');
  const fixedAEl = document.getElementById('fixed-a');
  const fixedBEl = document.getElementById('fixed-b');
  const fixedRunBtn = document.getElementById('fixed-run');
  const sampleBtn = document.getElementById('sample');
  const sampleBlossomBtn = document.getElementById('sample-blossom');
  const clearBtn = document.getElementById('clear');
  const statusEl = document.getElementById('status');
  const errorsEl = document.getElementById('errors');
  const resultEl = document.getElementById('result');
  const resultHeadEl = document.getElementById('result-head');
  const resultBodyEl = document.getElementById('result-body');
  const fixedStatusEl = document.getElementById('fixed-status');
  const fixedErrorsEl = document.getElementById('fixed-errors');
  const fixedResultEl = document.getElementById('fixed-result');
  const fixedResultHeadEl = document.getElementById('fixed-result-head');
  const fixedResultBodyEl = document.getElementById('fixed-result-body');

  let seq = 0;
  let worker = null;

  function spawnWorker() {
    if (worker) worker.terminate();
    worker = new Worker('worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      showErrors(['匹配 Worker 启动或运行失败：' + (e.message || '未知错误') + '（请通过 HTTP 访问本页面，file:// 下 Worker 不可用）']);
    };
  }

  function onWorkerMessage(event) {
    const data = event.data;
    if (data.seq !== seq) return; // 丢弃过期响应（固定结果不会被较早请求覆盖）
    setButtonsIdle();

    if (data.mode === 'fixed') {
      handleFixedMessage(data);
      return;
    }

    if (data.type === 'invalid' || data.type === 'error') {
      // 失败提交：清空上一次通过的配对，绝不保留旧结果
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
    }
  }

  // ---------- 一般复核配对的渲染（语义保持不变） ----------

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
    resultBodyEl.innerHTML = certificateHtml(c);
  }

  // ---------- 固定配对预演的渲染 ----------

  function handleFixedMessage(data) {
    if (data.type === 'fixed-invalid' || data.type === 'invalid' || data.type === 'error') {
      // 固定边不存在 / 未知通道 / 两端相同 / 本次输入校验失败：
      // 明确反馈并清除旧的固定配对结论（一般复核结论不受影响）
      clearFixedResult();
      showFixedErrors(data.errors);
      setFixedStatus('idle', '');
      return;
    }

    fixedErrorsEl.innerHTML = '';
    if (data.type === 'fixed-matched') {
      renderFixedMatched(data);
    } else if (data.type === 'fixed-unmatched') {
      renderFixedUnmatched(data);
    }
  }

  function renderFixedMatched(data) {
    const fixedKey = data.fixedPair.join(' ');
    setFixedStatus(
      'ok',
      `固定配对预演通过：固定组合 ${data.fixedPair.join(' — ')} 成立，其余 ${data.remainingCount} 个通道在删去固定两端后的剩余图上也能完整配对（耗时 ${data.elapsed.toFixed(2)} ms）`
    );
    fixedResultEl.hidden = false;
    fixedResultHeadEl.innerHTML =
      '<h2>固定配对预演：含固定组合的完整配对方案</h2>' +
      `<p class="explain">固定组合 <strong>${esc(data.fixedPair[0])} — ${esc(data.fixedPair[1])}</strong>` +
      `（兼容边清单第 ${data.edgeLine} 条）必须共同接管；删去这两个通道后，` +
      `剩余 ${data.remainingCount} 个通道可两两配对。下表把固定组合与剩余配对合并后按通道标识升序稳定展示：` +
      `全部 ${data.channels.length} 个通道<strong>有且仅有一次</strong>出现。</p>`;
    const rows = data.pairs
      .map((p, i) => {
        const isFixed = p.join(' ') === fixedKey;
        return `<tr${isFixed ? ' class="fixed-row"' : ''}><td>${i + 1}</td><td>${esc(p[0])}</td>` +
          `<td>${esc(p[1])}</td>${isFixed ? '<td class="badge">固定组合</td>' : '<td></td>'}</tr>`;
      })
      .join('');
    fixedResultBodyEl.innerHTML =
      '<table class="pairs fixed-pairs"><thead><tr><th>#</th><th>通道 A</th><th>通道 B</th><th>备注</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>` +
      note(`固定组合与剩余配对合并后按通道标识升序稳定排序；每个通道只出现一次，共 ${data.pairs.length} 对覆盖全部 ${data.channels.length} 个通道。`);
  }

  function renderFixedUnmatched(data) {
    const c = data.certificate;
    setFixedStatus(
      'fail',
      `固定配对预演失败：固定组合 ${data.fixedPair.join(' — ')} 成立，但删去固定两端后的剩余通道无法完整配对（耗时 ${data.elapsed.toFixed(2)} ms）`
    );
    fixedResultEl.hidden = false;
    fixedResultHeadEl.innerHTML =
      '<h2>剩余通道的 Tutte 阻塞集合（仅针对固定预演的剩余图）</h2>' +
      `<p class="explain">固定组合 <strong>${esc(data.fixedPair[0])} — ${esc(data.fixedPair[1])}</strong> 本身是一条真实录入边；` +
      `但删去这两个端点后，剩余 ${data.residualChannels.length} 个通道构成的图不存在完整配对。` +
      `下方移除集合 S 与奇数连通分量<strong>只描述删去固定两端后的剩余通道</strong>，` +
      `满足奇数分量数（${c.oddComponents.length}）严格大于 |S|（${c.removed.length}）。` +
      `它证明的是“强制该绑定后其余通道失去安置机会”，<strong>不是原图无法配对的失败证书</strong>：` +
      `原图若改用别的配对仍可能成功。</p>`;
    fixedResultBodyEl.innerHTML = certificateHtml(c, true);
  }

  /** Tutte 证书的通用渲染（一般复核 / 固定预演共用，措辞已在各检查项中区分）。 */
  function certificateHtml(c, isFixed) {
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
      `<h3>凭${isFixed ? '剩余图（仅含删去固定两端后的通道与边）' : '原图'}逐项核对</h3>` +
      '<ul class="checks">' +
      c.checks
        .map((k) => `<li class="${k.ok ? 'ok' : 'bad'}">${k.ok ? '✓' : '✗'} ${esc(k.label)}</li>`)
        .join('') +
      '</ul>' +
      (allChecksOk
        ? `<p class="verify-ok">证书全部核对项通过，可直接在${isFixed ? '剩余图上' : '录入的原图上'}复验。</p>`
        : '');

    return (
      `<div class="cert-grid"><div><h3>移除集合 S（${c.removed.length} 个）</h3>${removedHtml}</div>` +
      `<div><h3>移除后的奇数连通分量（${c.oddComponents.length} 个）</h3><div class="comps">${compsHtml}</div></div></div>` +
      checksHtml
    );
  }

  // ---------- 状态 / 错误 / 清空 ----------

  function showErrors(errors) {
    errorsEl.innerHTML =
      '<div class="error-box"><strong>输入无法复核：</strong><ul>' +
      errors.map((m) => `<li>${esc(m)}</li>`).join('') +
      '</ul></div>';
  }

  function showFixedErrors(errors) {
    fixedErrorsEl.innerHTML =
      '<div class="error-box"><strong>固定配对复核无法进行（旧的固定配对结论已清除）：</strong><ul>' +
      errors.map((m) => `<li>${esc(m)}</li>`).join('') +
      '</ul></div>';
  }

  function clearResult() {
    resultEl.hidden = true;
    resultHeadEl.innerHTML = '';
    resultBodyEl.innerHTML = '';
  }

  function clearFixedResult() {
    fixedResultEl.hidden = true;
    fixedResultHeadEl.innerHTML = '';
    fixedResultBodyEl.innerHTML = '';
  }

  function setStatus(kind, text) {
    statusEl.className = 'status ' + kind;
    statusEl.textContent = text;
  }

  function setFixedStatus(kind, text) {
    fixedStatusEl.className = 'status ' + kind;
    fixedStatusEl.textContent = text;
  }

  function setButtonsBusy(which) {
    runBtn.disabled = true;
    fixedRunBtn.disabled = true;
    if (which === 'fixed') {
      fixedRunBtn.textContent = '固定复核中…';
    } else {
      runBtn.textContent = '复核中…';
    }
  }

  function setButtonsIdle() {
    runBtn.disabled = false;
    fixedRunBtn.disabled = false;
    runBtn.textContent = '复核配对';
    fixedRunBtn.textContent = '固定配对复核';
  }

  function note(text) {
    return `<p class="muted">${esc(text)}</p>`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
    );
  }

  // ---------- 事件 ----------

  runBtn.addEventListener('click', () => {
    seq++;
    setButtonsBusy('general');
    errorsEl.innerHTML = '';
    setStatus('running', '正在 Web Worker 中按一般图语义执行 Edmonds 缩花…');
    spawnWorker();
    worker.postMessage({
      seq,
      mode: 'general',
      channelsText: channelsEl.value,
      edgesText: edgesEl.value,
    });
  });

  fixedRunBtn.addEventListener('click', () => {
    seq++;
    setButtonsBusy('fixed');
    fixedErrorsEl.innerHTML = '';
    setFixedStatus('running', '正在 Worker 中校验固定边，并在删去固定两端后的剩余图上执行 Edmonds 缩花…');
    spawnWorker();
    worker.postMessage({
      seq,
      mode: 'fixed',
      channelsText: channelsEl.value,
      edgesText: edgesEl.value,
      fixedA: fixedAEl.value,
      fixedB: fixedBEl.value,
    });
  });

  clearBtn.addEventListener('click', () => {
    channelsEl.value = '';
    edgesEl.value = '';
    fixedAEl.value = '';
    fixedBEl.value = '';
    seq++;
    clearResult();
    clearFixedResult();
    errorsEl.innerHTML = '';
    fixedErrorsEl.innerHTML = '';
    setStatus('idle', '');
    setFixedStatus('idle', '');
  });

  sampleBtn.addEventListener('click', () => {
    // 星型 K1,3：4 个通道仅经中心兼容。Tutte 证书 S={中心}，
    // 删除后得到 3 个单点奇分量，3 > 1，无法完整配对。
    channelsEl.value = 'CH-0 CH-1 CH-2 CH-3';
    edgesEl.value = 'CH-0 CH-1\nCH-0 CH-2\nCH-0 CH-3';
  });

  sampleBlossomBtn.addEventListener('click', () => {
    // 含两个奇环（三角花）的一般图：必须真正执行缩花才能找到完美匹配，
    // 二分图语义无法处理此类图。
    channelsEl.value = 'CH-A1 CH-A2 CH-A3 CH-B1 CH-B2 CH-B3';
    edgesEl.value =
      'CH-A1 CH-A2\nCH-A2 CH-A3\nCH-A3 CH-A1\n' +
      'CH-B1 CH-B2\nCH-B2 CH-B3\nCH-B3 CH-B1\n' +
      'CH-A1 CH-B1';
  });

  spawnWorker();
})();
