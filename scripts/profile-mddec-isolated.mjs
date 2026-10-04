import { performance } from "node:perf_hooks";
import { mdDec } from "../markdown.js";

const iterations = 1000;
const entityText = "text &lt; &gt; &quot; &#39; &nbsp; &#123; &amp; entities ";
const testCases = [
  { name: "Small", size: 50 },
  { name: "Medium", size: 500 },
  { name: "Large", size: 5_000 },
  { name: "Very Large", size: 50_000 }
].map(testCase => ({
  ...testCase,
  content: entityText.repeat(Math.ceil(testCase.size / entityText.length)).slice(0, testCase.size)
}));

const results = [];
for (const testCase of testCases) {
  for (let i = 0; i < 20; i++) mdDec(testCase.content);
  const startedAt = performance.now();
  for (let i = 0; i < iterations; i++) mdDec(testCase.content);
  const totalTime = performance.now() - startedAt;
  results.push({
    name: testCase.name,
    inputBytes: Buffer.byteLength(testCase.content),
    iterations,
    totalMs: totalTime,
    avgMs: totalTime / iterations
  });
}

console.log(`mdDec isolated benchmark (${process.version}, ${iterations} measured calls per size)`);
console.table(results.map((result, index) => {
  const previous = results[index - 1];
  const sizeRatio = previous ? result.inputBytes / previous.inputBytes : null;
  const timeRatio = previous ? result.avgMs / previous.avgMs : null;
  const exponent = previous && timeRatio > 0 ? Math.log(timeRatio) / Math.log(sizeRatio) : null;
  return {
    input: `${result.name} (${result.inputBytes} B)`,
    iterations: result.iterations,
    "total ms": result.totalMs.toFixed(3),
    "avg ms/call": result.avgMs.toFixed(6),
    "time ratio": timeRatio?.toFixed(2) ?? "—",
    "scaling exponent": exponent?.toFixed(2) ?? "—"
  };
}));
