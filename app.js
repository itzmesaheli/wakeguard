(function () {
  "use strict";

  /* ---------- face landmark indices (MediaPipe Face Mesh) ---------- */
  // Six points per eye: outer corner, two upper lid, inner corner, two lower lid
  const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
  const LEFT_EYE = [362, 385, 387, 263, 373, 380];
  // Inner lip top and bottom, mouth corners (yawn detection)
  const MOUTH = { top: 13, bottom: 14, left: 78, right: 308 };
  // Forehead, chin and cheek edges (head tilt and turn)
  const POSE = { forehead: 10, chin: 152, cheekL: 234, cheekR: 454 };

  /* ---------- tuning constants ---------- */
  const NO_FACE_ALARM_SEC = 3;       // face out of view this long sounds the alarm
  const WAKE_CLEAR_SEC = 1.0;        // eyes open and head up this long before a drowsiness alarm stops
  const AWAY_CLEAR_SEC = 0.8;        // facing forward this long before a distraction alarm stops
  const YAWN_MIN_SEC = 1.5;          // mouth wide open this long counts as a yawn
  const NOD_BEEP_SEC = 0.6;          // head down this long counts as a nod (soft beep)
  const NOD_ALARM_SEC = 2.0;         // head down this long sounds the loud alarm
  const EARLY_COOLDOWN_SEC = 8;      // minimum gap between soft beeps
  const FATIGUE_TIRED = 35;          // fatigue score where "Tired" starts
  const FATIGUE_VERY = 60;           // fatigue score where "Very tired" starts
  const BREAK_WINDOW_SEC = 600;      // alarms are counted over this window for the break message
  const MAX_SAMPLES = 7200;          // one sample per second, about 2 hours
  const HISTORY_KEY = "wakeguard_sessions";
  const ALARM_KEY = "wakeguard_alarms";   // every alarm, so you can mark it real or false
  const CAL_READY_SEC = 3;           // guided calibration: time to get into position
  const CAL_CAPTURE_SEC = 4;         // guided calibration: time spent measuring
  const CAL_RESULT_SEC = 3.5;        // how long the calibration result stays on screen
  const CAL_MIN_SAMPLES = 8;         // fewer good frames than this and calibration is rejected
  const CAL_MIN_EAR = 0.15;          // open-eye reading below this means the eyes are not being seen properly
  const BREAK_SNOOZE_MIN = 15;       // "remind me later" delay for the driving-time break reminder
  const LOW_LIGHT_LUMA = 55;         // average face brightness (0 to 255) below this counts as too dark
  const HIDDEN_EYE_RATIO = 0.42;     // eyes darker than this share of skin brightness, and flat, look like sunglasses
  const ESC_STEP_SEC = 10;           // the alarm gets louder every this many seconds if nobody responds
  const BLINK_BIN = 30;              // blink chart: seconds per bar
  const SLOW_BLINK_SEC = 0.4;        // a blink this long or longer counts as slow
  const PROFILES_KEY = "wakeguard_profiles";
  const VISION_BAD_SEC = 3;          // a lighting or sunglasses problem must last this long before the warning shows

  /* ---------- element lookup ---------- */
  const $ = (id) => document.getElementById(id);
  const ids = [
    "video", "overlay", "idle", "wakeText", "hud", "hudStatus", "hudScore", "hudBar", "error",
    "chart", "chart2", "csvSession", "csvAll", "clearAll", "historyBody", "historyEmpty",
    "status", "statusText", "fatigueBar", "fatigueVal", "fatigueLabel", "earBar", "thrMark",
    "earVal", "marVal", "tiltVal", "turnVal", "closedVal", "perclosVal", "blinkVal", "longestVal",
    "yawnVal", "nodVal", "distractVal", "alertVal",
    "startBtn", "calBtn", "silenceBtn", "testBtn", "driveBtn", "installBtn",
    "closeSec", "thr", "yawnThr", "nodDeg", "turnDeg", "turnSec", "vol", "sound",
    "voice", "vibrate", "earlyBeep", "contactName", "contactPhone", "breakAfter", "theme",
    "closeSecOut", "thrOut", "yawnThrOut", "nodDegOut", "turnDegOut", "turnSecOut", "volOut", "soundNote",
    "breakDialog", "breakTitle", "breakText", "breakCall", "breakClose", "breakSnooze", "breakHint",
    "calGuide", "calStep", "calTitle", "calText", "calCount", "calBar", "visionWarn",
    "driveTimeVal", "nextBreakVal", "lang", "langNote", "voiceTestBtn", "breakEvery",
    "chart3", "trendNote", "heatGrid", "heatNote",
    "accSummary", "accBody", "accNote", "accList", "accEmpty", "missedBtn", "accCsv", "accClear",
    "tripDialog", "tripVerdict", "tripStats", "tripSpark", "tripPeak", "tripTip", "tripAlarms", "tripAlarmsWrap", "tripClose", "tripBtn",
    "chart4", "chart5", "weeklyStats", "weeklyNote", "blinkNote", "driverBadge", "escalate", "voiceCmd", "voiceCmdNote", "preTrip",
    "uiLang", "textSize", "palette", "profileSel", "profileAdd", "profileRename", "profileDel", "profileNote",
    "exportBtn", "importBtn", "importFile", "backupNote", "preDialog", "preSleep", "preSleepy", "preLength", "preResult", "preRisk",
    "preAdvice", "preGo", "preSkip", "preCancel", "printReport", "tripScoreVal", "tripScoreWord", "tripStreak", "tripPre", "tripShare", "tripPrint"
  ];
  const ui = {};
  ids.forEach((id) => { ui[id] = $(id); });
  const video = ui.video, overlay = ui.overlay, ctx = overlay.getContext("2d");

  const state = {
    running: false, calibrating: false, calSamples: [], calPose: [], calUntil: 0, calPhase: null, calHideTimer: null,
    nextBreakAt: null, driveTimer: null, lastVisionAt: 0, visionBadSince: null, visionIssue: null, lastVisionBeepAt: 0,
    alarming: false, alarmKind: null, silencedUntil: 0, ducked: false,
    closedSince: null, openSince: null, closingWarned: false,
    lastFaceAt: 0, lastFrameAt: 0,
    earWindow: [], poseWindow: [], history: [], blinkTimes: [],
    basePitch: 0, baseYaw: 0,
    yawnSince: null, yawnCounted: false, yawning: false, yawnTimes: [],
    nodSince: null, nodCounted: false, nodTimes: [], headDown: false, headUpSince: null,
    awaySince: null, forwardSince: null,
    fatigueStage: 0, stage2BeepAt: 0, lastEarlyBeepAt: 0,
    alarmTimes: [],
    camera: null, faceMesh: null, wakeLock: null,
    session: null, lastSampleAt: 0, installPrompt: null,
    escLevel: 0, alarmStartAt: 0, escTimer: null,
    statusKind: "idle", statusKey: "Off", lastFatigue: 0, startKey: "Start monitoring",
    pre: null, preRisk: null, rec: null, recLang: null, recBlocked: false
  };

  /* ---------- drivers (profiles): each driver has their own settings, history and alarm log ---------- */
  function loadProfiles() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILES_KEY) || "null");
      if (p && Array.isArray(p.list) && p.list.length && p.list.some((x) => x.id === p.active)) return p;
    } catch (e) { /* ignore */ }
    return { active: "p1", list: [{ id: "p1", name: "Driver 1" }] };
  }
  const profiles = loadProfiles();
  function saveProfiles() { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); } catch (e) { /* ignore */ } }
  const sfx = (id) => (id === "p1" ? "" : "_" + id);                     // the first driver keeps the old storage names
  const pk = (base) => base + sfx(profiles.active);
  const activeName = () => (profiles.list.find((x) => x.id === profiles.active) || profiles.list[0]).name;
  function lsGet(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ } }

  /* ---------- interface language (English, Hindi, Bengali) ---------- */
  const I18N = { hi: {}, bn: {} };
  (window.WG_I18N || []).forEach((r) => { I18N.hi[r[0]] = r[1]; I18N.bn[r[0]] = r[2]; });
  const uiLang = () => (ui.uiLang && I18N[ui.uiLang.value] ? ui.uiLang.value : "en");
  function t(text, vars) {
    let out = text;
    const l = uiLang();
    if (l !== "en" && I18N[l][text]) out = I18N[l][text];
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
    return out;
  }
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };
  const I18N_ATTRS = ["aria-label", "placeholder", "title", "alt"];
  function applyI18n() {
    const l = uiLang();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (SKIP_TAGS[n.parentNode.nodeName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => {
      if (n._en === undefined) { if (!n.nodeValue.trim()) return; n._en = n.nodeValue; }
      const m = n._en.match(/^(\s*)([\s\S]*?)(\s*)$/);
      n.nodeValue = m[1] + (l === "en" ? m[2] : I18N[l][m[2]] || m[2]) + m[3];
    });
    document.querySelectorAll("[aria-label],[placeholder],[title]").forEach((e) => {
      I18N_ATTRS.forEach((a) => {
        if (!e.hasAttribute(a)) return;
        const k = "_en_" + a;
        if (e[k] === undefined) e[k] = e.getAttribute(a);
        e.setAttribute(a, l === "en" ? e[k] : I18N[l][e[k]] || e[k]);
      });
    });
    document.documentElement.lang = l;
  }

  /* ---------- small helpers ---------- */
  const round1 = (n) => Math.round(n * 10) / 10;
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const pad2 = (n) => String(n).padStart(2, "0");
  const nowSec = () => performance.now() / 1000;
  const num = (el) => Number(el.value);
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ":" + pad2(sec % 60);
  }
  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /* ---------- alarm recording (alarm.mp3 in the same folder) ---------- */
  const alarmFile = new Audio("alarm.mp3");
  alarmFile.loop = true;
  alarmFile.preload = "auto";
  let alarmFileOk = false;
  alarmFile.addEventListener("canplaythrough", () => { alarmFileOk = true; updateSoundNote(); });
  alarmFile.addEventListener("error", () => { alarmFileOk = false; updateSoundNote(); });

  function updateSoundNote() {
    ui.soundNote.textContent = alarmFileOk
      ? t("alarm.mp3 found.")
      : t("alarm.mp3 not found next to index.html, so the built-in siren is used.");
  }
  const useFile = () => ui.sound.value === "file" && alarmFileOk;

  /* ---------- settings ---------- */
  const RANGE_INPUTS = ["closeSec", "thr", "yawnThr", "nodDeg", "turnDeg", "turnSec", "vol"];
  const TEXT_INPUTS = ["sound", "theme", "contactName", "contactPhone", "breakAfter", "lang", "breakEvery", "uiLang", "textSize", "palette"];
  const CHECK_INPUTS = ["voice", "vibrate", "earlyBeep", "escalate", "voiceCmd", "preTrip"];
  const DEFAULTS = {};
  RANGE_INPUTS.concat(TEXT_INPUTS).forEach((k) => { DEFAULTS[k] = ui[k].value; });
  CHECK_INPUTS.forEach((k) => { DEFAULTS[k] = ui[k].checked; });
  function resetSettings() {
    RANGE_INPUTS.concat(TEXT_INPUTS).forEach((k) => { ui[k].value = DEFAULTS[k]; });
    CHECK_INPUTS.forEach((k) => { ui[k].checked = DEFAULTS[k]; });
  }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(pk("wakeguard")) || "{}");
      RANGE_INPUTS.concat(TEXT_INPUTS).forEach((k) => { if (s[k] !== undefined && s[k] !== "") ui[k].value = s[k]; });
      CHECK_INPUTS.forEach((k) => { if (typeof s[k] === "boolean") ui[k].checked = s[k]; });
    } catch (e) { /* storage unavailable: use defaults */ }
  }
  function saveSettings() {
    try {
      const s = {};
      RANGE_INPUTS.concat(TEXT_INPUTS).forEach((k) => { s[k] = ui[k].value; });
      CHECK_INPUTS.forEach((k) => { s[k] = ui[k].checked; });
      localStorage.setItem(pk("wakeguard"), JSON.stringify(s));
    } catch (e) { /* ignore */ }
  }
  let lastBreakEvery = null;
  let lastUiLang = "en";
  function syncSettingsUI() {
    ui.closeSecOut.textContent = num(ui.closeSec).toFixed(1) + " s";
    ui.thrOut.textContent = num(ui.thr).toFixed(2);
    ui.yawnThrOut.textContent = num(ui.yawnThr).toFixed(2);
    ui.nodDegOut.textContent = num(ui.nodDeg) + "°";
    ui.turnDegOut.textContent = num(ui.turnDeg) + "°";
    ui.turnSecOut.textContent = num(ui.turnSec).toFixed(1) + " s";
    ui.volOut.textContent = Math.round(num(ui.vol) * 100) + "%";
    ui.thrMark.style.left = Math.min(100, (num(ui.thr) / 0.4) * 100) + "%";
    applyLevel();
    applyTheme();
    applyLook();
    if (ui.uiLang.value !== lastUiLang) { lastUiLang = ui.uiLang.value; applyI18n(); refreshDynamic(); }
    updateLangNote();
    syncVoiceCmd();
    if (ui.breakEvery.value !== lastBreakEvery) {          // interval changed: count the next break from now
      lastBreakEvery = ui.breakEvery.value;
      if (state.running && state.session) scheduleBreak(nowSec() - state.session.startPerf);
    }
    saveSettings();
    drawCharts();
    drawInsightCharts();
  }
  RANGE_INPUTS.concat(TEXT_INPUTS, CHECK_INPUTS).forEach((k) => {
    ui[k].addEventListener("input", syncSettingsUI);
    ui[k].addEventListener("change", syncSettingsUI);
  });

  /* ---------- night mode ---------- */
  function applyTheme() {
    const hour = new Date().getHours();
    const night = ui.theme.value === "night" || (ui.theme.value === "auto" && (hour >= 19 || hour < 6));
    document.body.classList.toggle("night", night);
    refreshEyeCols();
  }
  // Text size and colour-blind palette
  let eyeCols = { ok: "#3ddc97", bad: "#ff4d4d" };
  function refreshEyeCols() { const c = chartColors(); eyeCols = { ok: c.ear, bad: c.alarm }; }
  function applyLook() {
    document.body.classList.toggle("cb", ui.palette.value === "cb");
    const scale = { normal: 1, large: 1.18, xlarge: 1.38 }[ui.textSize.value] || 1;
    document.documentElement.style.setProperty("--ts", String(scale));
    refreshEyeCols();
  }
  setInterval(applyTheme, 60000);

  /* ---------- alarm sounds ---------- */
  const siren = { ctx: null, osc: null, gain: null, timer: null, vibTimer: null, voiceTimer: null, active: false };

  // Slider volume, rising towards the device maximum while the alarm goes unanswered
  function effVol() {
    const b = num(ui.vol);
    return ui.escalate.checked ? Math.min(1, b + (1 - b) * (state.escLevel / 3)) : b;
  }
  // Applies the volume slider to whatever is playing. Quieter while the voice is speaking.
  function applyLevel() {
    const v = effVol() * (state.ducked ? 0.25 : 1);
    if (siren.gain) siren.gain.gain.value = v;
    alarmFile.volume = Math.min(1, v);
  }

  function ensureAudio() {
    if (!siren.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      siren.ctx = new AC();
    }
    if (siren.ctx.state === "suspended") siren.ctx.resume();
  }

  // Built-in tones. Drowsiness: harsh two-tone siren. Distraction: softer, lower two-note chime.
  function startSynth(kind) {
    if (siren.osc) return;
    ensureAudio();
    const distract = kind === "distract";
    const low = distract ? 392 : 880, high = distract ? 587 : 1320, step = distract ? 450 : 280;
    siren.gain = siren.ctx.createGain();
    siren.osc = siren.ctx.createOscillator();
    siren.osc.type = distract ? "triangle" : "square";
    siren.osc.frequency.value = low;
    siren.osc.connect(siren.gain).connect(siren.ctx.destination);
    applyLevel();
    siren.osc.start();
    let up = false;
    siren.timer = setInterval(() => {
      up = !up;
      siren.osc.frequency.setValueAtTime(up ? high : low, siren.ctx.currentTime);
    }, step);
  }

  function stopSynth() {
    clearInterval(siren.timer); siren.timer = null;
    if (siren.osc) { try { siren.osc.stop(); } catch (e) {} siren.osc.disconnect(); siren.osc = null; }
    siren.gain = null;
  }

  /* ---------- spoken alerts in English, Hindi or Bengali ---------- */
  const PHRASES = {
    en: { name: "English", code: "en-IN",
      drowsy: "Wake up! Wake up! Please pull over.",
      distract: "Eyes on the road! Eyes on the road!",
      rest: "Time for a break. Please pull over somewhere safe and rest." },
    hi: { name: "Hindi", code: "hi-IN",
      drowsy: "जागिए! जागिए! कृपया गाड़ी रोकिए।",
      distract: "सड़क पर ध्यान दीजिए! सड़क पर ध्यान दीजिए!",
      rest: "आराम करने का समय हो गया है। कृपया सुरक्षित जगह गाड़ी रोककर आराम कीजिए।" },
    bn: { name: "Bengali", code: "bn-IN",
      drowsy: "জেগে উঠুন! জেগে উঠুন! দয়া করে গাড়ি থামান।",
      distract: "রাস্তার দিকে তাকান! রাস্তার দিকে তাকান!",
      rest: "বিশ্রামের সময় হয়েছে। দয়া করে নিরাপদ জায়গায় গাড়ি থামিয়ে বিশ্রাম নিন।" }
  };
  let voices = [];
  function loadVoices() { if ("speechSynthesis" in window) voices = speechSynthesis.getVoices(); }
  if ("speechSynthesis" in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = () => { loadVoices(); updateLangNote(); };   // browsers load voices a moment after the page
  }
  const normLang = (l) => String(l || "").replace("_", "-").toLowerCase();
  function findVoice(code) {
    const want = normLang(code), prefix = want.slice(0, 2);
    return voices.find((v) => normLang(v.lang) === want) || voices.find((v) => normLang(v.lang).startsWith(prefix)) || null;
  }
  const currentLang = () => (PHRASES[ui.lang.value] ? ui.lang.value : "en");

  // The chosen language if this device has a voice for it. Otherwise English, so the driver still hears a warning.
  function speechPlan(kind) {
    let key = currentLang();
    let voice = findVoice(PHRASES[key].code);
    if (!voice && key !== "en") { key = "en"; voice = findVoice(PHRASES.en.code); }
    return { key: key, voice: voice, text: PHRASES[key][kind] };
  }

  function updateLangNote() {
    const key = currentLang();
    if (key === "en" || !("speechSynthesis" in window)) { ui.langNote.textContent = ""; return; }
    const nm = t(PHRASES[key].name);
    ui.langNote.textContent = findVoice(PHRASES[key].code) ? "" :
      t("No {lang} voice was found on this device, so alerts are spoken in English. Add a {lang} voice in your device's speech settings, then reload this page.", { lang: nm });
  }

  function speakText(kind, duck) {
    if (!ui.voice.checked || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const plan = speechPlan(kind);
    const u = new SpeechSynthesisUtterance(plan.text);
    u.lang = PHRASES[plan.key].code;
    if (plan.voice) u.voice = plan.voice;
    u.volume = effVol();
    u.rate = plan.key === "en" ? 1.1 : 1;
    if (duck) {
      u.onstart = () => { state.ducked = true; applyLevel(); };
      u.onend = () => { state.ducked = false; applyLevel(); };
    }
    speechSynthesis.speak(u);
  }
  const speakAlert = (kind) => speakText(kind, true);

  ui.voiceTestBtn.addEventListener("click", () => {
    if (!ui.voice.checked) ui.voice.checked = true;      // testing the voice means you want it on
    speakText("drowsy", false);
  });

  // A short, soft beep used as an early warning before the loud alarm
  function beep() {
    if (state.alarming || !siren.ctx) return;
    ensureAudio();
    const o = siren.ctx.createOscillator(), g = siren.ctx.createGain();
    o.type = "sine";
    o.frequency.value = 660;
    g.gain.value = num(ui.vol) * 0.4;
    o.connect(g).connect(siren.ctx.destination);
    o.start();
    o.stop(siren.ctx.currentTime + 0.25);
  }

  function startSound(kind) {
    if (siren.active) return;
    siren.active = true;
    kind = kind || "drowsy";
    if (kind === "drowsy" && useFile()) {
      alarmFile.currentTime = 0;
      applyLevel();
      // If the browser refuses to play the file, fall back to the built-in siren
      alarmFile.play().catch(() => { if (siren.active) startSynth(kind); });
    } else {
      startSynth(kind);
    }
    speakAlert(kind);
    siren.voiceTimer = setInterval(() => speakAlert(kind), kind === "distract" ? 4000 : 6000);
    if (ui.vibrate.checked && navigator.vibrate) {
      const pattern = kind === "distract" ? [200, 120, 200] : [400, 150, 400, 150, 400];
      navigator.vibrate(pattern);
      siren.vibTimer = setInterval(() => navigator.vibrate(pattern), 1500);
    }
  }

  function stopSound() {
    siren.active = false;
    clearInterval(siren.vibTimer); clearInterval(siren.voiceTimer);
    siren.vibTimer = siren.voiceTimer = null;
    state.ducked = false;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    alarmFile.pause();
    alarmFile.currentTime = 0;
    stopSynth();
    if (navigator.vibrate) navigator.vibrate(0);
  }

  // Browsers only allow sound after a click, so unlock the audio during the Start click
  function unlockAudio() {
    ensureAudio();
    const was = alarmFile.volume;
    alarmFile.volume = 0;
    alarmFile.play().then(() => { alarmFile.pause(); alarmFile.currentTime = 0; alarmFile.volume = was; })
      .catch(() => { alarmFile.volume = was; });
  }

  // Soft early warning: one short beep, then the loud alarm only if the problem continues
  function earlyWarning(detail) {
    if (!ui.earlyBeep.checked || state.alarming) return;
    const now = nowSec();
    if (now - state.lastEarlyBeepAt < EARLY_COOLDOWN_SEC) return;
    state.lastEarlyBeepAt = now;
    beep();
    const s = state.session;
    if (s) {
      s.warnings++;
      logEvent("warning", detail);
      drawCharts();
    }
  }

  /* ---------- alarm state ---------- */
  function setAlarm(on, reason, kind) {
    kind = kind || "drowsy";
    if (on && state.alarming) {
      // A drowsiness alarm takes over from a distraction alarm
      if (kind === "drowsy" && state.alarmKind === "distract") { endAlarm(); beginAlarm(reason, kind); }
      return;
    }
    if (on === state.alarming) return;
    if (on) beginAlarm(reason, kind); else endAlarm();
  }

  function beginAlarm(reason, kind) {
    state.alarming = true;
    state.alarmKind = kind;
    document.body.classList.add("alarm");
    document.body.classList.toggle("distract", kind === "distract");
    ui.silenceBtn.hidden = false;
    ui.wakeText.hidden = false;
    ui.wakeText.textContent = kind === "distract" ? t("EYES ON THE ROAD!") : t("WAKE UP!");
    state.alarmStartAt = nowSec(); state.escLevel = 0;
    clearInterval(state.escTimer);
    state.escTimer = setInterval(tickEscalation, 1000);
    ui.wakeText.classList.toggle("distract", kind === "distract");

    const s = state.session;
    if (s) {
      if (kind === "distract") s.distractions++;
      else { s.alerts++; cellFor(s).alarms++; }
      s.activeAlarm = logEvent(kind === "distract" ? "distraction" : "alarm", reason || "eyes closed");
      updateSessionStats();
      drawCharts();
    }
    startSound(kind);
    if (kind === "drowsy") {
      state.alarmTimes.push(nowSec());
      maybeSuggestBreak();
    }
  }

  // Escalating alarm: every ESC_STEP_SEC without a response the sound gets louder; after two steps a break window opens
  function tickEscalation() {
    if (!state.alarming || !ui.escalate.checked) return;
    const el = nowSec() - state.alarmStartAt;
    const lvl = Math.min(3, Math.floor(el / ESC_STEP_SEC));
    if (lvl === state.escLevel) return;
    state.escLevel = lvl;
    applyLevel();
    if (lvl >= 2 && ui.breakDialog.hidden) {
      showBreakDialog(t("Please pull over"),
        t("The alarm has been sounding for {n} seconds. Stop somewhere safe and rest before you drive on.", { n: Math.round(el) }), false);
    }
  }

  function endAlarm() {
    clearInterval(state.escTimer); state.escTimer = null; state.escLevel = 0;
    state.alarming = false;
    state.alarmKind = null;
    document.body.classList.remove("alarm", "distract");
    ui.silenceBtn.hidden = true;
    ui.wakeText.hidden = true;
    const s = state.session;
    if (s && s.activeAlarm) {
      s.activeAlarm.duration = round1(nowSec() - s.startPerf - s.activeAlarm.t);
      s.activeAlarm = null;
    }
    stopSound();
  }

  function silenceAlarm() {
    setAlarm(false);
    const now = nowSec();
    state.silencedUntil = now + 5;     // short grace period so the alarm does not instantly re-fire
    state.closedSince = null; state.nodSince = null; state.awaySince = null;
    state.lastFaceAt = now;
  }

  function checkAlarmClear(now) {
    if (!state.alarming) return;
    if (state.alarmKind === "distract") {
      if (state.forwardSince !== null && now - state.forwardSince >= AWAY_CLEAR_SEC) setAlarm(false);
    } else if (
      state.openSince !== null && now - state.openSince >= WAKE_CLEAR_SEC &&
      state.headUpSince !== null && now - state.headUpSince >= WAKE_CLEAR_SEC
    ) {
      setAlarm(false);
    }
  }

  /* ---------- "take a break" message after repeated alarms ---------- */
  function maybeSuggestBreak() {
    const now = nowSec();
    state.alarmTimes = state.alarmTimes.filter((t) => now - t <= BREAK_WINDOW_SEC);
    const limit = Math.max(2, Math.round(num(ui.breakAfter)) || 3);
    if (state.alarmTimes.length >= limit) {
      showBreak(state.alarmTimes.length);
      state.alarmTimes = [];
    }
  }

  function showBreak(count) {
    showBreakDialog(t("Time to take a break"),
      t("You have triggered {n} drowsiness alarms in the last 10 minutes. Pull over somewhere safe and rest before driving on. Do not use your phone while driving.", { n: count }), false);
  }

  // Shared "take a break" window: used after repeated alarms and by the driving-time reminder
  function showBreakDialog(title, text, canSnooze) {
    ui.breakTitle.textContent = title;
    ui.breakText.textContent = text;
    ui.breakSnooze.hidden = !canSnooze;
    const name = ui.contactName.value.trim();
    const phone = ui.contactPhone.value.replace(/[^\d+]/g, "");
    const hasPhone = phone.length >= 5;
    ui.breakCall.hidden = !hasPhone;
    ui.breakHint.hidden = hasPhone;
    if (hasPhone) {
      ui.breakCall.href = "tel:" + phone;
      ui.breakCall.textContent = t("Call {name} (when safely stopped)", { name: name || t("my contact") });
    }
    ui.breakDialog.hidden = false;
    ui.breakClose.focus();
  }

  ui.breakClose.addEventListener("click", () => {
    ui.breakDialog.hidden = true;
    if (state.alarming) silenceAlarm();
  });
  ui.breakSnooze.addEventListener("click", () => {
    ui.breakDialog.hidden = true;
    if (state.session) scheduleBreak(nowSec() - state.session.startPerf, BREAK_SNOOZE_MIN * 60);
    if (state.alarming) silenceAlarm();
  });

  /* ---------- driving timer: a break reminder every few hours, even if you feel fine ---------- */
  const breakIntervalSec = () => Math.max(0, Number(ui.breakEvery.value) || 0) * 60;
  function scheduleBreak(driveSec, afterSec) {
    const wait = afterSec || breakIntervalSec();
    state.nextBreakAt = wait > 0 ? driveSec + wait : null;
  }
  function fmtClock(sec) {          // 7:05 under an hour, 1:07:05 above
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ":" + pad2(m) + ":" + pad2(s) : m + ":" + pad2(s);
  }
  function fmtLong(sec) {           // "2 hours 5 minutes"
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    const parts = [];
    if (h) parts.push(t(h === 1 ? "{n} hour" : "{n} hours", { n: h }));
    if (m || !h) parts.push(t(m === 1 ? "{n} minute" : "{n} minutes", { n: m }));
    return parts.join(" ");
  }
  function tickDrive() {
    const s = state.session;
    if (!s || !state.running) return;
    const el = nowSec() - s.startPerf;
    ui.driveTimeVal.textContent = fmtClock(el);
    if (state.nextBreakAt === null) { ui.nextBreakVal.textContent = t("Off"); return; }
    const left = state.nextBreakAt - el;
    ui.nextBreakVal.textContent = left > 0 ? fmtClock(left) : t("now");
    if (left <= 0 && ui.breakDialog.hidden && !state.alarming) {
      scheduleBreak(el);                        // the next reminder counts from now
      showBreakDialog(t("Break time"),
        t("You have been driving for about {time}. Take a break of 15 to 20 minutes even if you feel fine: stop somewhere safe, walk around and drink some water.", { time: fmtLong(el) }), true);
      speakText("rest", false);
      beep(); setTimeout(beep, 350);
    }
  }

  /* ---------- session data ---------- */
  function newSession() {
    return {
      startedAt: new Date(), startPerf: nowSec(), samples: [], events: [],
      alerts: 0, distractions: 0, yawns: 0, nods: 0, warnings: 0, blinks: 0,
      longestClosure: 0, peakFatigue: 0, peakAt: 0, earSum: 0, earN: 0,
      cells: {},                     // seconds monitored, tired seconds and alarms for each weekday-and-hour slot
      blinkMs: 0, slowBlinks: 0, blinkBins: {}, escalations: 0, pre: state.pre,
      activeAlarm: null, saved: false, endPerf: null
    };
  }

  // The weekday-and-hour slot for "now" (key = weekday * 24 + hour). Feeds the time-of-day heatmap.
  function cellFor(s) {
    const d = new Date();
    const k = d.getDay() * 24 + d.getHours();
    return s.cells[k] || (s.cells[k] = { sec: 0, tired: 0, alarms: 0 });
  }

  function logEvent(type, detail) {
    const s = state.session;
    if (!s) return null;
    const ev = { t: round1(nowSec() - s.startPerf), type: type, detail: detail, duration: null };
    s.events.push(ev);
    return ev;
  }

  function fatigueScore(now) {
    state.yawnTimes = state.yawnTimes.filter((t) => now - t <= 300);   // yawns in the last 5 minutes
    state.nodTimes = state.nodTimes.filter((t) => now - t <= 120);     // nods in the last 2 minutes
    const n = state.history.length;
    const closedPct = n ? (state.history.filter((h) => h.closed).length / n) * 100 : 0;
    const score = Math.min(50, closedPct * 2.5) + Math.min(30, state.yawnTimes.length * 15) + Math.min(20, state.nodTimes.length * 10);
    return Math.min(100, Math.round(score));
  }

  function updateFatigueUI(score) {
    const stage = score >= FATIGUE_VERY ? 2 : score >= FATIGUE_TIRED ? 1 : 0;
    const label = ["Alert", "Tired", "Very tired"][stage];
    const color = ["var(--ok)", "var(--warn)", "var(--danger)"][stage];
    state.lastFatigue = score;
    ui.fatigueVal.textContent = score;
    ui.fatigueLabel.textContent = t(label);
    ui.fatigueBar.style.width = score + "%";
    ui.fatigueBar.style.background = color;
    ui.hudBar.style.width = score + "%";
    ui.hudBar.style.background = color;
    ui.hudScore.textContent = t("Fatigue") + " " + score + " · " + t(label);
    return stage;
  }

  function sampleSession(e, mar, closed, tilt, turn, now) {
    const s = state.session;
    if (!s) return;
    s.earSum += e; s.earN++;
    if (now - state.lastSampleAt < 1) return;      // one sample per second
    state.lastSampleAt = now;

    const f = fatigueScore(now);
    if (f > s.peakFatigue) { s.peakFatigue = f; s.peakAt = round1(now - s.startPerf); }   // when the drowsiest moment happened
    const cell = cellFor(s);
    cell.sec++;
    if (f >= FATIGUE_TIRED) cell.tired++;
    s.samples.push({ t: round1(now - s.startPerf), ear: round3(e), mar: round3(mar), closed: closed, tilt: round1(tilt), turn: round1(turn), fatigue: f });
    if (s.samples.length > MAX_SAMPLES) s.samples.shift();

    // Early warning when tiredness is building, before any loud alarm
    const stage = updateFatigueUI(f);
    if (!state.alarming) {
      if (stage > state.fatigueStage) {
        earlyWarning(stage === 2 ? "fatigue very high" : "fatigue rising");
      } else if (stage === 2 && now - state.stage2BeepAt > 30) {
        state.stage2BeepAt = now;
        earlyWarning("fatigue still very high");
      }
    }
    state.fatigueStage = stage;

    updateSessionStats();
    drawCharts();
  }

  function updateSessionStats() {
    const s = state.session;
    ui.yawnVal.textContent = s ? s.yawns : 0;
    ui.nodVal.textContent = s ? s.nods : 0;
    ui.distractVal.textContent = s ? s.distractions : 0;
    ui.alertVal.textContent = s ? s.alerts : 0;
    ui.longestVal.textContent = (s ? s.longestClosure : 0).toFixed(1) + " s";
    ui.csvSession.disabled = !(s && (s.samples.length || s.events.length));
  }

  // Safe driving score, 0 to 100: starts at 100, points come off for each kind of warning sign
  function computeScore(sm) {
    const pen = Math.min(40, (sm.alerts || 0) * 10) + Math.min(15, (sm.distractions || 0) * 3) + Math.min(12, (sm.nods || 0) * 3) +
      Math.min(10, (sm.yawns || 0) * 2) + Math.min(23, Math.max(0, (sm.peakFatigue || 0) - 20) * 0.35);
    return Math.max(0, Math.round(100 - pen));
  }
  const scoreOf = (sm) => (typeof sm.score === "number" ? sm.score : computeScore(sm));
  const scoreWord = (n) => (n >= 85 ? "Excellent" : n >= 70 ? "Good" : n >= 50 ? "Fair" : "Needs rest");
  const scoreLevel = (n) => (n >= 70 ? "ok" : n >= 50 ? "warn" : "danger");
  function calmStreak(list) {                  // trips in a row, latest first, with no drowsiness alarm
    let n = 0;
    for (let i = list.length - 1; i >= 0 && (list[i].alerts || 0) === 0; i--) n++;
    return n;
  }

  function summarise(s, durationSec) {
    const sm = {
      started: s.startedAt.toISOString(),
      duration: Math.round(durationSec),
      alerts: s.alerts,
      distractions: s.distractions,
      yawns: s.yawns,
      nods: s.nods,
      warnings: s.warnings,
      peakFatigue: s.peakFatigue,
      peakAt: s.peakAt,
      cells: s.cells,
      longest: round1(s.longestClosure),
      blinksPerMin: round1(durationSec > 0 ? s.blinks / (durationSec / 60) : 0),
      avgEar: round3(s.earN ? s.earSum / s.earN : 0),
      avgBlinkMs: s.blinks ? Math.round(s.blinkMs / s.blinks) : 0,
      slowBlinks: s.slowBlinks,
      escalations: s.escalations,
      driver: activeName(),
      pre: s.pre || null
    };
    sm.score = computeScore(sm);
    return sm;
  }

  function finishSession() {
    const s = state.session;
    if (!s || s.saved) return;
    s.saved = true;
    s.endPerf = nowSec();
    const dur = s.endPerf - s.startPerf;
    saveSessionAlarms(s);
    let summary = null;
    if (dur >= 10 && s.earN > 0) {
      summary = summarise(s, dur);
      const list = loadHistory();
      list.push(summary);
      saveHistory(list.slice(-50));
    }
    renderHistory();
    updateSessionStats();
    if (summary) showTrip(summary, s.samples.map((p) => p.fatigue));   // trip report after Stop
  }

  /* ---------- saved history (browser storage) ---------- */
  function loadHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(pk(HISTORY_KEY)) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(pk(HISTORY_KEY), JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  function renderHistory() {
    const list = loadHistory();
    ui.historyBody.textContent = "";
    list.slice(-5).reverse().forEach((r) => {
      const tr = document.createElement("tr");
      const when = new Date(r.started);
      const cells = [
        isNaN(when) ? "" : when.toLocaleString([], { dateStyle: "short", timeStyle: "short" }),
        fmtTime(r.duration),
        r.alerts || 0,
        r.distractions || 0,
        r.yawns || 0,
        r.nods || 0,
        r.peakFatigue || 0,
        Number(r.longest || 0).toFixed(1) + " s",
        Number(r.blinksPerMin || 0).toFixed(1),
        scoreOf(r)
      ];
      cells.forEach((v) => {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      });
      ui.historyBody.appendChild(tr);
    });
    ui.historyEmpty.hidden = list.length > 0;
    ui.csvAll.disabled = ui.clearAll.disabled = list.length === 0;
    ui.tripBtn.disabled = list.length === 0;
    renderInsights();
  }

  /* ---------- CSV export ---------- */
  const csvText = (v) => '"' + String(v).replace(/"/g, '""') + '"';

  function downloadCsv(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stamp(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  // One row per second ("sample") plus one row per alarm, distraction, yawn, nod or early warning, sorted by time
  function sessionCsv(s) {
    const rows = [];
    s.samples.forEach((p) => rows.push({ t: p.t, line: ["sample", p.t, p.ear, p.mar, p.closed ? 1 : 0, p.tilt, p.turn, p.fatigue, ""].join(",") }));
    s.events.forEach((ev) => {
      const isAlarm = ev.type === "alarm" || ev.type === "distraction";
      const detail = ev.detail + (isAlarm && ev.duration !== null ? "; lasted " + ev.duration + " s" : "");
      rows.push({ t: ev.t, line: [ev.type, ev.t, "", "", "", "", "", "", csvText(detail)].join(",") });
    });
    rows.sort((a, b) => a.t - b.t);
    const head = "record,time_s,eye_openness,mouth_openness,eyes_closed,head_tilt_deg,head_turn_deg,fatigue_score,detail";
    return [head].concat(rows.map((r) => r.line)).join("\n");
  }

  function historyCsv(list) {
    const head = "started,duration_s,alarms,distractions,yawns,nods,early_warnings,peak_fatigue,longest_closure_s,blinks_per_min,avg_eye_openness,safe_score,avg_blink_ms,slow_blinks,driver";
    return [head].concat(list.map((r) => [
      r.started, r.duration, r.alerts || 0, r.distractions || 0, r.yawns || 0, r.nods || 0, r.warnings || 0,
      r.peakFatigue || 0, r.longest || 0, r.blinksPerMin || 0, r.avgEar || 0, scoreOf(r), r.avgBlinkMs || 0, r.slowBlinks || 0, csvText(r.driver || "")
    ].join(","))).join("\n");
  }

  ui.csvSession.addEventListener("click", () => {
    const s = state.session;
    if (s) downloadCsv("wakeguard-session-" + stamp(s.startedAt) + ".csv", sessionCsv(s));
  });
  ui.csvAll.addEventListener("click", () => {
    downloadCsv("wakeguard-all-sessions-" + stamp(new Date()) + ".csv", historyCsv(loadHistory()));
  });
  ui.clearAll.addEventListener("click", () => {
    if (!window.confirm(t("Delete all saved sessions from this browser?"))) return;
    try { localStorage.removeItem(pk(HISTORY_KEY)); } catch (e) { /* ignore */ }
    renderHistory();
  });

  /* ---------- charts (plain canvas, no library) ---------- */
  function chartColors() {
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
      grid: v("--line", "#27313a"), text: v("--muted", "#8a9aa3"), ear: v("--ok", "#3ddc97"),
      thr: v("--warn", "#ffb020"), alarm: v("--danger", "#ff4d4d"), yawn: v("--info", "#6cb8ff"),
      distract: v("--distract", "#b48cff"), early: v("--early", "#ffd27a"), fatigue: v("--fatigue", "#f0a35c")
    };
  }

  function eventStyle(ev, col) {
    if (ev.type === "alarm") return { color: col.alarm, width: 2, dash: [] };
    if (ev.type === "distraction") return { color: col.distract, width: 2, dash: [] };
    if (ev.type === "yawn") return { color: col.yawn, width: 1, dash: [3, 3] };
    return { color: col.early, width: 1, dash: [3, 3] };       // nod and early warning
  }

  function drawLineChart(c, cfg) {
    const col = chartColors();
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;                                       // hidden (for example in drive mode)
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = "11px 'IBM Plex Mono', monospace";

    const pad = { l: 36, r: 8, t: 8, b: 22 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const Y = (v) => pad.t + (1 - Math.min(Math.max(v, 0), cfg.yMax) / cfg.yMax) * ph;

    // horizontal grid and y labels
    g.lineWidth = 1;
    g.strokeStyle = col.grid;
    g.fillStyle = col.text;
    g.textAlign = "right";
    g.textBaseline = "middle";
    cfg.ticks.forEach((v) => {
      g.beginPath();
      g.moveTo(pad.l, Y(v));
      g.lineTo(w - pad.r, Y(v));
      g.stroke();
      g.fillText(cfg.fmt(v), pad.l - 6, Y(v));
    });

    const s = state.session;
    const S = s ? s.samples : [];
    if (S.length < 2) {
      g.textAlign = "center";
      g.fillText(t("Fills in once per second after you press Start."), pad.l + pw / 2, pad.t + ph / 2);
      return;
    }

    const t0 = S[0].t;
    const t1 = Math.max(t0 + 60, S[S.length - 1].t);
    const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * pw;

    // time labels
    g.textAlign = "center";
    g.textBaseline = "top";
    g.fillStyle = col.text;
    for (let i = 0; i <= 5; i++) {
      const t = t0 + ((t1 - t0) * i) / 5;
      g.fillText(fmtTime(t), X(t), h - pad.b + 6);
    }

    // reference lines (thresholds)
    g.setLineDash([5, 4]);
    cfg.refs(col).forEach((r) => {
      g.strokeStyle = r.color;
      g.beginPath();
      g.moveTo(pad.l, Y(r.v));
      g.lineTo(w - pad.r, Y(r.v));
      g.stroke();
    });
    g.setLineDash([]);

    // event markers
    s.events.forEach((ev) => {
      if (ev.t < t0 || ev.t > t1) return;
      const st = eventStyle(ev, col);
      g.strokeStyle = st.color;
      g.lineWidth = st.width;
      g.setLineDash(st.dash);
      g.beginPath();
      g.moveTo(X(ev.t), pad.t);
      g.lineTo(X(ev.t), pad.t + ph);
      g.stroke();
    });
    g.setLineDash([]);

    // data line (broken where the face was not visible for a few seconds)
    g.strokeStyle = cfg.color(col);
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.beginPath();
    S.forEach((p, i) => {
      const y = Y(cfg.get(p));
      if (i === 0 || p.t - S[i - 1].t > 3) g.moveTo(X(p.t), y);
      else g.lineTo(X(p.t), y);
    });
    g.stroke();
  }

  function drawCharts() {
    drawLineChart(ui.chart, {
      yMax: 0.45, ticks: [0, 0.15, 0.3, 0.45], fmt: (v) => v.toFixed(2),
      get: (p) => p.ear, color: (c) => c.ear,
      refs: (c) => [{ v: num(ui.thr), color: c.thr }]
    });
    drawLineChart(ui.chart2, {
      yMax: 100, ticks: [0, 35, 60, 100], fmt: (v) => String(v),
      get: (p) => p.fatigue, color: (c) => c.fatigue,
      refs: (c) => [{ v: FATIGUE_TIRED, color: c.thr }, { v: FATIGUE_VERY, color: c.alarm }]
    });
    drawBlinkChart();
  }
  const drawInsightCharts = () => { drawTrends(); drawWeekly(); };
  window.addEventListener("resize", () => { drawCharts(); drawInsightCharts(); });

  // Shared canvas set-up for the extra charts. Returns null when the canvas is hidden.
  function setupCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return null;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = "11px 'IBM Plex Mono', monospace";
    return { g: g, w: w, h: h, col: chartColors() };
  }

  /* --- blink analysis: bars = blinks per minute, line = average blink length --- */
  function blinkSeries(s) {
    const tNow = s.samples.length ? s.samples[s.samples.length - 1].t : 0;
    const last = Math.floor(tNow / BLINK_BIN);
    const out = [];
    for (let i = 0; i <= last; i++) {
      const b = s.blinkBins[i] || { n: 0, ms: 0 };
      const span = i === last ? tNow - i * BLINK_BIN : BLINK_BIN;
      if (span < 10) { out.push({ i: i, rate: null, ms: null }); continue; }     // too little of this bar has happened yet
      out.push({ i: i, rate: (b.n * 60) / span, ms: b.n ? b.ms / b.n : null });
    }
    return out;
  }
  function drawBlinkChart() {
    const k = setupCanvas(ui.chart5);
    if (!k) return;
    const g = k.g, w = k.w, h = k.h, col = k.col;
    const pad = { l: 30, r: 38, t: 10, b: 24 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const RMAX = 40, MMAX = 600;
    g.lineWidth = 1; g.strokeStyle = col.grid; g.textBaseline = "middle";
    [0, 1 / 3, 2 / 3, 1].forEach((f) => {
      const y = pad.t + (1 - f) * ph;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
      g.textAlign = "right"; g.fillStyle = col.ear; g.fillText(String(Math.round(f * RMAX)), pad.l - 6, y);
      g.textAlign = "left"; g.fillStyle = col.fatigue; g.fillText(String(Math.round(f * MMAX)), w - pad.r + 6, y);
    });
    const s = state.session;
    const tNow = s && s.samples.length ? s.samples[s.samples.length - 1].t : 0;
    if (!s || tNow < 20) {
      ui.blinkNote.textContent = "";
      g.textAlign = "center"; g.fillStyle = col.text;
      g.fillText(t("Fills in after about 30 seconds of driving."), pad.l + pw / 2, pad.t + ph / 2);
      return;
    }
    const ser = blinkSeries(s);
    const n = ser.length, slot = pw / Math.max(n, 6), bw = Math.min(26, slot * 0.6);
    const cx = (i) => pad.l + (i + 0.5) * slot;
    g.globalAlpha = 0.75; g.fillStyle = col.ear;
    ser.forEach((b, i) => {
      if (b.rate === null) return;
      const v = Math.min(b.rate, RMAX), y = pad.t + (1 - v / RMAX) * ph;
      g.fillRect(cx(i) - bw / 2, y, bw, pad.t + ph - y);
    });
    g.globalAlpha = 1;
    g.setLineDash([5, 4]); g.strokeStyle = col.thr;
    const ySlow = pad.t + (1 - (SLOW_BLINK_SEC * 1000) / MMAX) * ph;
    g.beginPath(); g.moveTo(pad.l, ySlow); g.lineTo(w - pad.r, ySlow); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = col.fatigue; g.fillStyle = col.fatigue; g.lineWidth = 2; g.lineJoin = "round";
    g.beginPath();
    let pen = false;
    ser.forEach((b, i) => {
      if (b.ms === null) { pen = false; return; }
      const y = pad.t + (1 - Math.min(b.ms, MMAX) / MMAX) * ph;
      if (!pen) { g.moveTo(cx(i), y); pen = true; } else g.lineTo(cx(i), y);
    });
    g.stroke();
    ser.forEach((b, i) => { if (b.ms !== null) { g.beginPath(); g.arc(cx(i), pad.t + (1 - Math.min(b.ms, MMAX) / MMAX) * ph, 3, 0, 6.283); g.fill(); } });
    g.fillStyle = col.text; g.textAlign = "center"; g.textBaseline = "top";
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 48))));
    ser.forEach((b, i) => { if (i % every === 0) g.fillText(fmtTime(b.i * BLINK_BIN), cx(i), h - pad.b + 6); });

    const avg = s.blinks ? Math.round(s.blinkMs / s.blinks) : 0;
    ui.blinkNote.textContent = s.blinks
      ? t("{n} blinks so far, average length {ms} ms, {slow} slow (0.4 s or longer). Longer, slower blinks are a sign of tiredness. Resting adults blink about 12 to 20 times a minute.", { n: s.blinks, ms: avg, slow: s.slowBlinks })
      : t("No blinks counted yet.");
  }

  /* ---------- insights: trends, time-of-day heatmap, trip report, accuracy test ---------- */
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];                       // Monday first
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MIN_CELL_SEC = 30;      // a heatmap square needs this much monitored time before it is coloured
  const MIN_LABELLED = 20;      // marked alarms needed before the accuracy figures mean much

  const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : "");
  const pctText = (n, d) => (d > 0 ? Math.round((n / d) * 100) + "%" : "n/a");
  const hourName = (h) => (h % 12 || 12) + " " + t(h < 12 ? "am" : "pm");
  const reasonName = (r) => cap(t(String(r || "other").toLowerCase()));
  const LOCALES = { en: undefined, hi: "hi-IN", bn: "bn-IN" };
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fillStats(box, pairs) {
    box.textContent = "";
    pairs.forEach((p) => {
      const d = el("div", "read");
      d.appendChild(el("b", "", String(p[0])));
      d.appendChild(el("span", "", p[1]));
      box.appendChild(d);
    });
  }

  function loadAlarms() {
    try {
      const list = JSON.parse(localStorage.getItem(pk(ALARM_KEY)) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveAlarms(list) {
    try { localStorage.setItem(pk(ALARM_KEY), JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  // Keep every alarm from the session so it can be marked real or false afterwards
  function saveSessionAlarms(s) {
    const found = s.events.filter((ev) => ev.type === "alarm" || ev.type === "distraction");
    if (!found.length) return;
    const list = loadAlarms();
    found.forEach((ev, i) => list.push({
      id: s.startedAt.getTime() + "-" + i,
      at: new Date(s.startedAt.getTime() + ev.t * 1000).toISOString(),
      kind: ev.type === "distraction" ? "distract" : "drowsy",
      reason: ev.detail,
      duration: ev.duration,
      label: null
    }));
    saveAlarms(list.slice(-300));
  }

  function renderInsights() {
    drawInsightCharts();
    renderHeatmap();
    renderAccuracy();
  }

  /* --- trends across sessions: bars = drowsiness alarms, line = peak fatigue --- */
  function drawTrends() {
    const c = ui.chart3;
    const list = loadHistory().slice(-15);
    const col = chartColors();
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = "11px 'IBM Plex Mono', monospace";

    const pad = { l: 30, r: 34, t: 10, b: 24 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const maxA = Math.max(4, Math.ceil(Math.max.apply(null, list.map((r) => r.alerts || 0)) / 2) * 2);
    const YA = (v) => pad.t + (1 - v / maxA) * ph;
    const YF = (v) => pad.t + (1 - Math.min(v, 100) / 100) * ph;

    g.lineWidth = 1;
    g.strokeStyle = col.grid;
    g.textBaseline = "middle";
    [0, 0.5, 1].forEach((f) => {
      const y = pad.t + (1 - f) * ph;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
      g.textAlign = "right"; g.fillStyle = col.alarm;
      g.fillText(String(Math.round(f * maxA)), pad.l - 6, y);
      g.textAlign = "left"; g.fillStyle = col.fatigue;
      g.fillText(String(Math.round(f * 100)), w - pad.r + 6, y);
    });

    ui.trendNote.textContent = "";
    if (!list.length) {
      g.textAlign = "center"; g.fillStyle = col.text;
      g.fillText(t("Your sessions appear here after you press Stop."), pad.l + pw / 2, pad.t + ph / 2);
      return;
    }

    const n = list.length, slot = pw / n, bw = Math.min(30, slot * 0.5);
    const cx = (i) => pad.l + (i + 0.5) * slot;

    g.globalAlpha = 0.75;
    g.fillStyle = col.alarm;
    list.forEach((r, i) => {
      const a = r.alerts || 0;
      if (a > 0) g.fillRect(cx(i) - bw / 2, YA(a), bw, YA(0) - YA(a));
    });
    g.globalAlpha = 1;

    g.strokeStyle = col.fatigue; g.lineWidth = 2; g.lineJoin = "round";
    g.beginPath();
    list.forEach((r, i) => { if (i === 0) g.moveTo(cx(i), YF(r.peakFatigue || 0)); else g.lineTo(cx(i), YF(r.peakFatigue || 0)); });
    g.stroke();
    g.fillStyle = col.fatigue;
    list.forEach((r, i) => { g.beginPath(); g.arc(cx(i), YF(r.peakFatigue || 0), 3.5, 0, 6.283); g.fill(); });

    g.fillStyle = col.text; g.textAlign = "center"; g.textBaseline = "top";
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 56))));
    list.forEach((r, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      const d = new Date(r.started);
      g.fillText(isNaN(d) ? "" : d.toLocaleDateString(LOCALES[uiLang()], { day: "numeric", month: "short" }), cx(i), h - pad.b + 6);
    });

    const avgA = list.reduce((a, r) => a + (r.alerts || 0), 0) / n;
    const avgP = list.reduce((a, r) => a + (r.peakFatigue || 0), 0) / n;
    ui.trendNote.textContent = t("Sessions shown: {n}. On average {a} drowsiness alarms and a peak fatigue score of {p} per session.",
      { n: n, a: avgA.toFixed(1), p: Math.round(avgP) });
  }

  /* --- weekly summary: minutes driven per day (bars) and average safe driving score (line) --- */
  function drawWeekly() {
    const list = loadHistory();
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); days.push({ d: d, min: 0, n: 0, sc: 0, al: 0 }); }
    const start = days[0].d.getTime(), end = start + 7 * 86400000;
    const prevStart = start - 7 * 86400000;
    let pSum = 0, pN = 0;
    list.forEach((r) => {
      const at = new Date(r.started).getTime();
      if (isNaN(at)) return;
      if (at >= prevStart && at < start) { pSum += scoreOf(r); pN++; }
      if (at < start || at >= end) return;
      const day = days[Math.min(6, Math.floor((at - start) / 86400000))];
      day.min += (r.duration || 0) / 60; day.n++; day.sc += scoreOf(r); day.al += r.alerts || 0;
    });
    const trips = days.reduce((a, d) => a + d.n, 0);
    const mins = days.reduce((a, d) => a + d.min, 0);
    const alarms = days.reduce((a, d) => a + d.al, 0);
    const avg = trips ? Math.round(days.reduce((a, d) => a + d.sc, 0) / trips) : null;
    fillStats(ui.weeklyStats, [
      [trips, t("Trips this week")],
      [mins >= 60 ? (mins / 60).toFixed(1) + " h" : Math.round(mins) + " min", t("Time driven")],
      [alarms, t("Drowsiness alarms")],
      [avg === null ? "--" : avg, t("Average score")],
      [calmStreak(list), t("Calm drives in a row")]
    ]);
    if (avg === null) ui.weeklyNote.textContent = t("No trips in the last 7 days yet.");
    else if (pN) {
      const diff = avg - Math.round(pSum / pN);
      ui.weeklyNote.textContent = diff === 0 ? t("Your average score is the same as last week.")
        : t(diff > 0 ? "Your average score is {n} points higher than last week." : "Your average score is {n} points lower than last week.", { n: Math.abs(diff) });
    } else ui.weeklyNote.textContent = t("A calm drive is one with no drowsiness alarm. Keep the streak going.");

    const k = setupCanvas(ui.chart4);
    if (!k) return;
    const g = k.g, w = k.w, h = k.h, col = k.col;
    const pad = { l: 34, r: 34, t: 10, b: 24 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const maxM = Math.max(60, Math.ceil(Math.max.apply(null, days.map((d) => d.min)) / 60) * 60);
    g.lineWidth = 1; g.strokeStyle = col.grid; g.textBaseline = "middle";
    [0, 0.5, 1].forEach((f) => {
      const y = pad.t + (1 - f) * ph;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
      g.textAlign = "right"; g.fillStyle = col.ear; g.fillText(String(Math.round(f * maxM)), pad.l - 6, y);
      g.textAlign = "left"; g.fillStyle = col.fatigue; g.fillText(String(Math.round(f * 100)), w - pad.r + 6, y);
    });
    const slot = pw / 7, bw = Math.min(30, slot * 0.5), cx = (i) => pad.l + (i + 0.5) * slot;
    g.globalAlpha = 0.75; g.fillStyle = col.ear;
    days.forEach((d, i) => { if (d.min > 0) { const y = pad.t + (1 - d.min / maxM) * ph; g.fillRect(cx(i) - bw / 2, y, bw, pad.t + ph - y); } });
    g.globalAlpha = 1;
    g.strokeStyle = col.fatigue; g.fillStyle = col.fatigue; g.lineWidth = 2; g.lineJoin = "round";
    g.beginPath();
    let pen = false;
    days.forEach((d, i) => {
      if (!d.n) { pen = false; return; }
      const y = pad.t + (1 - d.sc / d.n / 100) * ph;
      if (!pen) { g.moveTo(cx(i), y); pen = true; } else g.lineTo(cx(i), y);
    });
    g.stroke();
    days.forEach((d, i) => { if (d.n) { g.beginPath(); g.arc(cx(i), pad.t + (1 - d.sc / d.n / 100) * ph, 3.5, 0, 6.283); g.fill(); } });
    g.fillStyle = col.text; g.textAlign = "center"; g.textBaseline = "top";
    days.forEach((d, i) => g.fillText(d.d.toLocaleDateString(LOCALES[uiLang()], { weekday: "short" }), cx(i), h - pad.b + 6));
  }

  /* --- time-of-day heatmap: share of monitored time spent tired, by weekday and hour --- */
  function renderHeatmap() {
    const grid = ui.heatGrid;
    grid.textContent = "";
    const agg = {};
    loadHistory().forEach((r) => {
      if (!r.cells) return;
      Object.keys(r.cells).forEach((k) => {
        const c = r.cells[k];
        const a = agg[k] || (agg[k] = { sec: 0, tired: 0, alarms: 0 });
        a.sec += c.sec || 0; a.tired += c.tired || 0; a.alarms += c.alarms || 0;
      });
    });

    grid.appendChild(el("span", "heat-corner"));
    for (let h = 0; h < 24; h++) grid.appendChild(el("span", "heat-h", h % 3 === 0 ? String(h) : ""));

    const byHour = [];
    for (let h = 0; h < 24; h++) byHour.push({ sec: 0, tired: 0 });
    let anyData = false;

    DAY_ORDER.forEach((d) => {
      grid.appendChild(el("span", "heat-d", t(DAY_NAMES[d])));
      for (let h = 0; h < 24; h++) {
        const c = agg[d * 24 + h];
        const cell = el("span", "heat-c");
        const dh = t(DAY_NAMES[d]) + " " + hourName(h);
        let tip = dh + ": " + t("no data");
        if (c && c.sec > 0) {
          byHour[h].sec += c.sec; byHour[h].tired += c.tired;
          anyData = true;
          const mins = Math.max(1, Math.round(c.sec / 60));
          if (c.sec >= MIN_CELL_SEC) {
            const share = c.tired / c.sec;
            const lvl = Math.min(1, share / 0.5);
            cell.style.background = "color-mix(in srgb, var(--danger) " + Math.round(lvl * 100) + "%, color-mix(in srgb, var(--ok) 45%, var(--line)))";
            tip = dh + ": " + t("tired {p}% of {m} min monitored", { p: Math.round(share * 100), m: mins });
          } else {
            tip = dh + ": " + t("too little data ({s} s)", { s: Math.round(c.sec) });
            cell.classList.add("thin");
          }
          if (c.alarms > 0) { cell.classList.add("has-alarm"); tip += ", " + t(c.alarms === 1 ? "{n} alarm" : "{n} alarms", { n: c.alarms }); }
        } else {
          cell.classList.add("empty");
        }
        cell.title = tip;
        cell.setAttribute("aria-label", tip);
        cell.setAttribute("role", "img");
        grid.appendChild(cell);
      }
    });

    let best = -1, bestShare = 0;
    byHour.forEach((b, h) => {
      if (b.sec < 60) return;
      const share = b.tired / b.sec;
      if (share > bestShare) { bestShare = share; best = h; }
    });
    if (!anyData) ui.heatNote.textContent = t("Drive a few sessions and this map will show when you get tired. Each square is one weekday and hour.");
    else if (best < 0 || bestShare < 0.05) ui.heatNote.textContent = t("No clear tired period yet. That is a good sign, or you need more sessions.");
    else ui.heatNote.textContent = t("You are most often tired between {a} and {b} (tired {p}% of the time monitored in that hour).",
      { a: hourName(best), b: hourName((best + 1) % 24), p: Math.round(bestShare * 100) });
  }

  /* --- trip report shown after Stop --- */
  function tipFor(sm) {
    if (sm.alerts >= 3) return t("Several drowsiness alarms went off. Stop somewhere safe and rest for at least 20 minutes (a short nap helps more than coffee alone) before you drive on.");
    if (sm.alerts >= 1 || sm.peakFatigue >= FATIGUE_VERY) return t("You were close to nodding off at times. Plan a break every 2 hours, and pull over as soon as your eyes feel heavy.");
    if (sm.yawns >= 3) return t("Frequent yawning is an early sign of tiredness. Open a window, have some water and take a short walk at your next stop.");
    if (sm.nods >= 2) return t("Your head nodded forward more than once. Take a break soon, even if you feel fine.");
    if (sm.distractions >= 2) return t("You looked away from the road several times. Put your phone out of reach and mount the camera so it matches your view of the road.");
    if (sm.duration < 60) return t("That was a very short session. Trip reports are more useful over a longer drive.");
    return t("Good drive, you stayed alert. On long trips, still take a short break every 2 hours.");
  }

  function drawSpark(c, series) {
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const col = chartColors();
    const Y = (v) => 4 + (1 - Math.min(v, 100) / 100) * (h - 8);
    g.setLineDash([4, 4]); g.lineWidth = 1;
    [[FATIGUE_TIRED, col.thr], [FATIGUE_VERY, col.alarm]].forEach((r) => {
      g.strokeStyle = r[1]; g.beginPath(); g.moveTo(0, Y(r[0])); g.lineTo(w, Y(r[0])); g.stroke();
    });
    g.setLineDash([]);
    if (series.length < 2) return;
    g.strokeStyle = col.fatigue; g.lineWidth = 2; g.lineJoin = "round";
    g.beginPath();
    series.forEach((v, i) => { const x = (i / (series.length - 1)) * w; if (i === 0) g.moveTo(x, Y(v)); else g.lineTo(x, Y(v)); });
    g.stroke();
  }

  let tripWindow = null;      // time range of the trip being shown, to list its alarms
  let lastTrip = null;        // the trip being shown: { sm, series }, used for sharing and printing

  const SLEEP_LABEL = { 8: "7 hours or more", 6: "About 6 hours", 5: "About 5 hours", 4: "4 hours or less" };
  const LEN_LABEL = { 1: "Under 1 hour", 2: "1 to 2 hours", 4: "2 to 4 hours", 6: "More than 4 hours" };
  const RISK_NAME = ["Low", "Moderate", "High"];
  function preText(pre) {
    if (!pre) return "";
    return t("Before this drive: slept {sleep}; sleepiness {sl} out of 5; planned drive {len}. Pre-trip risk: {risk}.",
      { sleep: t(SLEEP_LABEL[pre.sleep] || ""), sl: pre.sleepy, len: t(LEN_LABEL[pre.length] || ""), risk: t(RISK_NAME[pre.risk] || "Low") });
  }

  function tripVerdictOf(sm) {
    const level = sm.alerts >= 3 || sm.peakFatigue >= FATIGUE_VERY ? 2 : sm.alerts >= 1 || sm.peakFatigue >= FATIGUE_TIRED || sm.nods >= 2 ? 1 : 0;
    return { level: level, text: t(["You stayed alert", "Some tiredness showed", "High fatigue"][level]) };
  }
  function tripRows(sm) {
    return [
      [fmtTime(sm.duration), t("Drive length")],
      [sm.alerts || 0, t("Drowsiness alarms")],
      [sm.distractions || 0, t("Looking-away alerts")],
      [sm.yawns || 0, t("Yawns")],
      [sm.nods || 0, t("Head nods")],
      [Number(sm.longest || 0).toFixed(1) + " s", t("Longest eye closure")],
      [Number(sm.blinksPerMin || 0).toFixed(1), t("Blinks per minute")],
      [sm.avgBlinkMs ? sm.avgBlinkMs + " ms" : "--", t("Average blink length")],
      [(sm.peakFatigue || 0) + " / 100", t("Peak fatigue")]
    ];
  }
  function peakText(sm) {
    const t0 = new Date(sm.started).getTime();
    if (sm.peakFatigue > 0 && typeof sm.peakAt === "number") {
      const clock = new Date(t0 + sm.peakAt * 1000).toLocaleTimeString(LOCALES[uiLang()], { hour: "numeric", minute: "2-digit" });
      const word = sm.peakFatigue >= FATIGUE_VERY ? "Very tired" : sm.peakFatigue >= FATIGUE_TIRED ? "Tired" : "Alert";
      return t("Your drowsiest moment was {at} into the drive (about {clock}), when your fatigue score reached {score} ({word}).",
        { at: fmtTime(sm.peakAt), clock: clock, score: sm.peakFatigue, word: t(word) });
    }
    return t("No sign of tiredness was detected during this drive.");
  }

  function showTrip(sm, series) {
    const t0 = new Date(sm.started).getTime();
    tripWindow = { from: t0 - 1000, to: t0 + sm.duration * 1000 + 3000 };
    lastTrip = { sm: sm, series: series };

    const v = tripVerdictOf(sm);
    ui.tripVerdict.textContent = v.text;
    ui.tripVerdict.dataset.s = ["ok", "warn", "danger"][v.level];

    const sc = scoreOf(sm);
    ui.tripScoreVal.textContent = sc;
    ui.tripScoreWord.textContent = t(scoreWord(sc));
    ui.tripScoreVal.parentNode.dataset.s = scoreLevel(sc);
    const streak = calmStreak(loadHistory());
    ui.tripStreak.textContent = (sm.alerts || 0) === 0 && streak > 0
      ? t(streak === 1 ? "Calm drive: no drowsiness alarm. Streak: {n} trip." : "Calm drive: no drowsiness alarm. Streak: {n} trips in a row.", { n: streak })
      : t("This drive had a drowsiness alarm, so the calm-drive streak starts again.");

    fillStats(ui.tripStats, tripRows(sm));
    ui.tripPeak.textContent = peakText(sm);
    ui.tripTip.textContent = t("Tip: {tip}", { tip: tipFor(sm) });
    ui.tripPre.textContent = preText(sm.pre);
    ui.tripPre.hidden = !sm.pre;

    ui.tripSpark.hidden = !series;
    ui.tripDialog.hidden = false;
    if (series) drawSpark(ui.tripSpark, series);
    refreshTripAlarms();
    ui.tripClose.focus();
  }

  function refreshTripAlarms() {
    if (!tripWindow) return;
    const list = loadAlarms().filter((a) => {
      const t = new Date(a.at).getTime();
      return a.kind !== "manual" && t >= tripWindow.from && t <= tripWindow.to;
    });
    ui.tripAlarmsWrap.hidden = list.length === 0;
    renderAlarmList(ui.tripAlarms, list, false);
  }

  ui.tripClose.addEventListener("click", () => { ui.tripDialog.hidden = true; });
  ui.tripBtn.addEventListener("click", () => {
    const list = loadHistory();
    if (list.length) showTrip(list[list.length - 1], null);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ui.tripDialog.hidden) ui.tripDialog.hidden = true; });

  /* --- share the trip summary on WhatsApp --- */
  function shareText(sm) {
    const sc = scoreOf(sm);
    const when = new Date(sm.started).toLocaleString(LOCALES[uiLang()], { dateStyle: "medium", timeStyle: "short" });
    const lines = ["WakeGuard · " + (sm.driver || activeName()), when, tripVerdictOf(sm).text,
      t("Safe driving score") + ": " + sc + "/100 (" + t(scoreWord(sc)) + ")"];
    tripRows(sm).slice(0, 5).concat([tripRows(sm)[8]]).forEach((r) => lines.push(r[1] + ": " + r[0]));
    lines.push(t("Tip: {tip}", { tip: tipFor(sm) }));
    return lines.join("\n");
  }
  ui.tripShare.addEventListener("click", () => {
    if (!lastTrip) return;
    const url = "https://wa.me/?text=" + encodeURIComponent(shareText(lastTrip.sm));
    window.open(url, "_blank", "noopener");
  });

  /* --- printable report (Print, then choose "Save as PDF") --- */
  function sparkImage(series) {
    const c = document.createElement("canvas");
    c.width = 720; c.height = 140;
    const g = c.getContext("2d");
    const Y = (v) => 8 + (1 - Math.min(v, 100) / 100) * 124;
    g.fillStyle = "#fff"; g.fillRect(0, 0, 720, 140);
    g.lineWidth = 1; g.setLineDash([6, 5]);
    [[FATIGUE_TIRED, "#c98a1b"], [FATIGUE_VERY, "#c43a3a"]].forEach((r) => { g.strokeStyle = r[1]; g.beginPath(); g.moveTo(0, Y(r[0])); g.lineTo(720, Y(r[0])); g.stroke(); });
    g.setLineDash([]);
    if (series.length > 1) {
      g.strokeStyle = "#222"; g.lineWidth = 2;
      g.beginPath();
      series.forEach((v, i) => { const x = (i / (series.length - 1)) * 720; if (i === 0) g.moveTo(x, Y(v)); else g.lineTo(x, Y(v)); });
      g.stroke();
    }
    return c.toDataURL("image/png");
  }
  function buildPrint(lt) {
    const sm = lt.sm, box = ui.printReport;
    box.textContent = "";
    const sc = scoreOf(sm);
    box.appendChild(el("h1", "", "WakeGuard · " + t("Trip report")));
    box.appendChild(el("p", "pr-meta", (sm.driver || activeName()) + " · " +
      new Date(sm.started).toLocaleString(LOCALES[uiLang()], { dateStyle: "long", timeStyle: "short" })));
    box.appendChild(el("p", "pr-score", t("Safe driving score") + ": " + sc + " / 100 · " + t(scoreWord(sc))));
    box.appendChild(el("p", "pr-verdict", tripVerdictOf(sm).text));
    const table = el("table", "pr-table");
    tripRows(sm).forEach((r) => {
      const tr = el("tr");
      tr.appendChild(el("th", "", r[1])); tr.appendChild(el("td", "", String(r[0])));
      table.appendChild(tr);
    });
    box.appendChild(table);
    box.appendChild(el("p", "", peakText(sm)));
    if (lt.series && lt.series.length > 1) {
      const img = new Image();
      img.src = sparkImage(lt.series); img.alt = t("Fatigue score over the drive"); img.className = "pr-spark";
      box.appendChild(el("p", "pr-cap", t("Fatigue score over the drive")));
      box.appendChild(img);
    }
    box.appendChild(el("p", "", t("Tip: {tip}", { tip: tipFor(sm) })));
    if (sm.pre) box.appendChild(el("p", "", preText(sm.pre)));
    const t0 = new Date(sm.started).getTime();
    const alarms = loadAlarms().filter((a) => {
      const at = new Date(a.at).getTime();
      return a.kind !== "manual" && at >= t0 - 1000 && at <= t0 + sm.duration * 1000 + 3000;
    });
    if (alarms.length) {
      box.appendChild(el("h2", "", t("Alarms during this drive")));
      const ul = el("ul");
      alarms.forEach((a) => ul.appendChild(el("li", "",
        new Date(a.at).toLocaleTimeString(LOCALES[uiLang()], { hour: "numeric", minute: "2-digit" }) + " · " + reasonName(a.reason) +
        (a.duration !== null && a.duration !== undefined ? " · " + Number(a.duration).toFixed(1) + " s" : "") +
        (a.label ? " · " + t(a.label === "real" ? "Real" : "False alarm") : ""))));
      box.appendChild(ul);
    }
    box.appendChild(el("p", "pr-foot", t("WakeGuard is a learning project, not a safety device. If you feel sleepy, stop driving and rest.")));
  }
  function printTrip() {
    if (!lastTrip) return;
    buildPrint(lastTrip);
    document.body.classList.add("printing-trip");
    const done = () => { document.body.classList.remove("printing-trip"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(done, 60000);
    window.print();
  }
  ui.tripPrint.addEventListener("click", printTrip);

  /* --- accuracy test: mark alarms real or false, then see precision and recall --- */
  function renderAlarmList(box, list, showDate) {
    box.textContent = "";
    list.forEach((a) => {
      const li = el("li", "arow");
      const d = new Date(a.at);
      const when = showDate
        ? d.toLocaleString(LOCALES[uiLang()], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
        : d.toLocaleTimeString(LOCALES[uiLang()], { hour: "numeric", minute: "2-digit" });
      li.appendChild(el("span", "", when + " · " + reasonName(a.reason) + (a.duration !== null && a.duration !== undefined ? " · " + Number(a.duration).toFixed(1) + " s" : "")));
      const group = el("span", "verdict");
      [["real", "Real"], ["false", "False alarm"]].forEach((o) => {
        const b = el("button", "small v-" + o[0], t(o[1]));
        b.type = "button";
        b.dataset.id = a.id;
        b.dataset.label = o[0];
        b.setAttribute("aria-pressed", String(a.label === o[0]));
        group.appendChild(b);
      });
      li.appendChild(group);
      box.appendChild(li);
    });
  }

  function onLabelClick(e) {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    const list = loadAlarms();
    const a = list.find((x) => x.id === b.dataset.id);
    if (!a) return;
    a.label = a.label === b.dataset.label ? null : b.dataset.label;     // click again to undo
    saveAlarms(list);
    renderAccuracy();
    refreshTripAlarms();
  }
  ui.accList.addEventListener("click", onLabelClick);
  ui.tripAlarms.addEventListener("click", onLabelClick);

  function accuracyStats(list) {
    const out = { by: {}, real: 0, fals: 0, missed: 0, unmarked: 0, total: 0 };
    list.forEach((a) => {
      if (a.label === "missed") { out.missed++; return; }
      out.total++;
      const k = cap(a.reason || "other");
      const row = out.by[k] || (out.by[k] = { n: 0, real: 0, fals: 0, unmarked: 0 });
      row.n++;
      if (a.label === "real") { row.real++; out.real++; }
      else if (a.label === "false") { row.fals++; out.fals++; }
      else { row.unmarked++; out.unmarked++; }
    });
    return out;
  }

  function renderAccuracy() {
    const all = loadAlarms();
    const st = accuracyStats(all);

    fillStats(ui.accSummary, [
      [st.total, t("Alarms recorded")],
      [st.real, t("Marked real")],
      [st.fals, t("Marked false")],
      [st.missed, t("Missed moments")],
      [pctText(st.real, st.real + st.fals), t("Precision")],
      [pctText(st.real, st.real + st.missed), t("Recall")]
    ]);

    ui.accBody.textContent = "";
    Object.keys(st.by).sort().forEach((k) => {
      const r = st.by[k];
      const tr = el("tr");
      [reasonName(k), r.n, r.real, r.fals, r.unmarked, pctText(r.real, r.real + r.fals)].forEach((v) => tr.appendChild(el("td", "", String(v))));
      ui.accBody.appendChild(tr);
    });
    if (st.total) {
      const tr = el("tr", "total");
      [t("All alarms"), st.total, st.real, st.fals, st.unmarked, pctText(st.real, st.real + st.fals)].forEach((v) => tr.appendChild(el("td", "", String(v))));
      ui.accBody.appendChild(tr);
    }

    const marked = st.real + st.fals;
    ui.accNote.textContent = marked < MIN_LABELLED
      ? t("Only {n} alarms are marked so far. Mark about {m} or more before trusting these percentages.", { n: marked, m: MIN_LABELLED })
      : t("Precision = real ÷ (real + false): how often an alarm was right. Recall = real ÷ (real + missed): how many drowsy moments it caught.");

    const recent = all.filter((a) => a.label !== "missed").slice(-8).reverse();
    renderAlarmList(ui.accList, recent, true);
    ui.accEmpty.hidden = recent.length > 0;
    ui.accCsv.disabled = ui.accClear.disabled = all.length === 0;
  }

  ui.missedBtn.addEventListener("click", () => {
    const list = loadAlarms();
    list.push({ id: "m-" + Date.now(), at: new Date().toISOString(), kind: "manual", reason: "missed drowsy moment", duration: null, label: "missed" });
    saveAlarms(list.slice(-300));
    renderAccuracy();
  });
  ui.accCsv.addEventListener("click", () => {
    const rows = ["time,type,reason,duration_s,verdict"].concat(loadAlarms().map((a) =>
      [a.at, a.kind, csvText(a.reason || ""), a.duration === null || a.duration === undefined ? "" : a.duration, a.label || "not marked"].join(",")));
    downloadCsv("wakeguard-accuracy-" + stamp(new Date()) + ".csv", rows.join("\n"));
  });
  ui.accClear.addEventListener("click", () => {
    if (!window.confirm(t("Delete all recorded alarms and your real / false marks?"))) return;
    try { localStorage.removeItem(pk(ALARM_KEY)); } catch (e) { /* ignore */ }
    renderAccuracy();
  });

  /* ---------- geometry ---------- */
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Eye aspect ratio: eyelid gap divided by eye width. Drops towards 0 as the eye closes.
  function ear(lm, idx) {
    const p = idx.map((i) => lm[i]);
    return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3]));
  }

  // Mouth aspect ratio: lip gap divided by mouth width. Rises when the mouth opens wide.
  function mouthRatio(lm) {
    return dist(lm[MOUTH.top], lm[MOUTH.bottom]) / dist(lm[MOUTH.left], lm[MOUTH.right]);
  }

  // Head angles in degrees from the 3D landmarks. Pitch grows when the head tilts forward (nodding down).
  // Yaw changes when the head turns left or right. Both are relative, so calibration sets the zero point.
  function headPose(lm) {
    const aspect = video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 0.75;
    const f = lm[POSE.forehead], c = lm[POSE.chin], l = lm[POSE.cheekL], r = lm[POSE.cheekR];
    const pitch = (Math.atan2(c.z - f.z, (c.y - f.y) * aspect) * 180) / Math.PI;
    const yaw = (Math.atan2(r.z - l.z, r.x - l.x) * 180) / Math.PI;
    return { pitch: pitch, yaw: yaw };
  }

  /* ---------- status display ---------- */
  function setStatus(kind, text) {
    state.statusKind = kind; state.statusKey = text;
    ui.status.dataset.s = kind;
    ui.statusText.textContent = t(text);
    ui.hud.dataset.s = kind;
    ui.hudStatus.textContent = t(text);
  }

  function refreshStatus(now) {
    if (state.calibrating) return;
    const limit = num(ui.closeSec);
    const closingFor = state.closedSince === null ? 0 : now - state.closedSince;
    if (state.alarming) setStatus("danger", state.alarmKind === "distract" ? "Eyes on road!" : "Wake up!");
    else if (closingFor > limit * 0.5) setStatus("warn", "Eyes closing");
    else if (state.headDown) setStatus("warn", "Head down");
    else if (state.awaySince !== null && now - state.awaySince > 1) setStatus("warn", "Looking away");
    else if (state.yawning) setStatus("warn", "Yawning");
    else if (state.fatigueStage === 2) setStatus("warn", "Very tired");
    else if (state.fatigueStage === 1) setStatus("warn", "Getting tired");
    else setStatus("ok", "Alert");
  }

  /* ---------- per-frame logic ---------- */
  function onResults(results) {
    const now = nowSec();
    state.lastFrameAt = now;

    if (overlay.width !== video.videoWidth && video.videoWidth) {
      overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    }
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const faces = results.multiFaceLandmarks;
    if (!faces || !faces.length) { handleNoFace(now); return; }

    state.lastFaceAt = now;
    const lm = faces[0];
    const raw = (ear(lm, RIGHT_EYE) + ear(lm, LEFT_EYE)) / 2;
    const mar = mouthRatio(lm);
    const pose = headPose(lm);

    state.earWindow.push(raw);
    if (state.earWindow.length > 3) state.earWindow.shift();
    state.poseWindow.push(pose);
    if (state.poseWindow.length > 3) state.poseWindow.shift();
    const e = state.earWindow.reduce((a, b) => a + b, 0) / state.earWindow.length;
    const pitch = state.poseWindow.reduce((a, p) => a + p.pitch, 0) / state.poseWindow.length;
    const yaw = state.poseWindow.reduce((a, p) => a + p.yaw, 0) / state.poseWindow.length;

    drawEyes(lm, e < num(ui.thr));
    checkVision(lm, now);

    if (state.calibrating) { calTick(now, { raw: raw, pitch: pitch, yaw: yaw }); return; }

    const tilt = pitch - state.basePitch;
    const turn = yaw - state.baseYaw;
    const closed = e < num(ui.thr);

    updateYawn(mar, now);
    updateHead(tilt, turn, now);
    updateClosure(closed, now);
    checkAlarmClear(now);
    updateReadouts(e, mar, tilt, turn);
    sampleSession(e, mar, closed, tilt, turn, now);
    refreshStatus(now);
  }

  function drawEyes(lm, closed) {
    ctx.fillStyle = closed ? eyeCols.bad : eyeCols.ok;
    [...RIGHT_EYE, ...LEFT_EYE].forEach((i) => {
      ctx.beginPath();
      ctx.arc(lm[i].x * overlay.width, lm[i].y * overlay.height, 3, 0, 6.283);
      ctx.fill();
    });
  }

  function updateYawn(mar, now) {
    if (mar > num(ui.yawnThr)) {
      if (state.yawnSince === null) state.yawnSince = now;
      if (!state.yawnCounted && now - state.yawnSince >= YAWN_MIN_SEC) {
        state.yawnCounted = true;
        state.yawnTimes.push(now);
        const s = state.session;
        if (s) {
          s.yawns++;
          logEvent("yawn", "mouth wide open");
          updateSessionStats();
          drawCharts();
        }
        earlyWarning("yawn");
      }
    } else {
      state.yawnSince = null;
      state.yawnCounted = false;
    }
    state.yawning = state.yawnCounted;
  }

  function updateHead(tilt, turn, now) {
    const s = state.session;

    // Head nod: soft beep first, loud alarm if the head stays down
    if (tilt > num(ui.nodDeg)) {
      if (state.nodSince === null) state.nodSince = now;
      const down = now - state.nodSince;
      if (!state.nodCounted && down >= NOD_BEEP_SEC) {
        state.nodCounted = true;
        state.nodTimes.push(now);
        if (s) {
          s.nods++;
          logEvent("nod", "head tilted forward");
          updateSessionStats();
        }
        earlyWarning("head nod");
      }
      if (down >= NOD_ALARM_SEC && now > state.silencedUntil) setAlarm(true, "head down", "drowsy");
      state.headUpSince = null;
    } else {
      state.nodSince = null;
      state.nodCounted = false;
      if (state.headUpSince === null) state.headUpSince = now;
    }
    state.headDown = state.nodSince !== null && now - state.nodSince >= NOD_BEEP_SEC;

    // Looking away from the road: a different alert from the drowsiness alarm
    if (Math.abs(turn) > num(ui.turnDeg)) {
      state.forwardSince = null;
      if (state.awaySince === null) state.awaySince = now;
      if (now - state.awaySince >= num(ui.turnSec) && now > state.silencedUntil && !state.alarming) {
        setAlarm(true, "looking away", "distract");
      }
    } else {
      state.awaySince = null;
      if (state.forwardSince === null) state.forwardSince = now;
    }
  }

  function updateClosure(closed, now) {
    const limit = num(ui.closeSec);
    const s = state.session;
    if (closed) {
      if (state.closedSince === null) state.closedSince = now;
      state.openSince = null;
      const dur = now - state.closedSince;
      if (s && dur > s.longestClosure) s.longestClosure = dur;
      if (dur >= limit * 0.5 && !state.closingWarned) {
        state.closingWarned = true;
        earlyWarning("eyes closing");
      }
      if (dur >= limit && now > state.silencedUntil) setAlarm(true, "eyes closed", "drowsy");
    } else {
      if (state.closedSince !== null) {
        const dur = now - state.closedSince;
        if (dur > 0.05 && dur < 0.7) {                 // a normal blink is brief
          state.blinkTimes.push(now);
          if (s) {
            s.blinks++;
            s.blinkMs += dur * 1000;
            if (dur >= SLOW_BLINK_SEC) s.slowBlinks++;
            const bi = Math.floor((now - s.startPerf) / BLINK_BIN);
            const bin = s.blinkBins[bi] || (s.blinkBins[bi] = { n: 0, ms: 0 });
            bin.n++; bin.ms += dur * 1000;
          }
        }
        state.closedSince = null;
      }
      state.closingWarned = false;
      if (state.openSince === null) state.openSince = now;
    }

    state.history.push({ t: now, closed: closed });
    while (state.history.length && now - state.history[0].t > 60) state.history.shift();
    while (state.blinkTimes.length && now - state.blinkTimes[0] > 60) state.blinkTimes.shift();

    const dur = state.closedSince === null ? 0 : now - state.closedSince;
    ui.closedVal.textContent = dur.toFixed(1) + " s";
    if (s) ui.longestVal.textContent = s.longestClosure.toFixed(1) + " s";
  }

  function updateReadouts(e, mar, tilt, turn) {
    ui.earVal.textContent = e.toFixed(2);
    ui.marVal.textContent = mar.toFixed(2);
    ui.tiltVal.textContent = (tilt >= 0 ? "+" : "") + Math.round(tilt) + "°";
    ui.turnVal.textContent = Math.round(turn) + "°";
    ui.earBar.style.width = Math.min(100, (e / 0.4) * 100) + "%";
    ui.earBar.style.background = e < num(ui.thr) ? "var(--danger)" : "var(--ok)";
    const n = state.history.length;
    const closedN = state.history.filter((h) => h.closed).length;
    ui.perclosVal.textContent = (n ? Math.round((closedN / n) * 100) : 0) + "%";
    ui.blinkVal.textContent = state.blinkTimes.length;
  }

  /* ---------- low light and sunglasses warning ---------- */
  const probe = document.createElement("canvas");
  const pctx = probe.getContext("2d", { willReadFrequently: true });

  // Average brightness and spread (0 to 255) of a box in the camera picture. Returns null if it cannot be read.
  function probeRegion(x, y, w, h, cols, rows) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !pctx) return null;
    x = Math.max(0, Math.min(vw - 2, x)); y = Math.max(0, Math.min(vh - 2, y));
    w = Math.max(2, Math.min(vw - x, w)); h = Math.max(2, Math.min(vh - y, h));
    try {
      probe.width = cols; probe.height = rows;
      pctx.drawImage(video, x, y, w, h, 0, 0, cols, rows);
      const d = pctx.getImageData(0, 0, cols, rows).data;
      const n = cols * rows;
      let sum = 0, sq = 0;
      for (let i = 0; i < n; i++) {
        const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
        sum += l; sq += l * l;
      }
      const mean = sum / n;
      return { mean: mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
    } catch (e) { return null; }
  }

  // Once a second: is the face too dark, or are the eyes hidden (dark, flat lenses compared with the cheeks)?
  function checkVision(lm, now) {
    if (now - state.lastVisionAt < 1) return;
    state.lastVisionAt = now;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    const fx0 = Math.min(lm[234].x, lm[454].x) * vw, fx1 = Math.max(lm[234].x, lm[454].x) * vw;
    const fy0 = lm[10].y * vh, fy1 = lm[152].y * vh;
    const face = probeRegion(fx0, fy0, fx1 - fx0, fy1 - fy0, 16, 16);
    if (!face) return;

    let issue = null;
    if (face.mean < LOW_LIGHT_LUMA) {
      issue = "dark";
    } else {
      const eyeBoxes = [[33, 133, 159, 145], [362, 263, 386, 374]].map((b) => {
        const w = Math.abs(lm[b[1]].x - lm[b[0]].x) * vw;
        const x0 = Math.min(lm[b[0]].x, lm[b[1]].x) * vw;
        const yc = ((lm[b[2]].y + lm[b[3]].y) / 2) * vh;
        return { w: w, stat: probeRegion(x0, yc - w * 0.3, w, w * 0.6, 16, 8) };
      });
      const sz = (eyeBoxes[0].w + eyeBoxes[1].w) / 4;
      const cheeks = [205, 425].map((i) => probeRegion(lm[i].x * vw - sz / 2, lm[i].y * vh - sz / 2, sz, sz, 6, 6));
      if (eyeBoxes.every((b) => b.stat) && cheeks.every(Boolean)) {
        const eyeMean = (eyeBoxes[0].stat.mean + eyeBoxes[1].stat.mean) / 2;
        const eyeStd = (eyeBoxes[0].stat.std + eyeBoxes[1].stat.std) / 2;
        const skin = (cheeks[0].mean + cheeks[1].mean) / 2;
        if (skin > 70 && eyeMean < HIDDEN_EYE_RATIO * skin && eyeStd < 22) issue = "hidden";
      }
    }

    if (issue) { if (state.visionBadSince === null) state.visionBadSince = now; }
    else state.visionBadSince = null;
    setVision(issue && now - state.visionBadSince >= VISION_BAD_SEC ? issue : null, now);
  }

  function setVision(issue, now) {
    if (issue === state.visionIssue) return;
    state.visionIssue = issue;
    ui.visionWarn.hidden = !issue;
    if (!issue) return;
    ui.visionWarn.textContent = issue === "dark"
      ? t("Too dark: the camera may not see your eyes. Turn on the cabin light or face a light source.")
      : t("Cannot see your eyes (sunglasses?). Take them off or move the camera. Drowsiness detection may not work.");
    if (now - state.lastVisionBeepAt > 30) {          // a soft double beep, only once in a while
      state.lastVisionBeepAt = now;
      beep(); setTimeout(beep, 350);
    }
  }

  function handleNoFace(now) {
    if (state.calibrating) { calTick(now, null); return; }
    const gone = now - state.lastFaceAt;
    if (gone > NO_FACE_ALARM_SEC && now > state.silencedUntil) {
      setAlarm(true, "face lost", "drowsy");
      setStatus("danger", "Face lost!");
    } else if (gone > 1) {
      setStatus("warn", "No face in view");
    }
    ui.earVal.textContent = "--";
    ui.marVal.textContent = "--";
    ui.tiltVal.textContent = "--";
    ui.turnVal.textContent = "--";
  }

  /* ---------- guided calibration: 3 steps with a countdown ---------- */
  function startCalibration() {
    clearTimeout(state.calHideTimer);
    const now = nowSec();
    state.calibrating = true; state.calPhase = "ready";
    state.calSamples = []; state.calPose = []; state.calUntil = now + CAL_READY_SEC;
    setAlarm(false);
    setStatus("warn", "Calibrating…");
    ui.calBtn.disabled = true;
    delete ui.calGuide.dataset.result;
    ui.calGuide.hidden = false;
    drawCalGuide(now, true);
  }

  function drawCalGuide(now, faceSeen) {
    const left = Math.max(0, state.calUntil - now);
    if (state.calPhase === "ready") {
      ui.calStep.textContent = t("Step 1 of 3");
      ui.calTitle.textContent = t("Get in position");
      ui.calText.textContent = t("Sit upright the way you normally drive. Keep the camera at eye level with your whole face in view.");
      ui.calBar.style.width = Math.min(100, 100 * (1 - left / CAL_READY_SEC)) + "%";
    } else {
      ui.calStep.textContent = t("Step 2 of 3");
      ui.calTitle.textContent = t("Look straight ahead");
      ui.calText.textContent = faceSeen
        ? t("Keep your eyes open and blink normally. Stay still.")
        : t("I can't see your face. Move into the camera's view.");
      ui.calBar.style.width = Math.min(100, 100 * (1 - left / CAL_CAPTURE_SEC)) + "%";
    }
    ui.calCount.textContent = String(Math.ceil(left));
  }

  // Called for every camera frame while calibrating. sample is null when no face is visible.
  function calTick(now, sample) {
    if (!state.calibrating) return;
    if (state.calPhase === "ready") {
      if (now >= state.calUntil) {
        state.calPhase = "capture";
        state.calUntil = now + CAL_CAPTURE_SEC;
        state.calSamples = []; state.calPose = [];
        beep();
      }
    } else if (sample) {
      state.calSamples.push(sample.raw);
      state.calPose.push({ pitch: sample.pitch, yaw: sample.yaw });
    }
    if (state.calPhase === "capture" && now >= state.calUntil) { finishCalibration(); return; }
    drawCalGuide(now, !!sample);
  }

  function finishCalibration() {
    const sorted = state.calSamples.slice().sort((a, b) => a - b);
    const typical = sorted.length ? sorted[Math.floor(sorted.length * 0.6)] : 0;   // upper-range open-eye reading (ignores blinks)
    let ok = false, title, text;
    if (sorted.length < CAL_MIN_SAMPLES) {
      title = t("Could not see your face");
      text = t("Check the camera angle and the lighting, then press Calibrate again.");
    } else if (typical < CAL_MIN_EAR) {
      title = t("Eyes not clear");
      text = t("Your eyes look almost closed to the camera. Check the lighting or take off sunglasses, then press Calibrate again.");
    } else {
      ok = true;
      ui.thr.value = Math.max(0.10, Math.min(0.35, typical * 0.72)).toFixed(2);   // 72% of the open-eye reading
      // Head position: whatever the driver looks like facing the road counts as zero
      state.basePitch = median(state.calPose.map((p) => p.pitch));
      state.baseYaw = median(state.calPose.map((p) => p.yaw));
      syncSettingsUI();
      title = t("Calibrated");
      text = t("Eye-closed threshold set to {thr} and your head position saved. Monitoring is on.", { thr: ui.thr.value });
    }

    state.calibrating = false; state.calPhase = null;
    state.closedSince = null; state.nodSince = null; state.awaySince = null; state.forwardSince = null;
    state.history = [];
    ui.calBtn.disabled = false;
    setStatus("ok", "Alert");

    // Step 3: show the result for a few seconds while monitoring carries on
    ui.calGuide.dataset.result = ok ? "ok" : "warn";
    ui.calStep.textContent = t("Step 3 of 3");
    ui.calTitle.textContent = title;
    ui.calText.textContent = text;
    ui.calCount.textContent = ok ? "✓" : "!";
    ui.calBar.style.width = "100%";
    clearTimeout(state.calHideTimer);
    state.calHideTimer = setTimeout(() => { ui.calGuide.hidden = true; delete ui.calGuide.dataset.result; }, CAL_RESULT_SEC * 1000);
  }

  /* ---------- start / stop ---------- */
  async function requestWakeLock() {
    try { if (navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
  }

  function showError(msg) { ui.error.textContent = msg; ui.error.hidden = !msg; }

  function resetTracking() {
    state.closedSince = null; state.openSince = null; state.closingWarned = false;
    state.earWindow = []; state.poseWindow = []; state.history = []; state.blinkTimes = [];
    state.yawnSince = null; state.yawnCounted = false; state.yawning = false; state.yawnTimes = [];
    state.nodSince = null; state.nodCounted = false; state.nodTimes = []; state.headDown = false; state.headUpSince = null;
    state.awaySince = null; state.forwardSince = null;
    state.fatigueStage = 0; state.stage2BeepAt = 0; state.lastEarlyBeepAt = 0;
    state.alarmTimes = [];
  }

  /* ---------- pre-trip check: 3 questions give a risk rating before you drive ---------- */
  function preAssess() {
    const sleep = Number(ui.preSleep.value), sleepy = Number(ui.preSleepy.value), length = Number(ui.preLength.value);
    const pts = ({ 8: 0, 6: 1, 5: 2.5, 4: 4 }[sleep] || 0) + ({ 1: 0, 2: 0.5, 3: 1.5, 4: 3, 5: 5 }[sleepy] || 0) + ({ 1: 0, 2: 0.5, 4: 1.5, 6: 2.5 }[length] || 0);
    const risk = pts >= 5 || sleepy >= 5 || (sleep <= 4 && length >= 4) ? 2 : pts >= 2.5 ? 1 : 0;
    return { sleep: sleep, sleepy: sleepy, length: length, risk: risk };
  }
  const PRE_ADVICE = [
    "You look ready to drive. Still take a short break every 2 hours.",
    "Plan a break within 90 minutes, and pull over as soon as your eyes feel heavy.",
    "Driving tired is dangerous. If you can, nap for 20 minutes first or let someone else drive. Your first break reminder will come after 1 hour."
  ];
  function updatePreResult() {
    const a = preAssess();
    ui.preResult.dataset.s = ["ok", "warn", "danger"][a.risk];
    ui.preRisk.textContent = t("Risk before driving: {risk}", { risk: t(RISK_NAME[a.risk]) });
    ui.preAdvice.textContent = t(PRE_ADVICE[a.risk]);
  }
  ["preSleep", "preSleepy", "preLength"].forEach((k) => ui[k].addEventListener("change", updatePreResult));
  function openPre() { updatePreResult(); ui.preDialog.hidden = false; ui.preGo.focus(); }
  ui.preGo.addEventListener("click", () => { ui.preDialog.hidden = true; start(preAssess()); });
  ui.preSkip.addEventListener("click", () => { ui.preDialog.hidden = true; start(null); });
  ui.preCancel.addEventListener("click", () => { ui.preDialog.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ui.preDialog.hidden) ui.preDialog.hidden = true; });

  /* ---------- voice command: say "I'm awake" to silence the alarm ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const AWAKE_WORDS = ["awake", "i am up", "i'm up", "जाग", "जगा", "জেগে", "জাগ", "jaag", "jag raha", "jaga"];
  const heardAwake = (text) => { const x = String(text).toLowerCase(); return AWAKE_WORDS.some((w) => x.includes(w)); };
  const VOICECMD_NOTE = "Uses the microphone and your browser's speech service. Works in Chrome. You will be asked for permission.";
  function updateVoiceCmdNote() {
    ui.voiceCmdNote.textContent = !SR ? t("This browser has no speech recognition, so the voice command is not available. Try Chrome.")
      : state.recBlocked ? t("Microphone permission was denied. Allow it in the browser to use the voice command.") : t(VOICECMD_NOTE);
  }
  function startVoiceCmd() {
    if (state.rec || !SR || !ui.voiceCmd.checked || !state.running || state.recBlocked) return;
    const code = PHRASES[currentLang()].code;
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = code;
    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const alt = ev.results[i][0];
        if (alt && state.alarming && heardAwake(alt.transcript)) { silenceAlarm(); break; }
      }
    };
    r.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { state.recBlocked = true; updateVoiceCmdNote(); } };
    r.onend = () => { state.rec = null; if (state.running && ui.voiceCmd.checked && !state.recBlocked) setTimeout(startVoiceCmd, 400); };
    state.rec = r; state.recLang = code;
    try { r.start(); } catch (e) { state.rec = null; }
  }
  function stopVoiceCmd() {
    const r = state.rec;
    state.rec = null;
    if (r) { r.onend = null; try { r.abort(); } catch (e) { /* ignore */ } }
  }
  function syncVoiceCmd() {
    updateVoiceCmdNote();
    if (!(state.running && ui.voiceCmd.checked)) { stopVoiceCmd(); return; }
    if (state.rec && state.recLang !== PHRASES[currentLang()].code) stopVoiceCmd();
    startVoiceCmd();
  }

  function setStartLabel(key) { state.startKey = key; ui.startBtn.textContent = t(key); }

  async function start(pre) {
    showError("");
    if (typeof FaceMesh === "undefined" || typeof Camera === "undefined") {
      showError(t("Could not load the face-tracking library. Check your internet connection and reload the page."));
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError(t("Camera access needs https or localhost. Open this page through a local server or a secure site."));
      return;
    }
    unlockAudio();
    ui.startBtn.disabled = true;
    setStartLabel("Starting camera…");

    try {
      state.faceMesh = new FaceMesh({ locateFile: (f) => "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/" + f });
      state.faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      state.faceMesh.onResults(onResults);

      state.camera = new Camera(video, {
        onFrame: async () => { await state.faceMesh.send({ image: video }); },
        width: 640, height: 480, facingMode: "user"
      });
      await state.camera.start();
    } catch (err) {
      ui.startBtn.disabled = false;
      setStartLabel("Start monitoring");
      showError(err && err.name === "NotAllowedError"
        ? t("Camera permission was denied. Allow camera access in the browser and try again.")
        : t("Could not start the camera:") + " " + (err && err.message ? err.message : err));
      return;
    }

    state.running = true;
    state.lastFaceAt = nowSec();
    resetTracking();
    state.basePitch = 0; state.baseYaw = 0;
    state.pre = pre || null;
    state.preRisk = pre ? pre.risk : null;
    state.session = newSession();
    state.lastSampleAt = 0;
    state.visionBadSince = null; setVision(null, 0);
    scheduleBreak(0);                                   // driving timer starts with the session
    const firstCap = state.preRisk === 2 ? 3600 : state.preRisk === 1 ? 5400 : 0;      // a tired driver gets the first reminder sooner
    if (firstCap && state.nextBreakAt !== null && state.nextBreakAt > firstCap) state.nextBreakAt = firstCap;
    tickDrive();
    clearInterval(state.driveTimer);
    state.driveTimer = setInterval(tickDrive, 1000);
    updateFatigueUI(0);
    updateSessionStats();
    drawCharts();
    ui.idle.hidden = true;
    ui.startBtn.disabled = false;
    setStartLabel("Stop monitoring");
    ui.startBtn.classList.remove("primary"); ui.startBtn.classList.add("stop");
    ui.calBtn.disabled = false;
    setStatus("ok", "Alert");
    requestWakeLock();
    startCalibration();   // calibrate automatically on first start
    state.recBlocked = false;
    syncVoiceCmd();
  }

  function stop() {
    state.running = false;
    stopVoiceCmd();
    setAlarm(false);
    ui.breakDialog.hidden = true;
    finishSession();
    if (state.camera) { state.camera.stop(); state.camera = null; }
    const stream = video.srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    if (state.faceMesh) { state.faceMesh.close(); state.faceMesh = null; }
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    clearInterval(state.driveTimer); state.driveTimer = null; state.nextBreakAt = null;
    ui.driveTimeVal.textContent = "0:00"; ui.nextBreakVal.textContent = "--";
    state.pre = null; state.preRisk = null;
    clearTimeout(state.calHideTimer); ui.calGuide.hidden = true; delete ui.calGuide.dataset.result;
    state.visionBadSince = null; setVision(null, 0);
    ui.idle.hidden = false;
    setStartLabel("Start monitoring");
    ui.startBtn.classList.add("primary"); ui.startBtn.classList.remove("stop");
    ui.calBtn.disabled = true;
    state.calibrating = false;
    resetTracking();
    setStatus("idle", "Off");
  }

  ui.startBtn.addEventListener("click", () => {
    if (state.running) stop();
    else if (ui.preTrip.checked) openPre();
    else start(null);
  });
  ui.calBtn.addEventListener("click", startCalibration);
  ui.silenceBtn.addEventListener("click", silenceAlarm);
  ui.testBtn.addEventListener("click", () => {
    ensureAudio();   // this click already counts as the user gesture browsers require
    startSound("drowsy");
    setTimeout(() => { if (!state.alarming) stopSound(); }, 3500);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.running) requestWakeLock();
  });

  /* ---------- drive mode (full-screen camera, big buttons) ---------- */
  function setDrive(on) {
    document.body.classList.toggle("drive", on);
    ui.driveBtn.textContent = t(on ? "Exit drive mode" : "Drive mode (full screen)");
    try {
      if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch (e) { /* fullscreen not available */ }
    setTimeout(() => { drawCharts(); drawInsightCharts(); }, 50);
  }
  ui.driveBtn.addEventListener("click", () => setDrive(!document.body.classList.contains("drive")));

  /* ---------- install as an app (PWA) ---------- */
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installPrompt = e;
    ui.installBtn.hidden = false;
  });
  ui.installBtn.addEventListener("click", async () => {
    const p = state.installPrompt;
    if (!p) return;
    p.prompt();
    try { await p.userChoice; } catch (e) { /* ignore */ }
    state.installPrompt = null;
    ui.installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => { ui.installBtn.hidden = true; });

  // Service worker: lets the installed app open offline once it has loaded online
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* needs https or localhost */ });
  }

  /* ---------- drivers: add, rename, remove, switch ---------- */
  function fillProfileSel() {
    ui.profileSel.textContent = "";
    profiles.list.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.name;
      ui.profileSel.appendChild(o);
    });
    ui.profileSel.value = profiles.active;
    ui.driverBadge.textContent = "· " + activeName();
    ui.profileDel.disabled = profiles.list.length < 2;
  }
  function switchProfile(id) {
    if (id === profiles.active) return;
    if (state.running) {
      ui.profileSel.value = profiles.active;
      ui.profileNote.textContent = t("Stop monitoring before you switch drivers.");
      return;
    }
    saveSettings();                                   // keep the old driver's settings first
    profiles.active = id; saveProfiles();
    resetSettings(); loadSettings();
    state.basePitch = 0; state.baseYaw = 0;
    lastUiLang = "en";                                // the new driver may use another interface language
    applyI18n();
    syncSettingsUI();
    refreshDynamic();
    ui.profileNote.textContent = t("Switched to {name}.", { name: activeName() });
  }
  const cleanName = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 20);
  const nameTaken = (n, exceptId) => profiles.list.some((p) => p.id !== exceptId && p.name.toLowerCase() === n.toLowerCase());
  ui.profileSel.addEventListener("change", () => switchProfile(ui.profileSel.value));
  ui.profileAdd.addEventListener("click", () => {
    if (state.running) { ui.profileNote.textContent = t("Stop monitoring before you switch drivers."); return; }
    const n = cleanName(window.prompt(t("Name of the new driver:"), ""));
    if (!n) return;
    if (nameTaken(n)) { ui.profileNote.textContent = t("A driver with that name already exists."); return; }
    const id = "p" + Date.now().toString(36);
    profiles.list.push({ id: id, name: n });
    saveProfiles(); fillProfileSel();
    switchProfile(id);
    ui.profileSel.value = id;
  });
  ui.profileRename.addEventListener("click", () => {
    const n = cleanName(window.prompt(t("New name for this driver:"), activeName()));
    if (!n) return;
    if (nameTaken(n, profiles.active)) { ui.profileNote.textContent = t("A driver with that name already exists."); return; }
    profiles.list.find((p) => p.id === profiles.active).name = n;
    saveProfiles(); fillProfileSel();
  });
  ui.profileDel.addEventListener("click", () => {
    if (profiles.list.length < 2) return;
    if (state.running) { ui.profileNote.textContent = t("Stop monitoring before you switch drivers."); return; }
    if (!window.confirm(t("Remove {name} and delete their settings, history and alarm log from this browser?", { name: activeName() }))) return;
    const gone = profiles.active;
    ["wakeguard", HISTORY_KEY, ALARM_KEY].forEach((b) => { try { localStorage.removeItem(b + sfx(gone)); } catch (e) { /* ignore */ } });
    profiles.list = profiles.list.filter((p) => p.id !== gone);
    profiles.active = profiles.list[0].id;
    saveProfiles();
    resetSettings(); loadSettings();
    lastUiLang = "en"; applyI18n();
    syncSettingsUI(); refreshDynamic();
  });

  /* ---------- backup and restore: everything in one JSON file ---------- */
  ui.exportBtn.addEventListener("click", () => {
    saveSettings();
    const data = {
      app: "WakeGuard", version: 2, exportedAt: new Date().toISOString(), active: profiles.active,
      profiles: profiles.list.map((p) => ({
        id: p.id, name: p.name,
        settings: lsGet("wakeguard" + sfx(p.id), {}),
        history: lsGet(HISTORY_KEY + sfx(p.id), []),
        alarms: lsGet(ALARM_KEY + sfx(p.id), [])
      }))
    };
    downloadCsv("wakeguard-backup-" + stamp(new Date()) + ".json", JSON.stringify(data, null, 1), "application/json");
    ui.backupNote.textContent = t("Backup file saved. Keep it somewhere safe.");
  });
  ui.importBtn.addEventListener("click", () => { ui.importFile.value = ""; ui.importFile.click(); });
  ui.importFile.addEventListener("change", () => {
    const f = ui.importFile.files && ui.importFile.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => importData(String(rd.result || ""));
    rd.onerror = () => { ui.backupNote.textContent = t("That file is not a WakeGuard backup."); };
    rd.readAsText(f);
  });
  function importData(text) {
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!data || data.app !== "WakeGuard" || !Array.isArray(data.profiles)) { ui.backupNote.textContent = t("That file is not a WakeGuard backup."); return; }
    if (state.running) { ui.backupNote.textContent = t("Stop monitoring before you import data."); return; }
    if (!window.confirm(t("Add the data in this file to what is already saved in this browser?"))) return;
    saveSettings();
    let sessions = 0, alarms = 0, drivers = 0;
    data.profiles.forEach((fp) => {
      if (!fp || typeof fp.name !== "string") return;
      let target = profiles.list.find((p) => p.name.toLowerCase() === fp.name.toLowerCase());
      if (!target) {
        target = { id: "p" + Date.now().toString(36) + drivers, name: cleanName(fp.name) || "Driver" };
        profiles.list.push(target); drivers++;
        if (fp.settings && typeof fp.settings === "object") lsSet("wakeguard" + sfx(target.id), fp.settings);
      }
      const hKey = HISTORY_KEY + sfx(target.id), aKey = ALARM_KEY + sfx(target.id);
      const hist = lsGet(hKey, []), seen = {};
      hist.forEach((r) => { seen[r.started] = true; });
      (Array.isArray(fp.history) ? fp.history : []).forEach((r) => { if (r && r.started && !seen[r.started]) { hist.push(r); seen[r.started] = true; sessions++; } });
      hist.sort((a, b) => String(a.started).localeCompare(String(b.started)));
      lsSet(hKey, hist.slice(-50));
      const al = lsGet(aKey, []), ids2 = {};
      al.forEach((a) => { ids2[a.id] = true; });
      (Array.isArray(fp.alarms) ? fp.alarms : []).forEach((a) => { if (a && a.id && !ids2[a.id]) { al.push(a); ids2[a.id] = true; alarms++; } });
      al.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      lsSet(aKey, al.slice(-300));
    });
    saveProfiles();
    fillProfileSel();
    renderHistory();
    ui.backupNote.textContent = t("Imported: {s} sessions, {a} alarms and {d} new drivers added.", { s: sessions, a: alarms, d: drivers });
  }

  // Re-draws everything that was written by code (not by the page), so a language change shows everywhere
  function refreshDynamic() {
    setStatus(state.statusKind, state.statusKey);
    updateFatigueUI(state.lastFatigue);
    updateSessionStats();
    updateSoundNote();
    updateLangNote();
    updateVoiceCmdNote();
    updatePreResult();
    setStartLabel(state.startKey);
    ui.driveBtn.textContent = t(document.body.classList.contains("drive") ? "Exit drive mode" : "Drive mode (full screen)");
    if (!state.running) ui.nextBreakVal.textContent = "--";
    fillProfileSel();
    renderHistory();
    drawCharts();
  }

  /* ---------- start-up ---------- */
  fillProfileSel();
  loadSettings();
  updateSoundNote();
  syncSettingsUI();
  renderHistory();
  updateSessionStats();
  updateFatigueUI(0);

  // An installed phone app opens straight into drive mode
  try {
    if (window.matchMedia("(display-mode: standalone)").matches && window.matchMedia("(max-width: 800px)").matches) setDrive(true);
  } catch (e) { /* ignore */ }
})();