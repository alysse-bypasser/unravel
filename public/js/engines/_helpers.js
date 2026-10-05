/* Unravel – shared transform helpers used by every engine. */
(function (H) {
  const U = window.UnravelUtils, P = window.UnravelPasses, R = window.UnravelRegistry;

  // Obtain the Program NodePath for an AST (needed for scope-aware transforms).
  H.programPath = function (ast) {
    let captured = null;
    Babel.packages.traverse(ast, { Program(p) { captured = p; } });
    return captured;
  };

  // Standard "deobfuscation core": fold, inline arrays, unflatten, dead code.
  // `level`: light | standard | deep
  H.coreTransform = function (programPath, level, opts) {
    opts = opts || {};
    const notes = [];
    R.stabilise(programPath, [P.foldConstants, P.inlineLocalArrays], level === "light" ? 2 : 4);
    R.stabilise(programPath, [P.foldConstants, P.inlineGlobalRegistry], level === "light" ? 2 : 4);
    if (level !== "light") {
      R.stabilise(programPath, [P.unflattenControlFlow, P.foldConstants], 3);
    }
    R.stabilise(programPath, [P.removeAntiDebug, P.removeDeadCode, P.normalizeLiterals],
                level === "deep" ? 6 : 4);
    if (opts.simplify !== false && level !== "light") {
      R.stabilise(programPath, [P.simplifyVisitor, P.foldConstants, P.removeDeadCode], 5);
      notes.push("Simplification applied.");
    }
    return notes;
  };

  // Rename stage shared by engines.
  H.renameStage = function (programPath, opts) {
    const notes = [];
    const map = U.renameHexIdentifiers(programPath);
    if (Object.keys(map).length) notes.push("Renamed " + Object.keys(map).length + " obfuscated identifier(s).");
    if (opts.simplify !== false) {
      const extra = U.renameShortLocals(programPath);
      if (extra) notes.push("Inferred " + extra + " readable local name(s).");
    }
    return notes;
  };

  // Finish: generate + post-processing pass.
  H.finish = function (programPath, opts, notes) {
    let out = U.generate(programPath.node);
    out = window.UnravelPost.process(out, { simplify: opts.simplify !== false });
    return { code: out, notes: notes || [] };
  };
})(window.UnravelEngineHelpers = window.UnravelEngineHelpers || {});
