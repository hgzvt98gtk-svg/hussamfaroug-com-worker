var tagAttrs = "(?:[^>\"']|\"[^\"]*\"|'[^']*')*";
var mdPatterns = {
  title: new RegExp("<title\\b" + tagAttrs + ">([\\s\\S]*?)<\\/title\\s*>", "i"),
  main: new RegExp("<(main|article)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>", "i"),
  body: new RegExp("<body\\b" + tagAttrs + ">([\\s\\S]*?)<\\/body\\s*>", "i"),
  heading: new RegExp("<h([1-6])\\b" + tagAttrs + ">([\\s\\S]*?)<\\/h\\1\\s*>", "gi"),
  pre: new RegExp("<pre\\b" + tagAttrs + ">([\\s\\S]*?)<\\/pre\\s*>", "gi"),
  code: new RegExp("<code\\b" + tagAttrs + ">([\\s\\S]*?)<\\/code\\s*>", "gi"),
  blockquote: new RegExp("<blockquote\\b" + tagAttrs + ">([\\s\\S]*?)<\\/blockquote\\s*>", "gi"),
  anchor: new RegExp("<a\\b" + tagAttrs + "\\bhref\\s*=\\s*([\"'])(.*?)\\1" + tagAttrs + ">([\\s\\S]*?)<\\/a\\s*>", "gi"),
  list: new RegExp("<(ul|ol)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>", "gi"),
  listItem: new RegExp("<li\\b" + tagAttrs + ">([\\s\\S]*?)<\\/li\\s*>", "gi"),
  format: new RegExp("<(strong|b|em|i)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>|<hr\\b" + tagAttrs + "\\s*\\/?>|<p\\b" + tagAttrs + ">|<\\/p\\s*>|<br\\b" + tagAttrs + "\\s*\\/?>", "gi")
};
var attributeEntities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", colon: ":", Tab: "\t", NewLine: "\n" };
var unsafeDestination = /[\u0000-\u001f\u007f-\u009f\ufffd]|&(?:#[^\s&]*|[a-z][a-z0-9]*;)/i;
var mdDecStats;

export function resetMdDecStats() {
  mdDecStats = { callCount: 0, totalTime: 0, maxTime: 0, callsBySize: [] };
}

export function getMdDecStats() {
  return mdDecStats ? {
    ...mdDecStats,
    callsBySize: mdDecStats.callsBySize.map(call => ({ ...call }))
  } : null;
}

export function disableMdDecStats() {
  mdDecStats = undefined;
}

export function mdDec(value) {
  var stats = mdDecStats;
  var startedAt = stats ? performance.now() : 0;
  var result = value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, function(match, decimal) {
    var codePoint = Number(decimal);
    return codePoint <= 1114111 ? String.fromCodePoint(codePoint) : match;
  }).replace(/&amp;/g, "&");
  if (stats) {
    var elapsed = performance.now() - startedAt;
    stats.callCount++;
    stats.totalTime += elapsed;
    stats.maxTime = Math.max(stats.maxTime, elapsed);
    stats.callsBySize.push({ size: value.length, elapsed });
  }
  return result;
}

function mdStripTags(html) {
  var text = [];
  var textStart = 0;
  var i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      i++;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      var commentEnd = html.indexOf("-->", i + 4);
      if (commentEnd !== -1) {
        text.push(html.slice(textStart, i));
        i = commentEnd + 3;
        textStart = i;
        continue;
      }
    }
    var nameStart = html[i + 1] === "/" ? i + 2 : i + 1;
    var firstChar = html.charCodeAt(nameStart);
    if (!(firstChar >= 65 && firstChar <= 90 || firstChar >= 97 && firstChar <= 122)) {
      i++;
      continue;
    }
    var quote = "";
    var end = nameStart + 1;
    while (end < html.length) {
      var char = html[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      end++;
    }
    if (end === html.length) {
      break;
    }
    text.push(html.slice(textStart, i));
    i = end + 1;
    textStart = i;
  }
  text.push(html.slice(textStart));
  return text.join("");
}

function mdClean(html) {
  return mdStripTags(html).replace(/\s+/g, " ").trim();
}

function mdAttribute(value) {
  return value.replace(/&(?:#(x[0-9a-f]+|\d+);?|([a-z][a-z0-9]*);)/gi, function(match, numeric, named) {
    if (!numeric) return Object.hasOwn(attributeEntities, named) ? attributeEntities[named] : match;
    var codePoint = numeric[0].toLowerCase() === "x" ? parseInt(numeric.slice(1), 16) : Number(numeric);
    return codePoint > 0 && codePoint <= 1114111 && !(codePoint >= 55296 && codePoint <= 57343) ? String.fromCodePoint(codePoint) : "\ufffd";
  });
}

