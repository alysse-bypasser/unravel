/* Engine: unravel — flagship full-pipeline deobfuscator. */
(function () {
  const U = window.UnravelUtils, R = window.UnravelRegistry, H = window.UnravelEngineHelpers;

  R.register({
    id: "unravel",
    name: "unravel",
    category: "deobfuscator",
    flagship: true,
    desc: "Full pipeline: runtime string-array decoding, control-flow un-flattening, opaque predicates, " +
          "dead-code & anti-debug removal, renaming and final simplification.",
    tags: ["javascript-obfuscator", "so", "TASLA", "binder"],
    test(ast, code) {
      const f = U.detectFeatures(code);
      const strong = f.includes("hexadecimal identifiers") || f.includes("string array") ||
                     f.includes("control-flow flattening");
      return strong ? Math.min(0.98, 0.55 + f.length * 0.06) : 0.3;
    },
    async transform(ast, code, opts) {
      const notes = [];
      const programPath = H.programPath(ast);

      // Stage 1 – runtime string-array decoder (sandboxed eval, best effort).
      try {
        const decoded = await window.UnravelRuntime.decodeStringArraysAsync(code);
        const names = Object.keys(decoded || {});
        if (names.length) {
          programPath.traverse({
            CallExpression(p) {
              const root = U.memberRootName(p);
              if (!root || !decoded[root]) return;
              if (p.node.arguments.length !== 1) return;
              const arr = decoded[root];
              const idx = p.get("arguments.0").evaluate();
              if (!idx.confident || typeof idx.value !== "number") return;
              const i = ((Math.trunc(idx.value) % arr.length) + arr.length) % arr.length;
              if (typeof arr[i] === "string") p.replaceWith(U.t.stringLiteral(arr[i]));
            },
          });
          const total = names.reduce((a, n) => a + decoded[n].length, 0);
          notes.push("Decoded " + total + " string(s) from " + names.length + " runtime array(s).");
        }
      } catch (e) { /* runtime decode is best-effort */ }

      // Stages 2-4 – shared core + simplify + rename.
      notes.push(...H.coreTransform(programPath, "deep", opts));
      notes.push(...H.renameStage(programPath, opts));

      return H.finish(programPath, opts, notes);
    },
  });
})();
