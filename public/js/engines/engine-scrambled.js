/* Engine: scrambled — control-flow un-flattener + opaque-predicate killer. */
(function () {
  const U = window.UnravelUtils, P = window.UnravelPasses, R = window.UnravelRegistry, H = window.UnravelEngineHelpers;

  // Extra visitor: remove while/for loops whose body only spins on a constant condition,
  // and collapse `if (x === y) {...} else {...}` opaque predicates built from hex constants.
  const opaqueKiller = {
    IfStatement: {
      exit(path) {
        const test = path.get("test");
        const ev = test.evaluate();
        if (!ev.confident) return;
        if (ev.value) {
          path.replaceWithMultiple(flattenBlock(path.node.consequent));
        } else if (path.node.alternate) {
          path.replaceWithMultiple(flattenBlock(path.node.alternate));
        } else path.remove();
      },
    },
    WhileStatement(path) {
      const t2 = path.get("test").evaluate();
      if (t2.confident && !t2.value) { path.remove(); return; }
      // spin-loop guard: while (!![]) { ... } with no break → drop wrapper, keep body once? conservative: skip
    },
    ForStatement(path) {
      if (!path.node.test) return;
      const t2 = path.get("test").evaluate();
      if (t2.confident && !t2.value) path.remove();
    },
  };

  function flattenBlock(node) {
    return U.t.isBlockStatement(node) ? node.body : [node];
  }

  R.register({
    id: "scrambled",
    name: "scrambled",
    category: "deobfuscator",
    desc: "Rebuilds linear control flow from flattened while/switch state machines, kills opaque " +
          "predicates and strips injected dead functions.",
    tags: ["control flow flattening", "opaque predicates", "dead code"],
    test(ast, code) {
      const f = U.detectFeatures(code);
      let s = 0.15;
      if (f.includes("control-flow flattening")) s += 0.5;
      if (f.includes("opaque predicates")) s += 0.2;
      if (f.includes("dead code injection")) s += 0.1;
      return Math.min(s, 0.95);
    },
    transform(ast, code, opts) {
      const notes = [];
      const programPath = H.programPath(ast);

      R.stabilise(programPath, [P.foldConstants], 3);
      for (let i = 0; i < 4; i++) {
        programPath.scope.crawl();
        programPath.traverse(P.unflattenControlFlow);
        programPath.traverse(opaqueKiller);
        programPath.traverse(P.removeDeadCode);
      }
      notes.push("Un-flattened state machines & resolved constant branches.");
      notes.push(...H.coreTransform(programPath, "standard", opts));
      notes.push(...H.renameStage(programPath, opts));
      return H.finish(programPath, opts, notes);
    },
  });
})();
