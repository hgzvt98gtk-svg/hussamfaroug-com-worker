function mdDec(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, function(match, decimal) {
    var codePoint = Number(decimal);
    return codePoint <= 1114111 ? String.fromCodePoint(codePoint) : match;
  }).replace(/&amp;/g, "&");
}

function mdStripTags(html) {
  var text = "";
  var i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      text += html[i++];
      continue;
    }
    if (html.startsWith("<!--", i)) {
      var commentEnd = html.indexOf("-->", i + 4);
      if (commentEnd !== -1) {
        i = commentEnd + 3;
        continue;
      }
    }
    var nameStart = html[i + 1] === "/" ? i + 2 : i + 1;
    var firstChar = html.charCodeAt(nameStart);
    if (!(firstChar >= 65 && firstChar <= 90 || firstChar >= 97 && firstChar <= 122)) {
      text += html[i++];
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
      text += html.slice(i);
      break;
    }
    i = end + 1;
  }
  return text;
}

function mdClean(html) {
  return mdStripTags(html).replace(/\s+/g, " ").trim();
}

function mdRu(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

export async function convertMd(html, url) {
  var tagAttrs = "(?:[^>\"']|\"[^\"]*\"|'[^']*')*";
  var title = (html.match(new RegExp("<title\\b" + tagAttrs + ">([\\s\\S]*?)<\\/title\\s*>", "i")) || [])[1] || "";
  title = mdDec(title.trim());
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
    .transform(new Response(html)).text();
  var match = body.match(new RegExp("<(main|article)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>", "i"));
  if (match) body = match[2];
  else {
    match = body.match(new RegExp("<body\\b" + tagAttrs + ">([\\s\\S]*?)<\\/body\\s*>", "i"));
    if (match) body = match[1];
  }
  var markdown = "";
  if (title) markdown += "# " + title + "\n\n";
  body = body.replace(new RegExp("<h([1-6])\\b" + tagAttrs + ">([\\s\\S]*?)<\\/h\\1\\s*>", "gi"), function(_, level, content) {
    return "\n\n" + "#".repeat(Number(level)) + " " + mdClean(content) + "\n\n";
  });
  body = body.replace(new RegExp("<pre\\b" + tagAttrs + ">([\\s\\S]*?)<\\/pre\\s*>", "gi"), function(_, content) {
    return "\n\n```\n" + mdStripTags(content).trim() + "\n```\n\n";
  });
  body = body.replace(new RegExp("<code\\b" + tagAttrs + ">([\\s\\S]*?)<\\/code\\s*>", "gi"), function(_, content) {
    return "`" + mdStripTags(content).trim() + "`";
  });
  body = body.replace(new RegExp("<blockquote\\b" + tagAttrs + ">([\\s\\S]*?)<\\/blockquote\\s*>", "gi"), function(_, content) {
    return "\n\n" + mdClean(content).split("\n").map(function(line) {
      return "> " + line;
    }).join("\n") + "\n\n";
  });
  body = body.replace(new RegExp("<img\\b" + tagAttrs + ">", "gi"), function(image) {
    var alt = (image.match(/alt=["']([^"']*)["']/i) || [])[1] || "";
    var src = (image.match(/src=["']([^"']*)["']/i) || [])[1] || "";
    return "![" + alt + "](" + mdRu(src, url) + ")";
  });
  body = body.replace(new RegExp("<a\\b" + tagAttrs + "\\bhref\\s*=\\s*([\"'])(.*?)\\1" + tagAttrs + ">([\\s\\S]*?)<\\/a\\s*>", "gi"), function(_, quote, href, content) {
    return "[" + mdClean(content) + "](" + mdRu(href, url) + ")";
  });
  body = body.replace(new RegExp("<(ul|ol)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>", "gi"), function(_, type, content) {
    var items = content.match(new RegExp("<li\\b" + tagAttrs + ">([\\s\\S]*?)<\\/li\\s*>", "gi")) || [];
    var ordered = type.toLowerCase() === "ol";
    return "\n\n" + items.map(function(item, index) {
      return (ordered ? index + 1 + ". " : "- ") + mdClean(item);
    }).join("\n") + "\n\n";
  });
  body = body.replace(new RegExp("<(strong|b|em|i)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>|<hr\\b" + tagAttrs + "\\s*\\/?>|<p\\b" + tagAttrs + ">|<\\/p\\s*>|<br\\b" + tagAttrs + "\\s*\\/?>", "gi"), function(match, tag, content) {
    if (content !== void 0) {
      var text = mdClean(content);
      return tag.toLowerCase() === "strong" || tag.toLowerCase() === "b" ? "**" + text + "**" : "*" + text + "*";
    }
    if (/^<hr/i.test(match)) return "\n\n---\n\n";
    if (/^<p/i.test(match)) return "\n\n";
    if (/^<\/p/i.test(match)) return "\n";
    return "\n";
  });
  body = mdStripTags(body);
  body = mdDec(body);
  body = body.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/^[ \t]+/gm, "").replace(/[ \t]+$/gm, "").trim();
  return (markdown + body).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
