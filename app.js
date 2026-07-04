/* BaDerech verification engine, v3 (approval form only). States: IDLE, VERIFYING, BLOCKED_STILL, VERIFIED. */

(function () {
  "use strict";

  var CONFIG = {
    MIN_SAMPLES: 3,          // no verdict before this many samples
    SMOOTH_WINDOW: 3,        // samples averaged per smoothed point
    STILL_LIMIT_M: 25,       // less net movement than this counts as couch
    STILL_AFTER_SAMPLES: 6,  // how many samples of stillness before rejection
    MOVE_M: 40,              // net smoothed movement that earns VERIFIED
    MAX_ACCURACY_M: 50       // GPS samples with worse accuracy are ignored
  };

  var params = new URLSearchParams(location.search);
  var DEMO = params.get("demo") === "1";

  var state = {
    phase: "IDLE",
    samples: [],
    baseline: null,
    movedM: 0,
    watchId: null,
    demoTimer: null
  };

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
    if (typeof accuracy === "number" && accuracy > CONFIG.MAX_ACCURACY_M) return;
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
    if (state.samples.length >= CONFIG.STILL_AFTER_SAMPLES && state.movedM < CONFIG.STILL_LIMIT_M) {
      return verdict("BLOCKED_STILL");
    }
  }

  function updateTelemetry() {
    $("t-samples").textContent = String(state.samples.length);
    $("t-moved").textContent = String(Math.round(state.movedM));
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
    }, function () {
      $("verify-status").textContent = "אין הרשאת מיקום. בלי מיקום אין אימות.";
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }

  function stopWatching() {
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    stopDemoFeed();
  }

  function resetEngine() {
    state.samples = [];
    state.baseline = null;
    state.movedM = 0;
  }

  function beginVerifying() {
    resetEngine();
    state.phase = "VERIFYING";
    show("screen-verifying");
    updateTelemetry();
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

  // verification happens on foot: desktop without touch gets the gate screen (demo bypasses)
  var IS_TOUCH = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
  if (!DEMO && !IS_TOUCH) show("screen-desktop");
})();
