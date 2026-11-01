/* ============================================================================
   jak2-view.js · JAK2 6VGL 红对接对照的独立 3D 视图
   ----------------------------------------------------------------------------
   与 assets/scene3d.js 完全解耦：不影响 HIV-1 的两处 3D 实例。
   数据（只读拷贝，未改动）：
     data/jak2/receptor.pdb        6VGL A 840–1132 制备受体（module02 outputs）
     data/jak2/rxt_reference.sdf   RXT 共晶姿势（reference.sdf）
     data/jak2/poses.pdbqt         Vina 9 个姿势（run jak2_6vgl_rxt_dock-20261030-001201）
   ========================================================================== */
(function () {
  "use strict";

  var ELEMENT_COLORS = {
    N: "#6d86a0", O: "#b06a58", S: "#a8975e", P: "#b08a5e",
    F: "#88a189", CL: "#88a189", Cl: "#88a189",
    BR: "#a2715c", Br: "#a2715c"
  };

  var refModel = null;
  var poseModel = null;
  var proteinModel = null;
  var viewer = null;
  var spinning = false;
  var mode = "reference";
  var ready = false;

  function $(sel) { return document.querySelector(sel); }

  function splitModels(text) {
    var out = [];
    var cur = null;
    text.split(/\r?\n/).forEach(function (line) {
      if (/^MODEL/.test(line)) { cur = []; return; }
      if (/^ENDMDL/.test(line)) {
        if (cur && cur.length) out.push(cur.join("\n") + "\nEND\n");
        cur = null;
        return;
      }
      if (cur) cur.push(line);
    });
    if (!out.length) out.push(text);
    return out;
  }

  /* PDBQT 的原子类型写在 78–79 列（A / OA / NA / SA…），3Dmol 的 PDB 解析器
     会把这些当成未知元素而丢掉。这里只做格式转换：把类型映射成元素符号，
     坐标与原子数不变。 */
  function pdbqtToPdb(text) {
    var map = {
      A: "C", C: "C", N: "N", NA: "N", OA: "O", O: "O",
      SA: "S", S: "S", HD: "H", H: "H", F: "F", CL: "CL", BR: "BR", I: "I", P: "P"
    };
    var out = [];
    text.split(/\r?\n/).forEach(function (line) {
      // PDBQT 的 ROOT / ENDROOT / BRANCH 行会让 3Dmol 的 PDB 解析器提前结束
      if (!/^(ATOM|HETATM)/.test(line)) return;
      var t = line.slice(77, 79).trim().toUpperCase();
      if (t === "HD" || t === "H") return;           // 只画重原子，与共晶 SDF 一致
      var base = line.slice(0, 54);
      var el = map[t] || t.charAt(0);
      out.push(base + "  1.00  0.00          " + el.padEnd(2, " "));
    });
    return out.join("\n") + "\nEND\n";
  }

  function paintLigand(model, carbon) {
    model.setStyle({}, {
      stick: { color: carbon, radius: 0.24 },
      sphere: { color: carbon, scale: 0.18 }
    });
    Object.keys(ELEMENT_COLORS).forEach(function (elem) {
      model.setStyle({ elem: elem }, {
        stick: { color: ELEMENT_COLORS[elem], radius: 0.24 },
        sphere: { color: ELEMENT_COLORS[elem], scale: 0.18 }
      });
    });
  }

  function setMode(next) {
    if (!ready) return;
    mode = next;
    if (next === "reference") {
      if (proteinModel) {
        proteinModel.setStyle({ chain: "A" }, {
          cartoon: { color: "#a8bbcb", opacity: 1, arrows: true, ribbon: false }
        });
      }
      paintLigand(refModel, "#c47a55");
      if (poseModel) poseModel.setStyle({}, {});
      viewer.zoomTo({ model: 1 }, 0);
      viewer.zoom(0.35, 0);
      setBadge("6VGL · RXT 共晶姿势");
    } else {
      // 对接姿势在口袋里，蛋白降成半透明才看得见配体
      if (proteinModel) {
        proteinModel.setStyle({ chain: "A" }, {
          cartoon: { color: "#c9d4dd", opacity: 0.42, arrows: true, ribbon: false }
        });
      }
      refModel.setStyle({}, {});
      paintLigand(poseModel, "#7c8778");
      viewer.zoomTo({ model: 2 }, 0);
      viewer.zoom(0.45, 0);
      setBadge("6VGL · 对接姿势 #1");
    }
    document.querySelectorAll("[data-jak2-view]").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-jak2-view") === next);
    });
    viewer.render();
  }

  function setBadge(text) {
    var el = $("#jak2-badge");
    if (el) el.textContent = text;
  }

  function init() {
    var host = $("#jak2-viewer");
    if (!host || typeof $3Dmol === "undefined") return;

    Promise.all([
      fetch("data/jak2/receptor.pdb", { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("receptor " + r.status); return r.text(); }),
      fetch("data/jak2/rxt_reference.sdf", { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("reference " + r.status); return r.text(); }),
      fetch("data/jak2/poses.pdbqt", { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("poses " + r.status); return r.text(); })
    ]).then(function (texts) {
      viewer = $3Dmol.createViewer(host, {
        backgroundColor: "#fffefa",
        antialias: true,
        cartoonQuality: 10,
        upscale: true
      });

      var protein = viewer.addModel(texts[0], "pdb");
      proteinModel = protein;

      protein.setStyle({}, {});
      protein.setStyle({ chain: "A" }, {
        cartoon: { color: "#a8bbcb", opacity: 1, arrows: true, ribbon: false }
      });

      refModel = viewer.addModel(texts[1], "sdf");
      poseModel = viewer.addModel(pdbqtToPdb(splitModels(texts[2])[0]), "pdb");
      poseModel.setStyle({}, {});

      try {
        viewer.setViewStyle({ style: "ambientOcclusion", strength: 0.8 });
      } catch (e) { /* 旧版 3Dmol 忽略 */ }

      ready = true;
      setMode("reference");
      setBadge("6VGL · RXT 共晶姿势");
      host.dataset.ready = "1";
      document.body.dataset.jak2Ready = "1";
      window.__JAK2 = {
        viewer: viewer,
        setMode: setMode,
        isReady: function () { return ready; },
        pixelInfo: function () {
          var c = host.querySelector("canvas");
          return c ? { css: [host.clientWidth, host.clientHeight], px: [c.width, c.height], ratio: c.width / Math.max(1, host.clientWidth) } : null;
        }
      };
    }).catch(function (err) {
      console.error("[jak2-view]", err);
      setBadge("JAK2 结构加载失败：" + err.message);
      host.dataset.ready = "0";
      document.body.dataset.jak2Ready = "0";
    });
  }

  function wire() {
    document.querySelectorAll("[data-jak2-view]").forEach(function (btn) {
      btn.addEventListener("click", function () { setMode(btn.getAttribute("data-jak2-view")); });
    });
    var spin = $("#jak2-spin");
    if (spin) {
      spin.addEventListener("click", function () {
        if (!viewer) return;
        spinning = !spinning;
        viewer.spin(spinning ? "y" : false);
        spin.setAttribute("aria-pressed", spinning ? "true" : "false");
      });
    }
    var reset = $("#jak2-reset");
    if (reset) {
      reset.addEventListener("click", function () {
        if (!viewer || !ready) return;
        setMode(mode);
      });
    }
  }

  function boot() {
    wire();
    // v4：JAK2 视图在隐藏的子页里，页签不可见时建实例会得到 0×0 的 canvas。
    // 这里改成「进入边界页才初始化」，之后每次切回只做 resize + render。
    var started = false;
    function mount() {
      var host = $("#jak2-viewer");
      if (!host) return;
      if (!started) { started = true; init(); return; }
      if (viewer && ready) {
        setTimeout(function () {
          try { viewer.resize(); viewer.render(); } catch (e) { /* 忽略 */ }
        }, 40);
      }
    }
    document.addEventListener("a4s:view", function (e) {
      if (e && e.detail && e.detail.view === "jak2") mount();
    });
    if (document.body && document.body.getAttribute("data-route") === "jak2") mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
