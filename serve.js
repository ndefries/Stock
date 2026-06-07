const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const root = __dirname;
const configPath = path.join(root, 'config.json');
const outputDir = path.join(root, 'meetings');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', md: 'text/markdown' };

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (_) { return {}; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Find the claude CLI — handles Windows .cmd wrappers and Unix PATH
function findClaudeCLI() {
  const isWin = process.platform === 'win32';

  // Build candidate list — try multiple ways to locate npm bin on Windows
  const candidates = [];
  if (isWin) {
    const appdata = process.env.APPDATA
      || path.join(require('os').homedir(), 'AppData', 'Roaming');
    candidates.push(
      path.join(appdata, 'npm', 'claude.cmd'),
      path.join(appdata, 'npm', 'claude'),
    );
    // Also try PATH via cmd shell
    candidates.push('claude');
  } else {
    candidates.push(
      '/usr/local/bin/claude',
      path.join(require('os').homedir(), '.npm-global', 'bin', 'claude'),
      'claude',
    );
  }

  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { timeout: 5000, stdio: 'pipe', shell: isWin });
      return c;
    } catch (_) {}
  }
  return null;
}

// Run claude CLI with a prompt via stdin, return the response text
function runClaudeCLI(prompt) {
  return new Promise((resolve, reject) => {
    const cli = findClaudeCLI();
    if (!cli) { reject(new Error('claude_not_found')); return; }

    const isWin = process.platform === 'win32';
    const { spawn } = require('child_process');
    const child = spawn(cli, ['--print', '--output-format', 'text'], {
      timeout: 120000,
      shell: isWin
    });

    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new Error(stderr || `claude exited with code ${code}`)); return; }
      resolve(stdout.trim());
    });

    // Send prompt via stdin and close it
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Fallback: use Anthropic SDK if API key is configured
async function runAnthropicSDK(prompt) {
  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.apiKey.includes('YOUR-KEY')) throw new Error('no_api_key');
  const { Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const message = await client.messages.create({
    model: cfg.model || 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });
  return message.content[0].text;
}

async function runAI(prompt) {
  // Try CLI first (works with corporate/SSO accounts, no API key)
  try { return await runClaudeCLI(prompt); }
  catch (e) {
    if (e.message !== 'claude_not_found') throw e;
  }
  // Fall back to SDK with API key
  return await runAnthropicSDK(prompt);
}

