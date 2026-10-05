/* Unravel – engine registry & pipeline runner. */
(function (R) {
  const U = window.UnravelUtils, P = window.UnravelPasses;

  R.engines = [];           // [{id,name,desc,tags,test(ast,code),transform(ast,opts)}]
  R.byCategory = {};        // deobfuscator | decompiler | dumper

  R.register = function (engine) {
    R.engines.push(engine);
    (R.byCategory[engine.category] = R.byCategory[engine.category] || []).push(engine);
  };

  R.get = function (id) { return R.engines.find(e => e.id === id); };

  // Run visitors repeatedly until stable or max passes.
  R.stabilise = function (programPath, visitors, maxPasses) {
    maxPasses = maxPasses || 6;
    let prev = null;
    for (let i = 0; i < maxPasses; i++) {
      programPath.scope.crawl();
      for (const v of visitors) programPath.traverse(v);
      const out = U.generate(programPath.node);
      if (out === prev) break;
      prev = out;
    }
    return prev;
  };

  // Parse source → { ast, code } with error info attached.
  R.parse = function (code) {
    const warnings = [];
    let src = code;
    // Tolerate HTML pages: extract inline <script> blocks (used by dumper/decompiler).
    let extractedScripts = null;
    try {
      Babel.packages.parser.parse(src, { sourceType: "unambiguous", errorRecovery: true });
    } catch (e) {
      if (/<script[\s>]/i.test(src)) {
        const blocks = [];
        const re = /<script(?:[^>]*)>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(src))) {
          if (/src\s*=/.test(m[0].slice(0, m[0].indexOf(">")))) continue;
          if (/\btype\s*=\s*["'](application\/(json|ld\+json)|text\/template)["']/i.test(m[0])) continue;
          if (m[1].trim()) blocks.push(m[1]);
        }
        if (blocks.length) {
          extractedScripts = blocks;
          src = blocks.join("\n;\n");
          warnings.push("Input looks like an HTML page – extracted " + blocks.length + " inline script block(s).");
        } else throw e;
      } else throw e;
    }
    const ast = Babel.packages.parser.parse(src, {
      sourceType: "unambiguous",
      errorRecovery: true,
      attachComment: true,
      allowReturnOutsideFunction: true,
      plugins: ["jsx"],
    });
    return { ast, code: src, warnings, extractedScripts };
  };

  // Execute a full engine run and produce stats. (async – engines may sandbox-eval)
  R.run = async function (engineId, inputCode, opts) {
    opts = opts || {};
    const t0 = performance.now();
    const parsed = R.parse(inputCode);
    const engine = R.get(engineId);
    if (!engine) throw new Error("Unknown engine: " + engineId);

    const result = await engine.transform(parsed.ast, parsed.code, opts, parsed);
    const outCode = result.code;
    const ms = Math.round(performance.now() - t0);

    const stats = {
      engine: engine.name,
      timeMs: ms,
      inBytes: inputCode.length,
      outBytes: outCode.length,
      lines: outCode.split("\n").length,
      notes: result.notes || [],
      warnings: parsed.warnings.concat(result.warnings || []),
    };
    return { code: outCode, map: result.map || null, stats };
  };
})(window.UnravelRegistry = window.UnravelRegistry || {});
