"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import GUI from "lil-gui";
import gsap from "gsap";
import {
  POST_VS,
  POST_FS,
  WARP_DEFAULTS,
  stepWarp,
} from "@/shared/postShader";

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashChunk(cx, cy) {
  let h = 2166136261;
  h = Math.imul(h ^ cx, 16777619);
  h = Math.imul(h ^ cy, 16777619);
  h = Math.imul(h ^ (cx * 374761393), 16777619);
  h = Math.imul(h ^ (cy * 668265263), 16777619);
  return h >>> 0;
}

const IMAGE_COUNT = 53;

function preloadAllImages() {
  const loader = new THREE.TextureLoader();
  return Promise.all(
    Array.from({ length: IMAGE_COUNT }, (_, i) => {
      const index = i + 1;
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const tex = loader.load(`/Visual-${index}.png`, (t) => {
            t.minFilter = THREE.LinearFilter;
            t.magFilter = THREE.LinearFilter;
          });
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          resolve({
            index,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            texture: tex,
          });
        };
        img.onerror = () =>
          resolve({
            index,
            naturalWidth: 300,
            naturalHeight: 300,
            texture: null,
          });
        img.src = `/Visual-${index}.png`;
      });
    }),
  );
}

export default function InfiniteCanvas() {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    const params = {
      chunkSize: 1500,
      renderRadius: 2,
      planesPerChunk: 20,
      sizeScale: 0.4,
      padding: 80,
      bgColor: "#ffffff",

      dragZoomOut: 0.7,
      dragZoomEaseIn: "circ.out",
      dragZoomEaseOut: "power2.out",
      dragZoomInDuration: 0.45,
      dragZoomOutDuration: 0.85,

      zoom: 1.3,
      zoomMin: 0.1,
      zoomMax: 1.0,

      panSmoothing: 0.15,
      panSensitivity: 1.0,
      panDeadzone: 2,

      scrollPanSpeed: 1.5,
      scrollSmoothing: 0.17,
      scrollHorizontal: true,

      inertiaDamping: 0.885,
      inertiaMultiplier: 20,
      inertiaMinThreshold: 0.0035,

      barrelEnabled: true,
      barrelStrength: 0.57,
      barrelK2: 0.0,
      cornerRadius: 0.0,
      vignette: 0.0,

      // drag K2 animation targets (exposed to GUI for tuning)
      dragK2Target: 0.5,
      dragK2InDuration: 0.45,
      dragK2OutDuration: 0.85,
      dragK2EaseIn: "circ.out",
      dragK2EaseOut: "power2.out",

      ...WARP_DEFAULTS,
    };

    /* ── renderer ── */
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(params.bgColor);
    container.appendChild(renderer.domElement);
    const cvs = renderer.domElement;

    /* ── camera ── */
    let W = container.clientWidth;
    let H = container.clientHeight;
    let baseZoom = params.zoom;
    let dragZoomMult = 1.0;

    const camera = new THREE.OrthographicCamera(
      -W / 2,
      W / 2,
      H / 2,
      -H / 2,
      0.1,
      10,
    );
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    const scene = new THREE.Scene();

    function getEffectiveZoom() {
      return baseZoom * dragZoomMult;
    }

    function applyZoom() {
      const z = getEffectiveZoom();
      const hw = W / 2 / z;
      const hh = H / 2 / z;
      camera.left = -hw;
      camera.right = hw;
      camera.top = hh;
      camera.bottom = -hh;
      camera.updateProjectionMatrix();
    }

    /* ── post-processing ── */
    const dpr = Math.min(window.devicePixelRatio, 2);
    let renderTarget = new THREE.WebGLRenderTarget(W * dpr, H * dpr, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });

    function hexToVec3(hex) {
      const c = new THREE.Color(hex);
      return new THREE.Vector3(c.r, c.g, c.b);
    }

    const postUniforms = {
      tDiffuse: { value: renderTarget.texture },
      barrelStrength: { value: params.barrelStrength },
      barrelK2: { value: 0.0 }, // always starts at 0
      aspect: { value: W / H },
      cornerRadius: { value: params.cornerRadius },
      vignette: { value: params.vignette },
      bgColor: { value: hexToVec3(params.bgColor) },
      enabled: { value: 1.0 },

      warp: { value: new THREE.Vector2(0, 0) },
      bend: { value: WARP_DEFAULTS.warpBend },
      stretch: { value: WARP_DEFAULTS.warpStretch },
      split: { value: WARP_DEFAULTS.warpSplit },
    };

    const postMat = new THREE.ShaderMaterial({
      uniforms: postUniforms,
      vertexShader: POST_VS,
      fragmentShader: POST_FS,
      depthTest: false,
      depthWrite: false,
    });

    const qGeo = new THREE.PlaneGeometry(2, 2);
    const qMesh = new THREE.Mesh(qGeo, postMat);
    const postScene = new THREE.Scene();
    postScene.add(qMesh);
    const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    function syncPost() {
      postUniforms.barrelStrength.value = params.barrelStrength;
      // barrelK2 is driven by drag animation — don't overwrite it here
      postUniforms.cornerRadius.value = params.cornerRadius;
      postUniforms.vignette.value = params.vignette;
      postUniforms.enabled.value = params.barrelEnabled ? 1.0 : 0.0;
      postUniforms.aspect.value = W / H;
      postUniforms.bend.value = params.warpBend;
      postUniforms.stretch.value = params.warpStretch;
      postUniforms.split.value = params.warpSplit;
    }

    /* ── chunks ── */
    let imageData = [];
    const activeChunks = new Map();
    let lastCx = null,
      lastCy = null;
    const chunkImgCache = new Map();

    function getChunkImgs(cx, cy) {
      const key = `${cx},${cy}`;
      if (chunkImgCache.has(key)) return chunkImgCache.get(key);
      const total = imageData.length,
        count = params.planesPerChunk;
      const li = (((cx * 7919 + cy * 104729) % 999983) + 999983) % 999983;
      const off = (li * count) % total;
      const rng = mulberry32(hashChunk(cx, cy));
      const pool = Array.from({ length: total }, (_, i) => i);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const idx = [];
      for (let i = 0; i < count; i++) idx.push(pool[(off + i) % total]);
      chunkImgCache.set(key, idx);
      return idx;
    }

    function genPlanes(cx, cy) {
      const rng = mulberry32(hashChunk(cx, cy));
      const CS = params.chunkSize,
        S = params.sizeScale;
      const imgs = getChunkImgs(cx, cy);
      const planes = [],
        placed = [];
      for (let i = 0; i < imgs.length; i++) {
        const img = imageData[imgs[i]];
        const w = img.naturalWidth * S,
          h = img.naturalHeight * S;
        let px,
          py,
          tries = 0,
          ok = false;
        while (tries < 150) {
          px = rng() * Math.max(1, CS - w);
          py = rng() * Math.max(1, CS - h);
          let ol = false;
          for (const p of placed) {
            if (
              px - params.padding < p.px + p.w &&
              px + w + params.padding > p.px &&
              py - params.padding < p.py + p.h &&
              py + h + params.padding > p.py
            ) {
              ol = true;
              break;
            }
          }
          if (!ol) {
            ok = true;
            break;
          }
          tries++;
        }
        if (!ok) continue;
        placed.push({ px, py, w, h });
        planes.push({ lx: px, ly: py, w, h, ii: imgs[i] });
      }
      return planes;
    }

    const ck = (cx, cy) => `${cx},${cy}`;

    function mkChunk(cx, cy) {
      const g = new THREE.Group();
      const ps = genPlanes(cx, cy);
      const ox = cx * params.chunkSize,
        oy = cy * params.chunkSize;
      ps.forEach(({ lx, ly, w, h, ii }) => {
        const img = imageData[ii];
        const mat = img.texture
          ? new THREE.MeshBasicMaterial({ map: img.texture })
          : new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
        const geo = new THREE.PlaneGeometry(w, h);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(ox + lx + w / 2, -(oy + ly + h / 2), 0);
        g.add(mesh);
      });
      scene.add(g);
      return g;
    }

    function rmChunk(g) {
      g.children.forEach((m) => {
        m.geometry.dispose();
        m.material.dispose();
      });
      scene.remove(g);
    }

    function updChunks() {
      if (!imageData.length) return;
      const cx = camera.position.x,
        cy = -camera.position.y;
      const ccx = Math.floor(cx / params.chunkSize),
        ccy = Math.floor(cy / params.chunkSize);
      const R = params.renderRadius;
      const need = new Set();
      for (let dx = -R; dx <= R; dx++)
        for (let dy = -R; dy <= R; dy++) need.add(ck(ccx + dx, ccy + dy));
      for (const [k, g] of activeChunks) {
        if (!need.has(k)) {
          rmChunk(g);
          activeChunks.delete(k);
        }
      }
      for (const k of need) {
        if (!activeChunks.has(k)) {
          const [a, b] = k.split(",").map(Number);
          activeChunks.set(k, mkChunk(a, b));
        }
      }
    }

    function rebuildAll() {
      for (const [, g] of activeChunks) rmChunk(g);
      activeChunks.clear();
      chunkImgCache.clear();
      lastCx = null;
      lastCy = null;
      updChunks();
    }

    /* ── GSAP drag-zoom ── */
    let dzT = null;
    const dzS = { m: 1.0 };
    function animDZ(t, d, e) {
      if (dzT) dzT.kill();
      dzT = gsap.to(dzS, {
        m: t,
        duration: d,
        ease: e,
        onUpdate: () => {
          dragZoomMult = dzS.m;
          applyZoom();
        },
      });
    }

    /* ── GSAP drag barrel-K2 ── */
    let bkT = null;
    const bkS = { v: 0.0 };
    // Signed scroll travel, in viewport fractions, driving the warp.
    const warpS = { x: 0, y: 0 };
    function animK2(target, duration, ease) {
      if (bkT) bkT.kill();
      bkT = gsap.to(bkS, {
        v: target,
        duration,
        ease,
      });
    }

    /* ── GUI ── */
    const gui = new GUI({ title: "Canvas Params" });
    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "10px";
    gui.domElement.style.right = "10px";
    gui.domElement.style.zIndex = "1000";
    container.appendChild(gui.domElement);

    const EA = [
      "none",
      "power1.in",
      "power1.out",
      "power1.inOut",
      "power2.in",
      "power2.out",
      "power2.inOut",
      "power3.in",
      "power3.out",
      "power3.inOut",
      "power4.in",
      "power4.out",
      "power4.inOut",
      "back.in",
      "back.out",
      "back.inOut",
      "circ.in",
      "circ.out",
      "circ.inOut",
      "expo.in",
      "expo.out",
      "expo.inOut",
      "sine.in",
      "sine.out",
      "sine.inOut",
    ];

    const fL = gui.addFolder("Layout");
    fL.add(params, "chunkSize", 800, 6000, 100)
      .name("Chunk Size")
      .onFinishChange(rebuildAll);
    fL.add(params, "planesPerChunk", 1, 30, 1)
      .name("Images / Chunk")
      .onFinishChange(rebuildAll);
    fL.add(params, "sizeScale", 0.1, 1.5, 0.01)
      .name("Size Scale")
      .onFinishChange(rebuildAll);
    fL.add(params, "padding", 0, 300, 5)
      .name("Padding")
      .onFinishChange(rebuildAll);
    fL.add(params, "renderRadius", 1, 5, 1)
      .name("Render Radius")
      .onFinishChange(rebuildAll);

    const fZ = gui.addFolder("Zoom");
    fZ.add(params, "zoom", params.zoomMin, params.zoomMax, 0.01)
      .name("Zoom Level")
      .onChange((v) => {
        baseZoom = v;
        applyZoom();
      });
    fZ.add(params, "zoomMin", 0.05, 1, 0.01).name("Zoom Min");
    fZ.add(params, "zoomMax", 1, 10, 0.5).name("Zoom Max");

    const fDZ = gui.addFolder("Drag Zoom-Out");
    fDZ.add(params, "dragZoomOut", 0.3, 1.0, 0.01).name("Zoom Out Level");
    fDZ
      .add(params, "dragZoomInDuration", 0.05, 2.0, 0.05)
      .name("Zoom-Out Duration");
    fDZ
      .add(params, "dragZoomOutDuration", 0.05, 2.0, 0.05)
      .name("Zoom-Back Duration");
    fDZ.add(params, "dragZoomEaseIn", EA).name("Zoom-Out Easing");
    fDZ.add(params, "dragZoomEaseOut", EA).name("Zoom-Back Easing");

    const fP = gui.addFolder("Pan Movement");
    fP.add(params, "panSmoothing", 0.01, 1.0, 0.01).name("Smoothing");
    fP.add(params, "panSensitivity", 0.1, 3.0, 0.05).name("Sensitivity");
    fP.add(params, "panDeadzone", 0, 20, 1).name("Deadzone (px)");

    const fSc = gui.addFolder("Scroll Pan");
    fSc.add(params, "scrollPanSpeed", 0.1, 5.0, 0.1).name("Speed");
    fSc.add(params, "scrollSmoothing", 0.01, 1.0, 0.01).name("Smoothing");
    fSc.add(params, "scrollHorizontal").name("Horizontal (trackpad)");

    const fI = gui.addFolder("Inertia (after release)");
    fI.add(params, "inertiaDamping", 0.7, 0.99, 0.005).name("Damping");
    fI.add(params, "inertiaMultiplier", 1, 40, 1).name("Velocity Scale");
    fI.add(params, "inertiaMinThreshold", 0.0001, 0.01, 0.0001).name(
      "Min Threshold",
    );

    const fSt = gui.addFolder("Style");
    fSt
      .addColor(params, "bgColor")
      .name("Background")
      .onChange((v) => {
        renderer.setClearColor(v);
        postUniforms.bgColor.value = hexToVec3(v);
      });

    const fB = gui.addFolder("Barrel Distortion");
    fB.add(params, "barrelEnabled").name("Enabled").onChange(syncPost);
    fB.add(params, "barrelStrength", 0.0, 2.0, 0.01)
      .name("Strength (r²)")
      .onChange(syncPost);
    fB.add(params, "cornerRadius", 0.0, 0.15, 0.005)
      .name("Corner Radius")
      .onChange(syncPost);
    fB.add(params, "vignette", 0.0, 0.5, 0.01)
      .name("Vignette")
      .onChange(syncPost);

    const fK2 = gui.addFolder("Drag K2 Animation");
    fK2.add(params, "dragK2Target", 0.0, 3.0, 0.05).name("K2 Target");
    fK2
      .add(params, "dragK2InDuration", 0.05, 2.0, 0.05)
      .name("Drag-In Duration");
    fK2
      .add(params, "dragK2OutDuration", 0.05, 2.0, 0.05)
      .name("Drag-Out Duration");
    fK2.add(params, "dragK2EaseIn", EA).name("Drag-In Easing");
    fK2.add(params, "dragK2EaseOut", EA).name("Drag-Out Easing");

    const fW = gui.addFolder("Scroll Warp");
    fW.add(params, "scrollWarpEnabled").name("Enabled");
    fW.add(params, "warpBend", 0.0, 2.0, 0.01).name("Bend").onChange(syncPost);
    fW.add(params, "warpStretch", 0.0, 1.5, 0.01)
      .name("Stretch")
      .onChange(syncPost);
    fW.add(params, "warpK2", 0.0, 3.0, 0.05).name("Globe Bulge (r\u2074)");
    fW.add(params, "warpSplit", 0.0, 0.05, 0.001)
      .name("Chromatic Split")
      .onChange(syncPost);
    fW.add(params, "warpGain", 0.0, 40.0, 0.5).name("Velocity Gain");
    fW.add(params, "warpMax", 0.1, 2.0, 0.05).name("Max Warp");
    fW.add(params, "warpAttack", 0.02, 1.0, 0.01).name("Attack");
    fW.add(params, "warpRelease", 0.005, 0.5, 0.005).name("Release");

    /* ── raycaster ── */
    const ray = new THREE.Raycaster();
    const mN = new THREE.Vector2();
    let hov = false;
    function updH(cx, cy) {
      if (isD) return;
      mN.x = (cx / W) * 2 - 1;
      mN.y = -(cy / H) * 2 + 1;
      ray.setFromCamera(mN, camera);
      const ms = [];
      for (const [, g] of activeChunks) for (const c of g.children) ms.push(c);
      const h = ray.intersectObjects(ms, false).length > 0;
      if (h !== hov) {
        hov = h;
        cvs.style.cursor = h ? "pointer" : "grab";
      }
    }

    /* ── drag ── */
    let isD = false,
      dAct = false;
    let dS = { x: 0, y: 0 },
      cS = { x: 0, y: 0 };
    let vel = { x: 0, y: 0 },
      lP = { x: 0, y: 0 };
    let lT = 0,
      tX = 0,
      tY = 0;

    const onDown = (e) => {
      if (e.target !== cvs) return;
      isD = true;
      dAct = false;
      cvs.style.cursor = "grabbing";
      dS.x = e.clientX;
      dS.y = e.clientY;
      cS.x = camera.position.x;
      cS.y = camera.position.y;
      tX = camera.position.x;
      tY = camera.position.y;
      lP.x = e.clientX;
      lP.y = e.clientY;
      lT = performance.now();
      vel.x = 0;
      vel.y = 0;
      cvs.setPointerCapture(e.pointerId);
      animDZ(
        params.dragZoomOut,
        params.dragZoomInDuration,
        params.dragZoomEaseIn,
      );
      // ── animate K2 in on drag start ──
      animK2(params.dragK2Target, params.dragK2InDuration, params.dragK2EaseIn);
    };

    const onMove = (e) => {
      if (!isD) {
        updH(e.clientX, e.clientY);
        return;
      }
      if (!dAct) {
        const dx = e.clientX - dS.x,
          dy = e.clientY - dS.y;
        if (Math.sqrt(dx * dx + dy * dy) < params.panDeadzone) return;
        dAct = true;
      }
      const now = performance.now(),
        dt = now - lT,
        z = getEffectiveZoom(),
        s = params.panSensitivity;
      tX = cS.x - ((e.clientX - dS.x) / z) * s;
      tY = cS.y + ((e.clientY - dS.y) / z) * s;
      if (dt > 0) {
        vel.x = (e.clientX - lP.x) / dt;
        vel.y = (e.clientY - lP.y) / dt;
      }
      lP.x = e.clientX;
      lP.y = e.clientY;
      lT = now;
    };

    const onUp = () => {
      if (!isD) return;
      isD = false;
      dAct = false;
      cvs.style.cursor = hov ? "pointer" : "grab";
      animDZ(1.0, params.dragZoomOutDuration, params.dragZoomEaseOut);
      // ── animate K2 back to 0 on drag end ──
      animK2(0.0, params.dragK2OutDuration, params.dragK2EaseOut);
    };

    cvs.addEventListener("pointerdown", onDown);
    cvs.addEventListener("pointermove", onMove);
    cvs.addEventListener("pointerup", onUp);
    cvs.addEventListener("pointercancel", onUp);

    /* ── pinch ── */
    let lpd = 0;
    const onTS = (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX,
          dy = e.touches[0].clientY - e.touches[1].clientY;
        lpd = Math.sqrt(dx * dx + dy * dy);
      }
    };
    const onTM = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX,
          dy = e.touches[0].clientY - e.touches[1].clientY,
          d = Math.sqrt(dx * dx + dy * dy);
        baseZoom *= 1 + (d - lpd) * 0.005;
        baseZoom = Math.max(params.zoomMin, Math.min(params.zoomMax, baseZoom));
        params.zoom = baseZoom;
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
        applyZoom();
        lpd = d;
      }
    };
    cvs.addEventListener("touchstart", onTS, { passive: false });
    cvs.addEventListener("touchmove", onTM, { passive: false });

    /* ── scroll ── */
    let sTX = 0,
      sTY = 0,
      sCX = 0,
      sCY = 0;
    const onWh = (e) => {
      e.preventDefault();
      const z = getEffectiveZoom(),
        sp = params.scrollPanSpeed / z;
      sTY -= e.deltaY * sp;
      if (params.scrollHorizontal) sTX -= e.deltaX * sp;
    };
    cvs.addEventListener("wheel", onWh, { passive: false });

    /* ── resize ── */
    const onRs = () => {
      W = container.clientWidth;
      H = container.clientHeight;
      renderer.setSize(W, H);
      renderTarget.setSize(W * dpr, H * dpr);
      postUniforms.aspect.value = W / H;
      applyZoom();
    };
    window.addEventListener("resize", onRs);

    /* ── render loop ── */
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const z = getEffectiveZoom();

      const ss = params.scrollSmoothing;
      const sdx = (sTX - sCX) * ss,
        sdy = (sTY - sCY) * ss;
      if (Math.abs(sdx) > 0.01 || Math.abs(sdy) > 0.01) {
        sCX += sdx;
        sCY += sdy;
        camera.position.x += sdx;
        camera.position.y += sdy;
        tX += sdx;
        tY += sdy;
        cS.x += sdx;
        cS.y += sdy;
      }

      // sdx/sdy are the smoothed world-space steps actually applied to the
      // camera this frame; scaled by zoom and viewport they give the
      // fraction of the screen the canvas travelled. Negated so the far
      // edges trail the motion instead of leading it.
      const on = params.scrollWarpEnabled;
      const warpMag = stepWarp(
        warpS,
        on ? -(sdx * z) / W : 0,
        on ? -(sdy * z) / H : 0,
        params,
      );
      postUniforms.warp.value.set(warpS.x, warpS.y);
      postUniforms.barrelK2.value = bkS.v + params.warpK2 * warpMag;

      if (isD) {
        const s = params.panSmoothing;
        camera.position.x += (tX - camera.position.x) * s;
        camera.position.y += (tY - camera.position.y) * s;
      } else if (
        Math.abs(vel.x) > params.inertiaMinThreshold ||
        Math.abs(vel.y) > params.inertiaMinThreshold
      ) {
        camera.position.x -= (vel.x * params.inertiaMultiplier) / z;
        camera.position.y += (vel.y * params.inertiaMultiplier) / z;
        vel.x *= params.inertiaDamping;
        vel.y *= params.inertiaDamping;
      }

      const ccx = Math.floor(camera.position.x / params.chunkSize);
      const ccy = Math.floor(-camera.position.y / params.chunkSize);
      if (ccx !== lastCx || ccy !== lastCy) {
        lastCx = ccx;
        lastCy = ccy;
        updChunks();
      }

      renderer.setRenderTarget(renderTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      postUniforms.tDiffuse.value = renderTarget.texture;
      renderer.render(postScene, postCam);
    };

    preloadAllImages().then((data) => {
      if (disposed) return;
      imageData = data;
      applyZoom();
      updChunks();
      tick();
    });

    return () => {
      disposed = true;
      if (dzT) dzT.kill();
      if (bkT) bkT.kill();
      cancelAnimationFrame(raf);
      gui.destroy();
      window.removeEventListener("resize", onRs);
      cvs.removeEventListener("pointerdown", onDown);
      cvs.removeEventListener("pointermove", onMove);
      cvs.removeEventListener("pointerup", onUp);
      cvs.removeEventListener("pointercancel", onUp);
      cvs.removeEventListener("touchstart", onTS);
      cvs.removeEventListener("touchmove", onTM);
      cvs.removeEventListener("wheel", onWh);
      for (const [, g] of activeChunks) rmChunk(g);
      activeChunks.clear();
      imageData.forEach((d) => {
        if (d.texture) d.texture.dispose();
      });
      renderTarget.dispose();
      postMat.dispose();
      qGeo.dispose();
      renderer.dispose();
      if (container.contains(cvs)) container.removeChild(cvs);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        position: "relative",
        cursor: "grab",
        background: "#ffffff",
      }}
    />
  );
}
