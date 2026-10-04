import { performance } from "node:perf_hooks";

const targetSize = 50_000;
const iterations = 100;
const entityText = "&lt; &gt; &quot; &#39; &nbsp; &#123; &amp; plain text ";
const input = entityText.repeat(Math.ceil(targetSize / entityText.length)).slice(0, targetSize);
const passes = [
  { name: "/&lt;/g", replace: value => value.replace(/&lt;/g, "<") },
  { name: "/&gt;/g", replace: value => value.replace(/&gt;/g, ">") },
  { name: "/&quot;/g", replace: value => value.replace(/&quot;/g, '"') },
  { name: "/&#39;/g", replace: value => value.replace(/&#39;/g, "'") },
  { name: "/&nbsp;/g", replace: value => value.replace(/&nbsp;/g, " ") },
  {
    name: "/&#(\\d+);/g",
    replace: value => value.replace(/&#(\d+);/g, (match, decimal) => {
      const codePoint = Number(decimal);
      return codePoint <= 1114111 ? String.fromCodePoint(codePoint) : match;
    })
  },
  { name: "/&amp;/g", replace: value => value.replace(/&amp;/g, "&") }
];

function sevenPass(value) {
  return passes.reduce((result, pass) => pass.replace(result), value);
}

function combinedPass(value) {
  return value.replace(/&(?:lt;|gt;|quot;|#39;|nbsp;|#(\d+);|amp;)/g, (match, decimal) => {
    if (match === "&lt;") return "<";
    if (match === "&gt;") return ">";
    if (match === "&quot;") return '"';
    if (match === "&#39;") return "'";
    if (match === "&nbsp;") return " ";
    if (match === "&amp;") return "&";
    const codePoint = Number(decimal);
    return codePoint <= 1114111 ? String.fromCodePoint(codePoint) : match;
  });
}

if (sevenPass(input) !== combinedPass(input)) {
  throw new Error("Combined-regex result differs from the seven-pass decoder");
}

function measure(operation) {
  for (let i = 0; i < 5; i++) operation();
  const startedAt = performance.now();
  for (let i = 0; i < iterations; i++) operation();
  return performance.now() - startedAt;
}

const individual = passes.map(pass => ({
  pattern: pass.name,
  totalMs: measure(() => pass.replace(input))
}));
const sevenPassMs = measure(() => sevenPass(input));
const combinedMs = measure(() => combinedPass(input));
const individualSum = individual.reduce((total, pass) => total + pass.totalMs, 0);

console.log(`Regex pass benchmark (${process.version}, ${targetSize} characters, ${iterations} iterations)`);
console.table([
  ...individual.map(pass => ({
    operation: pass.pattern,
    "total ms": pass.totalMs.toFixed(3),
    "% of individual sum": `${(pass.totalMs / individualSum * 100).toFixed(1)}%`
  })),
  { operation: "7-pass sequential", "total ms": sevenPassMs.toFixed(3), "% of individual sum": "—" },
  { operation: "Combined single-pass", "total ms": combinedMs.toFixed(3), "% of individual sum": "—" }
]);
console.log(`Individual isolated pass sum: ${individualSum.toFixed(3)} ms`);
console.log(`Measured 7-pass total: ${sevenPassMs.toFixed(3)} ms`);
console.log(`Measured single-pass total: ${combinedMs.toFixed(3)} ms`);
console.log(`Speedup: ${(sevenPassMs / combinedMs).toFixed(2)}x`);
