/* Unravel – UI: engine picker, simplify toggle, editor panes, actions. */
(function (UI) {
  const R = window.UnravelRegistry;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  UI.state = {
    engine: "unravel",
    simplify: true,
    busy: false,
    lastOutput: "",
  };

  // ---- engine cards ----------------------------------------------------------
  UI.renderEngines = function () {
    const groups = [
      ["deobfuscator", "Deobfuscators"],
      ["decompiler", "Decompiler"],
      ["dumper", "Dumper"],
    ];
    const host = $("#engine-list");
    host.innerHTML = "";
    for (const [cat, label] of groups) {
      const engines = R.byCategory[cat] || [];
      if (!engines.length) continue;
      host.appendChild(el("div", "group-label", label));
      for (const eng of engines) {
        const card = el("button", "engine-card" + (eng.flagship ? " flagship" : "") +
          (UI.state.engine === eng.id ? " active" : ""));
        card.type = "button";
        card.dataset.id = eng.id;
        card.innerHTML =
          '<span class="engine-name">' + esc(eng.name) + (eng.flagship ? ' <i class="star">★</i>' : "") + "</span>" +
          '<span class="engine-desc">' + esc(eng.desc) + "</span>" +
          '<span class="engine-tags">' + eng.tags.map(t => "<i>" + esc(t) + "</i>").join("") + "</span>";
        card.addEventListener("click", () => {
          UI.state.engine = eng.id;
          UI.renderEngines();
          UI.updateRecommendation();
        });
        host.appendChild(card);
      }
    }
  };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---- recommendation badge ---------------------------------------------------
  let recDebounce = null;
  UI.updateRecommendation = function () {
    clearTimeout(recDebounce);
    recDebounce = setTimeout(() => {
      const code = $("#input-code").value;
      const box = $("#recommendation");
      if (!code.trim()) { box.innerHTML = ""; return; }
      let best = null, bestScore = -1;
      for (const eng of R.engines) {
        let s = 0;
        try { s = eng.test(null, code); } catch (e) { s = 0; }
        if (s > bestScore) { bestScore = s; best = eng; }
      }
      if (best && bestScore >= 0.5) {
        box.innerHTML = '<span class="rec">recommended: <b>' + esc(best.name) + "</b> (" +
          Math.round(bestScore * 100) + "% match)" +
          (best.id !== UI.state.engine ? ' · <button type="button" id="rec-switch">switch</button>' : "") +
          "</span>";
        const sw = $("#rec-switch");
        if (sw) sw.addEventListener("click", () => { UI.state.engine = best.id; UI.renderEngines(); UI.updateRecommendation(); });
      } else {
        box.innerHTML = '<span class="rec muted">no strong obfuscation signature — decompiler mode may be enough</span>';
      }
    }, 300);
  };

  // ---- run ----------------------------------------------------------------------
  UI.run = async function () {
    if (UI.state.busy) return;
    const input = $("#input-code").value;
    if (!input.trim()) { flash("Paste some JavaScript first."); return; }
    UI.state.busy = true;
    setBusy(true);
    try {
      const res = await R.run(UI.state.engine, input, { simplify: UI.state.simplify });
      UI.state.lastOutput = res.code;
      renderOutput(res);
      flash("Done in " + res.stats.timeMs + " ms");
    } catch (e) {
      console.error(e);
      renderError(e);
    } finally {
      UI.state.busy = false;
      setBusy(false);
    }
  };

  function setBusy(on) {
    $("#run-btn").disabled = on;
    $("#run-btn").classList.toggle("busy", on);
    $("#status-dot").className = "dot " + (on ? "busy" : "ok");
    $("#status-text").textContent = on ? "working…" : "ready";
  }

  function renderOutput(res) {
    const out = $("#output-code");
    out.value = res.code;
    $("#stats-line").innerHTML =
      chip(res.stats.engine) + chip(res.stats.timeMs + " ms") +
      chip(fmt(res.stats.inBytes) + " → " + fmt(res.stats.outBytes)) +
      chip(res.stats.lines + " lines");
    const notes = $("#notes-list");
    notes.innerHTML = "";
    for (const n of res.stats.notes) notes.appendChild(el("li", null, esc(n)));
    for (const w of res.stats.warnings) notes.appendChild(el("li", "warn", "⚠ " + esc(w)));
    $("#results-meta").style.display = "block";
  }

  function renderError(e) {
    $("#output-code").value = "";
    $("#stats-line").innerHTML = chip('<span class="err">error</span>');
    $("#notes-list").innerHTML = '<li class="err">' + esc(String(e.message || e)) + "</li>";
    $("#results-meta").style.display = "block";
  }

  function chip(html) { return '<span class="chip">' + html + "</span>"; }
  function fmt(n) { return n > 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B"; }

  let flashTimer = null;
  function flash(msg) {
    $("#status-text").textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (!UI.state.busy) $("#status-text").textContent = "ready"; }, 2600);
  }

  // ---- actions --------------------------------------------------------------------
  UI.copy = async function () {
    if (!UI.state.lastOutput) return flash("Nothing to copy yet");
    try { await navigator.clipboard.writeText(UI.state.lastOutput); flash("Copied ✓"); }
    catch (e) { fallbackCopy(UI.state.lastOutput); flash("Copied ✓"); }
  };

  UI.download = function () {
    if (!UI.state.lastOutput) return flash("Nothing to download yet");
    const blob = new Blob([UI.state.lastOutput], { type: "text/javascript" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "unravel." + UI.state.engine.replace(/\s+/g, "-") + ".js";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }

  UI.clearAll = function () {
    $("#input-code").value = "";
    $("#output-code").value = "";
    $("#results-meta").style.display = "none";
    $("#recommendation").innerHTML = "";
    try { localStorage.removeItem("unravel.input"); } catch (e) {}
  };

  UI.loadSample = function () {
    fetch("samples/sample-obfuscated.js").then(r => r.text()).then(code => {
      $("#input-code").value = code;
      UI.updateRecommendation();
      persist();
    }).catch(() => flash("sample unavailable"));
  };

  function persist() {
    try { localStorage.setItem("unravel.input", $("#input-code").value.slice(0, 200000)); } catch (e) {}
  }

  // ---- wire-up ---------------------------------------------------------------------
  UI.init = function () {
    UI.renderEngines();
    setBusy(false);

    $("#run-btn").addEventListener("click", UI.run);
    $("#btn-copy").addEventListener("click", UI.copy);
    $("#btn-download").addEventListener("click", UI.download);
    $("#btn-clear").addEventListener("click", UI.clearAll);
    $("#btn-sample").addEventListener("click", UI.loadSample);

    const toggle = $("#toggle-simplify");
    toggle.checked = UI.state.simplify;
    toggle.addEventListener("change", () => { UI.state.simplify = toggle.checked; });

    const input = $("#input-code");
    input.addEventListener("input", debounce(() => { UI.updateRecommendation(); persist(); }, 350));
    input.addEventListener("drop", handleDrop);
    input.addEventListener("dragover", (e) => e.preventDefault());

    // restore previous input
    try {
      const saved = localStorage.getItem("unravel.input");
      if (saved) { input.value = saved; UI.updateRecommendation(); }
    } catch (e) {}

    // Ctrl+Enter runs
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") UI.run();
    });

    function handleDrop(e) {
      e.preventDefault();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { input.value = reader.result; UI.updateRecommendation(); };
      reader.readAsText(f);
    }

    function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  };
})(window.UnravelUI = window.UnravelUI || {});
