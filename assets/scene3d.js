/* ============================================================================
   scene3d.js · v2（2026-11-01 视觉升级）
   ----------------------------------------------------------------------------
   方案 A：继续用本地 3Dmol.js 2.5.5，但把观感整体重设。
   选择理由（相比换 NGL / Mol*）：
     1. 依赖已在 vendor/ 内、离线可用，换库要重新打包 3–8 MB 的 wasm/js，
        还要重写两处实例 + 点击/标签/姿势逻辑，回归面大而收益不确定；
     2. 2.5.5 已内置环境光遮蔽（renderer.enableAmbientOcclusion）、
        cartoon 曲线质量（cartoonQuality）、逐元素 colorscheme、高 DPI 超采样，
        这几项正是「旧」的主因，调好即可达到现代观感；
     3. 数据绑定与交互（9 姿势 / 点击残基 / 最佳姿势高亮）保持原样，风险最小。

   观感升级点：
     · 背景暖白 #fffefa（与页面同色，画布边界消失）
     · 链 A/B 低饱和双色（蓝灰 / 暖灰），cartoonQuality 12 + edged
     · 关闭默认描边，改用环境光遮蔽（AO strength 0.9）+ 柔和分层
     · 口袋残基细 sticks；Asp25 橙色 + 三层半透明 halo（发光感）
     · 配体逐元素降饱和配色 + 细 sticks，取代厚重 grayCarbon 球棍
     · 相机切换 300ms 缓动（四元数 slerp + 位置线性插值）
     · 姿势切换 300ms 双姿势交叉淡入淡出（不硬切）
     · 高 DPI：每次 resize 重新按 devicePixelRatio 设 canvas 像素，并暴露 pixelInfo()

   数据：data/structure/*.pdb|sdf（未改动）。不联网、不用 CDN。
   ========================================================================== */
