/* Engine: decompiler — beautify + structural recovery, NO deobfuscation.
 * For minified-but-not-obfuscated code, bundles and readable-but-ugly scripts. */
(function () {
  const U = window.UnravelUtils, P = window.UnravelPasses, R = window.UnravelRegistry, H = window.UnravelEngineHelpers;

  // Split comma-declarator chains into one statement per variable (readability).
  const splitDeclarations = {
    VariableDeclaration: {
      exit(path) {
        if (path.node.declarations.length <= 1) return;
        if (!path.parentPath.isProgram() && !U.t.isBlockStatement(path.parent)) return;
        const stmts = path.node.declarations.map(d =>
          U.t.variableDeclaration(path.node.kind, [d]));
        path.replaceWithMultiple(stmts);
      },
    },
  };

  // Add braces to single-statement if/loops for consistent structure.
  const addBraces = {
    IfStatement(path) {
      const b = (n) => U.t.isBlockStatement(n) ? n : U.t.blockStatement([n]);
      path.node.consequent = b(path.node.consequent);
      if (path.node.alternate) path.node.alternate = b(path.node.alternate);
    },
    Loop: {
      exit(path) {
        if (path.node.body && !U.t.isBlockStatement(path.node.body)) {
          path.node.body = U.t.blockStatement([path.node.body]);
        }
      },
    },
  };

  R.register({
    id: "decompiler",
    name: "decompiler",
    category: "decompiler",
    desc: "No deobfuscation — pure structural recovery: pretty-print, split declarations, restore " +
          "blocks, rename mangled locals. Use when you just need readable output from minified JS.",
    tags: ["beautify", "un-minify", "bundles"],
    test(ast, code) {
      const f = U.detectFeatures(code);
      // decompiler shines when there is NO heavy obfuscation but code IS minified
      const heavy = f.includes("string array") || f.includes("control-flow flattening") ||
                    f.includes("hexadecimal identifiers");
      if (heavy) return 0.2;
      if (f.includes("minified bundle") || f.includes("webpack/browserify module")) return 0.85;
      return 0.4;
    },
    transform(ast, code, opts) {
      const notes = [];
      const programPath = H.programPath(ast);

      // Light normalisation only — deliberately NOT touching semantics.
      programPath.traverse(addBraces);
      programPath.traverse(splitDeclarations);
      R.stabilise(programPath, [P.simplifyVisitor], 3);
      notes.push("Pretty-printed with braces restored and declarations split.");

      const extra = U.renameShortLocals(programPath);
      if (extra) notes.push("Inferred " + extra + " readable local name(s).");
      const map = U.renameHexIdentifiers(programPath);
      if (Object.keys(map).length) notes.push("Renamed " + Object.keys(map).length + " hex identifier(s).");

      let out = U.generate(programPath.node);
      out = window.UnravelPost.process(out, { simplify: false });
      return { code: out, notes };
    },
  });
})();
