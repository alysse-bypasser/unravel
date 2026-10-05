/* Unravel – shared Babel transform passes.
 * These are plain visitor objects (no plugin wrapper needed) that the pipeline
 * applies with `path.traverse(visitor)` repeatedly until output stabilises. */
(function (U) {
  const t = Babel.types;

  // ---------------------------------------------------------------------------
  // 1. Constant folding + member-call simplification
  //    "a" + "b" -> "ab", [].map.call(x, f) -> x.map(f), []["concat"](...) etc.
  // ---------------------------------------------------------------------------
  U.foldConstants = {
    BinaryExpression: {
      exit(path) {
        if (path.node.operator === "+" &&
            (t.isStringLiteral(path.node.left) || t.isStringLiteral(path.node.right))) {
          const ev = path.evaluate();
          if (ev.confident && typeof ev.value === "string") {
            path.replaceWith(t.stringLiteral(ev.value));
          }
        } else if (path.node.operator !== "instanceof") {
          const ev = path.evaluate();
          if (ev.confident && (typeof ev.value === "number" || typeof ev.value === "boolean")) {
            if (typeof ev.value === "number" && !isFinite(ev.value)) return;
            path.replaceWith(t.valueToNode(ev.value));
          }
        }
      },
    },
    UnaryExpression: {
      exit(path) {
        const ev = path.evaluate();
        if (ev.confident && (typeof ev.value === "string" || typeof ev.value === "number" || typeof ev.value === "boolean")) {
          if (typeof ev.value === "number" && !isFinite(ev.value)) return;
          path.replaceWith(t.valueToNode(ev.value));
        }
      },
    },
    CallExpression: {
      exit(path) {
        const callee = path.node.callee;
        if (!t.isMemberExpression(callee)) return;
        const obj = callee.object, prop = callee.property;
        const fname = U.getStringValue(prop) || (t.isIdentifier(prop) ? prop.name : null);
        if (!fname) return;
        const args = path.node.arguments;
        // [ ].map.call(arr, fn) / ["filter"].call(arr, fn) …
        const ARRAY_METHODS = ["map", "filter", "forEach", "join", "slice", "some", "every", "find", "indexOf", "concat", "reverse"];
        const isArrayObj =
          (t.isArrayExpression(obj) && obj.elements.length === 0) ||
          (t.isCallExpression(obj) && t.isMemberExpression(obj.callee) &&
           U.getStringValue(obj.callee.property) === "atob");
        if (isArrayObj && ARRAY_METHODS.includes(fname) && args.length >= 2) {
          path.replaceWith(t.callExpression(
            t.memberExpression(args[0], t.identifier(fname)), args.slice(1)));
          return;
        }
        // Function.prototype.bind.call(f, ctx) -> f.bind(ctx) is already fine; skip.
        // "str".split/repeat/charCodeAt style on evaluated strings handled by evaluate().
      },
    },
  };

  // ---------------------------------------------------------------------------
  // 2. String-array inlining.
  //    Pass A: local `const _arr = ["a","b"]; … _arr[i]` → inline literal.
  //    Pass B: global registry functions `function g(){return ["a","b"]}` or
  //            `var g = function(){…}` referenced as g(i) → inline literal.
  // ---------------------------------------------------------------------------
  U.inlineLocalArrays = {
    VariableDeclarator(path) {
      const id = path.node.id;
      const init = path.node.init;
      if (!t.isIdentifier(id) || !t.isArrayExpression(init)) return;
      if (!init.elements.every(e => e && t.isStringLiteral(e))) return;
      const binding = path.scope.getBinding(id.name);
      if (!binding || !binding.constant) return;
      for (const ref of binding.referencePaths) {
        const parent = ref.parentPath;
        if (parent && parent.isMemberExpression({ object: ref.node }) && parent.node.computed) {
          const idx = parent.evaluate();
          if (idx.confident && typeof idx.value === "number" &&
              idx.value >= 0 && idx.value < init.elements.length) {
            parent.replaceWith(t.cloneNode(init.elements[idx.value]));
          }
        }
      }
    },
  };

  U.inlineGlobalRegistry = {
    // function _0xabc(){ return [ "...", "..." ]; }  (or a rotated copy)
    FunctionDeclaration(path) {
      tryRegistry(path, path.node.id);
    },
    VariableDeclarator(path) {
      if (t.isFunctionExpression(path.node.init) || t.isArrowFunctionExpression(path.node.init)) {
        tryRegistry(path, path.node.id);
      }
    },
  };

  function tryRegistry(fnPath, idNode) {
    if (!idNode || !t.isIdentifier(idNode)) return;
    const body = fnPath.node.body && fnPath.node.body.body;
    if (!body || !body.length) return;
    // Find an array-of-strings either returned directly or assigned once at top.
    let arr = null;
    const ret = body.find(s => t.isReturnStatement(s) && t.isArrayExpression(s.argument) &&
                             s.argument.elements.every(e => e && t.isStringLiteral(e)));
    if (ret) arr = ret.argument;
    if (!arr) {
      const decl = body.find(s => t.isVariableDeclaration(s) && s.declarations.length === 1 &&
                                  t.isIdentifier(s.declarations[0].id) &&
                                  t.isArrayExpression(s.declarations[0].init) &&
                                  s.declarations[0].init.elements.every(e => e && t.isStringLiteral(e)));
      if (decl) {
        const localName = decl.declarations[0].id.name;
        const r = body.find(s => t.isReturnStatement(s) && t.isIdentifier(s.argument, { name: localName }));
        if (r) arr = decl.declarations[0].init;
      }
    }
    if (!arr) return;
    const strings = arr.elements.map(e => e.value);
    const binding = fnPath.scope.getBinding(idNode.name);
    if (!binding) return;
    let replaced = 0;
    for (const ref of binding.referencePaths) {
      const call = ref.parentPath;
      if (!call || !call.isCallExpression({ callee: ref.node })) continue;
      if (call.node.arguments.length !== 1) continue;
      const idx = call.get("arguments.0").evaluate();
      if (!idx.confident || typeof idx.value !== "number") continue;
      const i = ((idx.value % strings.length) + strings.length) % strings.length;
      call.replaceWith(t.stringLiteral(strings[i]));
      replaced++;
    }
    if (replaced > 0 && binding.referencePaths.length === replaced) {
      // all references consumed → drop the registry function
      if (fnPath.isFunctionDeclaration()) fnPath.remove();
      else if (fnPath.parentPath && fnPath.parentPath.isVariableDeclarator()) fnPath.parentPath.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Hex identifiers → readable names (_0x3f2a1b → v1, v2 …).
  // ---------------------------------------------------------------------------
  const RESERVED = new Set(["window", "self", "global", "document", "top", "parent"]);

  U.renameHexIdentifiers = function (programPath, opts) {
    opts = opts || {};
    const prefix = opts.prefix || "v";
    const globals = U.collectGlobals(programPath);
    const renameMap = Object.create(null);
    let counter = 0;
    const nextName = (kind) => {
      let name;
      do { name = kind + (++counter); } while (globals.has(name) || renameMap[name] || RESERVED.has(name));
      return name;
    };
    programPath.traverse({
      Scopable(path) {
        for (const [name, binding] of Object.entries(path.scope.bindings)) {
          if (!/^_0x[0-9a-fA-F]{2,}$/.test(name)) continue;
          if (renameMap[name]) continue;
          let kind = "v";
          if (binding.kind === "function" || t.isFunction(binding.path.node)) kind = "fn";
          else if (binding.kind === "class") kind = "Cls";
          else if (t.isObjectExpression(binding.path.node && binding.path.node.init)) kind = "obj";
          renameMap[name] = nextName(kind);
        }
      },
      ReferencedIdentifier(path) {
        const name = path.node.name;
        if (!/^_0x[0-9a-fA-F]{2,}$/.test(name)) return;
        if (path.scope.hasBinding(name, true)) return; // declared somewhere → handled above
        if (!renameMap[name]) renameMap[name] = nextName("g"); // free/global hex name
      },
    });
    // Apply renames via scope so shadowing is respected per-binding.
    programPath.traverse({
      Scopable(path) {
        for (const [name, binding] of Object.entries(path.scope.bindings)) {
          if (renameMap[name] && binding.identifier.name === name) {
            try { binding.scope.rename(name, renameMap[name]); } catch (e) { /* ignore */ }
          }
        }
      },
    });
    // Global (undeclared) hex names: plain textual-safe AST rename.
    programPath.traverse({
      Identifier(path) {
        if (renameMap[path.node.name] && !path.scope.hasBinding(path.node.name, true)) {
          path.node.name = renameMap[path.node.name];
        }
      },
    });
    return renameMap;
  };

  // ---------------------------------------------------------------------------
  // 4. Rename short/mangled locals (webcrack-style "unminify"): a1, b2, _x …
  //    Infers role-based names from context.
  // ---------------------------------------------------------------------------
  const COMMON_GLOBALS = new Set([
    "window", "document", "console", "Math", "JSON", "Object", "Array", "String", "Number",
    "Boolean", "Promise", "Symbol", "Proxy", "Reflect", "Date", "RegExp", "Error", "Map",
    "Set", "WeakMap", "WeakSet", "localStorage", "sessionStorage", "navigator", "location",
    "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "require",
    "module", "exports", "__dirname", "__filename", "process", "Buffer", "global",
    "globalThis", "eval", "parseInt", "parseFloat", "isNaN", "encodeURIComponent",
    "decodeURIComponent", "atob", "btoa", "undefined", "NaN", "Infinity", "arguments",
    "this", "_", "$", "jQuery", "XMLHttpRequest", "WebSocket", "alert", "crypto",
  ]);

  U.renameShortLocals = function (programPath) {
    const globals = U.collectGlobals(programPath);
    let changed = 0, counter = 0;
    const uniq = (base) => {
      let n = base, i = 0;
      const seen = new Set([...globals, ...COMMON_GLOBALS]);
      while (seen.has(n)) n = base + (++i);
      return n;
    };
    programPath.traverse({
      Scopable(path) {
        for (const [name, binding] of Object.entries(path.scope.bindings)) {
          if (/^_?0x/i.test(name)) continue; // handled by hex-renamer
          if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) continue;
          const core = name.replace(/^[_$]+/, "");
          const shortMangle = /^[a-z][0-9]{1,2}$|^[a-z]$|^[A-Za-z]{1,2}[0-9]{1,3}$|^_+$/.test(core) && name.length <= 4;
          const hexish = /^[a-f0-9]{4,}$/i.test(core);
          if (!(shortMangle || hexish)) continue;
          const bp = binding.path;
          let newName = null;
          const init = bp.node && bp.node.init;
          if (bp.isFunctionDeclaration() || bp.isFunctionExpression() || bp.isArrowFunctionExpression ||
              (bp.isVariableDeclarator() && t.isFunction(init))) {
            const nm = guessFunctionName(bp);
            newName = uniq(nm || ("handler" + (++counter)));
          } else if (bp.isVariableDeclarator()) {
            if (init && t.isNewExpression(init) && t.isIdentifier(init.callee)) {
              newName = uniq(lowerFirst(init.callee.name) + "Instance");
            } else if (init && t.isCallExpression(init) && t.isIdentifier(init.callee)) {
              newName = uniq("get" + upperFirst(init.callee.name));
            } else if (init && t.isObjectExpression(init)) newName = uniq("obj" + (++counter));
            else if (init && t.isArrayExpression(init)) newName = uniq("list" + (++counter));
            else if (init && (t.isStringLiteral(init) || U.getStringValue(init))) newName = uniq("str" + (++counter));
            else if (init && t.isNumericLiteral(init)) newName = uniq("num" + (++counter));
            else if (bp.node.id && t.isObjectPattern(bp.node.id)) newName = uniq("destructured" + (++counter));
            else if (bp.node.id && t.isArrayPattern(bp.node.id)) newName = uniq("tuple" + (++counter));
            else newName = uniq("value" + (++counter));
          } else if (bp.isFunctionParameter() || (bp.parentPath && bp.parentPath.isFunction())) {
            newName = uniq(paramGuess(bp) || "arg" + (++counter));
          } else if (bp.isCatchClause()) {
            newName = uniq("error");
          } else if (bp.isClassDeclaration() || bp.isClassExpression()) {
            newName = uniq("Cls" + (++counter));
          }
          if (newName && newName !== name) {
            try { binding.scope.rename(name, newName); changed++; } catch (e) { /* ignore */ }
          }
        }
      },
    });
    return changed;
  };

  function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
  function upperFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function guessFunctionName(fp) {
    const p = fp.parentPath;
    if (p && p.isVariableDeclarator({ id: fp.node.id })) { /* noop */ }
    if (fp.node.id) {
      const n = fp.node.id.name;
      if (/^_?[a-f0-9]{4,}$/i.test(n.replace(/^_0x/i, "")) || /^[a-z][0-9]{1,2}$/.test(n)) return null;
      return n;
    }
    const declarator = fp.findParent(x => x.isVariableDeclarator());
    if (declarator && t.isIdentifier(declarator.node.id)) {
      const n = declarator.node.id.name;
      if (!/^[a-z][0-9]{1,2}$/.test(n)) return n;
    }
    // assigned to member: obj.fn = function…
    const assign = fp.findParent(x => x.isAssignmentExpression());
    if (assign && t.isMemberExpression(assign.node.left) && !assign.node.left.computed &&
        t.isIdentifier(assign.node.left.property)) {
      return assign.node.left.property.name;
    }
    // argument to a named call: addEventListener("click", f) → onClick-ish
    const callArg = fp.findParent(x => x.isCallExpression());
    if (callArg) {
      const c = callArg.node.callee;
      if (t.isMemberExpression(c) && t.isIdentifier(c.property)) return c.property.name;
      if (t.isIdentifier(c)) return c.name;
    }
    return null;
  }

  function paramGuess(bp) {
    const fn = bp.getFunctionParent();
    if (!fn) return null;
    const index = (fn.node.params || []).indexOf(bp.node);
    if (index === -1) return null;
    const fname = guessFunctionName(fn);
    if (!fname) return null;
    const hints = {
      addEventListener: ["event"], fetch: ["url", "options"], setTimeout: ["callback", "delay"],
      setInterval: ["callback", "delay"], push: ["item"], map: ["item"], filter: ["item"],
      forEach: ["item"], join: ["separator"], require: ["id"], createElement: ["tagName"],
      getElementById: ["id"], querySelector: ["selector"], appendChild: ["child"],
      replace: ["search", "replace"], split: ["separator"], slice: ["start", "end"],
    };
    const key = fname.replace(/^(on|get|create)/, "").toLowerCase();
    for (const [k, v] of Object.entries(hints)) {
      if (key.includes(k.toLowerCase()) && v[index]) return v[index];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 5. Dead code removal (if/cond, unreachable statements, empty blocks…)
  // ---------------------------------------------------------------------------
  U.removeDeadCode = {
    IfStatement: {
      exit(path) {
        const test = path.get("test");
        const ev = test.evaluate();
        if (!ev.confident) return;
        if (ev.value) {
          path.replaceInline(path.node.alternate && !t.isIfStatement(path.node.consequent)
            ? [path.node.consequent] : [path.node.consequent]);
          if (ev.value === true && path.node.alternate) {
            // keep consequent only
          }
        } else {
          if (path.node.alternate) path.replaceWith(path.node.alternate);
          else path.remove();
        }
      },
    },
    ConditionalExpression: {
      exit(path) {
        const ev = path.get("test").evaluate();
        if (!ev.confident) return;
        path.replaceWith(ev.value ? path.node.consequent : path.node.alternate);
      },
    },
    LogicalExpression: {
      exit(path) {
        const left = path.get("left").evaluate();
        if (!left.confident) return;
        if (path.node.operator === "&&") {
          path.replaceWith(left.value ? path.node.right : path.node.left);
        } else if (path.node.operator === "||") {
          path.replaceWith(left.value ? path.node.left : path.node.right);
        } else if (path.node.operator === "??") {
          path.replaceWith((left.value === null || left.value === undefined) ? path.node.right : path.node.left);
        }
      },
    },
    BlockStatement: {
      exit(path) {
        if (path.inList && path.parentPath.isIfStatement()) return;
        // remove unreachable statements after terminator
        const body = path.get("body");
        let cut = -1;
        for (let i = 0; i < body.length - 1; i++) {
          const s = body[i];
          if (s.isReturnStatement() || s.isThrowStatement() || s.isBreakStatement() ||
              s.isContinueStatement() || (s.isIfStatement() && isTerminating(s))) {
            cut = i; break;
          }
        }
        if (cut >= 0) {
          for (let i = body.length - 1; i > cut; i--) {
            const s = body[i];
            if (!s.isFunctionDeclaration() && !s.isClassDeclaration()) s.remove();
          }
        }
        if (path.node.body.length === 0 &&
            !(path.parentPath.isFunction() || path.parentPath.isCatchClause())) {
          path.remove();
        }
      },
    },
    SwitchCase: {
      exit(path) {
        const cases = path.parentPath.node.cases;
        if (t.isSwitchStatement(path.parent)) {
          const disc = path.parentPath.get("discriminant").evaluate();
          if (disc.confident && path.node.test) {
            const val = path.node.test;
            if (t.isStringLiteral(val) || t.isNumericLiteral(val)) {
              if (val.value !== disc.value) {
                // constant switch case not matching → dead branch
                if (path.node.consequent.length && !path.node.consequent.some(s => t.isBreakStatement(s))) {
                  // falls through – be conservative, keep
                } else {
                  path.remove();
                }
              }
            }
          }
        }
      },
    },
    ExpressionStatement: {
      exit(path) {
        const e = path.node.expression;
        if (t.isSequenceExpression(e)) {
          const pure = e.expressions.filter(x =>
            !(t.isCallExpression(x) || t.isNewExpression(x) || t.isAssignmentExpression(x) ||
              t.isUpdateExpression(x) || t.isYieldExpression(x) || t.isAwaitExpression(x)));
          const impure = e.expressions.filter(x => pure.indexOf(x) === -1);
          if (pure.length && !impure.length) { path.remove(); return; }
          if (pure.length && impure.length === 1) path.replaceWith(t.expressionStatement(impure[0]));
        } else if (isPureExpression(e) && !t.isTemplateLiteral(e)) {
          // bare constant / identifier statement: `_0xdead();` stays, `"use strict";` stays
          if (!(t.isStringLiteral(e) && path.key === 0)) path.remove();
        }
      },
    },
    SequenceExpression: {
      exit(path) {
        if (path.parentPath.isExpressionStatement()) return;
        if (path.node.expressions.length === 1) path.replaceWith(path.node.expressions[0]);
      },
    },
    ReturnStatement: {
      exit(path) {
        if (!path.node.argument) return;
        if (isPureExpression(path.node.argument) && isEmptyBody(path)) {
          path.replaceWith(t.returnStatement());
        }
      },
    },
    VariableDeclaration: {
      exit(path) {
        // drop declarators whose init is a pure constant and never referenced
        for (const d of path.get("declarations")) {
          const binding = d.scope.getBinding(d.node.id.name);
          if (!binding) continue;
          if (binding.references === 0 && !binding.constantViolations.length &&
              d.node.init && isPureExpression(d.node.init)) {
            if (path.node.declarations.length === 1) path.remove();
            else d.remove();
          }
        }
      },
    },
  };

  function isTerminating(ifPath) {
    const cons = ifPath.get("consequent");
    const alt = ifPath.get("alternate");
    const blockHasTerm = (p) => {
      if (!p || !p.node) return false;
      if (p.isBlockStatement()) return p.get("body").some(s =>
        s.isReturnStatement() || s.isThrowStatement() || (s.isIfStatement() && isTerminating(s)));
      if (p.isIfStatement()) return isTerminating(p);
      return p.isReturnStatement() || p.isThrowStatement();
    };
    return blockHasTerm(cons) && (alt ? blockHasTerm(alt) : false);
  }

  function isPureExpression(node) {
    if (t.isLiteral(node)) return true;
    if (t.isIdentifier(node)) return node.name !== "undefined" ? true : true;
    if (t.isUnaryExpression(node) && ["!", "-", "+", "~", "typeof", "void"].includes(node.operator)) {
      return isPureExpression(node.argument);
    }
    if (t.isBinaryExpression(node)) return isPureExpression(node.left) && isPureExpression(node.right);
    if (t.isLogicalExpression(node)) return isPureExpression(node.left) && isPureExpression(node.right);
    if (t.isConditionalExpression(node)) return isPureExpression(node.test) && isPureExpression(node.consequent) && isPureExpression(node.alternate);
    if (t.isMemberExpression(node)) return isPureExpression(node.object) && !node.computed;
    if (t.isSequenceExpression(node)) return node.expressions.every(isPureExpression);
    return false;
  }

  function isEmptyBody(returnPath) {
    const fn = returnPath.getFunctionParent();
    if (!fn) return false;
    const body = fn.node.body;
    return body && body.body && body.body.length === 1 && body.body[0] === returnPath.node;
  }

  // ---------------------------------------------------------------------------
  // 6. Remove debugger statements & self-defending anti-debug loops
  // ---------------------------------------------------------------------------
  U.removeAntiDebug = {
    DebuggerStatement(path) { path.remove(); },
    WhileStatement(path) {
      // while(true){ debugger; } / for(;;){debugger;}
      const hasDbg = !!path.node.body && JSON.stringify(path.node.body).includes('"DebuggerStatement"');
      if (hasDbg && path.get("test").evaluate().confident && path.get("test").evaluate().value) {
        path.remove();
      }
    },
    ForStatement(path) {
      const hasDbg = !!path.node.body && JSON.stringify(path.node.body).includes('"DebuggerStatement"');
      const noTest = !path.node.test;
      if (hasDbg && noTest) path.remove();
    },
    CallExpression(path) {
      // setInterval/setTimeout(function(){debugger}, 100)
      const c = path.node.callee;
      if (t.isIdentifier(c) && ["setInterval", "setTimeout"].includes(c.name) && path.node.arguments.length) {
        const fn = path.node.arguments[0];
        if ((t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn)) &&
            JSON.stringify(fn.body).includes('"DebuggerStatement"')) {
          path.remove();
        }
      }
    },
  };

  // ---------------------------------------------------------------------------
  // 7. Boolean / numeric literal normalisation: ![]→true, !!void 0→false, 0x1f→31
  // ---------------------------------------------------------------------------
  U.normalizeLiterals = {
    UnaryExpression: {
      exit(path) {
        const ev = path.evaluate();
        if (ev.confident && typeof ev.value === "boolean") path.replaceWith(t.booleanLiteral(ev.value));
      },
    },
    NumericLiteral(path) {
      // generator prints decimals by default; nothing to do beyond format pass
    },
  };

  // ---------------------------------------------------------------------------
  // 8. Simplify toggle (aggressive webcrack-like simplification).
  //    Runs many clean-up visitors until stable.
  // ---------------------------------------------------------------------------
  U.simplifyVisitor = {
    // var → let/const when safe
    VariableDeclaration: {
      exit(path) {
        if (path.node.kind !== "var") return;
        if (path.findParent(p => p.isLoop() && p.node.body && p.node.body.body &&
                                 p.node.body.body.includes(path.node))) return; // hoisting-sensitive
        let allConst = true;
        for (const d of path.node.declarations) {
          if (!d.init) { allConst = false; break; }
          if (!t.isIdentifier(d.id)) continue;
          const b = path.scope.getBinding(d.id.name);
          if (!b || !b.constant) { allConst = false; break; }
        }
        path.node.kind = allConst ? "const" : "let";
      },
    },
    // while(!x){} guard loops like obfuscator self-defence: keep but unwrap !0/!1
    // Merge consecutive variable declarations
    BlockStatement: {
      exit(path) {
        const body = path.node.body;
        for (let i = body.length - 1; i > 0; i--) {
          const cur = body[i], prev = body[i - 1];
          if (t.isVariableDeclaration(cur) && t.isVariableDeclaration(prev) && cur.kind === prev.kind) {
            prev.declarations.push(...cur.declarations);
            body.splice(i, 1);
          }
        }
      },
    },
    MemberExpression: {
      exit(path) {
        // obj["prop"] → obj.prop
        if (path.node.computed) {
          const s = U.getStringValue(path.node.property);
          if (s !== null && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) &&
              !t.isPrivateName(path.node.property)) {
            path.node.computed = false;
            path.node.property = t.identifier(s);
          }
        }
        // window["document"] → window.document done above; also strip void root checks
      },
    },
    ThisExpression(path) {
      // top-level this → globalThis-ish: leave alone (safe)
    },
    ArrowFunctionExpression: {
      exit(path) {
        // single-return-body arrows stay; ({...}) wrapped params unwrap
        if (path.node.params.length === 1 && t.isIdentifier(path.node.params[0])) return;
      },
    },
    ObjectExpression(path) {
      // {a: "b"} stays; __proto__ string keys → identifier where possible
      for (const p of path.node.properties) {
        if (p.type === "ObjectProperty" && p.computed === false && t.isStringLiteral(p.key)) {
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.key.value) && p.key.value !== "__proto__") {
            p.key = t.identifier(p.key.value);
            p.shorthand = false;
          }
        }
      },
    },
    TemplateLiteral(path) {
      if (!path.node.expressions.length) {
        path.replaceWith(t.stringLiteral(U.getStringValue(path.node)));
      }
    },
    StringLiteral: {
      exit(path) {
        // unescape \xNN unicode noise: "\x41" is already parsed to "A" by parser.
        // merge adjacent escapes nothing to do — but flag non-printable heavy strings later.
      },
    },
    // IIFE unwrapping: (function(){ … })() → statements ; ((f)=>f())(x)
    CallExpression: {
      exit(path) {
        const callee = path.node.callee;
        if ((t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) &&
            path.node.arguments.length === 0 && t.isBlockStatement(callee.body)) {
          const stmts = callee.body.body;
          if (!stmts.some(s => t.isReturnStatement(s) && s.argument)) {
            path.replaceWithMultiple(stmts);
          } else if (stmts.length === 1 && t.isReturnStatement(stmts[0])) {
            path.replaceWith(stmts[0].argument);
          }
        }
      },
    },
    AssignmentExpression: {
      exit(path) {
        // sequence-in-condition cleanup: (a = 1, a) → 1 handled by fold
      },
    },
  };

  // ---------------------------------------------------------------------------
  // 9. Control-flow flattening de-flattener (while+switch state machines).
  // ---------------------------------------------------------------------------
  U.unflattenControlFlow = {
    WhileStatement: {
      exit(path) {
        const body = path.node.body;
        if (!t.isBlockStatement(body)) return;
        const sw = body.body.find(s => t.isSwitchStatement(s));
        if (!sw || body.body.length > 3) return;
        // find the state variable: initialised before loop, updated inside
        let stateVar = null;
        if (t.isIdentifier(sw.discriminant)) stateVar = sw.discriminant.name;
        if (!stateVar) return;
        const initStmt = findPrevAssign(path, stateVar);
        if (!initStmt) return;
        const order = [];
        let curVal = getLiteralVal(initStmt.node.init);
        if (curVal === null) return;
        const cases = new Map();
        for (const c of sw.cases) {
          const v = getLiteralVal(c.test);
          if (v === null) continue;
          cases.set(String(v), c.consequent.filter(s => !t.isBreakStatement(s)));
        }
        const visited = new Set();
        let guard = 0;
        while (curVal !== null && cases.has(String(curVal)) && guard++ < 200) {
          const key = String(curVal);
          if (visited.has(key)) break;
          visited.add(key);
          const stmts = cases.get(key) || [];
          order.push(...stmts);
          const upd = stmts.find(s => t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) &&
                                      t.isIdentifier(s.expression.left, { name: stateVar }));
          if (!upd) break;
          curVal = getLiteralVal(upd.expression.right);
          if (curVal === null) break;
        }
        if (!order.length || visited.size < 2) return;
        const replacements = [t.blockStatement(order)];
        // keep any statements outside the switch (e.g., the initial declaration handling)
        const otherStmts = body.body.filter(s => s !== sw);
        if (otherStmts.length) replacements.unshift(...otherStmts);
        path.replaceWithMultiple(replacements);
        if (initStmt.node._uStateInit) initStmt.remove();
        else if (t.isExpressionStatement(initStmt.node)) initStmt.remove();
      },
    },
  };

  function findPrevAssign(whilePath, name) {
    const container = whilePath.container;
    if (!Array.isArray(container)) return null;
    const idx = whilePath.key;
    for (let i = idx - 1; i >= 0 && i > idx - 6; i--) {
      const s = container[i];
      if (!s) continue;
      if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) &&
          t.isIdentifier(s.expression.left, { name })) return whilePath.getSibling(i);
      if (t.isVariableDeclaration(s)) {
        const d = s.declarations.find(dd => t.isIdentifier(dd.id, { name }));
        if (d) return whilePath.getSibling(i);
      }
    }
    return null;
  }

  function getLiteralVal(node) {
    if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return node.value;
    return null;
  }

  // ---------------------------------------------------------------------------
  // 10. Universal "dumper": eval-at-runtime helpers live in engine-dumper.js.
  //     Here we only provide the static pieces shared by it.
  // ---------------------------------------------------------------------------
})(window.UnravelPasses = window.UnravelPasses || {});
