import { performance } from 'perf_hooks';
import { convertMd } from '../markdown.js';

// Test fixtures
const fixtures = {
  small: {
    name: 'Small (10 KB)',
    html: '<h1>Test Article</h1>' + 
      '<p>This is a test paragraph.</p>'.repeat(50) +
      '<a href="https://example.com">Link</a>',
    size: 10000
  },
  
  medium: {
    name: 'Medium (100 KB)',
    html: '<h1>Complex Article</h1>' +
      Array(100).fill().map((_, i) => 
        `<h2>Section ${i}</h2>` +
        '<p>Content with <strong>formatting</strong> and <em>emphasis</em>.</p>'.repeat(10) +
        `<a href="https://example.com/page${i}">Link ${i}</a>`
      ).join(''),
    size: 100000
  },
  
  large: {
    name: 'Large (1 MB)',
    html: '<h1>Very Large Document</h1>' +
      Array(500).fill().map((_, i) => 
        `<h2>Section ${i}</h2>` +
        '<p>'.repeat(10) + 'Paragraph text. '.repeat(50) + '</p>'.repeat(10) +
        `<a href="https://example.com/link${i}">Link ${i}</a>`
      ).join(''),
    size: 1000000
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
    size: 50000
  }
};

console.log('📊 Markdown Conversion Profiling');
console.log('================================\n');

const results = {};

for (const [key, fixture] of Object.entries(fixtures)) {
  console.log(`Testing: ${fixture.name}`);
  console.log(`HTML size: ${fixture.size} bytes\n`);
  
  const times = [];
  const componentTimes = {};
  
  // Warmup
  try {
    for (let i = 0; i < 3; i++) {
      await convertMd(fixture.html, 'https://example.com');
    }
  } catch (err) {
    console.log(`❌ Warmup failed: ${err.message}\n`);
    continue;
  }
  
  // Measure
  const iterations = key === 'large' ? 3 : key === 'complex' ? 5 : 10;
  
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    let rewriterTime = 0;
    let markdownTime = 0;
    
    try {
      const result = await convertMd(fixture.html, 'https://example.com', (component, ms) => {
        if (component === 'rewriter') rewriterTime = ms;
        if (component === 'markdown') markdownTime = ms;
      });
      
      const end = performance.now();
      const elapsed = end - start;
      times.push(elapsed);
      
      if (!componentTimes['rewriter']) componentTimes['rewriter'] = [];
      if (!componentTimes['markdown']) componentTimes['markdown'] = [];
      
      componentTimes['rewriter'].push(rewriterTime);
      componentTimes['markdown'].push(markdownTime);
      
      console.log(`  Iteration ${i + 1}: ${elapsed.toFixed(2)}ms (rewriter: ${rewriterTime.toFixed(2)}ms, markdown: ${markdownTime.toFixed(2)}ms)`);
      
    } catch (err) {
      console.log(`  Iteration ${i + 1}: ❌ ERROR - ${err.message}`);
    }
  }
  
  if (times.length > 0) {
    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p99 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.99)] || max;
    
    console.log(`\n  📈 Results:`);
    console.log(`     Min: ${min.toFixed(2)}ms`);
    console.log(`     Max: ${max.toFixed(2)}ms`);
    console.log(`     Avg: ${avg.toFixed(2)}ms`);
    console.log(`     P99: ${p99.toFixed(2)}ms`);
    
    // Component breakdown
    const rewriterAvg = componentTimes['rewriter'].reduce((a, b) => a + b, 0) / componentTimes['rewriter'].length;
    const markdownAvg = componentTimes['markdown'].reduce((a, b) => a + b, 0) / componentTimes['markdown'].length;
    
    console.log(`\n  🔧 Component average times:`);
    console.log(`     HTMLRewriter: ${rewriterAvg.toFixed(2)}ms`);
    console.log(`     Markdown gen: ${markdownAvg.toFixed(2)}ms`);
    console.log(`     Other: ${(avg - rewriterAvg - markdownAvg).toFixed(2)}ms`);
    
    results[key] = { min, max, avg, p99, rewriterAvg, markdownAvg };
  }
  
  console.log();
}

console.log('\n📊 Summary');
console.log('==========\n');

for (const [key, result] of Object.entries(results)) {
  const fixture = fixtures[key];
  console.log(`${fixture.name}:`);
  console.log(`  Total: ${result.avg.toFixed(2)}ms (p99: ${result.p99.toFixed(2)}ms)`);
  console.log(`  Rewriter: ${result.rewriterAvg.toFixed(2)}ms`);
  console.log(`  Markdown: ${result.markdownAvg.toFixed(2)}ms`);
  console.log();
}
