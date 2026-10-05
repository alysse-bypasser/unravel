/* Engine: binder — anti-debug / self-defending / eval-wrapped code stripper. */
(function () {
  const U = window.UnravelUtils, P = window.UnravelPasses, R = window.UnravelRegistry, H = window.UnravelEngineHelpers;

  // Unwrap `eval("code")` and `new Function("…")()` when the payload is a literal.
  const evalUnwrapper = {
    CallExpression: {
      exit(path) {
        const c = path.node.callee;
        // eval("...")
        if (U.t.isIdentifier(c, { name: "eval" }) && path.node.arguments.length === 1) {
          const s = U.getStringValue(path.node.arguments[0]);
          if (s !== null && s.length > 2) {
            try {
              const inner = Babel.packages.parser.parse(s, { errorRecovery: true });
              const stmts = inner.program.body.filter(x => !(U.t.isExpressionStatement(x) &&
                U.t.isStringLiteral(x.expression) && x.expression.value === "use strict"));
              if (stmts.length) {
                path.replaceWithMultiple(stmts);
                return;
              }
            } catch (e) { /* not parseable – leave */ }
          }
        }
        // new Function("return …")()  /  (function(){…})["apply"](…) style skipped (risky)
      },
    },
  };

  // Self-defending wrapper: (function(_0xa,_0xb){ … big decoder … }(strings, hex)) → keep only useful part
  const selfDefenceKiller = {
    ExpressionStatement(path) {
      const e = path.node.expression;
      if (!U.t.isCallExpression(e)) return;
      const callee = e.callee;
      if (!U.t.isFunctionExpression(callee) && !U.t.isArrowFunctionExpression(callee)) return;
      const body = callee.body && callee.body.body;
      if (!body || body.length < 2) return;
      // heuristics: params named _0x…, body dominated by string ops on arguments
      const paramHex = (callee.params || []).every(p => U.t.isIdentifier(p) && /^_0x/i.test(p.name));
      const argLiterals = (e.arguments || []).length >= 1;
      if (paramHex && argLiterals && JSON.stringify(body).includes("push")) {
        // rotation / initialisation IIFE with no external effect we can see → drop it
        // but ONLY if its parameters are never referenced outside this call (they can't be).
        path.remove();
      }
    },
  };

  R.register({
    id: "binder",
    name: "binder",
    category: "deobfuscator",
    desc: "Strips self-defending wrappers, debugger traps, console guards and unwraps literal " +
          "eval()/Function payloads before running the standard cleanup pipeline.",
    tags: ["self defending", "debugger protection", "eval"],
    test(ast, code) {
      const f = U.detectFeatures(code);
      let s = 0.15;
      if (f.includes("debugger protection")) s += 0.35;
      if (f.includes("eval / Function constructor")) s += 0.3;
      if (f.includes("hexadecimal identifiers")) s += 0.1;
      if (f.includes("string array")) s += 0.1;
      return Math.min(s, 0.95);
    },
    transform(ast, code, opts) {
      const notes = [];
      const programPath = H.programPath(ast);

      for (let i = 0; i < 4; i++) {
        programPath.scope.crawl();
        programPath.traverse(P.removeAntiDebug);
        programPath.traverse(evalUnwrapper);
        programPath.traverse(selfDefenceKiller);
        programPath.traverse(P.foldConstants);
        programPath.traverse(P.removeDeadCode);
      }
      notes.push("Removed anti-debug traps, self-defending wrappers; unwrapped literal eval payloads.");
      notes.push(...H.coreTransform(programPath, "standard", opts));
      notes.push(...H.renameStage(programPath, opts));
      return H.finish(programPath, opts, notes);
    },
  });
})();