function parseSummaryResponse(content) {
  const summaryMatch = content.match(/SUMMARY:\s*([\s\S]*?)(?=ACTIONS_JSON:|$)/);
  const actionsMatch = content.match(/ACTIONS_JSON:\s*([\s\S]*)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : content;
  let actions = [];
  if (actionsMatch) {
    try { actions = JSON.parse(actionsMatch[1].trim().replace(/```json\n?|\n?```/g, '')); }
    catch (_) {}
  }
  return { summary, actions };
}

function saveMeetingFile(title, date, duration, transcript, summary, actions) {
  const safe = (title || 'untitled').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const dateStr = new Date(date || Date.now()).toISOString().slice(0, 10);
  const filename = `${dateStr}-${safe}.md`;
  const filepath = path.join(outputDir, filename);
  const actionRows = actions.length
    ? actions.map(a => `| ${a.action||''} | ${a.owner||'TBC'} | ${a.dueDate||'TBC'} | ${a.priority||'medium'} |`).join('\n')
    : '| No actions identified | — | — | — |';
  fs.writeFileSync(filepath, `# ${title || 'Untitled Meeting'}

**Date:** ${new Date(date || Date.now()).toLocaleString('en-GB')}
**Duration:** ${duration || 'N/A'}

---

## Summary

${summary}

---

## Action Items

| Action | Owner | Due Date | Priority |
|--------|-------|----------|----------|
${actionRows}

---

## Transcript / Notes

${transcript || ''}
`, 'utf8');
  return filename;
}

// Detect what auth method is available
function getAuthStatus() {
  const cli = findClaudeCLI();
  const cfg = loadConfig();
  const hasKey = !!(cfg.apiKey && !cfg.apiKey.includes('YOUR-KEY'));
  return {
    ready: !!(cli || hasKey),
    method: cli ? 'cli' : hasKey ? 'apikey' : 'none',
    model: cfg.model || 'claude-sonnet-4-6'
  };
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────
function supabaseRequest(method, path, body, cfg) {
  return new Promise((resolve, reject) => {
    const u = new URL(cfg.supabaseUrl);
    const postData = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      path: `/rest/v1/${path}`,
      port: 443,
      method,
      headers: {
        'apikey': cfg.supabaseKey,
        'Authorization': `Bearer ${cfg.supabaseKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(method === 'POST' ? { 'Prefer': 'resolution=merge-duplicates,return=minimal' } : {}),
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      }
    };
    const r = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

async function supabaseGetPortfolio(cfg) {
  const r = await supabaseRequest('GET', 'portfolio?key=eq.main&select=data', null, cfg);
  if (r.status !== 200) throw new Error(`Supabase GET ${r.status}: ${r.body}`);
  const rows = JSON.parse(r.body);
  return rows.length ? rows[0].data : { watchlist: [], holdings: [] };
}

async function supabaseSavePortfolio(data, cfg) {
  const r = await supabaseRequest('POST', 'portfolio', {
    key: 'main',
    data,
    updated_at: new Date().toISOString()
  }, cfg);
  if (r.status >= 300) throw new Error(`Supabase POST ${r.status}: ${r.body}`);
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Yahoo Finance chart API (no auth required) ───────────────────────────────
const YH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchChart(symbol) {
  return new Promise((resolve, reject) => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const r = https.request({
      hostname: 'query1.finance.yahoo.com', path, port: 443,
      maxHeaderSize: 65536,
      headers: { 'User-Agent': YH_UA }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          const result = d?.chart?.result?.[0];
          if (!result) { resolve(null); return; }
          const meta = result.meta;
          const q = result.indicators?.quote?.[0] || {};
          const price = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose;
          resolve({
            symbol: meta.symbol,
            shortName: meta.longName || meta.shortName || symbol,
            currency: meta.currency,
            regularMarketPrice: price,
            regularMarketOpen: q.open?.[0] ?? null,
            regularMarketDayHigh: q.high?.[0] ?? meta.regularMarketDayHigh ?? null,
            regularMarketDayLow: q.low?.[0] ?? meta.regularMarketDayLow ?? null,
            regularMarketVolume: q.volume?.[0] ?? meta.regularMarketVolume ?? null,
            regularMarketPreviousClose: prevClose,
            regularMarketChange: prevClose != null ? price - prevClose : null,
            regularMarketChangePercent: prevClose != null ? ((price - prevClose) / prevClose) * 100 : null,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
          });
        } catch(e) { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.end();
  });
}

async function yahooQuote(symbolsStr) {
  const symbols = symbolsStr.split(',').map(s => s.trim()).filter(Boolean);
  const results = await Promise.all(symbols.map(fetchChart));
  return JSON.stringify({ quoteResponse: { result: results.filter(Boolean) } });
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, port: 443,
      maxHeaderSize: 131072,
      headers: { 'User-Agent': YH_UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    r.on('error', () => resolve(''));
    r.end();
  });
}

function extractDataField(html, field) {
  const m = html.match(new RegExp('data-field="' + field + '"[^>]*>([^<]+)<'));
  return m ? m[1].trim() : null;
}

function extractRawNum(html, key) {
  const m = html.match(new RegExp(key + '.{1,30}raw.{1,10}:([0-9]+)'));
  return m ? parseInt(m[1], 10) : null;
}

function extractDesc(html) {
  const m = html.match(/longBusinessSummary.{1,20}"([^"]{80,})"/);
  return m ? m[1] : null;
}

function extractSectorIndustry(html) {
  const decoded = html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
  // Extract from anchor hrefs pointing to /sectors/ and /industries/
  const sectorM = decoded.match(/href="\/sectors\/[^"]*"\s*[^>]*>([^<]+)</);
  const industryM = decoded.match(/href="\/industries\/[^"]*"\s*[^>]*>([^<]+)</);
  return {
    sector: sectorM ? sectorM[1].trim() : null,
    industry: industryM ? industryM[1].trim() : null,
  };
}

function parseFormattedNum(s) {
  if (!s) return null;
  const map = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 };
  const m = s.match(/([\d.]+)([TBMK]?)/);
  if (!m) return null;
  return parseFloat(m[1]) * (map[m[2]] || 1);
}

async function fetchDetail(symbol) {
  const [quoteHtml, profileHtml, chart, history] = await Promise.all([
    fetchHtml(`https://finance.yahoo.com/quote/${symbol}/`),
    fetchHtml(`https://finance.yahoo.com/quote/${symbol}/profile/`),
    fetchChart(symbol),
    fetchHistoryData(symbol, '1y', '1wk'),
  ]);
  const mcStr = extractDataField(quoteHtml, 'marketCap');
  const { sector, industry } = extractSectorIndustry(profileHtml);
  return {
    ...chart,
    marketCapStr: mcStr,
    marketCap: parseFormattedNum(mcStr),
    sharesOutstanding: extractRawNum(quoteHtml, 'impliedSharesOutstanding'),
    trailingPE: parseFloat(extractDataField(quoteHtml, 'trailingPE')) || null,
    targetMeanPrice: parseFloat(extractDataField(quoteHtml, 'targetMeanPrice')) || null,
    description: extractDesc(profileHtml),
    sector,
    industry,
    history,
  };
}

function fetchHistoryData(symbol, range, interval) {
  return new Promise((resolve) => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const r = https.request({
      hostname: 'query1.finance.yahoo.com', path, port: 443,
      maxHeaderSize: 65536,
      headers: { 'User-Agent': YH_UA }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          const result = d?.chart?.result?.[0];
          if (!result) { resolve([]); return; }
          const ts = result.timestamp || [];
          const q = result.indicators?.quote?.[0] || {};
          const rows = ts.map((t, i) => ({
            date: new Date(t * 1000).toISOString().slice(0, 10),
            open: q.open?.[i] ?? null,
            high: q.high?.[i] ?? null,
            low: q.low?.[i] ?? null,
            close: q.close?.[i] ?? null,
            volume: q.volume?.[i] ?? null,
          })).filter(r => r.close != null);
          resolve(rows);
        } catch(e) { resolve([]); }
      });
    });
    r.on('error', () => resolve([]));
    r.end();
  });
}
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = req.url.split('?')[0];

  // GET /api/status
  if (req.method === 'GET' && url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAuthStatus()));
    return;
  }

  // POST /api/setup (API key fallback path)
  if (req.method === 'POST' && url === '/api/setup') {
    try {
      const body = JSON.parse(await readBody(req));
      const cfg = loadConfig();
      cfg.apiKey = (body.apiKey || '').trim();
      cfg.model = body.model || cfg.model || 'claude-sonnet-4-6';
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/summarise
  if (req.method === 'POST' && url === '/api/summarise') {
    const status = getAuthStatus();
    if (!status.ready) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'setup_required' }));
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const { text, title, date, duration, transcript } = body;

      const prompt = `You are a meeting assistant. Analyse this meeting transcript/notes and produce:

1. A concise executive summary (3-5 sentences covering key decisions and discussion points)
2. A JSON array of action items:
[{"action":"task description","owner":"person name or empty string","dueDate":"YYYY-MM-DD or empty string","priority":"high|medium|low"}]

Meeting Title: ${title}
Transcript/Notes:
${text}

Respond with exactly:
SUMMARY:
<summary text>

ACTIONS_JSON:
<json array>`;

      const content = await runAI(prompt);
      const { summary, actions } = parseSummaryResponse(content);
      const filename = saveMeetingFile(title, date, duration, transcript, summary, actions);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary, actions, filename }));

    } catch(e) {
      let msg = e.message || 'Unknown error';
      if (msg === 'no_api_key') msg = 'setup_required';
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  // GET /api/appdata  — load persisted meetings + tasks
  if (req.method === 'GET' && url === '/api/appdata') {
    const dataPath = path.join(root, 'appdata.json');
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ meetings: [], tasks: [] }));
    }
    return;
  }

  // POST /api/appdata  — save meetings + tasks
  if (req.method === 'POST' && url === '/api/appdata') {
    try {
      const body = await readBody(req);
      fs.writeFileSync(path.join(root, 'appdata.json'), body, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/quote?symbols=BHP.AX,CBA.AX  — proxy Yahoo Finance (avoids CORS)
  if (req.method === 'GET' && url === '/api/quote') {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const symbols = qs.get('symbols') || '';
    if (!symbols) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbols required' }));
      return;
    }
    try {
      const data = await yahooQuote(symbols);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/detail?symbol=BHP.AX
  if (req.method === 'GET' && url === '/api/detail') {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const symbol = qs.get('symbol') || '';
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol required' }));
      return;
    }
    try {
      const data = await fetchDetail(symbol);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/portfolio
  if (req.method === 'GET' && url === '/api/portfolio') {
    const cfg = loadConfig();
    const portfolioPath = path.join(root, 'portfolio.json');
    // Try Supabase first, fall back to local file
    if (cfg.supabaseUrl && cfg.supabaseKey) {
      try {
        const data = await supabaseGetPortfolio(cfg);
        // Keep local file in sync
        fs.writeFileSync(portfolioPath, JSON.stringify(data), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      } catch(e) {
        console.warn('Supabase read failed, falling back to local:', e.message);
      }
    }
    try {
      const data = JSON.parse(fs.readFileSync(portfolioPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ watchlist: [], holdings: [] }));
    }
    return;
  }

  // POST /api/portfolio
  if (req.method === 'POST' && url === '/api/portfolio') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const cfg = loadConfig();
      // Save to local file always (fast, offline backup)
      fs.writeFileSync(path.join(root, 'portfolio.json'), body, 'utf8');
      // Save to Supabase (async, don't block the response)
      if (cfg.supabaseUrl && cfg.supabaseKey) {
        supabaseSavePortfolio(data, cfg).catch(e =>
          console.warn('Supabase write failed:', e.message)
        );
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/files
  if (req.method === 'GET' && url === '/api/files') {
    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.md')).sort().reverse()
      .map(f => ({ name: f, url: `/meetings/${f}` }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  // Static files
  const filePath = url === '/' ? '/meeting-notes.html' : url;
  const full = path.join(root, filePath);
  if (!full.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(full).slice(1);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

const cfg = loadConfig();
const port = cfg.port || 8080;
server.listen(port, '127.0.0.1', () => {
  const status = getAuthStatus();
  console.log(`\n✓ Meeting Notes running at http://localhost:${port}/meeting-notes.html`);
  if (status.method === 'cli')    console.log('  → Using Claude Code CLI (no API key needed)\n');
  else if (status.method === 'apikey') console.log('  → Using API key from config.json\n');
  else console.log('  ⚠  Run "claude" in terminal to log in, then restart this server.\n');
});
