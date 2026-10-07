/* Car 07's sound kit: everything is synthesised with Web Audio, nothing is sampled.
 * Each sound is a function (ctx, out, t, ...) that schedules itself at time t, so the
 * same code plays live on the page and renders offline for the demo video. */
(function (root) {
  const noiseCache = new WeakMap();
  function noise(ctx) {
    let b = noiseCache.get(ctx);
    if (!b) {
      b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseCache.set(ctx, b);
    }
    const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; return s;
  }
  const env = (ctx, t, a, peak, hold, rel, base = 0.0001) => {
    const g = ctx.createGain(); g.gain.value = base; g.gain.setValueAtTime(base, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
    return g;
  };
  const osc = (ctx, type, f, t) => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); return o; };
  const lp = (ctx, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = "lowpass"; b.frequency.value = f; b.Q.value = q; return b; };
  const bp = (ctx, f, q = 1) => { const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = f; b.Q.value = q; return b; };
  const hp = (ctx, f) => { const b = ctx.createBiquadFilter(); b.type = "highpass"; b.frequency.value = f; return b; };

  /* A small petrol engine: two detuned saws at the firing frequency, a sub, and a
   * tremolo at the cylinder rate, through a low-pass that opens with the revs. */
  function engine(ctx, out, t, dur, rpmFrom = 900, rpmTo = 900, vol = 0.16) {
    const f0 = rpmFrom / 60 * 2, f1 = rpmTo / 60 * 2;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.25);
    g.gain.setValueAtTime(vol, Math.max(t + 0.25, t + dur - 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f = lp(ctx, 380, 4); f.frequency.setValueAtTime(260 + f0 * 4, t); f.frequency.linearRampToValueAtTime(260 + f1 * 6, t + dur);
    const trem = ctx.createGain(); trem.gain.value = 0.55;
    const lfo = osc(ctx, "square", f0 / 2, t); lfo.frequency.linearRampToValueAtTime(f1 / 2, t + dur);
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.45; lfo.connect(lfoAmt).connect(trem.gain);
    const parts = [["sawtooth", 1, 0.5], ["sawtooth", 1.012, 0.4], ["square", 0.5, 0.35]];
    const oscs = parts.map(([type, mul, lvl]) => {
      const o = osc(ctx, type, f0 * mul, t); o.frequency.linearRampToValueAtTime(f1 * mul, t + dur);
      const l = ctx.createGain(); l.gain.value = lvl; o.connect(l).connect(f); return o;
    });
    const n = noise(ctx), nf = bp(ctx, 900, 0.8), ng = ctx.createGain(); ng.gain.value = 0.05 + (rpmTo / 9000) * 0.1;
    n.connect(nf).connect(ng).connect(f);
    f.connect(trem).connect(g).connect(out);
    [...oscs, lfo, n].forEach((o) => { o.start(t); o.stop(t + dur + 0.05); });
    return { stop(at) { g.gain.cancelScheduledValues(at); g.gain.setValueAtTime(g.gain.value || vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3); [...oscs, lfo, n].forEach((o) => { try { o.stop(at + 0.35); } catch {} }); } };
  }

  const S = {
    key(ctx, out, t) { const n = noise(ctx), f = bp(ctx, 3800, 3), g = env(ctx, t, 0.002, 0.07, 0.004, 0.03); n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.06); },
    click(ctx, out, t) { const o = osc(ctx, "triangle", 1400, t); o.frequency.exponentialRampToValueAtTime(500, t + 0.05); const g = env(ctx, t, 0.002, 0.12, 0, 0.06); o.connect(g).connect(out); o.start(t); o.stop(t + 0.1); },
    rev(ctx, out, t) { return engine(ctx, out, t, 1.25, 1100, 5200, 0.2); },
    ding(ctx, out, t, step = 0) {
      const base = 880 * Math.pow(2, [0, 2, 4, 7, 9][step % 5] / 12);
      [[1, 0.16], [2.01, 0.05], [3, 0.03]].forEach(([m, v]) => { const o = osc(ctx, "sine", base * m, t); const g = env(ctx, t, 0.004, v, 0.02, 0.5); o.connect(g).connect(out); o.start(t); o.stop(t + 0.6); });
    },
    whoosh(ctx, out, t) {
      const n = noise(ctx), f = bp(ctx, 400, 2.5); f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3200, t + 0.55); f.frequency.exponentialRampToValueAtTime(900, t + 0.9);
      const g = env(ctx, t, 0.25, 0.28, 0.1, 0.5); n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 1);
      const p = osc(ctx, "sine", 160, t + 0.05); p.frequency.exponentialRampToValueAtTime(50, t + 0.25); const pg = env(ctx, t + 0.05, 0.003, 0.3, 0, 0.2); p.connect(pg).connect(out); p.start(t + 0.05); p.stop(t + 0.3);
    },
    screech(ctx, out, t, dur = 1.0) {
      const n = noise(ctx), f = bp(ctx, 2600, 9), g = env(ctx, t, 0.03, 0.9, dur - 0.35, 0.3);
      const wob = osc(ctx, "sine", 9, t), wa = ctx.createGain(); wa.gain.value = 260; wob.connect(wa).connect(f.frequency);
      n.connect(f).connect(g).connect(out);
      const s = osc(ctx, "sawtooth", 1180, t); s.frequency.linearRampToValueAtTime(980, t + dur); const sv = osc(ctx, "sine", 13, t), sva = ctx.createGain(); sva.gain.value = 35; sv.connect(sva).connect(s.frequency);
      const sf = bp(ctx, 1500, 6), sg = env(ctx, t, 0.03, 0.13, dur - 0.35, 0.3); s.connect(sf).connect(sg).connect(out);
      [n, wob, s, sv].forEach((o) => { o.start(t); o.stop(t + dur + 0.1); });
    },
    thud(ctx, out, t) {
      const o = osc(ctx, "sine", 110, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.25); const g = env(ctx, t, 0.003, 0.45, 0.02, 0.28); o.connect(g).connect(out); o.start(t); o.stop(t + 0.35);
      const n = noise(ctx), f = lp(ctx, 1800), ng = env(ctx, t, 0.002, 0.12, 0, 0.08); n.connect(f).connect(ng).connect(out); n.start(t); n.stop(t + 0.1);
    },
    crash(ctx, out, t) {
      S.thud(ctx, out, t);
      const n = noise(ctx), f = lp(ctx, 5000), g = env(ctx, t, 0.002, 0.35, 0.05, 0.7); n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.9);
      [317, 548, 811, 1237].forEach((fr, k) => { const o = osc(ctx, "triangle", fr, t + 0.01 * k); const og = env(ctx, t + 0.01 * k, 0.002, 0.07, 0, 0.9); o.connect(og).connect(out); o.start(t + 0.01 * k); o.stop(t + 1.1); });
      [0.35, 0.55, 0.72].forEach((d) => S.key(ctx, out, t + d));
    },
    sputter(ctx, out, t) {
      for (let k = 0; k < 6; k++) { const at = t + k * 0.22 + (k > 3 ? 0.18 : 0); engine(ctx, out, at, 0.16, 900 - k * 90, 800 - k * 100, 0.18); }
      const p = osc(ctx, "sine", 220, t + 1.65); p.frequency.exponentialRampToValueAtTime(80, t + 1.9); const g = env(ctx, t + 1.65, 0.005, 0.25, 0, 0.25); p.connect(g).connect(out); p.start(t + 1.65); p.stop(t + 2);
    },
    boing(ctx, out, t) {
      const o = osc(ctx, "sine", 300, t); o.frequency.exponentialRampToValueAtTime(620, t + 0.12); o.frequency.exponentialRampToValueAtTime(420, t + 0.5);
      const v = osc(ctx, "sine", 14, t), va = ctx.createGain(); va.gain.setValueAtTime(60, t); va.gain.exponentialRampToValueAtTime(1, t + 0.6); v.connect(va).connect(o.frequency);
      const g = env(ctx, t, 0.005, 0.22, 0.05, 0.55); o.connect(g).connect(out); [o, v].forEach((x) => { x.start(t); x.stop(t + 0.7); });
      [[660, 0.75], [880, 0.88]].forEach(([fr, d]) => { const b = osc(ctx, "square", fr, t + d); const bg = env(ctx, t + d, 0.004, 0.05, 0.05, 0.08); const bf = lp(ctx, 2400); b.connect(bf).connect(bg).connect(out); b.start(t + d); b.stop(t + d + 0.2); });
    },
    horn(ctx, out, t) {
      [0, 0.26].forEach((d, k) => {
        [440, 554].forEach((fr) => { const o = osc(ctx, "square", fr * (k ? 1 : 0.94), t + d); const f = lp(ctx, 1600, 2); const g = env(ctx, t + d, 0.01, 0.07, k ? 0.32 : 0.12, 0.06); o.connect(f).connect(g).connect(out); o.start(t + d); o.stop(t + d + 0.6); });
      });
    },
    fanfare(ctx, out, t) {
      [523.25, 659.25, 783.99, 1046.5].forEach((fr, k) => {
        const at = t + 0.75 + k * 0.11; const o = osc(ctx, "triangle", fr, at); const o2 = osc(ctx, "square", fr * 2, at);
        const g = env(ctx, at, 0.005, 0.12, k === 3 ? 0.35 : 0.05, k === 3 ? 0.6 : 0.12); const g2 = env(ctx, at, 0.005, 0.02, 0.05, 0.1);
        o.connect(g).connect(out); o2.connect(g2).connect(out); [o, o2].forEach((x) => { x.start(at); x.stop(at + 1.2); });
      });
      for (let k = 0; k < 14; k++) S.key(ctx, out, t + 0.9 + Math.random() * 1.2);
    },
    tick(ctx, out, t, n = 8) { for (let k = 0; k < n; k++) { const at = t + k * 0.09 * (1 + k / n); const o = osc(ctx, "square", 2200, at); const g = env(ctx, at, 0.001, 0.05, 0, 0.02); o.connect(g).connect(out); o.start(at); o.stop(at + 0.04); } },
    swish(ctx, out, t) { const n = noise(ctx), f = bp(ctx, 900, 1.5); f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(2600, t + 0.25); const g = env(ctx, t, 0.08, 0.08, 0.02, 0.2); n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.4); },
    engine,
  };

  /* An original arcade-racing bed in A minor, 128 bpm: kick, off-beat hats, a
   * pumping saw bass and a chiptune hook. For the video only. */
  S.music = function (ctx, out, t0, dur) {
    const spb = 60 / 128, bars = Math.ceil(dur / (spb * 4));
    const prog = [[45, 57, 60, 64], [41, 53, 57, 60], [43, 55, 59, 62], [40, 52, 55, 59]]; // Am F G Em
    const hook = [69, 72, 74, 76, 74, 72, 69, null, 67, 69, 72, 69, 67, 64, null, null];
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const bus = ctx.createGain(); bus.gain.setValueAtTime(0.0001, t0); bus.gain.exponentialRampToValueAtTime(1, t0 + 1.5); bus.gain.setValueAtTime(1, t0 + dur - 2.5); bus.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); bus.connect(out);
    for (let b = 0; b < bars; b++) {
      const chord = prog[b % 4], bt = t0 + b * spb * 4;
      for (let q = 0; q < 4; q++) {
        const at = bt + q * spb; if (at > t0 + dur) break;
        const k = osc(ctx, "sine", 130, at); k.frequency.exponentialRampToValueAtTime(42, at + 0.14); const kg = env(ctx, at, 0.002, 0.42, 0.02, 0.2); k.connect(kg).connect(bus); k.start(at); k.stop(at + 0.3);
        const h = noise(ctx), hf = hp(ctx, 7000), hg = env(ctx, at + spb / 2, 0.002, 0.05, 0, 0.05); h.connect(hf).connect(hg).connect(bus); h.start(at + spb / 2); h.stop(at + spb / 2 + 0.08);
        for (let e = 0; e < 2; e++) { const ba = at + e * spb / 2; const bo = osc(ctx, "sawtooth", mtof(chord[0] - 12 + (e ? 12 : 0)), ba); const bf = lp(ctx, 500, 6); const bg = env(ctx, ba, 0.005, 0.11, spb / 2 - 0.12, 0.08); bo.connect(bf).connect(bg).connect(bus); bo.start(ba); bo.stop(ba + spb / 2 + 0.05); }
        if (q === 0 || q === 2) chord.slice(1).forEach((m) => { const p = osc(ctx, "triangle", mtof(m), at); const pg = env(ctx, at, 0.01, 0.025, spb * 1.6, 0.3); p.connect(pg).connect(bus); p.start(at); p.stop(at + spb * 2.2); });
      }
      if (b >= 2) hook.forEach((m, s) => { if (m == null) return; const at = bt + s * spb / 4 * (b % 2 ? 1 : 1); if (at > t0 + dur - 1) return; const o = osc(ctx, "square", mtof(m), at); const f = lp(ctx, 2600); const g = env(ctx, at, 0.004, 0.035, spb / 4 - 0.04, 0.05); o.connect(f).connect(g).connect(bus); o.start(at); o.stop(at + spb / 4 + 0.08); });
    }
  };

  /* Live player for the page: off until the visitor clicks, and muteable. */
  const Live = {
    ctx: null, out: null, loop: null,
    on: (() => { try { return localStorage.getItem("optic.sound") !== "off"; } catch { return true; } })(),
    wake() {
      if (!this.on) return null;
      if (!this.ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; this.ctx = new C(); this.out = this.ctx.createGain(); this.out.gain.value = 0.8; const comp = this.ctx.createDynamicsCompressor(); this.out.connect(comp).connect(this.ctx.destination); }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    },
    play(name, ...args) {
      try { window.dispatchEvent(new CustomEvent("optic:sfx", { detail: { name, args } })); } catch {}
      const ctx = this.wake(); if (!ctx || !S[name]) return;
      return S[name](ctx, this.out, ctx.currentTime + 0.01, ...args);
    },
    drive(on, rpm = 2600) {
      try { window.dispatchEvent(new CustomEvent("optic:sfx", { detail: { name: on ? "drive-on" : "drive-off", args: [rpm] } })); } catch {}
      const ctx = this.wake(); if (!ctx) return;
      if (this.loop) { this.loop.stop(ctx.currentTime); this.loop = null; }
      if (on) this.loop = engine(ctx, this.out, ctx.currentTime + 0.02, 600, rpm, rpm + 900, 0.11);
    },
    toggle() { this.on = !this.on; try { localStorage.setItem("optic.sound", this.on ? "on" : "off"); } catch {} if (!this.on) { if (this.loop) { this.loop.stop(this.ctx.currentTime); this.loop = null; } this.ctx?.suspend(); } else this.wake(); return this.on; },
  };
  root.OpticSFX = S; root.OpticSound = Live;
})(window);
