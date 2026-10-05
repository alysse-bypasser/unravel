/* Engine: so — targeted "string-array only" deobfuscator. */
(function () {
  const U = window.UnravelUtils, R = window.UnravelRegistry, H = window.UnravelEngineHelpers;

  R.register({
    id: "so",
    name: "so",
    category: "deobfuscator",
    desc: "Specialist for string-array obfuscation: decodes rotated/base64/RC4 string tables and inlines " +
          "every lookup. Fastest engine when the code is otherwise clean.",
    tags: ["string array", "base64", "rc4"],
    test(ast, code) {
      const f = U.detectFeatures(code);
      if (f.includes("string array")) return 0.9;
      if (f.includes("base64 strings") || f.includes("RC4-style decoder")) return 0.75;
      return 0.15;
    },
    async transform(ast, code, opts) {
      const notes = [];
      const programPath = H.programPath(ast);

      // runtime decode first (handles rotation + RC4 that static analysis can't follow)
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
      } catch (e) { /* fall through to static */ }

      R.stabilise(programPath, [window.UnravelPasses.foldConstants,
                                window.UnravelPasses.inlineLocalArrays,
                                window.UnravelPasses.inlineGlobalRegistry], 8);
      notes.push("Inlined remaining static string lookups.");
      const map = U.renameHexIdentifiers(programPath);
      if (Object.keys(map).length) notes.push("Renamed " + Object.keys(map).length + " identifier(s).");
      return H.finish(programPath, opts, notes);
    },
  });
})();