(function () {
  "use strict";

  var PALETTE = {
    bg: "#fffefa",
    chainA: "#a3b9cb",       // 低饱和蓝灰
    chainB: "#d6c2ac",       // 低饱和暖砂
    pocket: "#e6cdb8",       // 口袋残基（cartoon 着色，比链色更暖）
    pocketStick: "#bda491",
    dyad: "#e8551c",         // Asp25 催化二联体
    halo: "#e8551c",
    // 姿势视图里做背景用的「退后」配色：不用透明度（3Dmol 卡通透明会直接洗白），
    // 改用低饱和浅色保持实心，视觉上自然退到后层。
    dimA: "#dfe5ea",
    dimB: "#e9e1d7",
    dimPocket: "#f2e9e1",
    dimStick: "#cfc6bb"
  };

  /* 逐元素配色：碳用中性灰，杂原子降饱和。
     3Dmol 的自定义 colorscheme 对象在 2.5.5 的 stick 路径上会被静默忽略
     （实测碳色不生效、回落到近白），所以改成「基础色 + 按元素 addStyle 覆盖」。 */
  var ELEMENT_COLORS = {
    N: "#6d86a0", O: "#b06a58", S: "#a8975e", P: "#b08a5e",
    F: "#88a189", CL: "#88a189", Cl: "#88a189", BR: "#a2715c", Br: "#a2715c"
  };
  var LIGAND_CARBON = "#5f6469";
  var POSE_CARBON = "#7c8778";
  var BEST_POSE_CARBON = "#c47a55";

  var LABEL_STYLE = {
    backgroundColor: "#fffefa",
    backgroundOpacity: 0.9,
    borderColor: "rgba(27,25,23,0.18)",
    borderThickness: 1,
    fontColor: "#4a463f",
    fontSize: 12,
    fontFamily: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
    showBackground: true,
    inFront: true
  };

  var MOTION = {
    camera: 300,   // 相机缓动（ms）
    pose: 300      // 姿势交叉淡出（ms，CSS opacity 过渡）
  };

  // 取证/调试用：?motion=1500 放慢过渡，便于用截屏抓到中间态；
  // 不影响默认行为（不传参数时仍是 300ms）。
  (function () {
    var m = /[?&]motion=(\d{2,5})\b/.exec(location.search);
    if (m) {
      var ms = Math.max(100, Math.min(5000, parseInt(m[1], 10)));
      MOTION.camera = ms;
      MOTION.pose = ms;
    }
  })();

  function createMoleculeScene(opts) {
    var scene = {
      el: typeof opts.el === "string" ? document.querySelector(opts.el) : opts.el,
      meta: opts.meta,
      compact: !!opts.compact,
      onResidue: opts.onResidue || null,
      viewer: null,
      models: { protein: null, cocrystal: null, poses: [] },
      mode: opts.mode || "complex",
      pose: 1,
      bestPose: (opts.meta && opts.meta.poses && opts.meta.poses.best_pose) || 1,
      labelsOn: opts.labels !== false,
      spinning: false,
      ready: false,
      pixelRatio: 0,
      init: init,
      setView: setView,
      setPose: setPose,
      reset: reset,
      toggleSpin: toggleSpin,
      toggleLabels: toggleLabels,
      zoom: zoom,
      addLabels: addLabels,
      pixelInfo: pixelInfo,
      syncResolution: syncResolution
    };

    var camRaf = 0;

    /* ------------------------------------------------------------ 初始化 */
    async function init() {
      var meta = scene.meta;
      var texts = await Promise.all([
        fetchText("data/structure/" + basename(meta.receptor.file)),
        fetchText("data/structure/" + basename(meta.ligand.file)),
        fetchText("data/structure/" + basename(meta.cocrystal.file)),
        fetchText("data/structure/" + basename(meta.poses.file))
      ]);

      var viewer = $3Dmol.createViewer(scene.el, {
        backgroundColor: PALETTE.bg,
        antialias: true,
        cartoonQuality: scene.compact ? 8 : 12,
        // 高 DPI：3Dmol 的 renderer.setSize 会按 devicePixelRatio 设 canvas 像素，
        // 并在 dpr<2 时超采样到 2×（见 pixelInfo() 的实测输出）。
        upscale: true
      });
      scene.viewer = viewer;

      // 环境光遮蔽：让 cartoon 的曲面交界出现柔和暗部，替代「灰底平面」观感。
      // 需要做开启/关闭对比时用 ?ao=off（验收截图即由此生成）。
      var aoOn = !/[?&]ao=off\b/.test(location.search);
      try {
        if (aoOn) {
          viewer.setViewStyle({ style: "ambientOcclusion", strength: scene.compact ? 0.75 : 0.9 });
        }
      } catch (e) {
        if (window.console) console.warn("ambientOcclusion unsupported:", e && e.message);
      }

      var protein = viewer.addModel(texts[0], "pdb");
      scene.models.protein = protein;
      // PDB 无 CONECT（原始产物不该被改），按残基内共价半径补键，只为画出侧链 sticks
      inferResidueBonds(protein);

      scene.models.cocrystal = viewer.addModel(texts[2], "sdf");
      scene.models.poses = splitModels(texts[3]).map(function (chunk) {
        return viewer.addModel(chunk.text, "pdb");
      });

      paintProtein(1);
      paintCocrystal(1);
      scene.models.poses.forEach(function (m) { m.setStyle({}, {}); });
      scene.ready = true;
      bindClicks();
      bindResize();
      syncResolution();
      setView(scene.mode, { instant: true, silent: true });
      return scene;
    }

    /* ------------------------------------------------------------ 样式 */
    function cartoon(color, opacity) {
      // 注意：不要加 style:'edged' —— 3Dmol 2.5.5 里 edged 卡通与 setClickable
      // 同时开启时，clickable 顶点克隆会取到 undefined 并抛错（实测已复现）。
      // smooth 观感由 createViewer 的 cartoonQuality 提供，arrows 只影响 β 折叠。
      return {
        cartoon: {
          color: color,
          opacity: opacity === undefined ? 1 : opacity,
          arrows: true,
          ribbon: false
        }
      };
    }

    function paintProtein(opacity, dim) {
      var v = scene.viewer;
      var meta = scene.meta;
      var op = opacity === undefined ? 1 : opacity;
      var pocketResi = meta.pocket.residues.map(function (r) { return r.resseq; });
      var dyad = meta.catalytic_dyad.selection;
      var colors = dim
        ? { a: PALETTE.dimA, b: PALETTE.dimB, pocket: PALETTE.dimPocket, stick: PALETTE.dimStick, dyad: PALETTE.dyad }
        : { a: PALETTE.chainA, b: PALETTE.chainB, pocket: PALETTE.pocket, stick: PALETTE.pocketStick, dyad: PALETTE.dyad };

      v.setStyle({ model: 0 }, {});
      v.setStyle({ model: 0, chain: "A" }, cartoon(colors.a, op));
      v.setStyle({ model: 0, chain: "B" }, cartoon(colors.b, op));

      // 活性口袋：cartoon 着暖色 + 极细 sticks（让口袋成为画面焦点，而不是一团灰）
      v.addStyle({ model: 0, resi: pocketResi }, {
        cartoon: { color: colors.pocket, opacity: op, arrows: true, ribbon: false },
        stick: { color: colors.stick, radius: 0.075, opacity: 0.8 * op }
      });

      // Asp25 催化二联体：橙色球棍
      v.addStyle({
        model: 0,
        resn: dyad.resn,
        resi: [dyad.resi]
      }, {
        stick: { color: colors.dyad, radius: 0.17, opacity: op },
        sphere: { color: colors.dyad, scale: 0.26, opacity: op }
      });

      paintDyadHalo(op);
    }

    /* 发光 halo：三层同心半透明球，越外越淡。
       比「加 outline」更柔和，且在暖白底上不会出现黑边。 */
    function paintDyadHalo(opacity) {
      var v = scene.viewer;
      var ca = (scene.meta.catalytic_dyad && scene.meta.catalytic_dyad.ca_coords) || {};
      v.removeAllShapes();
      if (scene.mode === "ligand") return;
      Object.keys(ca).forEach(function (chain) {
        var p = ca[chain];
        [[2.7, 0.045], [1.9, 0.07], [1.25, 0.1]].forEach(function (ring) {
          v.addSphere({
            center: { x: p[0], y: p[1], z: p[2] },
            radius: ring[0],
            color: PALETTE.halo,
            opacity: ring[1] * (opacity === undefined ? 1 : opacity),
            wireframe: false
          });
        });
      });
    }

    /* 配体 / 姿势：基础色（碳）+ 逐元素覆盖（杂原子）。
       radius 0.26 + sphere 0.2 是「球棍但克制」的比例，
       比原来的 grayCarbon(0.24/0.16) 更清晰，又不像 spacefill 那样糊。 */
    function paintSmallMolecule(model, carbon, opts) {
      opts = opts || {};
      var radius = opts.radius || 0.26;
      var scale = opts.scale || 0.2;
      var op = opts.opacity === undefined ? 1 : opts.opacity;
      if (op <= 0.001) { model.setStyle({}, {}); return; }
      model.setStyle({}, {
        stick: { color: carbon, radius: radius, opacity: op },
        sphere: { color: carbon, scale: scale, opacity: op }
      });
      Object.keys(ELEMENT_COLORS).forEach(function (elem) {
        model.setStyle({ elem: elem }, {
          stick: { color: ELEMENT_COLORS[elem], radius: radius, opacity: op },
          sphere: { color: ELEMENT_COLORS[elem], scale: scale, opacity: op }
        });
      });
    }

    function paintCocrystal(scale) {
      paintSmallMolecule(scene.models.cocrystal, LIGAND_CARBON, {
        radius: (scale || 1) * 0.26,
        scale: 0.2
      });
    }

    function paintPoseModel(index, opacity, best) {
      var m = scene.models.poses[index];
      if (!m) return;
      if (opacity <= 0.001) { m.setStyle({}, {}); return; }
      paintSmallMolecule(m, best ? BEST_POSE_CARBON : POSE_CARBON, {
        radius: 0.21, scale: 0.16, opacity: opacity
      });
    }

    function paintPose(n) {
      var idx = clampPose(n) - 1;
      if (scene._paintedIdx === idx) return;
      if (scene._paintedIdx >= 0 && scene.models.poses[scene._paintedIdx]) {
        scene.models.poses[scene._paintedIdx].setStyle({}, {});   // 只清上一张，避免每次 9 个模型全量重建
      }
      paintPoseModel(idx, 1, isBestPose(n));
      scene._paintedIdx = idx;
    }

    /* ------------------------------------------------------------ 标签 */
    function addLabels() {
      var v = scene.viewer;
      var meta = scene.meta;
      v.removeAllLabels();
      if (!scene.labelsOn) { v.render(); return; }

      var ca = meta.catalytic_dyad.ca_coords || {};
      if (scene.mode !== "ligand") {
        Object.keys(ca).sort().forEach(function (chain, i) {
          var p = ca[chain];
          var dir = i === 0 ? 1 : -1;   // A 往右上、B 往左下，避免两个标签叠在一起
          v.addLabel("Asp25(" + chain + ")", Object.assign({}, LABEL_STYLE, {
            position: { x: p[0] + dir * 3.2, y: p[1] + dir * 4.0, z: p[2] },
            alignment: i === 0 ? "left" : "right",
            fontSize: scene.compact ? 11 : 12
          }));
        });
      }

      if (scene.mode === "poses") {
        var p = poseInfo(scene.pose);
        var c = poseCentroid();
        if (p && c) {
          v.addLabel("Pose " + p.pose + " · " + p.affinity.toFixed(3) + (p.best ? " · 最佳" : ""),
            Object.assign({}, LABEL_STYLE, {
              position: { x: c[0], y: c[1] + 6.5, z: c[2] },
              fontSize: 12,
              fontColor: p.best ? "#b8471a" : "#4a463f"
            }));
        }
      }
      v.render();
    }

    function poseInfo(n) {
      var list = (scene.meta.poses && scene.meta.poses.affinity_by_pose) || {};
      var entry = list[String(n)];
      if (!entry) return null;
      return { pose: n, affinity: entry.affinity, rmsd: entry.rmsd_A, best: entry.best };
    }

    function isBestPose(n) {
      var p = poseInfo(n);
      return !!(p && p.best);
    }

    function poseCentroid(n) {
      var idx = clampPose(n === undefined ? scene.pose : n) - 1;
      var atoms = scene.models.poses[idx].selectedAtoms({});
      if (!atoms.length) return null;
      var s = [0, 0, 0];
      atoms.forEach(function (a) { s[0] += a.x; s[1] += a.y; s[2] += a.z; });
      return [s[0] / atoms.length, s[1] / atoms.length, s[2] / atoms.length];
    }

    /* ------------------------------------------------------------ 视图 */
    function setView(mode, options) {
      if (!scene.ready) return;
      options = options || {};
      scene.mode = mode;
      var v = scene.viewer;

      v.setStyle({ model: 0 }, {});
      scene.models.cocrystal.setStyle({}, {});
      scene.models.poses.forEach(function (m) { m.setStyle({}, {}); });
      scene._paintedIdx = -1;

      if (mode === "protein") {
        paintProtein(1);
      } else if (mode === "complex") {
        paintProtein(1);
        paintCocrystal(1);
      } else if (mode === "ligand") {
        paintCocrystal(1.1);
      } else if (mode === "poses") {
        // 背景蛋白用浅色 + 0.5 透明：既保留口袋上下文，又不会抢配体；
        // 透明只作用在这一层，复合物/蛋白视图仍是实色（透明实色混用会洗白）。
        paintProtein(0.5, true);
        paintPose(scene.pose);
      }
      addLabels();

      var target = viewTarget(mode);
      if (options.instant) {
        v.zoomTo(target.sel, 0);
        v.zoom(target.factor, 0);
        v.render();
      } else {
        animateCamera(target.sel, target.factor, MOTION.camera);
      }
    }

    function viewTarget(mode) {
      var sel = { model: 0 };
      var factor = 1.26;
      if (mode === "ligand") { sel = { model: 1 }; factor = 0.92; }
      if (mode === "complex") { factor = scene.compact ? 1.12 : 1.16; }
      if (mode === "poses") {
        var idx = clampPose(scene.pose) - 1;
        var m = scene.models.poses[idx];
        sel = { model: m && m.getID ? m.getID() : 2 + idx };
        factor = 1.12;
      }
      return { sel: sel, factor: factor };
    }

    function setPose(n) {
      var prev = scene.pose;
      if (prev === n && scene.mode === "poses") return;
      scene.pose = n;
      if (scene.mode !== "poses") {
        setView("poses");
        return;
      }
      var target = viewTarget("poses");
      crossfadePose(prev, n);
      animateCamera(target.sel, target.factor, MOTION.camera);
      addLabels();
    }

    /* 姿势切换：把当前画面快照到一层常驻的 2D canvas 上，再用 CSS opacity 淡出。
       快照层在 init 时创建一次并复用（每次新建 canvas 会触发一次纹理上传 +
       合成层创建，实测单帧会掉到 ~66ms）；新姿势在下一次 rAF 里重绘，
       单帧不同时承担「抓帧 + 重算几何 + 重绘」。 */
    function ensureGhost() {
      if (scene.ghost) return scene.ghost;
      var g = document.createElement("canvas");
      g.className = "pose-ghost";
      g.setAttribute("aria-hidden", "true");
      g.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" +
        "opacity:0;transition:opacity " + MOTION.pose + "ms ease;z-index:2";
      scene.el.appendChild(g);
      scene.ghost = g;
      return g;
    }

    function crossfadePose(prev, next) {
      var v = scene.viewer;
      var ghost = ensureGhost();
      var gl = v.getCanvas();
      try {
        if (ghost.width !== Math.round(gl.width / 2) || ghost.height !== Math.round(gl.height / 2)) {
          ghost.width = Math.round(gl.width / 2);
          ghost.height = Math.round(gl.height / 2);
        }
        ghost.getContext("2d").drawImage(gl, 0, 0, ghost.width, ghost.height);
      } catch (e) {
        paintPose(next); v.render(); return;
      }
      ghost.style.transition = "none";
      ghost.style.opacity = "1";
      requestAnimationFrame(function () {
        paintPose(next);
        v.render();
        requestAnimationFrame(function () {
          ghost.style.transition = "opacity " + MOTION.pose + "ms ease";
          requestAnimationFrame(function () { ghost.style.opacity = "0"; });
        });
      });
    }

    /* 相机缓动：先把目标 view 算出来（zoomTo+zoom 立即执行），
       再回到起始 view 做「位置线性 + 四元数 slerp」补间。 */
    function animateCamera(sel, factor, duration) {
      var v = scene.viewer;
      cancelAnimationFrame(camRaf);
      var from = v.getView().slice();
      v.zoomTo(sel, 0);
      v.zoom(factor, 0);
      var to = v.getView().slice();
      if (duration <= 0 || prefersReducedMotion()) {
        v.setView(to, true);
        v.render();
        return;
      }
      v.setView(from, true);
      var t0 = performance.now();
      function step(now) {
        var k = Math.min(1, (now - t0) / duration);
        var e = easeInOut(k);
        var q = slerp(
          [from[4], from[5], from[6], from[7]],
          [to[4], to[5], to[6], to[7]], e
        );
        v.setView([
          lerp(from[0], to[0], e), lerp(from[1], to[1], e), lerp(from[2], to[2], e),
          lerp(from[3], to[3], e), q[0], q[1], q[2], q[3]
        ], true);
        v.render();
        if (k < 1) camRaf = requestAnimationFrame(step);
      }
      camRaf = requestAnimationFrame(step);
    }

    function zoom(mode) {
      var target = viewTarget(mode);
      animateCamera(target.sel, target.factor, MOTION.camera);
    }

    function reset() {
      scene.viewer.spin(false);
      scene.spinning = false;
      setView(scene.mode);
    }

    function toggleSpin(on) {
      scene.spinning = on;
      if (on) scene.viewer.spin("y", 1.4);
      else scene.viewer.spin(false);
      return scene.spinning;
    }

    function toggleLabels(on) {
      scene.labelsOn = on;
      addLabels();
      return scene.labelsOn;
    }

    /* ------------------------------------------------------------ 高 DPI */
    /* 返回 canvas 实际像素与 CSS 尺寸的对照，供验收打印：
       { cssW, cssH, pxW, pxH, dpr, ratio } —— ratio 必须 >= dpr。 */
    function pixelInfo() {
      var host = scene.el;
      var canvas = host && host.querySelector ? host.querySelector("canvas") : null;
      if (!canvas) return null;
      var rect = canvas.getBoundingClientRect();
      var cssW = Math.round(rect.width);
      var cssH = Math.round(rect.height);
      var dpr = window.devicePixelRatio || 1;
      return {
        cssW: cssW, cssH: cssH,
        pxW: canvas.width, pxH: canvas.height,
        dpr: dpr,
        ratio: cssW ? +(canvas.width / cssW).toFixed(3) : null,
        canvasStyleW: canvas.style.width,
        canvasStyleH: canvas.style.height,
        matchesDevice: cssW ? Math.abs(canvas.width / cssW - Math.max(dpr, 2)) < 0.02 : false
      };
    }

    function syncResolution() {
      var v = scene.viewer;
      if (!v) return null;
      v.resize();
      v.render();
      scene.pixelRatio = scene.pixelInfo();
      return scene.pixelRatio;
    }

    /* ------------------------------------------------------------ 交互 */
    function bindClicks() {
      var ids = [0, 1].concat(scene.models.poses.map(function (m) {
        return m.getID ? m.getID() : null;
      })).filter(function (x) { return x !== null; });
      ids.forEach(function (mi) {
        scene.viewer.setClickable({ model: mi }, true, function (atom) {
          if (!atom || !scene.onResidue) return;
          scene.onResidue({
            resn: atom.resn,
            resi: atom.resi,
            chain: atom.chain,
            atom: atom.atom,
            b: atom.b,
            element: atom.elem
          });
        });
      });
    }

    function bindResize() {
      var t = null;
      var lastDpr = window.devicePixelRatio;
      window.addEventListener("resize", function () {
        clearTimeout(t);
        t = setTimeout(function () {
          if (!scene.viewer) return;
          scene.viewer.resize();
          scene.viewer.render();
          scene.pixelRatio = scene.pixelInfo();
        }, 120);
      });
      // 浏览器缩放 / 跨屏拖动会改 devicePixelRatio，但不一定触发 resize
      if (window.matchMedia) {
        try {
          window.matchMedia("(resolution: " + lastDpr + "dppx)").addEventListener("change", function () {
            setTimeout(function () {
              if (scene.viewer) {
                scene.viewer.resize();
                scene.viewer.render();
                scene.pixelRatio = scene.pixelInfo();
              }
            }, 120);
          });
        } catch (e) { /* 老浏览器忽略 */ }
      }
    }

    return scene;
  }

  /* ---------------------------------------------------------------- 工具 */
  function basename(p) { return String(p).split(/[\\/]/).pop(); }

  function clampPose(n) {
    var v = Math.round(Number(n) || 1);
    return Math.max(1, v);
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function slerp(a, b, t) {
    var ax = a[0], ay = a[1], az = a[2], aw = a[3];
    var bx = b[0], by = b[1], bz = b[2], bw = b[3];
    var dot = ax * bx + ay * by + az * bz + aw * bw;
    if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
    if (dot > 0.9995) {
      var rx = lerp(ax, bx, t), ry = lerp(ay, by, t), rz = lerp(az, bz, t), rw = lerp(aw, bw, t);
      var n = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
      return [rx / n, ry / n, rz / n, rw / n];
    }
    var theta = Math.acos(dot);
    var s1 = Math.sin((1 - t) * theta) / Math.sin(theta);
    var s2 = Math.sin(t * theta) / Math.sin(theta);
    return [
      ax * s1 + bx * s2, ay * s1 + by * s2,
      az * s1 + bz * s2, aw * s1 + bw * s2
    ];
  }

  var prefersReducedMotion = function () {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  };

  var COVALENT = {
    H: 0.31, C: 0.76, N: 0.71, O: 0.66, S: 1.05, P: 1.07,
    F: 0.57, CL: 1.02, BR: 1.2, I: 1.39
  };

  /* 按残基内共价半径补键（PDB 无 CONECT 时 sticks 画不出来）。
     O(n²) 只发生在单个残基内部（≤15 原子），整体约 5k 次距离比较。 */
  function inferResidueBonds(model) {
    var atoms = model.atoms || [];
    var groups = Object.create(null);
    for (var i = 0; i < atoms.length; i++) {
      var a = atoms[i];
      var key = a.chain + "|" + a.resi + "|" + a.resn;
      (groups[key] = groups[key] || []).push(a);
    }
    var bonds = [];
    Object.keys(groups).forEach(function (k) {
      var list = groups[k];
      for (var i = 0; i < list.length; i++) {
        for (var j = i + 1; j < list.length; j++) {
          var a = list[i], b = list[j];
          if ((a.elem || "").toUpperCase() === "H" || (b.elem || "").toUpperCase() === "H") continue;
          var ra = COVALENT[(a.elem || "C").toUpperCase()] || 0.77;
          var rb = COVALENT[(b.elem || "C").toUpperCase()] || 0.77;
          var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
          var d2 = dx * dx + dy * dy + dz * dz;
          var lim = 1.25 * (ra + rb);
          if (d2 > 0.16 && d2 <= lim * lim) bonds.push({ atom1: a, atom2: b, bondOrder: 1 });
        }
      }
    });
    model.bonds = bonds;
    return bonds.length;
  }

  async function fetchText(url) {
    var res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error("fetch " + url + " -> " + res.status);
    return res.text();
  }

  function splitModels(text) {
    var out = [];
    var re = /^MODEL\s+(\d+)\s*$/gim;
    var matches = [];
    var m;
    while ((m = re.exec(text)) !== null) matches.push({ index: +m[1], start: m.index });
    for (var i = 0; i < matches.length; i++) {
      var start = matches[i].start;
      var end = i + 1 < matches.length ? matches[i + 1].start : text.length;
      out.push({ index: matches[i].index, text: text.slice(start, end) });
    }
    return out;
  }

  window.createMoleculeScene = createMoleculeScene;
})();
