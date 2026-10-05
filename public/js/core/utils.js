/* Unravel – shared AST utilities (browser, Babel standalone) */
(function (U) {
  const t = Babel.types;

  U.t = t;

  // ---- tiny string helpers -------------------------------------------------
  U.escapeHtml = function (s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };

  U.uid = (function () {
    let n = 0;
    return function (prefix) {
      return (prefix || "_u") + (++n).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    };
  })();

  // ---- constant evaluation --------------------------------------------------
  // Evaluate an expression node to a primitive. Returns { value } or null.
  U.evalConst = function (path) {
    const res = path.evaluate();
    if (res.confident && (typeof res.value !== "object" || res.value instanceof RegExp || res.value === null)) {
      return { value: res.value };
    }
    return null;
  };

  U.getStringValue = function (node) {
    if (!node) return null;
    if (t.isStringLiteral(node)) return node.value;
    if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node.quasis.map(q => q.value.cooked).join("");
    return null;
  };

  // ---- scope helpers ----------------------------------------------------------
  // Collect all "global" free identifiers in a program (names read but never declared).
  U.collectGlobals = function (programPath) {
    const globals = new Set();
    programPath.traverse({
      ReferencedIdentifier(p) {
        if (!p.scope.hasBinding(p.node.name, true)) globals.add(p.node.name);
      },
    });
    return globals;
  };

  // ---- member access helpers ---------------------------------------------------
  U.memberRootName = function (path) {
    let cur = path.node;
    while (t.isMemberExpression(cur) || t.isCallExpression(cur)) {
      cur = cur.callee ? cur.callee : cur.object;
    }
    return t.isIdentifier(cur) ? cur.name : null;
  };

  U.KNOWN_GLOBALS = [
    "window", "self", "global", "globalThis", "document", "top", "parent", "frames",
  ];

  U.isGlobalRooted = function (path) {
    const root = U.memberRootName(path);
    return !!(root && U.KNOWN_GLOBALS.includes(root));
  };

  // ---- obfuscation detection -----------------------------------------------------
  // Heuristics used by engine `test()` functions and by the UI badge.
  U.detectFeatures = function (code) {
    const feats = [];
    const push = (name, on) => { if (on) feats.push(name); };
    push("hexadecimal identifiers", /\b_0x[0-9a-fA-F]{2,}\b/.test(code));
    push("string array", /function\s*_?0x[0-9a-fA-F]+\s*\(\s*\)\s*\{[\s\S]{0,800}?"\x5c?u?[0-9a-fA-F]{2,}/.test(code) || /\['[^\']{2,}'\s*,\s*'[^\']{2,}'/.test(code));
    push("base64 strings", /atob\s*\(/.test(code) || /\\x61\\x74\\x6f\\x62/.test(code));
    push("RC4-style decoder", /charCodeAt\s*\([\s\S]{0,200}?charCodeAt/.test(code) && /%\s*256|&\s*255|>>>|<</.test(code));
    push("control-flow flattening", /while\s*\(\s*!?\s*[A-Za-z_$][\w$]*\s*\)[\s\S]{0,400}?switch\s*\(/.test(code) || /case\s*"?\d{4,}"?\s*:/.test(code));
    push("opaque predicates", /0x[0-9a-fA-F]+\s*[,;]\s*0x[0-9a-fA-F]+/.test(code));
    push("dead code injection", /function\s+[A-Za-z_$][\w$]{0,3}\s*\([^)]*\)\s*\{[^}]{0,80}?return[^;]*;\s*\}/.test(code) && /(?:_0x|0x[0-9a-fA-F]{3,})/.test(code));
    push("debugger protection", /\bdebugger\b/.test(code));
    push("eval / Function constructor", /\beval\s*\(|new\s+Function\s*\(/.test(code));
    push("minified bundle", (code.match(/\n/g) || []).length < 10 && code.length > 600);
    push("webpack/browserify module", /__webpack_require__|webpackChunk|module\.exports|require\s*\(/.test(code));
    return feats;
  };

  U.generate = function (ast) {
    return Babel.packages.generator(ast, {
      retainLines: false,
      compact: false,
      jsescOption: { minimal: true },
    }).code;
  };
})(window.UnravelUtils = window.UnravelUtils || {});
