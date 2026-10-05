/* Unravel – universal dumper engine.
 * Works against ALL JS obfuscators: instead of symbolically undoing each
 * protection, it lets the obfuscated code run itself inside a sandboxed iframe
 * and DUMPS what the obfuscator produces at runtime — decoded strings, eval /
 * new Function payloads, global property probes — then emits a clean report. */
(function () {
  const U = window.UnravelUtils, R = window.UnravelRegistry;

  // Babel plugin (plain visitor works with Babel.transform plugins array form)
  const instrumentVisitor = {
    CallExpression: {
      exit(path) {
        const t = U.t;
        const c = path.node.callee;
        // eval(...) → __uEval(...)
        if (t.isIdentifier(c, { name: "eval" })) {
          c.name = "__uEval";
          return;
        }
        // new Function(...) → __uNewFn(...)
        if (t.isNewExpression(path.parentPath && path.parentPath.node ? path.parentPath.node : null)) { /* noop */ }
        // record literal string arguments (decoder keys / table chunks)
        for (let i = 0; i < path.node.arguments.length; i++) {
          const a = path.node.arguments[i];
          if (t.isStringLiteral(a) && a.value.length >= 3 && !t.isCallExpression(c)) {
            path.node.arguments[i] = t.callExpression(t.identifier("__uStr"), [a]);
          } else if (t.isStringLiteral(a) && a.value.length >= 3) {
            path.node.arguments[i] = t.callExpression(t.identifier("__uStr"), [a]);
          }
        }
      },
    },
    NewExpression: {
      exit(path) {
        const t = U.t;
        if (t.isIdentifier(path.node.callee, { name: "Function" })) {
          path.replaceWith(t.callExpression(t.identifier("__uNewFn"), path.node.arguments));
        }
      },
    },
    MemberExpression: {
      exit(path) {
        const t = U.t;
        if (!U.isGlobalRooted(path) || !path.node.computed) return;
        const prop = path.node.property;
        if (t.isStringLiteral(prop) && /^[A-Za-z_$][\w$]*$/.test(prop.value)) {
          path.node.property = t.callExpression(t.identifier("__uProp"), [prop]);
        }
      },
    },
  };

  const PRELUDE = `
    var __uLog = { strings: [], evals: [], props: [], errors: [] };
    var __uSeenStr = {};
    function __uStr(s){ try{ if(typeof s==="string" && s.length>=3 && !__uSeenStr[s]){ __uSeenStr[s]=1; __uLog.strings.push(s);} }catch(e){} return s; }
    function __uProp(p){ try{ __uLog.props.push(p); }catch(e){} return p; }
    function __uEval(src){
      try{ if(typeof src==="string") __uLog.evals.push(src); }catch(e){}
      try{ return (0, eval)(src); }catch(e){ __uLog.errors.push(String(e&&e.message)); return undefined; }
    }
    function __uNewFn(){
      try{ __uLog.evals.push(Array.prototype.slice.call(arguments).join("\\n")); }catch(e){}
      try{ return Function.apply(null, arguments); }catch(e){ __uLog.errors.push(String(e&&e.message)); return function(){}; }
    }
    self.__uLog = __uLog;`;

  R.register({
    id: "dumper",
    name: "universal dumper",
    category: "dumper",
    desc: "Sandbox + instrumentation: executes any obfuscated script in an isolated realm and dumps every " +
          "runtime string, eval payload and global probe. Universal — not tied to one obfuscator.",
    tags: ["universal", "runtime", "sandbox", "eval capture"],
    test(ast, code) {
      const f = U.detectFeatures(code);
      if (!f.length) return 0.25;
      return Math.min(0.9, 0.4 + f.length * 0.08);
    },
    async transform(ast, code, opts) {
      const notes = [];

      // ---- 1. Instrument via a second parse+transform pass --------------------
      let instrumented;
      try {
        instrumented = Babel.transform(code, {
          configFile: false, babelrc: false, sourceType: "unambiguous",
          errorRecovery: true, compact: true,
          plugins: [function () { return { visitor: instrumentVisitor }; }],
        }).code;
      } catch (e) {
        instrumented = code;
        notes.push("Instrumentation pass failed; dumping raw execution only.");
      }

      // ---- 2. Guard loops so anti-analysis traps can't hang us -----------------
      const full = "(function(){" + PRELUDE + "\n" + instrumented + "\n})();";
      const guarded = window.UnravelRuntime.guardLoops(full) || full;

      // ---- 3. Run in sandbox -----------------------------------------------------
      const dump = await runInSandbox(guarded, opts);
      notes.push("Sandbox run: " + dump.stats);

      // ---- 4. Report --------------------------------------------------------------
      const report = buildReport(dump);
      return { code: report, notes, warnings: dump.log.errors.length
        ? ["Trapped " + dump.log.errors.length + " runtime error(s) during dump."] : [] };
    },
  });

  async function runInSandbox(scriptSrc, opts) {
    const sb = await window.UnravelRuntime.makeSandbox();
    let log = { strings: [], evals: [], props: [], errors: [] };
    let stats = "no data";
    try {
      const timeoutMs = opts.dumpTimeout || 2500;
      const done = new Promise((resolve) => {
        try { sb.win.eval(scriptSrc); }
        catch (e) { log.errors.push(String(e && e.message)); }
        resolve();
      });
      await Promise.race([done, new Promise(r => setTimeout(r, timeoutMs))]);
      log = sb.win.__uLog || log;
      stats = log.strings.length + " unique string(s), " + log.evals.length + " eval payload(s), " +
              log.props.length + " global probe(s)" +
              (log.errors.length ? ", " + log.errors.length + " trapped error(s)" : "");
    } catch (e) {
      stats = "sandbox failure: " + e.message;
    } finally {
      sb.cleanup();
    }
    return { log, stats };
  }

  function buildReport(dump) {
    const L = [];
    L.push("// ==============================================================");
    L.push("//  unravel :: universal dumper report");
    L.push("//  " + dump.stats);
    L.push("// ==============================================================");
    L.push("");
    if (dump.log.strings.length) {
      L.push("// ---- RUNTIME STRINGS (decoded by the obfuscator itself) ----");
      L.push("const strings = [");
      const sorted = [...new Set(dump.log.strings)].sort((a, b) => a.localeCompare(b));
      for (const s of sorted) L.push("  " + JSON.stringify(s) + ",");
      L.push("];");
      L.push("");
    }
    if (dump.log.evals.length) {
      L.push("// ---- EVAL / NEW FUNCTION PAYLOADS ----");
      dump.log.evals.forEach((src, i) => {
        L.push("// payload #" + (i + 1) + ":");
        let pretty = src;
        try {
          pretty = Babel.transform(src, {
            configFile: false, babelrc: false, errorRecovery: true, compact: false,
          }).code;
        } catch (e) { /* keep raw */ }
        L.push(pretty.split("\n").map(x => "//   " + x).join("\n"));
        L.push("");
      });
    }
    if (dump.log.props.length) {
      L.push("// ---- GLOBAL PROPERTY PROBES (env checks / anti-debug) ----");
      const uniq = [...new Set(dump.log.props)].sort();
      L.push("const probedGlobals = " + JSON.stringify(uniq, null, 2) + ";");
      L.push("");
    }
    if (dump.log.errors.length) {
      L.push("// ---- TRAPPED ERRORS (neutralised by the sandbox) ----");
      for (const e of [...new Set(dump.log.errors)]) L.push("// - " + e);
      L.push("");
    }
    L.push("// End of dump. Re-run with longer timeout or different engine for full decode.");
    return L.join("\n") + "\n";
  }
})();
