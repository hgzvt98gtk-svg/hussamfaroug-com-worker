import { performance } from 'perf_hooks';
import { HTMLRewriter as WasmHTMLRewriter } from 'html-rewriter-wasm';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { convertMd } from '../markdown.js';

// Same Workers API adapter as benchmark-markdown.mjs; no substitute regex parser.
globalThis.HTMLRewriter = class {
  constructor() { this.handlers = []; }
  on(selector, handler) { this.handlers.push(['on', selector, handler]); return this; }
  onDocument(handler) { this.handlers.push(['onDocument', handler]); return this; }
  transform(response) {
    const handlers = this.handlers;
    return new Response(new ReadableStream({
      async start(controller) {
        const rewriter = new WasmHTMLRewriter(chunk => controller.enqueue(chunk.slice()));
        try {
          for (const [method, ...args] of handlers) rewriter[method](...args);
          for await (const chunk of response.body) await rewriter.write(chunk);
          await rewriter.end();
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          rewriter.free();
        }
      }
    }), response);
  }
};

// Test fixtures
const fixtures = {
  small: {
    name: 'Small (10 KB)',
    html: '<h1>Test Article</h1>' + 
      '<p>This is a test paragraph.</p>'.repeat(50) +
      '<a href="https://example.com">Link</a>',
  },
  
  medium: {
    name: 'Medium (100 KB)',
    html: '<h1>Complex Article</h1>' +
      Array(100).fill().map((_, i) => 
        `<h2>Section ${i}</h2>` +
        '<p>Content with <strong>formatting</strong> and <em>emphasis</em>.</p>'.repeat(10) +
        `<a href="https://example.com/page${i}">Link ${i}</a>`
      ).join(''),
  },
  
  large: {
    name: 'Large (1 MB)',
    html: '<h1>Very Large Document</h1>' +
      Array(500).fill().map((_, i) => 
        `<h2>Section ${i}</h2>` +
        '<p>'.repeat(10) + 'Paragraph text. '.repeat(50) + '</p>'.repeat(10) +
        `<a href="https://example.com/link${i}">Link ${i}</a>`
      ).join(''),
  },
  
  complex: {
    name: 'Complex (50+ KB, deep nesting)',
    html: '<h1>Complex Nested HTML</h1>' +
      Array(50).fill().map((_, i) => 
        `<div id="section-${i}">` +
        `<h2>Section ${i}</h2>` +
        '<div>'.repeat(5) +
        '<p>Content with <strong>bold</strong> and <em>italic</em> and <code>code</code>.</p>'.repeat(10) +
        Array(20).fill(`<a href="https://example.com/link${i}">Link</a>`).join('') +
        '</div>'.repeat(5) +
        '</div>'
      ).join(''),
  }
};

function sizedHtml(bytes, unit, depth = 0) {
  const prefix = '<html><head><title>Profile</title></head><body><main>' + '<div>'.repeat(depth);
  const suffix = '</div>'.repeat(depth) + '</main></body></html>';
  const available = bytes - Buffer.byteLength(prefix + suffix);
  if (available < 0) throw new Error('Fixture size is smaller than nesting overhead');
  return prefix + unit.repeat(Math.floor(available / unit.length)) + ' '.repeat(available % unit.length) + suffix;
}

const complexUnit = '<h2>Heading</h2><p><strong>Bold</strong> and <em>emphasis</em> <a href="/page?q=1">link</a></p><ul><li>Item</li></ul><pre><code>const n = 1;</code></pre>';
for (const bytes of [50_000, 100_000, 500_000, 1_000_000]) {
  fixtures[`complex-${bytes}`] = {
    name: `Complex (${bytes} bytes, 128 div levels)`,
    html: sizedHtml(bytes, complexUnit, 128)
  };
}
for (const depth of [32, 128, 512]) {
  fixtures[`format-depth-${depth}`] = {
    name: `Formatting recursion (${depth} nested strong tags)`,
    html: '<h1>' + Array.from({ length: depth }, (_, i) => `<strong data-level="${i}">`).join('') +
      'text' + '</strong>'.repeat(depth) + '</h1>'
  };
}
for (const bytes of [50_000, 100_000, 500_000]) {
  for (const [name, unit] of [
    ['unclosed-headings', '<h1>text'],
    ['nested-headings', '<h1><h2><h1>text</h1></h2></h1>'],
    ['special-links', '<a href="/page?q=&amp;&quot;x">text &amp; *</a>'],
    ['unclosed-format', '<strong>text'],
    ['unclosed-titles', '<title>text']
  ]) {
    fixtures[`${name}-${bytes}`] = {
      name: `${name} (${bytes} bytes)`,
      html: name === 'unclosed-titles'
        ? unit.repeat(Math.floor(bytes / unit.length)) + ' '.repeat(bytes % unit.length)
        : sizedHtml(bytes, unit)
    };
  }
}