function mdLabel(value, trim = true) {
  var label = mdAttribute(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ");
  return (trim ? label.trim() : label).replace(/[\\`*_[\]{}()!#&]/g, "\\$&");
}

function mdRu(href, base) {
  if (href === null || href.trim() === "") return null;
  href = mdAttribute(href);
  if (unsafeDestination.test(href)) return null;
  try {
    var destination = new URL(href, base);
    if (!["http:", "https:"].includes(destination.protocol) || unsafeDestination.test(destination.href)) return null;
    return destination.href.replace(/[\\()[\]\s<>]/g, function(char) {
      if (char === "[" || char === "]") return "\\" + char;
      return encodeURIComponent(char).replace(/[()]/g, value => "%" + value.charCodeAt(0).toString(16).toUpperCase());
    });
  } catch {
    return null;
  }
}

export async function convertMd(html, url, onTiming) {
  // Keep generated Markdown out of the later prose tag-stripping and entity-decoding passes.
  var protectedText = [];
  var marker = "\u0000" + crypto.randomUUID() + ":";
  var markerPattern = new RegExp(marker + "(\\d+)\\u0000", "g");
  function protect(value) {
    return marker + (protectedText.push(value) - 1) + "\u0000";
  }
  function join(parts) {
    return parts.reduce((text, part) => text + (text.endsWith("`") && part.startsWith("`") ? " " : "") + part, "");
  }
  function code(content, block) {
    var text = join(mdDec(mdStripTags(content).trim()).split(markerPattern).map((part, index) => index % 2 ? protectedText[Number(part)] : part));
    if (!block) text = text.replace(/\r\n?|\n/g, " ");
    var length = block ? 3 : 1;
    for (var run of text.match(/`+/g) || []) length = Math.max(length, run.length + 1);
    var delimiter = "`".repeat(length);
    var padding = block ? "\n" : /^`|`$/.test(text) ? " " : "";
    return protect(delimiter + padding + text + padding + delimiter);
  }
  function anchor(_, quote, href, content) {
    var label = join(mdClean(content).split(markerPattern).map((part, index) => index % 2 ? protectedText[Number(part)] : mdLabel(part, false)));
    return protect(href ? "[" + label + "](" + href + ")" : label);
  }
  function containerText(content) {
    // Convert anchors before container cleanup can discard their safety boundary.
    content = content.replace(mdPatterns.anchor, anchor);
    content = content.replace(mdPatterns.format, function(match, tag, inner) {
      if (inner === void 0) return " ";
      var text = containerText(inner);
      return protect(tag.toLowerCase() === "strong" || tag.toLowerCase() === "b" ? "**" + text + "**" : "*" + text + "*");
    });
    return join(mdClean(content).split(markerPattern).map((part, index) => index % 2 ? protectedText[Number(part)] : mdLabel(part, false).replace(/\\&/g, "&")));
  }
  var title = (html.match(mdPatterns.title) || [])[1] || "";
  title = title.trim();
  var rewriterStartedAt = onTiming ? performance.now() : 0;
  var body = await new HTMLRewriter()
    .on("script, style, head, header, nav, footer, aside, svg, meta, link", {
      element(el) {
        el.replace(" ");
      }
    })
    .onDocument({
      comments(comment) {
        comment.replace(" ");
      }
    })
    .on("a", {
      element(el) {
        var destination = mdRu(el.getAttribute("href"), url);
        for (var [name] of Array.from(el.attributes)) el.removeAttribute(name);
        el.setAttribute("href", destination || "");
      }
    })
    .on("img", {
      element(el) {
        var destination = mdRu(el.getAttribute("src"), url);
        var alt = mdLabel(el.getAttribute("alt") || "");
        el.replace(protect(destination ? "![" + alt + "](" + destination + ")" : alt), { html: true });
      }
    })
    .transform(new Response(html)).text();
  if (onTiming) onTiming("rewriter", performance.now() - rewriterStartedAt);
  var markdownStartedAt = onTiming ? performance.now() : 0;
  var match = body.match(mdPatterns.main);
  if (match) body = match[2];
  else {
    match = body.match(mdPatterns.body);
    if (match) body = match[1];
  }
  var markdown = "";
  if (title) markdown += "# " + mdLabel(title).replace(/\\&/g, "&") + "\n\n";
  body = body.replace(mdPatterns.heading, function(_, level, content) {
    return "\n\n" + "#".repeat(Number(level)) + " " + protect(containerText(content)) + "\n\n";
  });
  body = body.replace(mdPatterns.pre, function(_, content) {
    return "\n\n" + code(content, true) + "\n\n";
  });
  body = body.replace(mdPatterns.code, function(_, content) {
    return code(content, false);
  });
  body = body.replace(mdPatterns.blockquote, function(_, content) {
    return "\n\n> " + protect(containerText(content)) + "\n\n";
  });
  body = body.replace(mdPatterns.anchor, anchor);
  body = body.replace(mdPatterns.list, function(_, type, content) {
    var items = content.match(mdPatterns.listItem) || [];
    var ordered = type.toLowerCase() === "ol";
    return "\n\n" + items.map(function(item, index) {
      return (ordered ? index + 1 + ". " : "- ") + protect(containerText(item));
    }).join("\n") + "\n\n";
  });
  body = body.replace(mdPatterns.format, function(match, tag, content) {
    if (content !== void 0) {
      var text = protect(containerText(content));
      return tag.toLowerCase() === "strong" || tag.toLowerCase() === "b" ? "**" + text + "**" : "*" + text + "*";
    }
    if (/^<hr/i.test(match)) return "\n\n---\n\n";
    if (/^<p/i.test(match)) return "\n\n";
    if (/^<\/p/i.test(match)) return "\n";
    return "\n";
  });
  body = mdStripTags(body);
  body = body.split(markerPattern).map((part, index) => index % 2 ? marker + part + "\u0000" : mdDec(part).replace(/[\\`[\]]/g, "\\$&")).join("");
  body = body.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/^[ \t]+/gm, "").replace(/[ \t]+$/gm, "").trim();
  body = join(body.split(markerPattern).map((part, index) => index % 2 ? protectedText[Number(part)] : part));
  var result = (markdown + body).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (onTiming) onTiming("markdown", performance.now() - markdownStartedAt);
  return result;
}
