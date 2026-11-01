/* ============================================================================
   app.js · v4（卡片首页 + 6 个子页 + hash 路由）
   ----------------------------------------------------------------------------
   结构：
     · 一条 hash 路由（#/ #/target #/method #/results #/evidence #/progress #/limits）
       只用 location.hash，不依赖服务端路由，file:// 下同样能来回切。
     · 首页 6 张卡片 → 6 个子页；3D 与监控各自在子页里初始化（进入时才建实例，
       避免隐藏容器里建出 0×0 的 canvas）。
     · 主界面只出现人话；运行标识、文件名、哈希、英文状态一律收在折叠的
       「技术证据」区，或只在下载的结果文件里。
   数据来源（只读，不改）：
     data/structure_meta.json · data/poses_meta.json
     /api/runs · /api/status · /api/log（server.py 读 run_state.json / events.jsonl）
   ========================================================================== */
(function () {
  "use strict";

  var POLL_MS = 1200;
  var DEFAULT_CASE = "hiv1_1t3r_darunavir";
  var VIEWS = ["home", "hiv1", "jak2", "egfr", "target", "method", "results", "evidence", "progress", "limits"];
  var TITLES = {
    home: "A4S 科研工作台 · 蛋白抑制剂设计案例",
    hiv1: "HIV-1 蛋白酶 × 达芦那韦 · 六章",
    jak2: "JAK2 × RXT · 六章",
    egfr: "EGFR · 六章（未执行）",
    target: "靶点与分子 · A4S 科研工作台",
    method: "方法 · A4S 科研工作台",
    results: "结果 · A4S 科研工作台",
    evidence: "证据与可复现 · A4S 科研工作台",
    progress: "实时进度 · A4S 科研工作台",
    limits: "边界与下一步 · A4S 科研工作台"
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var state = {
    meta: null,
    poses: null,
    heroScene: null,
    heroInit: false,
    scene: null,
    sceneInit: false,
    runs: [],
    runId: null,
    status: null,
    pollTimer: null,
    triggering: false,
    view: "home",
    pendingCase: null
  };

  /* ------------------------------------------------------------- 小工具 */
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function fmtDate(d) {
    if (!d || isNaN(d.getTime())) return "—";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
           " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function fmtClock(d) {
    if (!d || isNaN(d.getTime())) return "—";
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function fmtDur(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return "—";
    if (sec < 60) return sec.toFixed(1) + "s";
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    return m + "m" + (s < 10 ? "0" : "") + s + "s";
  }

  function elapsedOf(status) {
    if (!status) return null;
    var start = status.started_at ? new Date(status.started_at).getTime() : null;
    if (!start) return null;
    var end = status.finished_at ? new Date(status.finished_at).getTime() : Date.now();
    return Math.max(0, (end - start) / 1000);
  }

  function fmtAge(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return "—";
    if (sec < 90) return sec.toFixed(1) + " 秒前";
    if (sec < 5400) return Math.round(sec / 60) + " 分钟前";
    if (sec < 172800) return (sec / 3600).toFixed(1) + " 小时前";
    return Math.round(sec / 86400) + " 天前";
  }

  /* 阶段说明里偶尔带判定码（advance=1 / pass=1），翻成中文再上主视图 */
  function humanMessage(msg) {
    return String(msg || "—")
      .replace(/advance=1/g, "判定通过")
      .replace(/pass=(\d+)/g, "通过 $1 项")
      .replace(/NOT_RUN/g, "未执行");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* 状态一律翻成中文；英文只留在 data-state 属性里（不进文本）。 */
  var STATE_CN = {
    completed: "已完成",
    done: "已完成",
    running: "进行中",
    pending: "等待",
    failed: "失败",
    skipped: "跳过",
    blocked: "需复核",
    idle: "待机"
  };
  var STATE_TOKEN = {
    completed: "completed",
    done: "completed",
    running: "running",
    pending: "pending",
    failed: "failed",
    skipped: "skipped",
    blocked: "warn",
    idle: "idle"
  };

  function tokenOf(s) { return STATE_TOKEN[s] || "pending"; }
  function cnOf(s) { return STATE_CN[s] || "等待"; }

  var CASE_CN = {
    hiv1_1t3r_darunavir: "HIV-1 蛋白酶",
    jak2_6vgl_rxt: "JAK2 对照"
  };

  function runLabel(r) {
    var d = r.started_at ? new Date(r.started_at) : null;
    return fmtDate(d) + " · " + (CASE_CN[r.case_id] || "其他案例") + " · " + cnOf(r.status);
  }

  function labelForRunId(id) {
    var r = state.runs.filter(function (x) { return x.run_id === id; })[0];
    return r ? runLabel(r) : "这次运行";
  }

  /* ------------------------------------------------------------- 路由 */
  function requestedView() {
    var m = /^#\/([a-z0-9]+)/.exec(location.hash || "");
    var v = m && m[1];
    return VIEWS.indexOf(v) >= 0 ? v : "home";
  }

  function navigate(view, opts) {
    opts = opts || {};
    if (opts.caseSel) state.pendingCase = opts.caseSel;
    if (currentView() === view) {
      render(view);
      return;
    }
    location.hash = "#/" + view;
  }

  function currentView() { return state.view; }

  function render(view) {
    if (VIEWS.indexOf(view) < 0) view = "home";
    state.view = view;

    VIEWS.forEach(function (v) {
      var el = document.getElementById("view-" + v);
      if (el) el.hidden = (v !== view);
    });

    $$("[data-nav]").forEach(function (a) {
      a.classList.toggle("is-active", a.getAttribute("data-nav") === view);
    });

    document.body.dataset.route = view;
    document.title = TITLES[view] || TITLES.home;
    $$(".is-highlight").forEach(function (el) { el.classList.remove("is-highlight"); });

    // 路由切换一律回到页首（instant，绕开 html 的 smooth）
    try { window.scrollTo({ top: 0, behavior: "instant" }); }
    catch (e) { window.scrollTo(0, 0); }

    mountForView(view);
    setTimeout(refreshCuts, 60);

    if (state.pendingCase) {
      var target = document.getElementById(state.pendingCase);
      var host = target && target.closest ? target.closest(".view") : null;
      if (target && host && host.getAttribute("data-view") === view) {
        var head = target.querySelector(".case-head");
        $$(".is-highlight").forEach(function (el) { el.classList.remove("is-highlight"); });
        if (head) head.classList.add("is-highlight");
        var sel = state.pendingCase;
        setTimeout(function () {
          var el = document.getElementById(sel);
          if (el) el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
        }, 80);
        state.pendingCase = null;
      }
    }
  }

  function mountForView(view) {
    if (view === "home") ensureHeroScene();
    if (view === "target") ensureMainScene();
    // JAK2 的 3D 由 jak2-view.js 自己挂在事件上，进入「边界」页才建实例
    document.dispatchEvent(new CustomEvent("a4s:view", { detail: { view: view } }));
  }

  function wireRouter() {
    window.addEventListener("hashchange", function () {
      render(requestedView());
    });
    var rt = null;
    window.addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(refreshCuts, 160);
    });
    var skip = $("#skip-link");
    if (skip) {
      skip.addEventListener("click", function () {
        var main = $("#main");
        if (main) {
          main.setAttribute("tabindex", "-1");
          main.focus({ preventScroll: false });
        }
      });
    }
  }

  /* ------------------------------------------------------------- 数据加载 */
  function fetchJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(url + " -> " + r.status);
      return r.json();
    });
  }

  async function loadContent() {
    try {
      var meta = await fetchJSON("data/structure_meta.json");
      var poses = await fetchJSON("data/poses_meta.json");
      state.meta = meta;
      state.poses = poses;
      fillNumbers(meta, poses);
      buildLadder(poses);
      buildRmsdChart(poses);
      buildPoseChips(poses);
      updatePosePanel(1);
      document.body.dataset.structureReady = "1";
    } catch (err) {
      console.error("[content]", err);
      document.body.dataset.structureReady = "0";
      var tag = $("#card-target .card-visual-tag");
      if (tag) tag.textContent = "离线打开 · 3D 不加载";
      // 静态数字已经在 HTML 里，离线打开时保留它们
    }
  }

  function fillNumbers(meta, poses) {
    var best = poses.poses.filter(function (p) { return p.best; })[0] || poses.poses[0];
    setText($('[data-fact="rmsd-head"]'), best.rmsd_A.toFixed(3) + " Å");
    setText($("#viewer-caption .caption-key"),
      "1T3R · A/B 链 · " + meta.receptor.atoms.toLocaleString("en-US") + " 个原子");
    setText($('[data-pocket="count"]'), meta.pocket.count + " 个（≤ " + meta.pocket.cutoff_angstrom + " Å）");
    var dyad = meta.catalytic_dyad.carboxyl_oxygen_min_distance_A;
    setText($('[data-pocket="dyad"]'), (dyad === null ? "—" : dyad + " Å"));
    setText($("#viewer-caption-text"), "口袋 " + meta.pocket.count + " 个残基 · 九个姿势");
  }

  /* ------------------------------------------------------------- 九姿势图 */
  var SCALE_RMSD = 3.4;

  function buildRmsdChart(poses) {
    var host = $("#rmsd-chart");
    if (!host) return;
    host.innerHTML = "";
    poses.poses.forEach(function (p) {
      var pass = p.rmsd_A <= poses.rmsd_threshold_A;
      var row = document.createElement("div");
      row.className = "rmsd-row" + (pass ? " is-pass" : "");
      row.dataset.pose = p.pose;
      row.innerHTML =
        '<span class="rmsd-idx">#' + p.pose + "</span>" +
        '<span class="rmsd-track"><span class="rmsd-bar"></span></span>' +
        '<span class="rmsd-val">' + p.rmsd_A.toFixed(2) + " Å</span>";
      host.appendChild(row);
      var ratio = Math.min(1, p.rmsd_A / SCALE_RMSD);
      var bar = row.querySelector(".rmsd-bar");
      requestAnimationFrame(function () {
        setTimeout(function () { bar.style.transform = "scaleX(" + ratio.toFixed(4) + ")"; }, 60 + p.pose * 40);
      });
    });
    var cut = document.createElement("span");
    cut.className = "rmsd-cut";
    host.appendChild(cut);
    placeCut(host, cut, ".rmsd-track", poses.rmsd_threshold_A / SCALE_RMSD);
  }

  /* 判据线：跨整张图的一条竖线（画在容器上，不放进 track 的 overflow 里） */
  function placeCut(host, cut, trackSel, ratio) {
    cut.dataset.ratio = String(ratio);
    cut.dataset.track = trackSel;
    requestAnimationFrame(function () { positionCut(cut); });
  }

  function positionCut(cut) {
    var host = cut.parentElement;
    if (!host) return;
    var track = host.querySelector(cut.dataset.track || ".rmsd-track");
    if (!track) return;
    var hb = host.getBoundingClientRect();
    var tb = track.getBoundingClientRect();
    if (!tb.width) return;   // 视图隐藏时先不画，等切到这页再补
    cut.style.left = (tb.left - hb.left + tb.width * parseFloat(cut.dataset.ratio)).toFixed(1) + "px";
    cut.style.top = "0px";
    cut.style.height = hb.height.toFixed(1) + "px";
  }

  /* 视图切换 / 窗口尺寸变化后，把三张图的判据线重新对齐 */
  function refreshCuts() {
    $$(".rmsd-cut, .ladder-cut").forEach(function (cut) {
      if (cut.dataset.ratio) positionCut(cut);
    });
  }

  function buildLadder(poses) {
    var host = $("#affinity-ladder");
    if (!host) return;
    host.innerHTML = "";
    var maxAbs = Math.max.apply(null, poses.poses.map(function (p) { return Math.abs(p.affinity); }));
    var scaleMax = Math.ceil(maxAbs) + 0.5;
    poses.poses.forEach(function (p, i) {
      var row = document.createElement("div");
      row.className = "ladder-row" + (p.best ? " is-best" : "");
      row.dataset.pose = p.pose;
      row.innerHTML =
        '<span class="ladder-idx">#' + p.pose + "</span>" +
        '<span class="ladder-track"><span class="ladder-bar"></span></span>' +
        '<span class="ladder-val">' + p.affinity.toFixed(3) + "</span>";
      host.appendChild(row);
      var ratio = Math.abs(p.affinity) / scaleMax;
      var bar = row.querySelector(".ladder-bar");
      requestAnimationFrame(function () {
        setTimeout(function () { bar.style.transform = "scaleX(" + ratio.toFixed(4) + ")"; }, 90 + i * 55);
      });
    });
    var cut = document.createElement("span");
    cut.className = "ladder-cut";
    host.appendChild(cut);
    placeCut(host, cut, ".ladder-track", 7.0 / scaleMax);
    var best = poses.poses.filter(function (p) { return p.best; })[0] || poses.poses[0];
    setText($("#affinity-ladder-note"),
      "最佳 #" + best.pose + "，打分 " + best.affinity.toFixed(3) + " kcal/mol；竖线是 −7.0 的门槛。");
  }

  /* JAK2 的九姿势条：数字直接从页面里已有的读数表读，不另存一份数据 */
  function buildJak2Ladder() {
    var host = $("#jak2-ladder");
    if (!host || host.children.length) return;
    var rows = $$("#view-limits table.data-table tbody tr");
    if (!rows.length) return;
    var items = rows.map(function (tr) {
      var cells = tr.querySelectorAll("td");
      var txt = (cells[1] ? cells[1].textContent : "0").replace(/[\u2212\u2013\u2014]/g, "-");
      return { pose: parseInt(cells[0].textContent.replace("#", ""), 10), affinity: parseFloat(txt) };
    }).filter(function (x) { return !isNaN(x.affinity); });
    if (!items.length) return;
    var maxAbs = Math.max.apply(null, items.map(function (p) { return Math.abs(p.affinity); }));
    var scaleMax = Math.ceil(maxAbs) + 0.5;
    items.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "ladder-row" + (p.pose === 1 ? " is-best" : "");
      row.dataset.pose = p.pose;
      row.innerHTML =
        '<span class="ladder-idx">#' + p.pose + "</span>" +
        '<span class="ladder-track"><span class="ladder-bar"></span></span>' +
        '<span class="ladder-val">' + p.affinity.toFixed(3) + "</span>";
      host.appendChild(row);
      var ratio = Math.abs(p.affinity) / scaleMax;
      var bar = row.querySelector(".ladder-bar");
      requestAnimationFrame(function () {
        setTimeout(function () { bar.style.transform = "scaleX(" + ratio.toFixed(4) + ")"; }, 80 + p.pose * 40);
      });
    });
    var cut = document.createElement("span");
    cut.className = "ladder-cut";
    host.appendChild(cut);
    placeCut(host, cut, ".ladder-track", 7.0 / scaleMax);
  }

  /* ------------------------------------------------------------- 3D：延迟挂载 */
  function ensureHeroScene() {
    if (!state.meta || !state.poses) return;
    if (state.heroScene) { state.heroScene.syncResolution(); return; }
    var host = $("#hero-viewer");
    if (!host || typeof window.createMoleculeScene !== "function") return;
    if (state.heroInit) return;
    state.heroInit = true;
    state.heroScene = window.createMoleculeScene({
      el: "#hero-viewer",
      meta: state.meta,
      compact: true,
      labels: false,
      mode: "complex",
      onResidue: null
    });
    state.heroScene.init().then(function () {
      state.heroScene.syncResolution();
      // 卡片里的预览比主视图矮，稍微推近一点，别让分子缩成一小团
      try { state.heroScene.viewer.zoom(1.12); state.heroScene.viewer.render(); } catch (e) { /* 忽略 */ }
      window.__A4S_SCENES = window.__A4S_SCENES || {};
      window.__A4S_SCENES.hero = state.heroScene;
    }).catch(function (err) {
      console.error("[hero3d]", err);
      state.heroInit = false;
      var tag = $("#card-target .card-visual-tag");
      if (tag) tag.textContent = "3D 预览没能加载";
    });
  }

  function ensureMainScene() {
    if (!state.meta || !state.poses) return;
    if (state.scene) { state.scene.syncResolution(); return; }
    if (state.sceneInit) return;
    var host = $("#viewer");
    if (!host || typeof window.createMoleculeScene !== "function") return;
    state.sceneInit = true;
    state.scene = window.createMoleculeScene({
      el: "#viewer",
      meta: state.meta,
      mode: "complex",
      onResidue: onResidueClick
    });
    state.scene.init().then(function () {
      state.scene.syncResolution();
      window.__A4S_SCENES = window.__A4S_SCENES || {};
      window.__A4S_SCENES.main = state.scene;
      setViewerBadge("复合物 · 1T3R + 达芦那韦");
      document.body.dataset.sceneMain = "1";
    }).catch(function (err) {
      console.error("[scene3d]", err);
      state.sceneInit = false;
      setViewerBadge("结构没能加载，刷新一次再试");
      document.body.dataset.sceneMain = "0";
    });
  }

  var VIEW_DESC = {
    protein: "只看 1T3R 的 A/B 二聚体骨架：A 链蓝灰，B 链暖砂。暖色那一圈是距共晶配体 5 Å 以内的活性口袋残基，橙色球棍是 Asp25 催化二联体。",
    complex: "蛋白骨架加达芦那韦的共晶姿势。杂原子按 CPK 惯例降饱和着色，氮偏灰蓝，氧偏砖红，硫偏灰黄，能直接看出抑制剂压在口袋的哪一侧。",
    ligand: "单独看达芦那韦，球棍模型，带极性氢。用来核对官能团和立体中心，看它为什么能贴住 Asp25 这对天冬氨酸。",
    poses: "九个对接姿势逐个显示，背景口袋退成浅色。分数最低的那个用橙色碳标出来，下面一排条子给出每个姿势的打分和与共晶的偏差。"
  };

  function buildPoseChips(poses) {
    var host = $("#pose-chips");
    if (!host) return;
    host.innerHTML = "";
    poses.poses.forEach(function (p) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pose-chip" + (p.best ? " is-best" : "") + (p.pose === 1 ? " is-active" : "");
      btn.dataset.pose = p.pose;
      btn.setAttribute("aria-label", "姿势 " + p.pose + "，打分 " + p.affinity + " kcal/mol");
      btn.innerHTML = "<span>#" + p.pose + "</span><small>" + p.affinity.toFixed(2) + "</small>";
      btn.addEventListener("click", function () { selectPose(p.pose, true); });
      host.appendChild(btn);
    });
  }

  function selectPose(n, fromChip) {
    if (!state.scene || !state.scene.ready) return;
    $$("#pose-chips .pose-chip").forEach(function (b) {
      b.classList.toggle("is-active", +b.dataset.pose === n);
    });
    state.scene.setPose(n);
    updatePosePanel(n);
    if (fromChip) {
      $$(".seg-btn").forEach(function (b) { b.classList.toggle("is-active", b.dataset.view === "poses"); });
      var strip = $("#pose-strip");
      if (strip) strip.hidden = false;
      setText($("#aside-view-desc"), VIEW_DESC.poses);
      setViewerBadge("对接姿势 " + n + " / " + state.poses.count);
    }
  }

  function updatePosePanel(n) {
    if (!state.poses) return;
    var p = state.poses.poses.filter(function (x) { return x.pose === n; })[0];
    if (!p) return;
    setText($('[data-pose="index"]'), "#" + p.pose + (p.best ? "（最佳）" : ""));
    setText($('[data-pose="affinity"]'), p.affinity.toFixed(3) + " kcal/mol");
    var rmsdEl = $('[data-pose="rmsd"]');
    rmsdEl.textContent = p.rmsd_A.toFixed(3) + " Å";
    rmsdEl.className = p.rmsd_A <= state.poses.rmsd_threshold_A ? "good" : "warn";
    var verdict = $('[data-pose="verdict"]');
    verdict.textContent = p.rmsd_A <= state.poses.rmsd_threshold_A
      ? "≤ " + state.poses.rmsd_threshold_A.toFixed(1) + " Å 通过"
      : "> " + state.poses.rmsd_threshold_A.toFixed(1) + " Å 未通过";
    verdict.className = p.rmsd_A <= state.poses.rmsd_threshold_A ? "good" : "warn";
    setText($("#pose-foot"), p.best
      ? "这是打分最低的姿势。偏差是与共晶对照算的姿势回收证据，不代表亲和力，也不代表活性。"
      : "偏差是与共晶对照算的姿势回收证据，不代表亲和力，也不代表活性。");
  }

  function setViewerBadge(text) { setText($("#viewer-badge"), text); }

  function onResidueClick(info) {
    if (!info) return;
    var el = $("#residue-info");
    if (!el) return;
    var catalytic = info.resn === "ASP" && +info.resi === 25;
    el.classList.remove("muted");
    el.innerHTML =
      '<span class="res-tag">' + info.resn + " " + info.resi + (info.chain ? " · 链 " + info.chain : "") + "</span><br>" +
      "原子 <b>" + (info.atom || "—") + "</b> · 元素 " + (info.element || "—") +
      (info.b !== undefined && info.b !== null ? " · B-factor " + Number(info.b).toFixed(2) : "") +
      (catalytic ? '<br><span style="color:var(--orange)">HIV-1 蛋白酶催化二联体成员</span>' : "");
  }

  /* ------------------------------------------------------------- 3D 控件 */
  function wireViewerControls() {
    $$(".seg-btn[data-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!state.scene || !state.scene.ready) return;
        var mode = btn.dataset.view;
        $$(".seg-btn[data-view]").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
        state.scene.setView(mode);
        var strip = $("#pose-strip");
        if (strip) strip.hidden = mode !== "poses";
        setText($("#aside-view-desc"), VIEW_DESC[mode] || "");
        var badge = {
          protein: "蛋白 · 1T3R A/B",
          complex: "复合物 · 1T3R + 达芦那韦",
          ligand: "配体 · 达芦那韦",
          poses: "对接姿势 " + state.scene.pose + " / " + (state.poses ? state.poses.count : 9)
        };
        setViewerBadge(badge[mode]);
      });
    });

    function sceneGuard() { return state.scene && state.scene.ready; }

    var spin = $("#btn-spin");
    if (spin) spin.addEventListener("click", function () {
      if (!sceneGuard()) return;
      var on = state.scene.toggleSpin(!state.scene.spinning);
      this.setAttribute("aria-pressed", on ? "true" : "false");
    });

    var labels = $("#btn-labels");
    if (labels) labels.addEventListener("click", function () {
      if (!sceneGuard()) return;
      var on = state.scene.toggleLabels(!state.scene.labelsOn);
      this.setAttribute("aria-pressed", on ? "true" : "false");
    });

    var reset = $("#btn-reset");
    if (reset) reset.addEventListener("click", function () {
      if (!sceneGuard()) return;
      state.scene.reset();
      toast("视角已重置");
    });

    document.addEventListener("keydown", function (e) {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      if (e.key === "r" || e.key === "R") { if (sceneGuard()) state.scene.reset(); }
      if (e.key === "l" || e.key === "L") { if (labels) labels.click(); }
    });
  }

  /* ------------------------------------------------------------- 监控 */
  function startMonitor() {
    wireRunPicker();
    loadRuns().then(function () {
      poll();
      state.pollTimer = setInterval(poll, POLL_MS);
    });
  }

  async function loadRuns(preferredId) {
    try {
      var data = await fetchJSON("/api/runs");
      state.runs = data.runs || [];
      renderRunSelect(preferredId);
      updateHeaderStatus(data);
      if (data.trigger && data.trigger.state === "running") state.triggering = true;
      return data;
    } catch (err) {
      var snap = await fetchSnapshot();
      if (snap) {
        state.staticMode = true;
        state.snapshot = snap;
        state.runs = snap.runs || [];
        state.runId = (snap.status && snap.status.run_id) || (snap.runs[0] && snap.runs[0].run_id);
        document.body.dataset.snapshot = "1";
        var sel = $("#run-select"); if (sel) sel.style.display = "none";
        var trig = $("#btn-trigger"); if (trig) trig.style.display = "none";
        setHeader("idle", "公开快照 · 已完成运行的静态记录");
        var pTitle = $("#progress-title");
        if (pTitle) pTitle.textContent = "一次已完成的七步运行，逐步看";
        var pDesc = $("#progress-desc");
        if (pDesc) pDesc.textContent = "这里展示的是一次真实完成的运行记录，数据从结果文件导出后随页面一起发布；本地版会按 1.2 秒轮询实时状态。";
        var cardState = $("#card-progress-state");
        if (cardState) cardState.textContent = "快照";
        setText($("#card-progress-time"), "静态记录 · 数字来自那次已完成的运行");
        return snap;
      }
      document.body.dataset.offline = "1";
      setHeader("idle", "离线打开，读不到运行记录");
      var cardState2 = $("#card-progress-state");
      if (cardState2) cardState2.textContent = "离线";
      setText($("#card-progress-time"), "本地服务未运行 · 静态数字仍可读");
      return null;
    }
  }

  async function fetchSnapshot() {
    if (state.snapshot) return state.snapshot;
    try {
      var d = await fetchJSON("data/snapshot.json");
      if (d && d.ok) return d;
    } catch (e) { /* 没有快照就退回离线提示 */ }
    return null;
  }

  function setHeader(stateName, text) {
    var light = $("#header-status .light");
    if (light) light.dataset.state = stateName || "idle";
    setText($("#header-status .header-status-text"), text);
  }

  function updateHeaderStatus(data) {
    if (!data || !data.runs) return;
    var running = data.runs.filter(function (r) { return r.status === "running"; })[0];
    if (running) {
      setHeader("running", "正在跑 · 第 " + (running.stages_settled + 1) + " 步");
    } else if (state.status) {
      var d = state.status.finished_at || state.status.started_at;
      setHeader(state.status.status, "最近一次" + cnOf(state.status.status) + " · " + fmtClock(new Date(d)));
    } else {
      setHeader("idle", data.count + " 次运行可回放");
    }
  }

  function renderRunSelect(preferredId) {
    var sel = $("#run-select");
    if (!sel || !state.runs.length) return;
    var keep = preferredId || state.runId || sel.value;
    sel.innerHTML = "";
    state.runs.forEach(function (r) {
      var opt = document.createElement("option");
      opt.value = r.run_id;                 // 标识只留在 value，不进可见文本
      opt.textContent = runLabel(r);
      sel.appendChild(opt);
    });
    var pick = keep && state.runs.some(function (r) { return r.run_id === keep; }) ? keep : null;
    if (!pick) {
      var pref = state.runs.filter(function (r) { return r.case_id === DEFAULT_CASE; })[0];
      pick = (pref || state.runs[0]).run_id;
    }
    sel.value = pick;
    state.runId = pick;
  }

  function wireRunPicker() {
    var sel = $("#run-select");
    if (!sel) return;
    sel.addEventListener("change", function () {
      state.runId = sel.value;
      resetStatusPanel();
      poll();
    });
  }

  async function poll() {
    if (!state.runId) return;
    if (state.staticMode) {
      var snap = state.snapshot;
      if (!snap || !snap.status) return;
      state.status = snap.status;
      renderStatus(snap.status);
      var srun = (snap.status.stages || []).filter(function (s) { return s.status === "running"; })[0];
      renderLogSnapshot(srun ? srun.id : "export");
      return;
    }
    var t0 = performance.now();
    try {
      var results = await Promise.all([
        fetchJSON("/api/status?run=" + encodeURIComponent(state.runId)),
        fetchJSON("/api/runs?brief=1")
      ]);
      var status = results[0], runs = results[1];
      if (!status.ok) throw new Error(status.error || "status failed");
      state.status = status;
      var tRender = performance.now();
      renderStatus(status);
      if (window.__perf) window.__perf.domMs.push(+(performance.now() - tRender).toFixed(3));
      var running = status.stages.filter(function (s) { return s.status === "running"; })[0];
      await Promise.all([
        renderLog(running ? running.id : "export"),
        applyRuns(runs)
      ]);
      setText($("#meta-poll"), (POLL_MS / 1000).toFixed(1) + "s");
    } catch (err) {
      console.error(err);
      document.body.dataset.offline = "1";
      setHeader("idle", "离线打开，读不到运行记录");
    } finally {
      if (window.__perf) window.__perf.pollMs.push(+(performance.now() - t0).toFixed(2));
    }
  }

  var lastRunCount = -1;
  async function applyRuns(data) {
    if (!data || !data.ok) return;
    if (data.runs.length !== lastRunCount) {
      lastRunCount = data.runs.length;
      state.runs = data.runs;
      renderRunSelect(state.runId);
      updateHeaderStatus(data);
    }
    if (data.trigger) {
      if (data.trigger.state === "running") {
        state.triggering = true;
        var btn = $("#btn-trigger");
        if (btn) { btn.disabled = true; btn.textContent = "运行中…"; }
        if (data.trigger.run_id && data.trigger.run_id !== state.runId) {
          state.runId = data.trigger.run_id;
          renderRunSelect(data.trigger.run_id);
          resetStatusPanel();
          toast("已切到新的这次运行");
        }
      } else if (data.trigger.state === "finished" || data.trigger.state === "failed") {
        if (state.triggering) {
          state.triggering = false;
          var btn2 = $("#btn-trigger");
          if (btn2) { btn2.disabled = false; btn2.textContent = "运行一次"; }
          if (data.trigger.run_id && data.trigger.run_id !== state.runId) {
            state.runId = data.trigger.run_id;
            renderRunSelect(data.trigger.run_id);
            stageRowsBuilt = false;
          }
          toast("这次运行已经结束，结果已刷新");
        }
      }
    }
  }

  function renderStatus(s) {
    var pill = $("#run-status-pill");
    if (pill) pill.dataset.state = tokenOf(s.status);
    setText($("#run-status-text"), cnOf(s.status));

    var running = s.stages.filter(function (x) { return x.status === "running"; })[0];
    setText($("#meta-stage"), running
      ? running.index + "/7 " + running.label
      : (s.status === "completed" ? "七步全部完成" : cnOf(s.status)));
    setText($("#meta-elapsed"), fmtDur(elapsedOf(s)));

    var settled = s.stages.filter(function (x) {
      return x.status === "completed" || x.status === "failed" || x.status === "skipped";
    }).length;
    var fill = $("#overall-fill");
    if (fill) {
      fill.style.transform = "scaleX(" + (settled / 7).toFixed(3) + ")";
      fill.classList.toggle("is-running", s.status === "running");
    }
    setText($("#overall-text"), settled + " / 7 步");
    setText($("#overall-note"),
      "更新 " + fmtClock(new Date(s.updated_at)) + " · 状态文件 " +
      fmtAge(s.state_mtime_age_s) + "写过");

    renderStages(s);
    renderCounters(s);
    renderEvents(s);
    setText($("#events-source"), "共 " + s.events.length + " 条，显示最近 14 条");
    updateHeaderStatus({ runs: state.runs, count: state.runs.length });
    updateCardStatus(s, settled);
  }

  function updateCardStatus(s, settled) {
    var pill = $("#card-progress-pill");
    if (pill) pill.dataset.state = tokenOf(s.status);
    setText($("#card-progress-state"), cnOf(s.status));
    setText($("#card-progress-steps"), settled + " / 7");
    var d = s.finished_at || s.started_at;
    setText($("#card-progress-time"), "最近一次 " + fmtDate(new Date(d)) + " · 可回放历史运行");
  }

  var stageRowsBuilt = false;
  function renderStages(s) {
    var host = $("#stage-rows");
    if (!host) return;
    if (!stageRowsBuilt) {
      host.innerHTML = "";
      s.stages.forEach(function (st) {
        var row = document.createElement("div");
        row.className = "stage-row";
        row.dataset.stage = st.id;
        row.innerHTML =
          '<span class="sidx">' + String(st.index).padStart(2, "0") + "</span>" +
          '<span class="sname">' + st.label + "</span>" +
          '<span class="sstate"><span class="light"></span><span class="sstate-text"></span></span>' +
          '<span class="sbar"><i></i></span>' +
          '<span class="sdur"></span>' +
          '<span class="smsg"></span>';
        host.appendChild(row);
      });
      stageRowsBuilt = true;
    }
    s.stages.forEach(function (st) {
      var row = host.querySelector('[data-stage="' + st.id + '"]');
      if (!row) return;
      row.dataset.state = tokenOf(st.status);
      row.querySelector(".light").dataset.state = tokenOf(st.status);
      setText(row.querySelector(".sstate-text"), cnOf(st.status));
      var prog = st.progress || { done: 0, total: 0 };
      var ratio = prog.total ? Math.min(1, prog.done / prog.total) : (st.status === "completed" ? 1 : 0);
      row.querySelector(".sbar i").style.transform = "scaleX(" + ratio.toFixed(3) + ")";
      var dur = st.duration_live_s !== undefined && st.duration_live_s !== null ? st.duration_live_s : st.duration_s;
      setText(row.querySelector(".sdur"), fmtDur(dur) + (prog.total ? " · " + prog.done + "/" + prog.total : ""));
      setText(row.querySelector(".smsg"), humanMessage(st.message) + (st.artifact_exists === false ? "（产物缺失）" : ""));
    });
  }

  function renderCounters(s) {
    var host = $("#counters");
    if (!host) return;
    var keys = Object.keys(s.counters || {});
    var sig = keys.join("|") + "#" + host.children.length;
    if (host.dataset.sig !== sig) {
      host.innerHTML = "";
      keys.forEach(function (k) {
        var row = document.createElement("div");
        row.dataset.k = k;
        row.innerHTML = "<dt>" + k + "</dt><dd></dd>";
        host.appendChild(row);
      });
      host.dataset.sig = sig;
    }
    keys.forEach(function (k) {
      var dd = host.querySelector('[data-k="' + k + '"] dd');
      if (dd) setText(dd, String(s.counters[k]));
    });
  }

  function resetStatusPanel() {
    stageRowsBuilt = false;
    var host = $("#stage-rows");
    if (host) host.innerHTML = "";
    var fill = $("#overall-fill");
    if (fill) fill.style.transform = "scaleX(0)";
    setText($("#overall-text"), "— / 7 步");
    setText($("#meta-stage"), "—");
    setText($("#meta-elapsed"), "—");
    var ev = $("#events");
    if (ev) { ev.innerHTML = ""; delete ev.dataset.sig; }
    var p = $("#run-status-pill");
    if (p) p.dataset.state = "running";
    setText($("#run-status-text"), "读取中");
  }

  function renderEvents(s) {
    var host = $("#events");
    if (!host) return;
    var items = (s.events || []).slice(-14).reverse();
    var html = items.map(function (ev) {
      return '<li data-level="' + (ev.level || "info") + '">' +
        "<time>" + fmtClock(new Date(ev.ts)) + "</time>" +
        '<span class="ev-msg">' +
        (ev.stage ? '<span class="ev-stage">' + ev.stage + "</span>" : "") +
        escapeHtml(ev.message || "") +
        "</span></li>";
    }).join("");
    if (host.dataset.sig !== String(items.length) + html.length) {
      host.innerHTML = html;
      host.dataset.sig = String(items.length) + html.length;
    }
  }

  /* 公网/静态模式：直接从 data/snapshot.json 里读日志，不发请求 */
  function renderLogSnapshot(stage) {
    var snap = state.snapshot, pre = $("#log");
    if (!snap || !snap.logs || !pre) return;
    var entry = snap.logs[stage] || snap.logs["export"] || null;
    var text = entry && entry.lines ? entry.lines.join("\n") : "（快照未包含该阶段日志）";
    if (pre.textContent !== text) pre.textContent = text;
    setText($("#log-source"), entry && entry.source_name ? entry.source_name + " · 静态快照" : "静态快照");
  }

  async function renderLog(stage) {
    try {
      var data = await fetchJSON("/api/log?run=" + encodeURIComponent(state.runId) +
                                 "&stage=" + encodeURIComponent(stage) + "&lines=120");
      if (!data.ok) return;
      var pre = $("#log");
      if (!pre) return;
      var text = (data.lines || []).join("\n");
      if (pre.textContent !== text) pre.textContent = text || "（这次运行没有日志文件）";
      setText($("#log-source"), data.source_name
        ? data.source_name + (data.filtered_by_stage ? " · 已按阶段过滤" : " · 整轮尾部")
        : "无日志");
    } catch (err) {
      /* 离线打开时静默 */
    }
  }

  /* ------------------------------------------------------------- 触发运行 */
  function wireTrigger() {
    var modal = $("#modal");
    var trigger = $("#btn-trigger");
    if (!modal || !trigger) return;
    trigger.addEventListener("click", function () {
      if (state.triggering) return;
      modal.hidden = false;
    });
    $("#modal-cancel").addEventListener("click", function () { modal.hidden = true; });
    modal.addEventListener("click", function (e) { if (e.target === modal) modal.hidden = true; });
    $("#modal-confirm").addEventListener("click", async function () {
      modal.hidden = true;
      await triggerRun();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) modal.hidden = true;
    });
  }

  async function triggerRun() {
    state.triggering = true;
    var btn = $("#btn-trigger");
    btn.disabled = true;
    btn.textContent = "启动中…";
    try {
      var res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case: DEFAULT_CASE, confirm: true })
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || "trigger failed");
      toast("已在本机启动一次真实运行，状态每 1.2 秒自动刷新");
      btn.textContent = "运行中…";
    } catch (err) {
      state.triggering = false;
      btn.disabled = false;
      btn.textContent = "运行一次";
      toast("触发失败：" + err.message);
    }
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }

  /* ------------------------------------------------------------- 开头提问 */
  function wireAsk() {
    var form = $("#ask-form");
    var input = $("#ask-input");
    var out = $("#ask-result");
    if (!form || !input || !out) return;

    var cases = $$(".case-block").map(function (block) {
      return {
        el: block,
        id: block.getAttribute("data-case") || "",
        route: block.getAttribute("data-case-route") || "target",
        title: block.getAttribute("data-case-title") || "",
        summary: block.getAttribute("data-case-summary") || "",
        keywords: (block.getAttribute("data-case-keywords") || "").split("|").filter(Boolean)
      };
    }).filter(function (c) { return c.keywords.length; });

    function norm(s) {
      return String(s == null ? "" : s).toLowerCase()
        .replace(/[\s\u00a0·•×*_\-—–/\\()（）:：,，.。?？!！]/g, "");
    }

    function findCase(q) {
      var nq = norm(q);
      if (nq.length < 2) return null;
      for (var i = 0; i < cases.length; i++) {
        for (var j = 0; j < cases[i].keywords.length; j++) {
          var k = norm(cases[i].keywords[j]);
          if (!k) continue;
          if (nq.indexOf(k) >= 0) return cases[i];
          if (nq.length >= 3 && k.indexOf(nq) >= 0) return cases[i];
        }
      }
      return null;
    }

    function setResult(cls, html) {
      out.className = "ask-result" + (cls ? " " + cls : "");
      out.innerHTML = html;
      out.hidden = false;
    }

    function showHit(c) {
      setResult("is-hit",
        "<h3>找到：" + escapeHtml(c.title) + "</h3>" +
        "<p>" + escapeHtml(c.summary) + "。正在打开它的子页。</p>");
      navigate(c.route, { caseSel: c.el.id });
      toast("已打开：" + c.title);
    }

    function showMiss(q) {
      setResult("",
        "<h3>暂不支持：" + escapeHtml(q) + "</h3>" +
        "<p>当前只有两个已完成案例：HIV-1 蛋白酶 × 达芦那韦，以及 JAK2 × RXT（红对接对照）。" +
        "新靶点需要重跑管线，至少要先补齐这三样：</p>" +
        '<ul class="ask-gaps">' +
        "<li><b>结构</b>：高分辨率共晶，或可用的 apo / 预测模型</li>" +
        "<li><b>配体</b>：已知活性配体，加可制备的 3D 构象</li>" +
        "<li><b>配方</b>：盒子、判据、门控阈值都要先定</li>" +
        "</ul>" +
        '<div class="ask-more">' +
        '<button type="button" class="chip" data-ask="HIV-1 蛋白酶 · 达芦那韦">看 HIV-1 案例</button>' +
        '<button type="button" class="chip" data-ask="JAK2 · RXT">看 JAK2 案例</button>' +
        "</div>");
    }

    function showEmpty() {
      setResult("is-empty",
        "<h3>先输入一个靶点</h3>" +
        "<p>例如 HIV-1、JAK2 或 EGFR；也可以直接点上面的例子。</p>");
    }

    function run(q) {
      var value = String(q == null ? "" : q).trim();
      if (!value) { showEmpty(); return; }
      var hit = findCase(value);
      if (hit) showHit(hit); else showMiss(value);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      run(input.value);
    });

    $$("[data-ask]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        input.value = chip.getAttribute("data-ask");
        run(input.value);
      });
    });

    out.addEventListener("click", function (e) {
      var chip = e.target.closest ? e.target.closest("[data-ask]") : null;
      if (!chip) return;
      input.value = chip.getAttribute("data-ask");
      run(input.value);
    });
  }

  /* ------------------------------------------------------------- 性能采样 */
  var perf = {
    frames: 0,
    slowFrames: 0,
    longTasks: 0,
    maxFrameMs: 0,
    jsMs: [],
    domMs: [],
    pollMs: [],
    startedAt: performance.now(),
    worstFrameAt: null
  };
  window.__perf = perf;

  function startPerf() {
    var last = performance.now();
    function tick(now) {
      var a = performance.now();
      var dt = now - last;
      last = now;
      perf.frames++;
      if (dt > perf.maxFrameMs) { perf.maxFrameMs = dt; perf.worstFrameAt = new Date().toISOString(); }
      if (perf.frames > 8 && dt > 20) perf.slowFrames++;
      perf.jsMs.push(+(performance.now() - a).toFixed(3));
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    if ("PerformanceObserver" in window) {
      try {
        new PerformanceObserver(function (list) {
          perf.longTasks += list.getEntries().length;
        }).observe({ type: "longtask", buffered: true });
      } catch (e) { /* 忽略 */ }
    }
  }

  function stats(arr) {
    var v = arr.filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    if (!v.length) return { n: 0, mean: 0, p95: 0, max: 0 };
    return {
      n: v.length,
      mean: +(v.reduce(function (a, b) { return a + b; }, 0) / v.length).toFixed(3),
      p95: +v[Math.floor(v.length * 0.95)].toFixed(3),
      max: +v[v.length - 1].toFixed(3)
    };
  }

  window.__perfReset = function () {
    perf.frames = 0;
    perf.slowFrames = 0;
    perf.longTasks = 0;
    perf.maxFrameMs = 0;
    perf.jsMs = [];
    perf.domMs = [];
    perf.pollMs = [];
    perf.startedAt = performance.now();
    perf.worstFrameAt = null;
    return true;
  };

  window.__perfSummary = function () {
    var d = performance.now() - perf.startedAt;
    var js = stats(perf.jsMs), dom = stats(perf.domMs);
    return {
      sampled_s: +(d / 1000).toFixed(2),
      route: state.view,
      frames: perf.frames,
      fps: +(perf.frames / (d / 1000)).toFixed(1),
      slow_frames: perf.slowFrames,
      long_tasks: perf.longTasks,
      max_frame_ms: +perf.maxFrameMs.toFixed(2),
      js_frame: js,
      dom_update: dom,
      poll_calls: perf.pollMs.length,
      poll_max_ms: perf.pollMs.length ? Math.max.apply(null, perf.pollMs) : 0
    };
  };

  /* ------------------------------------------------------------- boot */
  async function boot() {
    wireRouter();
    wireAsk();
    wireViewerControls();
    wireTrigger();
    startPerf();
    render(requestedView());
    await loadContent();
    buildJak2Ladder();
    // 数据到位后，把当前视图的 3D 补挂上（直接深链到子页时也能出图）
    mountForView(state.view);
    startMonitor();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
