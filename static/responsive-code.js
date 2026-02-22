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
    { pat: ", ", mode: "after",  sep: true },
    { pat: "; ", mode: "after",  sep: true },
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
      { pat: " -",  mode: "before", sep: true },
      { pat: " \"", mode: "before", sep: true },
    ].concat(COMMON_RULES),
    ld: [
      { pat: ", ",  mode: "before", sep: true },
      { pat: ": ",  mode: "after" },
      { pat: " > ", mode: "before" },
    ].concat(COMMON_RULES),
  };

  // Break rule for space-separated argument languages (bash, dockerfile, nix).
  // A single space acts as both the break point and the argument separator.
  var SPACE_RULES = [{ pat: " ", mode: "before", sep: true }];

  // ── Segment helpers ──────────────────────────────────────────────────
  // A "segment" is { text, open, close } — plain text plus its wrapping
  // HTML tag (from syntect's <span> elements). A "line" is an array of
  // segments representing one source line.

  function plain(line) {
    return line.map(function(seg) { return seg.text; }).join('');
  }

  function leadingSpaces(line) {
    return Math.max(0, plain(line).search(/\S/));
  }

  function toHTML(line) {
    return line.map(function(seg) {
      var e = seg.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return seg.open ? seg.open + e + seg.close : e;
    }).join('');
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
    var pad = " ".repeat(n);
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

  // ── Indent compression ──────────────────────────────────────────────
  // Multiplies every line's leading-space count by `factor` (0 < factor ≤ 1),
  // rounding to the nearest integer.  Factor is computed once from the first
  // code block on the page and applied uniformly to all blocks.

  function applyIndentFactor(lines, factor) {
    // Detect this block's indent step to distinguish structural from alignment indents.
    var step = 0;
    for (var i = 0; i < lines.length; i++) {
      var sp0 = Math.max(0, plain(lines[i]).search(/\S/));
      if (sp0 > 0 && (!step || sp0 < step)) step = sp0;
    }
    step = step || DEFAULT_INDENT_STEP;

    var changed = false;
    var prevOrig = null;  // original plain text of previous line (pre-compression)
    var prevSp = 0;
    var prevRemoved = 0;
    var prevAligned = false;
    for (var i = 0; i < lines.length; i++) {
      var orig = plain(lines[i]);
      var sp = Math.max(0, orig.search(/\S/));
      if (sp > 0) {
        // A line is alignment-indented when the previous original line has
        // content at this column AND either it's a large forward jump (new
        // alignment start) or the previous line was itself aligned (continuation).
        var hasPrevContent = prevOrig !== null && sp < prevOrig.length && prevOrig[sp] !== ' ';
        var aligned = hasPrevContent
          && (sp > prevSp && sp - prevSp > step || prevAligned && sp >= prevSp);
        var remove = aligned ? prevRemoved : sp - Math.round(sp * factor);
        if (remove > 0) {
          lines[i] = removeNSpaces(lines[i], remove);
          changed = true;
        }
        prevRemoved = remove;
        prevAligned = aligned;
      } else {
        prevRemoved = 0;
        prevAligned = false;
      }
      prevOrig = orig;
      prevSp = sp;
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

  // ── Chunk scanner ────────────────────────────────────────────────────
  // Truly single-pass over a text chunk.  In one left-to-right scan:
  //   • tracks string context (both " and ') incrementally
  //   • tracks bracket depth/column for continuation-indent computation
  //   • accumulates `best` — the rightmost break within the column budget
  //     (the "go back one token" moment: when the window closes, `best` is
  //     the last opportunity that fit, with no further search)
  //   • tracks `lastSepPos` — rightmost argument separator seen anywhere,
  //     used to detect single-argument containers without a second pass
  //
  // Returns { bp, ps, hasArgSep } or null.
  // initPs carries bracket state accumulated from previous chunks so that
  // multi-line breaks stay aware of earlier openers.
  // "Before-closer" breaks save the pre-decrement bracket state so the
  // first fragment still sees the enclosing bracket in its depth count.
  function scanChunk(text, lang, floor, maxCols, initPs) {
    var isSpaceLang = SPACE_BREAK_LANGS[lang];
    var rules = isSpaceLang ? SPACE_RULES : (RULES[lang] || COMMON_RULES);
    var inStr = false, strChar = '';

    var depth = initPs.depth, openCol = initPs.col;
    var prevDepth, prevOpenCol;           // state before current char's bracket update

    var best = -1, bestPs = null;
    var lastSepPos = -1;

    for (var i = 0; i < text.length; i++) {
      var c = text[i];

      if (inStr) {
        if (c === strChar && (i === 0 || text[i - 1] !== '\\')) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }

      prevDepth = depth; prevOpenCol = openCol;
      if (OPENERS[c]) { depth++; openCol = i; }
      else if (CLOSERS[c]) { depth--; if (depth <= 0) { depth = 0; openCol = -1; } }

      for (var r = 0; r < rules.length; r++) {
        var pat  = rules[r].pat;
        var plen = pat.length;
        if (c !== pat[0]) continue;
        if (plen > 1) {
          var ok = true;
          for (var k = 1; k < plen; k++)
            if (text[i + k] !== pat[k]) { ok = false; break; }
          if (!ok) continue;
        }

        var bp = rules[r].mode === 'after' ? i + plen : i;
        if (bp <= floor || bp >= text.length) continue;

        if (plen === 1 && OPENERS[pat]) {
          if (singleArgContainer(text, i)) continue;
        } else if (plen === 1 && CLOSERS[pat]) {
          var op = findMatchingOpen(text, i);
          if (op >= 0 && singleArgContainer(text, op)) continue;
        }

        if (rules[r].sep)
          if (bp > lastSepPos) lastSepPos = bp;

        if (bp <= maxCols && bp > best) {
          best = bp;
          // "before" at a closer: first half excludes the closer, so depth
          // must still reflect the open bracket — use pre-decrement state.
          bestPs = (rules[r].mode === 'before' && plen === 1 && CLOSERS[pat])
            ? { depth: prevDepth, col: prevOpenCol }
            : { depth: depth, col: openCol };
        }
      }
    }

    if (best < 0) return null;
    return { bp: best, ps: bestPs, hasArgSep: lastSepPos >= best };
  }

  function defaultContIndent(lang, text, indent) {
    if (lang === "ld") {
      var colon = text.indexOf(": ");
      return colon >= 0 ? colon + LD_COLON_OFFSET : indent + CONT_INDENT;
    }
    return indent + CONT_INDENT;
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

    while (splits-- > 0) {
      var rt = plain(rem);
      if (rt.length <= budget) break;

      var result = scanChunk(rt, lang, Math.max(0, rt.search(/\S/)), budget, ps);
      if (!result || result.bp >= rt.length - 1) break;

      var halves = splitAt(rem, result.bp);
      var prevDepth = ps.depth;
      ps = result.ps;
      var ci = continuationIndent(ps, prevDepth, indent, fallbackCI, cols);

      // Single-argument container: avoid wasteful deep indent
      if (ps.depth > 0 && ci > fallbackCI && !result.hasArgSep)
        ci = Math.min(fallbackCI, cols >> 1);

      pieces.push(toHTML(halves[0]) + (addBackslash ? " \\" : ""));
      rem = prependPad(halves[1], ci);

      var newLen = plain(rem).length;
      if (newLen >= prevLen) break;
      prevLen = newLen;
    }

    if (!pieces.length) return null;
    pieces.push(toHTML(rem));
    return pieces.join("\n");
  }

  // ── Block formatter ──────────────────────────────────────────────────

  function formatBlock(pre, cols, factor) {
    var codeEl = pre.querySelector("code");
    if (!codeEl) return;

    var lang = (pre.getAttribute("data-lang") || "").toLowerCase();
    if (SKIP_LANGS[lang]) return;

    var lines = extractLines(codeEl);
    if (lines.length > MAX_LINES) return;

    var changed = factor < 1 && applyIndentFactor(lines, factor);

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

    // Compute a global indent factor from the first processable block so that
    // all blocks on the page share the same indentation scale.
    var factor = 1;
    for (var j = 0; j < pres.length; j++) {
      var lang0 = (pres[j].getAttribute("data-lang") || "").toLowerCase();
      if (SKIP_LANGS[lang0]) continue;
      var code0 = pres[j].querySelector("code");
      if (!code0) continue;
      var lines0 = extractLines(code0);
      if (lines0.length > MAX_LINES) continue;
      var step = detectIndentStep(lines0);
      factor = computeCompressedStep(step, cols) / step;
      break;
    }

    for (var i = 0; i < pres.length; i++) {
      try { formatBlock(pres[i], cols, factor); }
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
