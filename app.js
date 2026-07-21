/* BaDerech verification engine, v3 (approval form only). States: IDLE, VERIFYING, BLOCKED_STILL, VERIFIED. */

(function () {
  "use strict";

  var CONFIG = {
    MIN_SAMPLES: 3,          // smoothing minimum before movement is measured
    SMOOTH_WINDOW: 3,        // samples averaged per smoothed point
    MOVE_M: 25,              // net smoothed movement that earns VERIFIED, at any moment
    DECISION_MS: 60000,      // the full minute: under 25m by then is a rejection
    EARLY_MS: 10000,         // early check: no movement at all by now is an instant rejection
    EARLY_MIN_M: 5,          // "no movement" means less than this (above GPS jitter)
    DEMO_DECISION_MS: 8000,  // compressed windows for demo mode
    DEMO_EARLY_MS: 4000,
    MAX_ACCURACY_M: 30,      // GPS samples with worse accuracy are ignored
    BASELINE_ACCURACY_M: 20, // the baseline waits for a fix at least this tight
    WARMUP_MAX_MS: 10000,    // past this wait, weak GPS may anchor with any accepted fix
    MAX_SPEED_MPS: 40        // a jump implying more than this is a GPS glitch, not movement
  };

  var params = new URLSearchParams(location.search);
  var DEMO = params.get("demo") === "1";

  // in-app browsers (WhatsApp, Instagram, Facebook...) often block the location
  // prompt entirely; detect them so the user is routed to a real browser
  var UA = navigator.userAgent || "";
  var IN_APP = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Snapchat|TikTok|Line\//i.test(UA) ||
    (/Android/i.test(UA) && /; wv\)/i.test(UA)) ||
    (/iPhone|iPad|iPod/.test(UA) && !/Safari\//.test(UA) && !/CriOS|FxiOS|EdgiOS/.test(UA));

  var state = {
    phase: "IDLE",
    samples: [],
    baseline: null,
    movedM: 0,
    startedAt: 0,
    firstSampleAt: 0,
    warmupStart: 0,
    lastRaw: null,
    earlyPassed: false,
    watchId: null,
    tickTimer: null,
    demoTimer: null
  };

  function decisionMs() { return DEMO ? CONFIG.DEMO_DECISION_MS : CONFIG.DECISION_MS; }
  function earlyMs() { return DEMO ? CONFIG.DEMO_EARLY_MS : CONFIG.EARLY_MS; }

  function $(id) { return document.getElementById(id); }

  function show(screenId) {
    var screens = document.querySelectorAll(".screen");
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove("active");
    $(screenId).classList.add("active");
    window.scrollTo(0, 0);
  }

  function haversineM(a, b) {
    var R = 6371000;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLon = (b.lon - a.lon) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180;
    var la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function smoothed() {
    var n = Math.min(CONFIG.SMOOTH_WINDOW, state.samples.length);
    if (n === 0) return null;
    var lat = 0, lon = 0;
    for (var i = state.samples.length - n; i < state.samples.length; i++) {
      lat += state.samples[i].lat;
      lon += state.samples[i].lon;
    }
    return { lat: lat / n, lon: lon / n };
  }

  /* certificate link: snapshot encoded in the URL, zero backend */

  function b64url(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function makeCert() {
    var serial = "BD-" + new Date().getFullYear() + "-" +
      String(Math.floor(100000 + Math.random() * 900000));
    var data = {
      n: serial,
      ts: new Date().toISOString(),
      m: Math.round(state.movedM),
      s: "verified"
    };
    var base = location.href.split("?")[0].replace(/index\.html$/, "");
    return base + "cert.html?c=" + b64url(JSON.stringify(data));
  }

  function verifiedMessage(certUrl) {
    return "בדרך®, הרשות הלאומית לאימות ״אני בדרך״, מאשרת: " +
      Math.round(state.movedM) + " מטרים של תזוזה מאומתת.\n" +
      "תעודה רשמית: " + certUrl;
  }

  function waLink(text) {
    return "https://wa.me/?text=" + encodeURIComponent(text);
  }

  /* engine */

  function acceptSample(lat, lon, accuracy) {
    if (state.phase !== "VERIFYING") return;
    var now = Date.now();
    if (!state.warmupStart) state.warmupStart = now;
    if (typeof accuracy === "number" && accuracy > CONFIG.MAX_ACCURACY_M) return;

    // warm-up: the first fixes after GPS wakes are the noisiest; don't anchor
    // the baseline on them unless the wait runs long (weak-GPS fallback)
    if (!state.baseline &&
        typeof accuracy === "number" &&
        accuracy > CONFIG.BASELINE_ACCURACY_M &&
        now - state.warmupStart < CONFIG.WARMUP_MAX_MS) {
      $("verify-status").textContent = "ממתין לאיתות GPS יציב...";
      return;
    }

    // teleport filter: a jump between fixes that implies impossible speed is
    // multipath noise, not movement; drop it and wait for the next fix
    if (state.lastRaw) {
      var dt = (now - state.lastRaw.t) / 1000;
      if (dt > 0 &&
          haversineM(state.lastRaw, { lat: lat, lon: lon }) / dt > CONFIG.MAX_SPEED_MPS) return;
    }
    state.lastRaw = { lat: lat, lon: lon, t: now };

    if (!state.firstSampleAt) state.firstSampleAt = now;
    state.samples.push({ lat: lat, lon: lon });

    var sm = smoothed();
    if (state.samples.length < CONFIG.MIN_SAMPLES) {
      updateTelemetry();
      return;
    }
    if (!state.baseline) {
      state.baseline = sm;
      updateTelemetry();
      return;
    }

    state.movedM = haversineM(state.baseline, sm);
    updateTelemetry();

    if (state.movedM >= CONFIG.MOVE_M) return verdict("VERIFIED");
  }

  // the clock decides the rejection, internally, nothing shown:
  // no movement by the early mark = instant rejection; under 25m when the minute ends = rejection
  function tick() {
    if (state.phase !== "VERIFYING") return;
    if (!state.firstSampleAt) return; // the clock starts at the first real measurement, not the tap
    var elapsed = Date.now() - state.firstSampleAt;
    if (!state.earlyPassed && elapsed >= earlyMs()) {
      if (state.movedM < CONFIG.EARLY_MIN_M) return verdict("BLOCKED_STILL");
      state.earlyPassed = true;
    }
    if (elapsed >= decisionMs()) {
      if (state.movedM >= CONFIG.MOVE_M) return verdict("VERIFIED");
      return verdict("BLOCKED_STILL");
    }
  }

  function updateTelemetry() {
    $("t-samples").textContent = String(state.samples.length);
    $("t-moved").textContent = String(Math.round(state.movedM));
    var fill = $("t-track");
    if (fill) fill.style.width = Math.min(100, (state.movedM / CONFIG.MOVE_M) * 100) + "%";
    if (state.samples.length < CONFIG.MIN_SAMPLES) {
      $("verify-status").textContent = "ממתין לדגימות מיקום... (" +
        state.samples.length + "/" + CONFIG.MIN_SAMPLES + ")";
    } else {
      $("verify-status").textContent = "במדידה... יש להמשיך לזוז.";
    }
  }

  function verdict(v) {
    if (v === "VERIFIED") {
      state.phase = "VERIFIED";
      stopWatching();
      var certUrl = makeCert();
      $("verified-msg").textContent = verifiedMessage(certUrl);
      $("btn-share-verified").onclick = function () {
        window.open(waLink(verifiedMessage(certUrl)), "_blank");
      };
      show("screen-verified");
      return;
    }
    state.phase = "BLOCKED_STILL";
    $("blocked-evidence").textContent = "תזוזה שנמדדה: " + Math.round(state.movedM) + " מטרים.";
    show("screen-blocked");
  }

  function startWatching() {
    if (DEMO) return; // demo feeds samples by hand
    if (!("geolocation" in navigator)) {
      $("verify-status").textContent = "אין גישה למיקום בדפדפן הזה. הרשות מתנצלת (לא באמת).";
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(function (pos) {
      acceptSample(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
    }, function (err) {
      var code = err && err.code;
      var msg;
      if (code === 1) {
        msg = IN_APP
          ? "הדפדפן שבתוך האפליקציה חוסם מיקום. יש לפתוח את הקישור בדפדפן רגיל (תפריט שלוש הנקודות, ״פתיחה בדפדפן״)."
          : "אין הרשאת מיקום. בלי מיקום אין אימות.";
      } else if (code === 3) {
        msg = "איתור המיקום מתארך. עדיף תחת שמיים פתוחים.";
      } else {
        msg = "אין קליטת מיקום כרגע. בתוך מבנה זה קורה, בחוץ זה עובר.";
      }
      $("verify-status").textContent = msg;
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }

  function stopWatching() {
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    stopDemoFeed();
  }

  function resetEngine() {
    state.samples = [];
    state.baseline = null;
    state.movedM = 0;
    state.firstSampleAt = 0;
    state.warmupStart = 0;
    state.lastRaw = null;
    state.earlyPassed = false;
  }

  function beginVerifying() {
    resetEngine();
    state.phase = "VERIFYING";
    state.startedAt = Date.now();
    show("screen-verifying");
    updateTelemetry();
    state.tickTimer = setInterval(tick, 250);
    startWatching();
  }

  /* demo mode: drive every state without real GPS */

  var demoBase = { lat: 32.0800, lon: 34.7800 };
  var demoStep = 0;

  function stopDemoFeed() {
    if (state.demoTimer) { clearInterval(state.demoTimer); state.demoTimer = null; }
  }

  function demoFeed(mode) {
    stopDemoFeed();
    demoStep = 0;
    if (state.phase !== "VERIFYING") beginVerifying();
    state.demoTimer = setInterval(function () {
      demoStep++;
      var jitter = (Math.random() - 0.5) * 0.00002; // ~2m of noise
      var lat = demoBase.lat, lon = demoBase.lon;
      if (mode === "move") lat += demoStep * 0.0002; // ~22m per tick
      acceptSample(lat + jitter, lon + jitter, 10);
      if (state.phase !== "VERIFYING") stopDemoFeed();
    }, 700);
  }

  /* wiring */

  $("request-form").addEventListener("submit", function (e) {
    e.preventDefault();
    beginVerifying();
  });

  $("btn-retry").addEventListener("click", function () {
    beginVerifying();
  });

  $("btn-again").addEventListener("click", function () {
    stopWatching();
    resetEngine();
    state.phase = "IDLE";
    show("screen-idle");
  });

  if (DEMO) {
    document.body.classList.add("demo");
    var bar = $("demo-bar");
    bar.hidden = false;
    bar.addEventListener("click", function (e) {
      var mode = e.target.getAttribute("data-demo");
      if (mode === "still") demoFeed("still");
      if (mode === "move") demoFeed("move");
    });
  }

  if (!DEMO && IN_APP) $("inapp-notice").hidden = false;

  // verification happens on foot: desktop without touch gets the gate screen (demo bypasses)
  var IS_TOUCH = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
  if (!DEMO && !IS_TOUCH) show("screen-desktop");
})();
