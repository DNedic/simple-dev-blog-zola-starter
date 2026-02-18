// Responsive code formatting
// Measures available columns in each <pre> block and:
//   1. Compresses structural indentation when viewport is narrow
//   2. Breaks long lines at semantic points (language-aware)
//
// Works with Zola's syntect output: <pre data-lang="..."><code><span>...</span></code></pre>

(function () {
  "use strict";

  // ── Tuning constants ────────────────────────────────────────────────
  var DEBOUNCE_MS          = 150;  // resize debounce delay
  var MAX_LINES            = 500;  // skip blocks longer than this
  var MAX_SPLITS           = 10;   // max breaks per source line
  var MAX_COLS             = 200;  // skip formatting above this width
  var FALLBACK_COLS        = 80;   // when char-width probe fails
  var DEFAULT_INDENT_STEP  = 4;    // assumed step when none detected
  var CONT_INDENT          = 4;    // default continuation indent offset
  var MIN_COMPRESSED_STEP  = 2;    // never compress indent below this
  var COMPRESS_THRESHOLD   = 55;   // compress only below this col count
  var COMPRESS_AGGRESSIVE  = 35;   // halve indent below this col count
  var BACKSLASH_RESERVE    = 2;    // columns reserved for trailing " \"
  var PAREN_OFFSET         = 1;    // continuation past opening '('
  var LD_COLON_OFFSET      = 2;    // continuation past ld ": " separator

  var SKIP_LANGS = { asm: 1, nasm: 1, gas: 1 };
  var SPACE_BREAK_LANGS = { bash: 1, dockerfile: 1, nix: 1 };
  var BACKSLASH_LANGS = { bash: 1, dockerfile: 1 };
  var OPENERS = { '(': ')', '[': ']', '{': '}' };
  var CLOSERS = { ')': '(', ']': '[', '}': '{' };

  // ── Break rules ──────────────────────────────────────────────────────
  // { pat, mode } — "after": break after pat; "before": break before pat.
  // Rightmost match within column budget wins.
  // Languages in SPACE_BREAK_LANGS skip these entirely and break at any
  // unquoted space instead.

  var c_like = [
    { pat: "{",    mode: "after" },
    { pat: "}",    mode: "before" },
    { pat: " = ",  mode: "after" },
    { pat: " || ", mode: "before" },
    { pat: " && ", mode: "before" },
  ];

  var COMMON_RULES = [
    { pat: ", ", mode: "after" },
    { pat: "; ", mode: "after" },
    { pat: "(",  mode: "after" },
    { pat: ")",  mode: "before" },
  ];

  var RULES = {
    c:   c_like.concat([
      { pat: " << ", mode: "before" },
      { pat: " >> ", mode: "before" },
      { pat: "->",   mode: "before" },
    ]).concat(COMMON_RULES),
    cpp: c_like.concat([
      { pat: " << ", mode: "before" },
      { pat: " >> ", mode: "before" },
      { pat: "->",   mode: "before" },
      { pat: "::",   mode: "before" },
    ]).concat(COMMON_RULES),
    h:     c_like.concat(COMMON_RULES),
    cmake: [
      { pat: " -",  mode: "before" },
      { pat: " \"", mode: "before" },
    ].concat(COMMON_RULES),
    ld: [
      { pat: ", ",  mode: "before" },
      { pat: ": ",  mode: "after" },
      { pat: " > ", mode: "before" },
    ].concat(COMMON_RULES),
  };

  // ── Segment helpers ──────────────────────────────────────────────────
  // A "segment" is { text, open, close } — plain text plus its wrapping
  // HTML tag (from syntect's <span> elements). A "line" is an array of
  // segments representing one source line.

  function plain(line) {
    var s = "";
    for (var i = 0; i < line.length; i++) s += line[i].text;
    return s;
  }

  function leadingSpaces(line) {
    var n = 0;
    for (var i = 0; i < line.length; i++) {
      var t = line[i].text;
      for (var j = 0; j < t.length; j++) {
        if (t[j] === " ") n++; else return n;
      }
    }
    return n;
  }

  function toHTML(line) {
    var h = "";
    for (var i = 0; i < line.length; i++) {
      var seg = line[i];
      var escaped = seg.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      h += seg.open ? seg.open + escaped + seg.close : escaped;
    }
    return h;
  }

  function stripLeading(line) {
    var out = [], stripping = true;
    for (var i = 0; i < line.length; i++) {
      if (stripping) {
        var t = line[i].text, j = 0;
        while (j < t.length && t[j] === " ") j++;
        if (j < t.length) {
          out.push({ text: t.slice(j), open: line[i].open, close: line[i].close });
          stripping = false;
        }
      } else {
        out.push(line[i]);
      }
    }
    return out;
  }

  function removeNSpaces(line, n) {
    if (n <= 0) return line;
    var out = [], rem = n;
    for (var i = 0; i < line.length; i++) {
      if (rem > 0) {
        var t = line[i].text, cut = 0;
        while (cut < t.length && cut < rem && t[cut] === " ") cut++;
        rem -= cut;
        var rest = t.slice(cut);
        if (rest.length || line[i].open) out.push({ text: rest, open: line[i].open, close: line[i].close });
      } else {
        out.push(line[i]);
      }
    }
    return out;
  }

  function splitAt(line, pos) {
    var before = [], after = [], count = 0, done = false;
    for (var i = 0; i < line.length; i++) {
      if (done) { after.push(line[i]); continue; }
      var seg = line[i];
      if (count + seg.text.length <= pos) {
        before.push(seg);
        count += seg.text.length;
        if (count === pos) done = true;
      } else {
        var at = pos - count;
        before.push({ text: seg.text.slice(0, at), open: seg.open, close: seg.close });
        if (seg.text.length > at)
          after.push({ text: seg.text.slice(at), open: seg.open, close: seg.close });
        done = true;
      }
    }
    return [before, after];
  }

  function prependPad(line, n) {
    var pad = n > 0 ? new Array(n + 1).join(" ") : "";
    return [{ text: pad, open: "", close: "" }].concat(stripLeading(line));
  }

  // ── Parsing ──────────────────────────────────────────────────────────

  function measureColumns(pre) {
    var probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
    probe.textContent = "M";
    var container = pre.querySelector("code") || pre;
    container.appendChild(probe);
    var charW = probe.getBoundingClientRect().width;
    container.removeChild(probe);
    if (!charW) return FALLBACK_COLS;
    var style = getComputedStyle(pre);
    var padL = parseFloat(style.paddingLeft) || 0;
    var padR = parseFloat(style.paddingRight) || 0;
    return Math.floor((pre.clientWidth - padL - padR) / charW);
  }

  function extractLines(codeEl) {
    var lines = [[]];
    for (var i = 0; i < codeEl.childNodes.length; i++) {
      var node = codeEl.childNodes[i];
      var open = "", close = "", text = "";
      if (node.nodeType === 3) {
        text = node.textContent;
      } else if (node.nodeType === 1 && node.tagName === "SPAN") {
        var html = node.outerHTML;
        open = html.slice(0, html.indexOf(">") + 1);
        close = "</span>";
        text = node.textContent;
      } else continue;
      var parts = text.split("\n");
      for (var p = 0; p < parts.length; p++) {
        if (p > 0) lines.push([]);
        if (parts[p].length || (p === 0 && open))
          lines[lines.length - 1].push({ text: parts[p], open: open, close: close });
      }
    }
    return lines;
  }

  // ── Analysis ─────────────────────────────────────────────────────────

  function inQuotes(text, pos) {
    var count = 0;
    for (var i = 0; i < pos; i++)
      if (text[i] === '"' && (i === 0 || text[i - 1] !== '\\')) count++;
    return count % 2 === 1;
  }

  function detectIndentStep(lines) {
    var step = 0;
    for (var i = 0; i < lines.length; i++) {
      var sp = leadingSpaces(lines[i]);
      if (sp > 0 && (!step || sp < step)) step = sp;
    }
    return step || DEFAULT_INDENT_STEP;
  }

  function computeCompressedStep(step, cols) {
    if (cols >= COMPRESS_THRESHOLD || step <= MIN_COMPRESSED_STEP) return step;
    return cols < COMPRESS_AGGRESSIVE
      ? Math.max(step >> 1, MIN_COMPRESSED_STEP)
      : Math.max(step - 1, MIN_COMPRESSED_STEP);
  }

  function anyOverflow(lines, cols) {
    for (var i = 0; i < lines.length; i++)
      if (plain(lines[i]).length > cols) return true;
    return false;
  }

  // ── Indent compression ──────────────────────────────────────────────
  // Structural indent levels get compressed; alignment offsets (jumps of
  // more than one indent step) are preserved as-is.

  function compressIndentation(lines, step, newStep) {
    var changed = false, prevBase = 0;
    for (var i = 0; i < lines.length; i++) {
      var sp = leadingSpaces(lines[i]);
      if (sp === 0) { prevBase = 0; continue; }

      var base, align;
      if (sp <= prevBase + step) {
        base = sp; align = 0;
      } else {
        base = prevBase; align = sp - base;
      }

      var level = Math.round(base / step);
      var target = level * newStep + align;
      var remove = sp - target;
      if (remove > 0) {
        lines[i] = removeNSpaces(lines[i], remove);
        changed = true;
      }
      prevBase = base;
    }
    return changed;
  }

  // ── Line breaking ────────────────────────────────────────────────────

  // Returns true if the container at openPos has a single argument
  // (no comma at depth 1 — breaking at the bracket wastes vertical space).
  function singleArgContainer(text, openPos) {
    var open = text[openPos], close = OPENERS[open];
    if (!close) return false;
    var depth = 0;
    for (var i = openPos; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) { depth--; if (depth === 0) return true; }
      else if (text[i] === ',' && depth === 1) return false;
    }
    return true; // unclosed — treat as single-arg
  }

  // Find the matching opener for a closer at closePos.
  function findMatchingOpen(text, closePos) {
    var close = text[closePos], open = CLOSERS[close];
    if (!open) return -1;
    var depth = 0;
    for (var i = closePos; i >= 0; i--) {
      if (text[i] === close) depth++;
      else if (text[i] === open) { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  // Find rightmost unquoted space within maxCols.
  function findSpaceBreak(text, maxCols, minPos) {
    var floor = minPos || 1;
    for (var i = Math.min(text.length, maxCols) - 1; i >= floor; i--)
      if (text[i] === ' ' && !inQuotes(text, i)) return i;
    return -1;
  }

  // Find rightmost pattern-based break within maxCols.
  function findPatternBreak(text, maxCols, lang, minPos) {
    var rules = RULES[lang] || COMMON_RULES;
    var floor = minPos || 1, best = -1;
    for (var r = 0; r < rules.length; r++) {
      var idx = text.lastIndexOf(rules[r].pat, Math.min(text.length, maxCols) - 1);
      if (idx < floor) continue;
      if (lang === "cmake" && inQuotes(text, idx)) continue;
      // Skip single-arg container breaks — no horizontal gain
      var pat1 = rules[r].pat;
      if (pat1.length === 1 && OPENERS[pat1]) {
        if (singleArgContainer(text, idx)) continue;
      } else if (pat1.length === 1 && CLOSERS[pat1]) {
        var op = findMatchingOpen(text, idx);
        if (op >= 0 && singleArgContainer(text, op)) continue;
      }
      var sp = rules[r].mode === "after" ? idx + rules[r].pat.length : idx;
      if (sp <= floor || sp >= text.length) continue;
      if (sp > best) best = sp;
    }
    return best > 0 ? best : -1;
  }

  function findBreak(text, maxCols, lang, minPos) {
    return SPACE_BREAK_LANGS[lang]
      ? findSpaceBreak(text, maxCols, minPos)
      : findPatternBreak(text, maxCols, lang, minPos);
  }

  function defaultContIndent(lang, text, indent) {
    if (lang === "ld") {
      var colon = text.indexOf(": ");
      return colon >= 0 ? colon + LD_COLON_OFFSET : indent + CONT_INDENT;
    }
    return indent + CONT_INDENT;
  }

  // Track bracket depth across emitted chunks to indent continuations
  // inside containers to the opening bracket column + 1.
  function updateParenState(text, depth, col) {
    for (var i = 0; i < text.length; i++) {
      if (OPENERS[text[i]]) { depth++; col = i; }
      else if (CLOSERS[text[i]]) { depth--; if (depth <= 0) { depth = 0; col = -1; } }
    }
    return { depth: depth, col: col };
  }

  function continuationIndent(ps, prevDepth, indent, fallback, maxCols) {
    var ci;
    if (ps.depth > 0 && ps.col >= 0)
      ci = ps.col + PAREN_OFFSET;           // inside parens: align past '('
    else if (prevDepth > 0 && ps.depth === 0)
      ci = indent;                          // just closed parens: back to base
    else
      ci = fallback;
    return Math.min(ci, maxCols >> 1);
  }

  function breakLine(line, cols, lang) {
    var text = plain(line);
    var addBackslash = BACKSLASH_LANGS[lang];
    var budget = addBackslash ? cols - BACKSLASH_RESERVE : cols;
    if (text.length <= budget) return null;

    var indent = leadingSpaces(line);
    var fallbackCI = defaultContIndent(lang, text, indent);
    var ps = { depth: 0, col: -1 };
    var rem = line, pieces = [];
    var splits = MAX_SPLITS, prevLen = text.length;
    var rt = text;

    while (rt.length > budget && splits-- > 0) {
      var bp = findBreak(rt, budget, lang, leadingSpaces(rem) + 1);
      if (bp < 0 || bp >= rt.length - 1) break;

      var halves = splitAt(rem, bp);
      var prevDepth = ps.depth;
      ps = updateParenState(plain(halves[0]), ps.depth, ps.col);
      var ci = continuationIndent(ps, prevDepth, indent, fallbackCI, cols);

      // Single argument in container: use classic indent for more horizontal room
      if (ps.depth > 0 && ci > fallbackCI) {
        var tail = plain(halves[1]);
        var hasComma = false;
        for (var k = tail.indexOf(", "); k >= 0; k = tail.indexOf(", ", k + 1))
          if (!inQuotes(tail, k)) { hasComma = true; break; }
        if (!hasComma) ci = Math.min(fallbackCI, cols >> 1);
      }

      pieces.push(toHTML(halves[0]) + (addBackslash ? " \\" : ""));
      rem = prependPad(halves[1], ci);

      rt = plain(rem);
      if (rt.length >= prevLen) break;
      prevLen = rt.length;
    }

    if (!pieces.length) return null;
    pieces.push(toHTML(rem));
    return pieces.join("\n");
  }

  // ── Block formatter ──────────────────────────────────────────────────

  function formatBlock(pre, cols) {
    var codeEl = pre.querySelector("code");
    if (!codeEl) return;

    var lang = (pre.getAttribute("data-lang") || "").toLowerCase();
    if (SKIP_LANGS[lang]) return;

    var lines = extractLines(codeEl);
    if (lines.length > MAX_LINES) return;

    var step = detectIndentStep(lines);
    var newStep = computeCompressedStep(step, cols);
    var changed = false;

    if (anyOverflow(lines, cols) && newStep < step)
      changed = compressIndentation(lines, step, newStep);

    var output = [];
    for (var i = 0; i < lines.length; i++) {
      var broken = breakLine(lines[i], cols, lang);
      if (broken !== null) {
        output.push(broken);
        changed = true;
      } else {
        output.push(toHTML(lines[i]));
      }
    }

    if (changed) {
      if (!codeEl.hasAttribute("data-original"))
        codeEl.setAttribute("data-original", codeEl.innerHTML);
      codeEl.innerHTML = output.join("\n");
    }
  }

  // ── Init & resize ────────────────────────────────────────────────────

  function restoreAll() {
    var els = document.querySelectorAll("pre code[data-original]");
    for (var i = 0; i < els.length; i++)
      els[i].innerHTML = els[i].getAttribute("data-original");
  }

  function formatAll() {
    restoreAll();
    var pres = document.querySelectorAll("pre[data-lang]");
    if (!pres.length) return;
    var cols = measureColumns(pres[0]);
    if (cols <= 0 || cols >= MAX_COLS) return;
    for (var i = 0; i < pres.length; i++) {
      try { formatBlock(pres[i], cols); }
      catch (e) { console.error("responsive-code:", i, e); }
    }
  }

  var timer;
  function onResize() { clearTimeout(timer); timer = setTimeout(formatAll, DEBOUNCE_MS); }

  function init() {
    requestAnimationFrame(function () {
      formatAll();
      window.addEventListener("resize", onResize);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
