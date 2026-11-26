'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');

// ---------- 配置 ----------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.DASHSCOPE_API_KEY || '';
const MODEL = process.env.QWEN_MODEL || 'qwen-max';
const BASE_URL = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 10);
const MAX_INPUT = Number(process.env.MAX_INPUT_CHARS) || 8000;
const MOCK = process.env.MOCK === '1' || !API_KEY;
const UPSTREAM_TIMEOUT_MS = 180_000;

// ---------- Prompt ----------
const PROMPT_DIR = path.join(__dirname, 'prompts');
const readPrompt = (name) => fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), 'utf8').trim();
const COMMON = readPrompt('common');

const TASKS = {
  history: { prompt: readPrompt('history'), temperature: 0.4, label: '病史生成' },
  features: { prompt: readPrompt('features'), temperature: 0.2, label: '病历特点' },
  differential: { prompt: readPrompt('differential'), temperature: 0.3, label: '鉴别诊断' },
};

function buildMessages(task, input, diagnosis) {
  const system = `${COMMON}\n\n---\n\n${TASKS[task].prompt}`;
  let user;
  if (task === 'differential') {
    user = `初步诊断：${diagnosis || '（医生未填写）'}\n\n患者资料：\n${input}`;
  } else if (task === 'history') {
    user = `以下是医生提供的病史要点：\n${input}`;
  } else {
    user = `以下是患者病史：\n${input}`;
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---------- 应用 ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1)); // 部署在 Nginx 后面

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: MOCK ? 'mock' : MODEL });
});

const apiJson = express.json({ limit: '64kb' });
const limiter = RATE_LIMIT > 0
  ? rateLimit({
      windowMs: 60_000,
      limit: RATE_LIMIT,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: `请求太频繁，请稍后再试（每分钟最多 ${RATE_LIMIT} 次）` },
    })
  : (req, res, next) => next();

app.post('/api/generate', limiter, apiJson, async (req, res) => {
  const { task, input, diagnosis } = req.body || {};
  if (!TASKS[task]) return res.status(400).json({ error: '未知任务类型' });
  if (typeof input !== 'string' || !input.trim()) return res.status(400).json({ error: '请输入内容' });
  if (input.length > MAX_INPUT) return res.status(400).json({ error: `内容过长（最多 ${MAX_INPUT} 字）` });
  if (diagnosis != null && (typeof diagnosis !== 'string' || diagnosis.length > 500)) {
    return res.status(400).json({ error: '初步诊断格式不正确' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const sendError = (message) => res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), UPSTREAM_TIMEOUT_MS);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client closed'));
  });

  try {
    if (MOCK) {
      await mockStream(task, send, controller.signal);
    } else {
      await qwenStream(buildMessages(task, input.trim(), diagnosis?.trim()), TASKS[task].temperature, send, controller.signal);
    }
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
  } catch (err) {
    if (!controller.signal.aborted || String(controller.signal.reason?.message) === 'timeout') {
      console.error(`[generate] ${task} failed:`, err.message); // 只记录错误，不记录病历内容
      if (!res.writableEnded) sendError(friendlyError(err));
    }
  } finally {
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  }
});

function friendlyError(err) {
  if (err.status === 401 || err.status === 403) return '模型 API Key 无效或无权限，请联系管理员检查配置';
  if (err.status === 429) return '模型调用太频繁或额度不足，请稍后再试';
  if (err.status === 400) return `模型拒绝了请求：${err.detail || '参数错误'}`;
  if (err.name === 'AbortError' || /timeout/i.test(err.message)) return '模型响应超时，请重试';
  return '生成失败，请稍后重试';
}

// ---------- 调用通义千问（DashScope OpenAI 兼容接口，流式） ----------
async function qwenStream(messages, temperature, send, signal) {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, messages, temperature, stream: true }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let detail = '';
    try { detail = JSON.parse(text)?.error?.message || ''; } catch { /* ignore */ }
    const err = new Error(`upstream ${resp.status}: ${text.slice(0, 300)}`);
    err.status = resp.status;
    err.detail = detail;
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) send({ delta });
    }
  }
}

// ---------- 无 API Key 时的模拟输出（用于本地调试） ----------
const MOCK_TEXT = {
  history: '**主诉：** 发现左乳肿物3个月。\n\n**现病史：** 患者3个月前发现左乳肿物，无疼痛，肿物逐渐增大。于外院行乳腺B超检查，提示BI-RADS 4c类；行穿刺活检，病理示浸润性导管癌。\n\n**既往史：** 高血压病史10年，血压最高达180/110 mmHg，规律口服氨氯地平5 mg，每日1次，血压控制在130/80 mmHg左右。2001年行剖宫产术。\n\n**个人史：** 未提及。\n\n**婚育史：** 2001年剖宫产1次。\n\n**月经史：** 未提及。\n\n**家族史：** 未提及。\n\n> （这是模拟输出：服务器未配置 DASHSCOPE_API_KEY）',
  features: '1. **一般情况**：中年女性，44岁。\n2. **起病与病程**：慢性起病，病程3个月。\n3. **主要症状**：左乳无痛性肿物，逐渐增大。\n4. **既往史**：高血压病史10年，口服氨氯地平5 mg qd；2001年行剖宫产术。\n5. **辅助检查**：乳腺B超BI-RADS 4c类；穿刺病理示浸润性导管癌。\n\n> （这是模拟输出：服务器未配置 DASHSCOPE_API_KEY）',
  differential: '**初步诊断：** 左乳浸润性导管癌\n\n### 1. 乳腺纤维腺瘤\n- **典型特点：** 好发于18–25岁女性，肿物边界清、活动度好、质韧，生长缓慢。\n- **本患者支持点：** 无痛性乳腺肿物。\n- **不支持点：** 44岁，肿物渐大，BI-RADS 4c，病理为浸润性导管癌。\n- **结论：** 可排除。病理已明确诊断。\n\n### 2. 乳腺囊肿\n- **典型特点：** 圆形、边界清楚、有囊性感，B超为无回声区。\n- **本患者支持点：** 无。\n- **不支持点：** B超为实性可疑病灶，病理为癌。\n- **结论：** 可排除。\n\n### 建议完善的检查\n- 乳腺MRI\n- 免疫组化（ER、PR、HER2、Ki-67）\n\n> （这是模拟输出：服务器未配置 DASHSCOPE_API_KEY）',
};

async function mockStream(task, send, signal) {
  const chars = Array.from(MOCK_TEXT[task]);
  for (let i = 0; i < chars.length; i += 3) {
    if (signal.aborted) throw new Error('aborted');
    send({ delta: chars.slice(i, i + 3).join('') });
    await new Promise((r) => setTimeout(r, 15));
  }
}

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, HOST, () => {
  console.log(`首程助手已启动：http://${HOST}:${PORT}  模型：${MOCK ? 'MOCK（未配置 API Key）' : MODEL}`);
});
