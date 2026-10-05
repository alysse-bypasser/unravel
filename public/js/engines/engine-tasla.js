/* Engine: TASLA — aggressive all-in-one cleaner for heavily mangled scripts. */
(function () {
  const U = window.UnravelUtils, P = window.UnravelPasses, R = window.UnravelRegistry, H = window.UnravelEngineHelpers;

  // Extra aggressive visitors unique to TASLA.
  const aggressive = {
    // remove functions that are never referenced anywhere (dead top-level fns)
    Program(path) {
      path.traverse({
        FunctionDeclaration(p) {
          if (!p.node.id) return;
          const b = p.scope.getBinding(p.node.id.name);
          if (b && b.references === 0 && !b.constantViolations.length) p.remove();
        },
      });
    },
    // collapse `var a; a = expr;` → `var a = expr;` at same scope top level
    ExpressionStatement: {
      exit(path) {
        const e = path.node.expression;
        if (!U.t.isAssignmentExpression(e) || !U.t.isIdentifier(e.left)) return;
        const prev = path.getSibling(path.key - 1);
        if (prev && prev.node && U.t.isVariableDeclaration(prev.node) &&
            prev.node.declarations.length === 1 &&
            U.t.isIdentifier(prev.node.declarations[0].id, { name: e.left.name }) &&
            !prev.node.declarations[0].init) {
          prev.node.declarations[0].init = e.right;
          path.remove();
        }
      },
    },
    // comma-split assignments: a = 1, b = 2; → two statements
    SequenceExpression: {
      exit(path) {
        if (!path.parentPath.isExpressionStatement()) return;
        const parts = path.node.expressions;
        if (parts.every(x => U.t.isAssignmentExpression(x) || U.t.isCallExpression(x))) {
          path.parentPath.replaceWithMultiple(parts.map(x => U.t.expressionStatement(x)));
        }
      },
    },
    // typeof x !== "undefined" guards with declared bindings → true
    BinaryExpression: {
      exit(path) {
        const ev = path.evaluate();
        if (ev.confident && typeof ev.value === "boolean") path.replaceWith(U.t.booleanLiteral(ev.value));
      },
    },
  };

  R.register({
    id: "tasla",
    name: "TASLA",
    category: "deobfuscator",
    desc: "Aggressive multi-pass cleaner: runtime decode + static inline + un-flatten + dead function " +
          "pruning + full rename. Slowest but thorough on the worst scripts.",
    tags: ["aggressive", "multi-pass", "dead functions"],
    test(ast, code) {
      const f = U.detectFeatures(code);
      if (f.length >= 4) return Math.min(0.9, 0.45 + f.length * 0.07);
      return 0.35;
    },
    async transform(ast, code, opts) {
      const notes = [];
      const programPath = H.programPath(ast);

      try {
        const decoded = await window.UnravelRuntime.decodeStringArraysAsync(code);
        const names = Object.keys(decoded || {});
        if (names.length) {
          programPath.traverse({
            CallExpression(p) {
              const root = U.memberRootName(p);
              if (!root || !decoded[root] || p.node.arguments.length !== 1) return;
              const arr = decoded[root];
              const idx = p.get("arguments.0").evaluate();
              if (!idx.confident || typeof idx.value !== "number") return;
              const i = ((Math.trunc(idx.value) % arr.length) + arr.length) % arr.length;
              if (typeof arr[i] === "string") p.replaceWith(U.t.stringLiteral(arr[i]));
            },
          });
          notes.push("Runtime-decoded " + names.reduce((a, n) => a + decoded[n].length, 0) + " string(s).");
        }
      } catch (e) { /* best effort */ }

      for (let round = 0; round < 3; round++) {
        programPath.scope.crawl();
        programPath.traverse(aggressive);
        notes.push(...[]);
        R.stabilise(programPath, [P.foldConstants, P.inlineLocalArrays, P.inlineGlobalRegistry], 3);
        R.stabilise(programPath, [P.unflattenControlFlow, P.removeAntiDebug, P.removeDeadCode], 3);
      }
      notes.push("Pruned unreferenced functions and collapsed assignment chains.");
      notes.push(...H.coreTransform(programPath, "deep", opts));
      notes.push(...H.renameStage(programPath, opts));
      return H.finish(programPath, opts, notes);
    },
  });
})();
