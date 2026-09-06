/**
 * strategy.js: the strategy desk.
 *
 * A processor with a converter on its input port and a controller on its
 * output port is a machine that trades. This page runs that arrangement in
 * front of you: real ST-8 source, assembled by the same assembler the
 * workbench uses, executed on the same 2,161-gate netlist a contract walks,
 * against a price series fed in one byte at a time.
 *
 * Nothing here is a model of a processor deciding. It is the processor
 * deciding, and the tape is what came off the output port.
 */
(function () {
  "use strict";

  var host = document.getElementById("strategy");
  if (!host || !window.ST8 || !window.ST8_ASM) return;

  /* ------------------------------------------------------------- the markets
   *
   * The chart is TradingView's and shows the real symbol. The series the chip
   * runs on is generated from a fixed seed, so the run is reproducible: press
   * the same button tomorrow and every row of the tape comes back identical,
   * which is the property that makes a strategy checkable at all.
   */
  var MARKETS = [
    { key: "HOOD", tv: "NASDAQ:HOOD", label: "HOOD", seed: 0x48001, base: 84.2, vol: 0.021 },
    { key: "NVDA", tv: "NASDAQ:NVDA", label: "NVDA", seed: 0x4e564, base: 178.4, vol: 0.018 },
    { key: "AMD", tv: "NASDAQ:AMD", label: "AMD", seed: 0x414d44, base: 162.9, vol: 0.024 },
    { key: "BTC", tv: "COINBASE:BTCUSD", label: "BTC", seed: 0xb7c00, base: 71400, vol: 0.014 },
  ];

  /** A seeded walk, so a run is a fact rather than a fresh roll of the dice. */
  function series(m, n) {
    var s = m.seed >>> 0, px = m.base, out = [];
    for (var i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      var u = ((s >>> 8) & 0xffff) / 65535 - 0.5;
      s = (s * 1664525 + 1013904223) >>> 0;
      u += ((s >>> 8) & 0xffff) / 65535 - 0.5;
      px *= 1 + u * m.vol;
      out.push(px);
    }
    return out;
  }

  /* ----------------------------------------------------------- the converter
   *
   * Auto-ranging, the way an instrument auto-ranges. The window is the range
   * the symbol is actually trading in, and the byte is spent inside it, so
   * eight bits resolve a one-per-cent move far more finely than a naive map
   * of nought-to-the-price ever could.
   */
  function convert(prices) {
    var lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
    var span = hi - lo || 1;
    return {
      lo: lo,
      hi: hi,
      /** What one count is worth, as a fraction of the mid price. */
      tick: span / 255 / ((lo + hi) / 2),
      bytes: prices.map(function (p) {
        return Math.max(0, Math.min(255, Math.round(((p - lo) / span) * 255)));
      }),
    };
  }

  /* ---------------------------------------------------------- the strategies
   *
   * Each one is a real program. r5, r6 and r7 hold hold, buy and sell, so the
   * output port carries an intent the controller can read without knowing
   * which strategy produced it.
   */
  var STRATS = [
    {
      key: "breakout",
      name: "Channel breakout",
      note: "Buys a new high, sells a new low, holds inside the channel it has seen so far.",
      src: [
        "        ldi r1, #0        ; the highest sample seen",
        "        ldi r2, #255      ; the lowest sample seen",
        "        ldi r5, #0        ; HOLD",
        "        ldi r6, #1        ; BUY",
        "        ldi r7, #2        ; SELL",
        "loop:   in  r0",
        "        cmp r0, r1",
        "        jnc under         ; below the high",
        "        jz  under         ; level is not a break",
        "        mov r1, r0",
        "        out r6",
        "        jmp loop",
        "under:  cmp r0, r2",
        "        jc  flat          ; still inside the channel",
        "        mov r2, r0",
        "        out r7",
        "        jmp loop",
        "flat:   out r5",
        "        jmp loop",
      ].join("\n"),
    },
    {
      key: "momentum",
      name: "Tick momentum",
      note: "Follows the last move: up buys, down sells, unchanged holds.",
      src: [
        "        ldi r5, #0",
        "        ldi r6, #1",
        "        ldi r7, #2",
        "        in  r1            ; the first sample is the reference",
        "loop:   in  r0",
        "        cmp r0, r1",
        "        mov r1, r0        ; mov leaves the flags alone",
        "        jz  flat",
        "        jnc down",
        "        out r6",
        "        jmp loop",
        "down:   out r7",
        "        jmp loop",
        "flat:   out r5",
        "        jmp loop",
      ].join("\n"),
    },
    {
      key: "band",
      name: "Mean reversion",
      note: "Sells the top of a band around mid-window, buys the bottom, holds between.",
      src: [
        "        ldi r3, #128      ; mid-window",
        "        ldi r4, #40       ; half the band",
        "        ldi r5, #0",
        "        ldi r6, #1",
        "        ldi r7, #2",
        "        mov r1, r3",
        "        add r1, r4        ; the upper edge",
        "        mov r2, r3",
        "        sub r2, r4        ; the lower edge",
        "loop:   in  r0",
        "        cmp r0, r1",
        "        jz  low           ; the edge itself is inside",
        "        jc  rich          ; above the upper edge",
        "low:    cmp r0, r2",
        "        jc  flat          ; at or above the lower edge",
        "        out r6",
        "        jmp loop",
        "rich:   out r7",
        "        jmp loop",
        "flat:   out r5",
        "        jmp loop",
      ].join("\n"),
    },
    {
      key: "streak",
      name: "Three in a row",
      note: "Waits for three consecutive moves the same way before committing, a filter you can only build if the chip can count.",
      src: [
        "        ldi r5, #0",
        "        ldi r6, #1",
        "        ldi r7, #2",
        "        ldi r3, #0        ; the up streak",
        "        ldi r4, #0        ; the down streak",
        "        ldi r8, #3        ; how many it takes",
        "        in  r1",
        "loop:   in  r0",
        "        cmp r0, r1",
        "        mov r1, r0",
        "        jz  flat",
        "        jnc down",
        "        ldi r4, #0",
        "        inc r3",
        "        cmp r3, r8",
        "        jnc flat",
        "        ldi r3, #0",
        "        out r6",
        "        jmp loop",
        "down:   ldi r3, #0",
        "        inc r4",
        "        cmp r4, r8",
        "        jnc flat",
        "        ldi r4, #0",
        "        out r7",
        "        jmp loop",
        "flat:   out r5",
        "        jmp loop",
      ].join("\n"),
    },
  ];

  var ACTION = ["HOLD", "BUY", "SELL"];

  /**
   * Run a strategy over a converted series.
   *
   * The chip asks for a sample by executing `in`, and the host answers with
   * the next byte. That is the converter's side of the port, and it is the
   * same handshake a bus contract performs on chain: present, clock, read
   * what latched.
   */
  function run(program, bytes, budget) {
    var m = new window.ST8.Machine(program);
    var IN = window.ST8_DATA.ops.IN, OUT = window.ST8_DATA.ops.OUT;
    var tape = [], at = 0, cycles = 0;
    var cap = budget || 60000;

    while (cycles < cap && !m.halted()) {
      var word = m.program.rom[m.pc()] || 0;
      var op = (word >>> 20) & 0x1f;
      if (op === IN) {
        if (at >= bytes.length) break;
        m.inPort = bytes[at];
      }
      m.step();
      cycles++;
      if (op === IN) at++;
      if (op === OUT) {
        var v = m.out();
        tape.push({
          at: Math.max(0, at - 1),
          sample: bytes[Math.max(0, at - 1)],
          out: v,
          action: v & 3,
          cycle: m.cycle,
        });
      }
    }
    return { tape: tape, cycles: cycles, halted: m.halted() };
  }

  /* --------------------------------------------------------------- the panel */

  var market = MARKETS[0], strat = STRATS[0], result = null;
  var PRICES = null, CONV = null, chartUp = false;

  var elSym = document.getElementById("sd-symbols");
  var elStr = document.getElementById("sd-strats");
  var elSrc = document.getElementById("sd-src");
  var elNote = document.getElementById("sd-note");
  var elTape = document.getElementById("sd-tape");
  var elCyc = document.getElementById("sd-cycles");
  var elVer = document.getElementById("sd-verdict");

  function chips(hostEl, items, current, pick) {
    if (!hostEl) return;
    hostEl.textContent = "";
    items.forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (it === current ? " on" : "");
      b.textContent = it.label || it.name;
      b.setAttribute("aria-pressed", it === current ? "true" : "false");
      b.addEventListener("click", function () { pick(it); });
      hostEl.appendChild(b);
    });
  }

  function paint() {
    if (elSrc) elSrc.textContent = strat.src;
    if (elNote) elNote.textContent = strat.note;
    chips(elSym, MARKETS, market, function (m) {
      market = m;
      go();
      if (chartUp) mountChart();
    });
    chips(elStr, STRATS, strat, function (s) { strat = s; go(); });
  }

  function render() {
    if (!result) return;
    var t = result.tape;
    if (elCyc) {
      var changes = 0, p = -1;
      t.forEach(function (r) { if (r.action !== p) changes++; p = r.action; });
      elCyc.textContent = result.cycles.toLocaleString() + " cycles · " +
        t.length + " decisions · " + changes + " changes of intent";
    }

    var n = [0, 0, 0];
    t.forEach(function (r) { n[r.action]++; });
    if (elVer) {
      elVer.textContent = n[1] + " buy · " + n[2] + " sell · " + n[0] + " hold · " +
        "1 count = " + (CONV.tick * 100).toFixed(3) + "%";
    }

    if (!elTape) return;
    elTape.textContent = "";

    /* A run of HOLDs is one state, not forty rows of news. The controller
       only ever acts when the intent changes, so the tape records changes. */
    var moves = [], prev = -1;
    t.forEach(function (r) {
      if (r.action !== prev) moves.push(r);
      prev = r.action;
    });

    if (elTape.parentNode && !elTape.parentNode.querySelector("thead")) {
      var head = document.createElement("thead");
      head.innerHTML =
        "<tr><th>Cycle</th><th>Price</th><th>Sample</th><th>Intent</th></tr>";
      elTape.parentNode.insertBefore(head, elTape);
    }

    moves.slice(-40).reverse().forEach(function (r) {
      var px = PRICES[r.at];
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="mono dim">' + r.cycle + "</td>" +
        '<td class="mono">' + (px >= 1000 ? px.toFixed(0) : px.toFixed(2)) + "</td>" +
        '<td class="mono dim">' + r.sample + "</td>" +
        '<td><span class="act a' + r.action + '">' + ACTION[r.action] + "</span></td>";
      elTape.appendChild(tr);
    });
  }

  function go() {
    PRICES = series(market, 220);
    CONV = convert(PRICES);
    var program;
    try {
      program = window.ST8_ASM.assemble(strat.src);
    } catch (e) {
      if (elVer) elVer.textContent = "line " + e.line + ": " + e.message;
      return;
    }
    result = run(program, CONV.bytes);
    paint();
    render();
  }

  /* The chart is a third party's script, so nothing is requested from them
     until somebody asks for it. That is the reader's decision to make. */
  function mountChart() {
    var wrap = document.getElementById("tv-wrap");
    if (!wrap) return;
    wrap.textContent = "";
    var box = document.createElement("div");
    box.className = "tv-box";
    wrap.appendChild(box);

    var s = document.createElement("script");
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    s.async = true;
    s.textContent = JSON.stringify({
      symbol: market.tv,
      interval: "60",
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      style: "1",
      locale: "en",
      autosize: true,
      hide_side_toolbar: true,
      allow_symbol_change: false,
      backgroundColor: "rgba(0,0,0,0)",
    });
    box.appendChild(s);
    chartUp = true;
  }

  var btn = document.getElementById("tv-load");
  if (btn) btn.addEventListener("click", mountChart);

  var runBtn = document.getElementById("sd-run");
  if (runBtn) runBtn.addEventListener("click", go);

  var openBtn = document.getElementById("sd-open");
  if (openBtn) {
    openBtn.addEventListener("click", function () {
      var ed = document.getElementById("editor");
      if (!ed) return;
      ed.value = strat.src;
      ed.dispatchEvent(new Event("input", { bubbles: true }));
      /* The workbench is on the launchpad, which is a different page now. */
      var wb = document.getElementById("workbench");
      if (wb) wb.scrollIntoView({ behavior: "smooth", block: "start" });
      else location.href = "/launchpad.html#workbench";
    });
  }

  go();
})();