async function profile(key, fixture) {
console.log(`Testing: ${fixture.name}`);
console.log(`HTML size: ${Buffer.byteLength(fixture.html)} bytes\n`);
const times = [];
const componentTimes = { rewriter: [], markdown: [] };
const diagnostics = new Map();
const active = new Set();
function diagnostic(stage, phase, ms) {
  if (phase === 'start') {
    if (!active.has(stage)) {
      active.add(stage);
      parentPort?.postMessage({ stage });
    }
    return;
  }
  const entry = diagnostics.get(stage) || { calls: 0, inclusiveMs: 0, maxMs: 0 };
  entry.calls++;
  entry.inclusiveMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  diagnostics.set(stage, entry);
}
for (let i = 0; i < 3; i++) {
  active.clear();
  parentPort?.postMessage({ started: `warmup ${i + 1}` });
  await convertMd(fixture.html, 'https://example.com', undefined, diagnostic);
}
const iterations = key === 'large' ? 3 : key === 'complex' ? 5 : 10;
for (let i = 0; i < iterations; i++) {
  const start = performance.now();
  parentPort?.postMessage({ started: `iteration ${i + 1}` });
  const timing = { rewriter: 0, markdown: 0 };
  await convertMd(fixture.html, 'https://example.com', (stage, ms) => { timing[stage] = ms; });
  const elapsed = performance.now() - start;
  times.push(elapsed);
  for (const stage of ['rewriter', 'markdown']) componentTimes[stage].push(timing[stage]);
  console.log(`  Iteration ${i + 1}: ${elapsed.toFixed(3)}ms (rewriter: ${timing.rewriter.toFixed(3)}ms, markdown: ${timing.markdown.toFixed(3)}ms, other: ${(elapsed - timing.rewriter - timing.markdown).toFixed(3)}ms)`);
}
const average = values => values.reduce((a, b) => a + b, 0) / values.length;
const result = {
  min: Math.min(...times), max: Math.max(...times), avg: average(times),
  rewriterAvg: average(componentTimes.rewriter), markdownAvg: average(componentTimes.markdown)
};
result.otherAvg = result.avg - result.rewriterAvg - result.markdownAvg;
console.log('Results:', JSON.stringify(result));
console.log('Diagnostics (3 warmups, inclusive, NOT additive):', JSON.stringify(Object.fromEntries(diagnostics)));
return result;
}

if (!isMainThread) {
  try {
    parentPort.postMessage({ result: await profile(workerData.key, fixtures[workerData.key]) });
  } catch (error) {
    parentPort.postMessage({ error: error.stack });
  }
} else {
console.log('📊 Markdown Conversion Profiling');
console.log('================================\n');
console.log(`Node: ${process.version}; ${process.platform}/${process.arch}; html-rewriter-wasm@0.4.1`);
console.log('3 diagnostic warmups; uninstrumented measured iterations; isolated worker per fixture.');
const timeoutMs = Number(process.env.PROFILE_TIMEOUT_MS || 15000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid PROFILE_TIMEOUT_MS');
const filter = process.env.PROFILE_FILTER;
console.log(`Per-conversion timeout: ${timeoutMs}ms; startup also bounded\n`);

const results = {};

for (const [key, fixture] of Object.entries(fixtures)) {
  if (filter && !key.includes(filter)) continue;
  results[key] = await new Promise(resolve => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { key } });
    let lastStage = 'startup';
    let currentRun = 'startup';
    let settled = false;
    const finish = async (result, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate) await worker.terminate();
      resolve(result);
    };
    const timedOut = () => {
      console.log(`TIMEOUT: ${key} ${currentRun} after ${timeoutMs}ms; last newly entered diagnostic stage: ${lastStage}`);
      finish({ error: 'timeout', currentRun, lastStage, timeoutMs }, true);
    };
    let timer = setTimeout(timedOut, timeoutMs);
    worker.on('message', message => {
      if (message.started) {
        clearTimeout(timer);
        currentRun = message.started;
        lastStage = currentRun;
        timer = setTimeout(timedOut, timeoutMs);
      } else if (message.stage) {
        lastStage = message.stage;
        console.log(`  Diagnostic start: ${lastStage}`);
      } else {
        if (message.error) console.log(`ERROR: ${key}: ${message.error}`);
        finish(message.result || { error: message.error });
      }
    });
    worker.on('error', error => {
      console.log(`ERROR: ${key}: ${error.stack}`);
      finish({ error: error.message }, true);
    });
    worker.on('exit', code => {
      if (!settled) finish({ error: `Worker exited before returning results (${code})` });
    });
  });
}

console.log('\n📊 Summary');
console.log('==========\n');

for (const [key, result] of Object.entries(results)) {
  const fixture = fixtures[key];
  console.log(`${fixture.name}:`);
  if (result.error) {
    console.log(`  ${JSON.stringify(result)}`);
    continue;
  }
  console.log(`  Total: ${result.avg.toFixed(3)}ms (min: ${result.min.toFixed(3)}, max: ${result.max.toFixed(3)})`);
  console.log(`  Rewriter: ${result.rewriterAvg.toFixed(2)}ms`);
  console.log(`  Markdown: ${result.markdownAvg.toFixed(2)}ms`);
  console.log();
}
if (Object.values(results).some(result => result.error && result.error !== 'timeout')) process.exitCode = 1;
}
