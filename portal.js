/* PortalAds – ads through a web game portal SDK, used only by the portal builds (no Gumroad unlock there).
   window.PORTAL = { name: "crazygames" | "gamedistribution" | "poki", gameId: "<GameDistribution game id>" } is set in portal-config.js.
   Godot calls (res://web/web_bridge.gd): setListeners(onAdStart, onAdDone(ok), onMute(muted)), engineReady(),
   gameplayStart(), gameplayStop(), happy(), request("midgame" | "rewarded").
   Rules followed: ads only between levels (midgame) or when the player asks for a hint (rewarded); game muted
   and input blocked while an ad plays; a rewarded hint is given only when the ad was watched to the end;
   if the SDK is blocked (adblock/offline) the game keeps working. */
(function () {
  "use strict";
  var P = window.PORTAL || {};
  var L = { start: null, done: null, mute: null };
  var inGameplay = false, ready = false, busy = false;
  var lastMidgame = 0;
  function log() { if (window.PORTAL_DEBUG) console.log.apply(console, ["[portal]"].concat([].slice.call(arguments))); }
  function call(f, v) { if (f) { try { f(v); } catch (e) { console.warn(e); } } }
  var watchdog = 0;
  function arm(ms) { clearTimeout(watchdog); watchdog = setTimeout(function () { log("ad watchdog"); adDone(false); }, ms); }
  function adStart() { log("adStarted"); arm(150000); call(L.start); }
  function adDone(ok) { clearTimeout(watchdog); if (!busy) return; log("adDone", ok); busy = false; call(L.done, !!ok); }

  var impl = { init: function () { return Promise.resolve(); }, gameplayStart: function () {}, gameplayStop: function () {},
    loadingStop: function () {}, happy: function () {}, ad: function (kind) { adDone(false); } };

  if (P.name === "crazygames") {
    var sdk = function () { return window.CrazyGames && window.CrazyGames.SDK; };
    var usable = function () { var s = sdk(); return s && s.environment !== "disabled"; };
    impl.init = function () {
      if (!sdk()) return Promise.reject(new Error("CrazyGames SDK not loaded"));
      return sdk().init().then(function () {
        log("CrazyGames env", sdk().environment);
        if (!usable()) return;
        try { sdk().game.loadingStart(); } catch (e) {}
        var applyMute = function () { try { call(L.mute, !!(sdk().game.settings && sdk().game.settings.muteAudio)); } catch (e) {} };
        try { sdk().game.addSettingsChangeListener(applyMute); } catch (e) {}
        impl._applyMute = applyMute;
      });
    };
    impl.loadingStop = function () { if (usable()) { try { sdk().game.loadingStop(); } catch (e) {} if (impl._applyMute) impl._applyMute(); } };
    impl.gameplayStart = function () { if (usable()) try { sdk().game.gameplayStart(); } catch (e) {} };
    impl.gameplayStop = function () { if (usable()) try { sdk().game.gameplayStop(); } catch (e) {} };
    impl.happy = function () { if (usable()) try { sdk().game.happytime(); } catch (e) {} };
    impl.ad = function (kind) {
      if (!usable()) return adDone(false);
      var started = false;
      try {
        sdk().ad.requestAd(kind, {
          adStarted: function () { started = true; adStart(); },
          adFinished: function () { adDone(true); },
          adError: function (err) { log("adError", err && (err.code || err)); adDone(false); }
        });
      } catch (e) { adDone(false); }
    };
  } else if (P.name === "gamedistribution") {
    var pending = null, rewardedOk = false;
    window.GD_OPTIONS = {
      gameId: P.gameId || "",
      onEvent: function (ev) {
        log("GD event", ev.name);
        switch (ev.name) {
          case "SDK_GAME_PAUSE": if (pending) adStart(); break;
          case "SDK_REWARDED_WATCH_COMPLETE": rewardedOk = true; break;
        }
      }
    };
    (function (d, s, id) {
      var js, fjs = d.getElementsByTagName(s)[0];
      if (d.getElementById(id)) return;
      js = d.createElement(s); js.id = id; js.src = "https://html5.api.gamedistribution.com/main.min.js";
      fjs.parentNode.insertBefore(js, fjs);
    }(document, "script", "gamedistribution-jssdk"));
    impl.ad = function (kind) {
      var g = window.gdsdk;
      if (!g || typeof g.showAd !== "function") return adDone(false);
      pending = kind; rewardedOk = false;
      var fin = function (ok) { pending = null; adDone(ok); };
      try {
        var pr = kind === "rewarded" ? g.showAd("rewarded") : g.showAd();
        Promise.resolve(pr).then(function () { fin(kind === "rewarded" ? rewardedOk : true); /* reward only on SDK_REWARDED_WATCH_COMPLETE (GD rule) */ }, function (e) { log("GD showAd error", e); fin(false); });
      } catch (e) { fin(false); }
    };
  } else if (P.name === "poki") {
    // Poki rules: gameplayStart on real play only, never two identical events in a row, no SDK events while an ad
    // plays, commercialBreak only when the player heads back into gameplay (so the midgame asked for at the end of a
    // level is held and played just before the next level's gameplayStart), gameplayStop before any ad.
    var poki = function () { return window.PokiSDK; };
    var q = Promise.resolve(), playing = false, pendingBreak = false;
    var serial = function (f) { q = q.then(f).catch(function (e) { log("poki", e); }); return q; };
    var start = function () { if (!playing) { playing = true; log("Poki gameplayStart"); poki().gameplayStart(); } };
    var stop = function () { if (playing) { playing = false; log("Poki gameplayStop"); poki().gameplayStop(); } };
    window.addEventListener("keydown", function (ev) { if (["ArrowDown", "ArrowUp", " "].indexOf(ev.key) >= 0) ev.preventDefault(); });
    window.addEventListener("wheel", function (ev) { ev.preventDefault(); }, { passive: false });
    impl.init = function () {
      if (!poki()) return Promise.reject(new Error("Poki SDK not loaded"));
      return poki().init().then(function () { log("Poki SDK ready"); impl.ok = true; },
        function () { log("Poki init failed, playing anyway"); impl.ok = true; });
    };
    impl.loadingStop = function () { if (impl.ok) { log("Poki gameLoadingFinished"); poki().gameLoadingFinished(); } };
    impl.gameplayStart = function () {
      if (!impl.ok) return;
      serial(function () {
        if (!pendingBreak) return start();
        pendingBreak = false;
        return new Promise(function (res) { setTimeout(res, 0); }).then(function () {
          busy = true; arm(20000);
          log("Poki commercialBreak");
          return poki().commercialBreak(function () { adStart(); });
        }).then(function () { adDone(true); }, function () { adDone(false); }).then(start);
      });
    };
    impl.gameplayStop = function () { if (impl.ok) serial(function () { stop(); }); };   // a held break stays pending until the player plays again
    impl.ad = function (kind) {
      if (!impl.ok) return adDone(kind !== "rewarded");
      if (kind === "midgame") {
        // level finished: gameplay stops now, the break itself waits for the next gameplayStart
        inGameplay = false;
        serial(function () { stop(); pendingBreak = true; setTimeout(function () { adDone(true); }, 0); });
        return;
      }
      serial(function () {
        var was = playing; stop();
        log("Poki rewardedBreak");
        return poki().rewardedBreak(function () { adStart(); }).then(function (ok) { adDone(!!ok); }, function () { adDone(false); })
          .then(function () { if (was && inGameplay) start(); });
      });
    };
  }

  var initP = impl.init().catch(function (e) { console.info("[portal] SDK unavailable, playing without ads:", e && e.message); });
  // index.html waits for this (max 6 s) before starting the engine, so the save store below is ready when Godot loads progress
  window.PortalReady = initP;

  /* PortalStore – progress save through the portal (CrazyGames SDK Data Module: synced to the player's CrazyGames
     account, localStorage for guests). Used by res://meta/progress.gd on web builds: when enabled() is true the game
     saves ONLY here (CrazyGames rule: rely fully on the Data Module); otherwise it uses its own user:// file.
     Requires "Progress save: Yes, using the CrazyGames SDK Data Module" in the CrazyGames submission form. */
  window.PortalStore = {
    _off: false,
    enabled: function () {
      if (this._off || P.name !== "crazygames") return false;
      var s = window.CrazyGames && window.CrazyGames.SDK;
      if (!s || !s.data || s.environment === "disabled") return false;
      try { s.data.getItem("__probe"); return true; } catch (e) { log("data module off", e && (e.code || e)); this._off = true; return false; }
    },
    get: function (k) { try { var v = window.CrazyGames.SDK.data.getItem(k); return v == null ? "" : String(v); } catch (e) { return ""; } },
    set: function (k, v) {
      try { window.CrazyGames.SDK.data.setItem(k, v); return true; }
      catch (e) { console.warn("[portal] data module save failed", e && (e.code || e.message || e)); if (e && e.code === "dataModuleDisabled") this._off = true; return false; }
    }
  };

  window.PortalAds = {
    name: P.name || "",
    setListeners: function (onStart, onDone, onMute) { L.start = onStart; L.done = onDone; L.mute = onMute; },
    engineReady: function () { ready = true; initP.then(function () { impl.loadingStop(); }); },
    gameplayStart: function () { if (inGameplay) return; inGameplay = true; initP.then(impl.gameplayStart); },
    gameplayStop: function () { if (!inGameplay) return; inGameplay = false; initP.then(impl.gameplayStop); },
    happy: function () { initP.then(impl.happy); },
    wantsPreroll: function () { return P.name === "gamedistribution" && !lastMidgame; },
    request: function (kind) {
      if (busy) return;
      kind = kind === "rewarded" ? "rewarded" : "midgame";
      if (kind === "midgame" && P.name === "gamedistribution") {
        // GameDistribution: the first ad is the preroll (when the player first opens a level); after that
        // at most one midgame every 3 minutes (GD also applies its own frequency rules).
        var now = Date.now();
        if (lastMidgame && now - lastMidgame < 180000) { busy = true; setTimeout(function () { adDone(true); }, 0); return; }
        lastMidgame = now;
      }
      // Poki: the level is over now. Mark it synchronously, so a gameplayStart sent by Godot in the same frame
      // (Passatempos "Next" asks for the midgame and opens the next puzzle at once) is not swallowed as a duplicate.
      if (kind === "midgame" && P.name === "poki") inGameplay = false;
      busy = true;
      arm(20000);   // no answer from the SDK within 20 s (no fill, slow network): give the game back
      initP.then(function () { impl.ad(kind); });
    }
  };
}());
