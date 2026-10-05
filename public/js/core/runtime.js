/* Unravel – sandboxed runtime helpers.
 * Untrusted code is executed inside a sandboxed iframe (opaque origin: no DOM,
 * no network, no parent access) with a watchdog. Loop guards are injected via
 * Babel so infinite anti-analysis loops terminate instead of hanging the tab. */
(function (RT) {

  // ---- loop-guard plugin ------------------------------------------------------
  const LOOP_GUARD = function () {
    return {
      visitor: {
        "ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement"(path) {
          const body = path.get("body");
          if (!body.isBlockStatement()) {
            body.replaceWith(Babel.types.blockStatement([Babel.types.cloneNode(body.node)]));
          }
          const guard = Babel.types.ifStatement(
            Babel.types.binaryExpression(">",
              Babel.types.updateExpression("++", Babel.types.identifier("arguments.__uTick"), true),
              Babel.types.numericLiteral(300000)),
            Babel.types.throwStatement(
              Babel.types.newExpression(Babel.types.identifier("Error"),
                [Babel.types.stringLiteral("unravel-loop-guard")])));
          path.node.body.body.unshift(guard);
        },
      },
    };
  };

  RT.guardLoops = function (code) {
    try {
      return Babel.transform(code, {
        configFile: false, babelrc: false, sourceType: "script",
        errorRecovery: true, compact: true,
        plugins: [LOOP_GUARD],
      }).code;
    } catch (e) { return null; }
  };

  // ---- sandbox ------------------------------------------------------------------
  RT.makeSandbox = function () {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.setAttribute("sandbox", "allow-scripts"); // opaque origin → isolated realm
    document.body.appendChild(frame);
    return new Promise((resolve, reject) => {
      const w = frame.contentWindow;
      if (!w || !w.document) { frame.remove(); return reject(new Error("no sandbox")); }
      try { w.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} }; } catch (e) {}
      resolve({ win: w, cleanup: () => frame.remove() });
    });
  };

  /* ---------------------------------------------------------------------------
   * decodeStringArraysAsync(code) — universal javascript-obfuscator decoder.
   * Finds the string-table registry function + initialiser IIFEs, executes them
   * in the sandbox and samples g(i) to rebuild the final (rotated/decoded) array.
   * Returns { name: [strings...] } or {}.
   * ------------------------------------------------------------------------- */
  RT.decodeStringArraysAsync = async function (code) {
    let ast;
    try {
      ast = Babel.packages.parser.parse(code, { errorRecovery: true, sourceType: "script" });
    } catch (e) { return {}; }
    const t = Babel.types;

    const candidates = [];
    for (const stmt of ast.program.body) {
      if (t.isFunctionDeclaration(stmt) && stmt.id && looksLikeRegistry(stmt)) {
        candidates.push({ name: stmt.id.name, node: stmt });
      } else if (t.isVariableStatement(stmt)) {
        for (const d of stmt.declarations) {
          if (t.isIdentifier(d.id) && d.init && t.isFunction(d.init) && looksLikeRegistry(d.init)) {
            candidates.push({ name: d.id.name, node: d.init });
          }
        }
      }
    }
    if (!candidates.length) return {};

    const initCalls = ast.program.body.filter(s =>
      t.isExpressionStatement(s) && t.isCallExpression(s.expression) &&
      t.isFunction(s.expression.callee));

    const gen = (n) => Babel.packages.generator(n, { compact: true }).code;

    let sb;
    try { sb = await RT.makeSandbox(); } catch (e) { return {}; }
    const results = {};
    try {
      for (const cand of candidates.slice(0, 4)) {
        const prelude = initCalls.map(s => "try{(" + gen(s.expression) + ")()}catch(e){}").join(";");
        const script =
          "var arguments={__uTick:0};" + // shared tick counter for the guard
          prelude + ";" + gen(cand.node) + ";" +
          "self.__sample=[];" +
          "for(var i=0;i<6000;i++){try{var v=" + cand.name + "(i);" +
          "if(typeof v!=='string')break;self.__sample[i]=v;}catch(e){break}}";
        const guarded = RT.guardLoops(script);
        if (!guarded) continue;
        try {
          sb.win.eval(guarded);
          const sample = sb.win.__sample;
          if (Array.isArray(sample)) {
            const out = [];
            for (let i = 0; i < sample.length; i++) {
              if (typeof sample[i] !== "string") break;
              out.push(sample[i]);
            }
            if (out.length >= 4) results[cand.name] = out;
          }
          sb.win.__sample = undefined;
        } catch (e) { /* not safely runnable → skip this candidate */ }
      }
    } finally {
      sb.cleanup();
    }
    return results;
  };

  function looksLikeRegistry(fn) {
    let src;
    try { src = Babel.packages.generator(fn).code; } catch (e) { return false; }
    if (src.length > 500000) return false;
    const hasBigArray = /(?:["'][^"']{2,}["']\s*,\s*){8,}/.test(src);
    const hasDecoder = /(atob|charCodeAt|fromCharCode|% *256|& *255)/.test(src);
    const returnsLookup = /return\s+[\w$]+\s*\(/.test(src) || /return\s*(\[|[\w$]+\[)/.test(src);
    return (hasBigArray || hasDecoder) && returnsLookup;
  }
})(window.UnravelRuntime = window.UnravelRuntime || {});
