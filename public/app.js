(() => {
  'use strict';

  const MAX = 8000;
  const STORE_KEY = 'shoucheng.v1';

  const TASKS = {
    history: {
      title: '病史生成',
      hint: '输入零散的病史要点（关键词、短句、口语都可以），生成连贯规范的病史。',
      label: '病史要点',
      placeholder: '例如：\n女 44岁 左乳肿物3月 无痛 渐大\n高血压10年 最高180/110 氨氯地平5mg 一天一次\n2001年剖宫产\n青霉素过敏',
      example: '女 44岁 左乳肿物3月 无痛 渐大 近1月明显 无乳头溢液\n外院B超 左乳外上 2.1x1.8cm 低回声 形态不规则 BI-RADS 4c\n穿刺病理：浸润性导管癌\n高血压10年 最高180/110 吃氨氯地平5mg 一天一次 平时130/80左右\n2001年剖宫产\n青霉素过敏\n不抽烟不喝酒 已婚 G2P1\n月经规律 13岁初潮 5/28天\n母亲有糖尿病',
      chain: [
        { to: 'features', label: '提炼病历特点' },
        { to: 'differential', label: '写鉴别诊断' },
      ],
    },
    features: {
      title: '病历特点',
      hint: '粘贴完整的病史（越详细越好），提炼成分条的病历特点。',
      label: '完整病史',
      placeholder: '粘贴现病史、既往史、查体、辅助检查等完整内容……',
      example: '患者女，44岁，因"发现左乳肿物3个月"入院。患者3个月前无意中发现左乳肿物，约蚕豆大小，无疼痛，无乳头溢液，未予重视。近1个月自觉肿物明显增大。于外院行乳腺B超示：左乳外上象限低回声结节，大小约2.1×1.8cm，形态不规则，边缘呈毛刺状，BI-RADS 4c类。行超声引导下穿刺活检，病理示：浸润性导管癌。患者自发病以来，精神、食欲、睡眠可，大小便正常，体重无明显变化。\n既往史：高血压病史10年，血压最高180/110mmHg，规律口服氨氯地平5mg qd，血压控制在130/80mmHg左右。否认糖尿病、冠心病病史。2001年行剖宫产术。否认输血史。青霉素过敏。\n个人史：无吸烟、饮酒史。\n婚育史：已婚，G2P1。\n家族史：母亲患2型糖尿病。\n查体：T 36.5℃，P 78次/分，R 18次/分，BP 132/82mmHg。双乳对称，左乳外上象限可触及一大小约2×2cm肿物，质硬，边界不清，活动度差，无压痛，皮肤无橘皮样改变，乳头无内陷。左腋下未触及肿大淋巴结。',
      chain: [{ to: 'differential', label: '写鉴别诊断' }],
    },
    differential: {
      title: '鉴别诊断',
      hint: '填写初步诊断，并粘贴病史或病历特点，生成鉴别诊断。',
      label: '病史 / 病历特点',
      placeholder: '粘贴病史或病历特点……',
      exampleDiagnosis: '左乳浸润性导管癌',
      example: '1. 中年女性，44岁。\n2. 慢性起病，病程3个月，近1个月肿物增大。\n3. 左乳无痛性肿物；无乳头溢液。\n4. 既往高血压病史10年，口服氨氯地平5mg qd，控制可；2001年剖宫产；青霉素过敏。\n5. 查体：左乳外上象限约2×2cm肿物，质硬，边界不清，活动度差；皮肤无橘皮样改变；左腋下未触及肿大淋巴结。\n6. 辅助检查：乳腺B超示左乳外上象限低回声结节2.1×1.8cm，形态不规则，边缘毛刺，BI-RADS 4c类；穿刺病理示浸润性导管癌。',
      chain: [],
    },
  };

  // ---------- 状态 ----------
  const state = {
    active: 'history',
    data: {
      history: { input: '', output: '' },
      features: { input: '', output: '' },
      differential: { input: '', diagnosis: '', output: '' },
    },
    running: {}, // task -> AbortController
    errors: {},
  };

  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && saved.data) {
      for (const k of Object.keys(state.data)) Object.assign(state.data[k], saved.data[k] || {});
      if (TASKS[saved.active]) state.active = saved.active;
    }
  } catch { /* 浏览器存储不可用时忽略 */ }

  let saveTimer;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ active: state.active, data: state.data })); } catch { /* ignore */ }
    }, 300);
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    tabs: $('tabs'), model: $('model'),
    inputTitle: $('input-title'), inputHint: $('input-hint'), inputLabel: $('input-label'),
    diagField: $('diag-field'), diagnosis: $('diagnosis'),
    input: $('input'), counter: $('counter'),
    btnExample: $('btn-example'), btnClear: $('btn-clear'), btnGenerate: $('btn-generate'),
    btnRegen: $('btn-regen'), btnCopy: $('btn-copy'),
    output: $('output'), empty: $('empty'), md: $('md'), error: $('error'), chain: $('chain'),
    toast: $('toast'),
  };
  const isMobile = () => window.matchMedia('(max-width: 899px)').matches;

  marked.setOptions({ gfm: true, breaks: true });
  const renderMd = (text) => DOMPurify.sanitize(marked.parse(text));

  // ---------- 渲染 ----------
  function renderTab() {
    const t = state.active;
    const cfg = TASKS[t];
    const d = state.data[t];

    for (const b of el.tabs.querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b.dataset.task === t));
    }
    el.inputTitle.textContent = cfg.title;
    el.inputHint.textContent = cfg.hint;
    el.inputLabel.textContent = cfg.label;
    el.input.placeholder = cfg.placeholder;
    el.input.value = d.input;
    el.diagField.hidden = t !== 'differential';
    if (t === 'differential') el.diagnosis.value = d.diagnosis || '';
    updateCounter();
    autoGrow();
    renderOutput();
  }

  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderOutput(); });
  }

  function renderOutput() {
    const t = state.active;
    const d = state.data[t];
    const running = !!state.running[t];
    const has = !!d.output;

    el.empty.hidden = has || running;
    el.md.innerHTML = has ? renderMd(d.output) : '';
    el.md.classList.toggle('streaming', running);

    if (!isMobile() && running) el.output.scrollTop = el.output.scrollHeight;

    el.btnGenerate.classList.toggle('stop', running);
    el.btnGenerate.innerHTML = running
      ? '<span class="spinner"></span><span class="btn-label">停止</span>'
      : '<span class="btn-label">生成</span>';
    el.btnRegen.disabled = running || !has;
    el.btnCopy.disabled = running || !has;

    const err = state.errors[t];
    el.error.hidden = !err;
    el.error.textContent = err || '';

    const chain = TASKS[t].chain;
    if (has && !running && chain.length) {
      el.chain.hidden = false;
      el.chain.innerHTML = '<span class="chain-label">用这份结果继续：</span>';
      for (const c of chain) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small chain-btn';
        b.textContent = `→ ${c.label}`;
        b.addEventListener('click', () => chainTo(c.to));
        el.chain.appendChild(b);
      }
    } else {
      el.chain.hidden = true;
    }
  }

  function updateCounter() {
    const n = el.input.value.length;
    el.counter.textContent = `${n} / ${MAX}`;
    el.counter.classList.toggle('over', n > MAX);
  }

  function autoGrow() {
    if (!isMobile()) { el.input.style.height = ''; return; }
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.max(180, el.input.scrollHeight + 2)}px`;
  }

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1800);
  }

  // 输出转纯文本（去掉 Markdown 符号），方便粘贴进 HIS 系统
  function plainText(task) {
    const div = document.createElement('div');
    div.innerHTML = renderMd(state.data[task].output);
    div.querySelectorAll('li').forEach((li) => {
      const parent = li.parentElement;
      if (parent && parent.tagName === 'OL') {
        const idx = Array.prototype.indexOf.call(parent.children, li) + (Number(parent.getAttribute('start')) || 1);
        li.prepend(`${idx}. `);
      } else {
        li.prepend('- ');
      }
      li.append('\n');
    });
    div.querySelectorAll('p, h1, h2, h3, h4, blockquote').forEach((n) => n.append('\n\n'));
    div.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    div.querySelectorAll('ul, ol').forEach((n) => n.append('\n'));
    return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('已复制');
  }

  // ---------- 生成 ----------
  async function generate(task) {
    const d = state.data[task];
    const input = d.input.trim();
    if (!input) { toast('请先输入内容'); el.input.focus(); return; }
    if (input.length > MAX) { toast(`内容过长（最多 ${MAX} 字）`); return; }

    const ctrl = new AbortController();
    state.running[task] = ctrl;
    state.errors[task] = '';
    d.output = '';
    renderOutput();
    if (isMobile()) el.output.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const resp = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, input, diagnosis: task === 'differential' ? (d.diagnosis || '').trim() : undefined }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        let msg = `请求失败（${resp.status}）`;
        try { msg = (await resp.json()).error || msg; } catch { /* ignore */ }
        throw new Error(msg);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          if (data === '[DONE]') { finished = true; break; }
          const json = JSON.parse(data);
          if (event === 'error') throw new Error(json.message || '生成失败');
          if (json.delta) {
            d.output += json.delta;
            if (state.active === task) scheduleRender();
          }
        }
      }
      if (!finished && !d.output) throw new Error('连接中断，请重试');
    } catch (err) {
      if (err.name !== 'AbortError') state.errors[task] = err.message || '生成失败';
    } finally {
      delete state.running[task];
      save();
      if (state.active === task) renderOutput();
    }
  }

  function chainTo(target) {
    const src = state.active;
    const text = plainText(src);
    state.data[target].input = text;
    switchTab(target);
    if (target === 'differential' && !state.data.differential.diagnosis) {
      el.diagnosis.focus();
      toast('请填写初步诊断后点击生成');
    } else {
      generate(target);
    }
  }

  function switchTab(task) {
    if (!TASKS[task] || task === state.active) return;
    state.active = task;
    renderTab();
    save();
    window.scrollTo({ top: 0 });
  }

  // ---------- 事件 ----------
  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-task]');
    if (b) switchTab(b.dataset.task);
  });

  el.input.addEventListener('input', () => {
    state.data[state.active].input = el.input.value;
    updateCounter();
    autoGrow();
    save();
  });
  el.diagnosis.addEventListener('input', () => {
    state.data.differential.diagnosis = el.diagnosis.value;
    save();
  });
  el.diagnosis.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); generate('differential'); }
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); el.btnGenerate.click(); }
  });

  el.btnGenerate.addEventListener('click', () => {
    const t = state.active;
    if (state.running[t]) state.running[t].abort();
    else generate(t);
  });
  el.btnRegen.addEventListener('click', () => generate(state.active));
  el.btnCopy.addEventListener('click', () => copyText(plainText(state.active)));

  el.btnExample.addEventListener('click', () => {
    const t = state.active;
    const cfg = TASKS[t];
    state.data[t].input = cfg.example;
    if (cfg.exampleDiagnosis) state.data[t].diagnosis = cfg.exampleDiagnosis;
    renderTab();
    save();
  });
  el.btnClear.addEventListener('click', () => {
    const t = state.active;
    if (state.running[t]) state.running[t].abort();
    state.data[t].input = '';
    state.data[t].output = '';
    if (t === 'differential') state.data[t].diagnosis = '';
    state.errors[t] = '';
    renderTab();
    save();
    el.input.focus();
  });

  window.addEventListener('resize', autoGrow);

  fetch('/api/health').then((r) => r.json()).then((j) => {
    el.model.textContent = j.model === 'mock' ? '演示模式' : j.model;
  }).catch(() => {});

  renderTab();
})();
