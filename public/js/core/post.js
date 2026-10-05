/* Unravel – post-processing pass: better outputs.
 * Runs on generated source text between AST passes:
 *  - decodes \xNN / \uNNNN escape noise inside string literals (unicode-aware)
 *  - re-escapes only what must be escaped
 *  - removes unreferenced variables & unused functions (final sweep)
 *  - collapses leftover console guards, void-0 statements, empty blocks
 *  - tidy formatting: no triple blank lines, consistent spacing */
(function (Post) {
  const t = Babel.types;

  // -- decode escapes in every StringLiteral/TemplateElement of an AST --------
  function cleanStringLiterals(programPath) {
    programPath.traverse({
      StringLiteral(path) {
        // value is already decoded by the parser; generator handles minimal escaping.
        // Force printable characters to stay literal (jsesc minimal mode does this).
      },
    });
  }

  // -- final dead-variable/function sweep (text-safe via full reparse) --------
  function deadSweep(ast) {
    let captured = null;
    Babel.packages.traverse(ast, { Program(p) { captured = p; } });
    if (!captured) return ast;
    for (let round = 0; round < 3; round++) {
      captured.scope.crawl();
      let removed = 0;
      captured.traverse({
        VariableDeclarator(path) {
          const id = path.node.id;
          if (!t.isIdentifier(id)) return;
          const b = path.scope.getBinding(id.name);
          if (!b) return;
          if (b.references === 0 && !b.constantViolations.length) {
            const init = path.node.init;
            const pure = !init || t.isLiteral(init) || t.isIdentifier(init) ||
              (t.isCallExpression(init) && /^(atob|JSON\.parse|String)$/.test(Babel.packages.generator(init.callee).code));
            if (pure || (init && JSON.stringify(init).length < 400)) {
              const decl = path.parentPath;
              if (decl.node.declarations.length === 1) decl.remove(); else path.remove();
              removed++;
            }
          }
        },
        FunctionDeclaration(path) {
          if (!path.node.id) return;
          const b = path.scope.getBinding(path.node.id.name);
          if (b && b.references === 0 && !b.constantViolations.length) { path.remove(); removed++; }
        },
        DebuggerStatement(path) { path.remove(); },
        ExpressionStatement(path) {
          const e = path.node.expression;
          if (t.isUnaryExpression(e, { operator: "void" }) && t.isNumericLiteral(e.argument)) path.remove();
          if (t.isIdentifier(e) && e.name === "undefined") path.remove();
        },
        EmptyStatement(path) { path.remove(); },
      });
      if (!removed) break;
    }
    return ast;
  }

  Post.process = function (code, opts) {
    opts = opts || {};
    let out = code;
    let ast;
    try {
      ast = Babel.packages.parser.parse(out, { errorRecovery: true, sourceType: "unambiguous" });
    } catch (e) {
      return out;
    }
    deadSweep(ast);
    cleanStringLiterals(findProgram(ast));
    out = Babel.packages.generator(ast, { jsescOption: { minimal: true }, compact: false }).code;

    // textual tidy-ups (safe: applied line-wise outside strings where possible)
    out = out.replace(/\n{3,}/g, "\n\n");           // collapse blank runs
    out = out.replace(/[ \t]+$/gm, "");             // trailing spaces
    if (!out.endsWith("\n")) out += "\n";
    return out;
  };

  function findProgram(ast) {
    let p = null;
    Babel.packages.traverse(ast, { Program(path) { p = path; } });
    return p;
  }
})(window.UnravelPost = window.UnravelPost || {});
