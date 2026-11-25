(function () {
  "use strict";

  var cfg = window.DEKIRU_CONFIG || {};
  var STORAGE_KEY = cfg.storageKey || "dekiru_words_v2";
  var GAP_MS = 1500;
  var REPEAT_GAP_MS = 400;
  var RB = /\{([^{}|]+)\|([^{}|]+)\}/g;

  var data = null;
  var groupsById = {};
  var filteredGroups = [];
  var filterLevel = "all";
  var viewGroup = null;
  var playlist = [];
  var playSource = { type: "group", id: null };
  var index = 0;
  var playing = false;
  var paused = false;
  var pass = 1;
  var cmd = null;
  var rate = 0.7;
  var twice = false;
  var loopOn = false;
  var randomOn = false;
  var jaVoice = null;
  var wakeLock = null;
  var resumeTimer = null;
  var gapTimer = null;
  var currentUtterance = null;
  var searchQuery = "";
  var sheetItem = null;

  var el = {};

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ruby(s) {
    return esc(s).replace(RB, "<ruby>$1<rt>$2</rt></ruby>");
  }

  function plain(s) {
    return String(s || "").replace(RB, "$1");
  }

  function yomi(s) {
    return String(s || "").replace(RB, "$2");
  }

  function speakable(s) {
    return String(s || "")
      .replace(/([0-9０-９])\{([^{}|]+)\|([^{}|]+)\}/g, "$1$2")
      .replace(RB, "$1")
      .replace(/[～〜（）()／]/g, "")
      .trim();
  }

  function speakText(word) {
    return String(word || "").replace(/^[~～〜]+/, "").replace(/[（）()／]/g, "").trim();
  }

  function posClass(pos) {
    if (pos === "动词") return "verb";
    if (pos === "形容词") return "adj";
    if (pos === "名词" || pos === "课内短语") return "noun";
    return "oth";
  }

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        group: playSource.type === "group" ? playSource.id : viewGroup,
        index: index,
        rate: rate,
        twice: twice,
        loop: loopOn,
        random: randomOn,
        filter: filterLevel
      }));
    } catch (e) {}
  }

  function pickVoice() {
    if (!window.speechSynthesis) return;
    var voices = speechSynthesis.getVoices() || [];
    jaVoice = voices.filter(function (v) { return v.lang === "ja-JP"; })[0]
      || voices.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf("ja") === 0; })[0]
      || null;
  }

  function waitForVoices() {
    if (!window.speechSynthesis) return;
    pickVoice();
    if (jaVoice || (speechSynthesis.getVoices() || []).length) return;
    speechSynthesis.addEventListener("voiceschanged", function () { pickVoice(); }, { once: true });
    setTimeout(pickVoice, 800);
  }

  async function requestWake() {
    if (!("wakeLock" in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request("screen"); }
    catch (e) { wakeLock = null; }
  }

  async function releaseWake() {
    if (!wakeLock) return;
    try { await wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  function startResumeWatch() {
    stopResumeWatch();
    if (!window.speechSynthesis) return;
    resumeTimer = setInterval(function () {
      if (!playing || paused) return;
      try { if (speechSynthesis.speaking) speechSynthesis.resume(); } catch (e) {}
    }, 8000);
  }

  function stopResumeWatch() {
    if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
  }

  function clearGap() {
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  }

  function allWords() {
    var out = [];
    if (!filteredGroups.length) return out;
    filteredGroups.forEach(function (g) {
      g.words.forEach(function (w, i) {
        out.push({ word: w, group: g.id, orig: i });
      });
    });
    return out;
  }

  function visibleWords() {
    var q = (searchQuery || "").trim();
    if (q) {
      var nq = q.toLowerCase();
      return allWords().filter(function (item) {
        var w = item.word;
        return (w.w && w.w.indexOf(q) !== -1)
          || (w.r && w.r.indexOf(q) !== -1)
          || (w.zh && w.zh.indexOf(q) !== -1)
          || (w.pos && w.pos.indexOf(q) !== -1)
          || (w.en && String(w.en).toLowerCase().indexOf(nq) !== -1)
          || (w.origin && String(w.origin).toLowerCase().indexOf(nq) !== -1);
      });
    }
    var gid = viewGroup || (filteredGroups[0] && filteredGroups[0].id);
    var g = groupsById[gid];
    if (!g) return [];
    return g.words.map(function (w, i) { return { word: w, group: g.id, orig: i }; });
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function buildPlaylist(gid, useRandom) {
    var g = groupsById[gid];
    if (!g) return [];
    var items = g.words.map(function (w, i) { return { word: w, group: g.id, orig: i }; });
    return useRandom ? shuffle(items.slice()) : items;
  }

  function currentItem() { return playlist[index] || null; }

  function showNow(item) {
    if (!item) {
      el.nowWord.textContent = "—";
      el.nowReading.textContent = searchQuery ? "没有匹配的词" : "请选择一个类别";
      el.nowZh.textContent = "";
      el.nowProgress.textContent = "0 / 0";
      return;
    }
    var w = item.word;
    el.nowWord.textContent = w.w;
    el.nowReading.textContent = w.r;
    el.nowZh.textContent = w.zh || "";
    var bits = [(index + 1) + " / " + playlist.length, item.group + " 行"];
    if (w.pos) bits.push(w.posd ? w.pos + " · " + w.posd : w.pos);
    el.nowProgress.textContent = bits.join(" · ");
  }

  function highlightList() {
    var item = currentItem();
    var nodes = el.list.querySelectorAll(".word");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var on = item && n.getAttribute("data-group") === item.group && Number(n.getAttribute("data-orig")) === item.orig;
      n.classList.toggle("current", !!on);
      if (on) {
        try { n.scrollIntoView({ block: "center", behavior: "smooth", inline: "nearest" }); }
        catch (e) { n.scrollIntoView(true); }
      }
    }
  }

  function renderCats() {
    el.cats.innerHTML = "";
    filteredGroups.forEach(function (g) {
      var wrap = document.createElement("div");
      wrap.className = "cat" + (viewGroup === g.id && !searchQuery ? " on" : "");
      wrap.setAttribute("role", "listitem");
      wrap.setAttribute("data-group", g.id);
      var sel = document.createElement("button");
      sel.type = "button";
      sel.className = "cat-sel";
      sel.innerHTML = '<span class="kana"></span><span class="n"></span>';
      sel.querySelector(".kana").textContent = g.id;
      sel.querySelector(".n").textContent = String(g.count);
      sel.setAttribute("aria-label", g.id + "行，" + g.count + " 个词");
      sel.addEventListener("click", function () {
        el.search.value = "";
        searchQuery = "";
        selectGroup(g.id, 0, false);
      });
      var play = document.createElement("button");
      play.type = "button";
      play.className = "cat-play";
      play.setAttribute("data-group", g.id);
      play.setAttribute("aria-label", "播放" + g.id + "行");
      play.textContent = "▶ 播放";
      play.addEventListener("click", function () { startGroup(g.id, 0); });
      wrap.appendChild(sel);
      wrap.appendChild(play);
      el.cats.appendChild(wrap);
    });
  }

  function renderList() {
    var items = visibleWords();
    el.list.innerHTML = "";
    if (searchQuery.trim()) {
      el.listTitle.textContent = "搜索「" + searchQuery.trim() + "」";
      el.listCount.textContent = items.length + " 词";
    } else {
      var gid = viewGroup || (filteredGroups[0] && filteredGroups[0].id);
      el.listTitle.textContent = gid + " 行";
      el.listCount.textContent = items.length + " 词";
    }
    if (!items.length) {
      el.status.hidden = false;
      el.status.textContent = "没有找到匹配的词。";
      return;
    }
    el.status.hidden = true;
    var frag = document.createDocumentFragment();
    items.forEach(function (item) {
      var w = item.word;
      var row = document.createElement("div");
      row.className = "word";
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.setAttribute("data-group", item.group);
      row.setAttribute("data-orig", String(item.orig));
      row.setAttribute("data-id", w.id);
      var pos = w.posd ? w.pos + " · " + w.posd : w.pos;
      row.innerHTML = '<div class="main"><span class="w"></span><span class="r"></span><span class="zh"></span></div>'
        + '<div class="meta"><span class="lv"></span><span class="badge ' + posClass(w.pos) + '"></span></div>'
        + '<button type="button" class="say" aria-label="朗读">🔊</button>';
      row.querySelector(".w").textContent = w.w;
      row.querySelector(".r").textContent = w.r;
      row.querySelector(".zh").textContent = w.zh || "";
      row.querySelector(".badge").textContent = pos;
      row.querySelector(".lv").innerHTML = levelBadgeHtml(w) + (w.star ? badgeHtml("⭐", "star") : "");
      row.querySelector(".say").addEventListener("click", function (ev) {
        ev.stopPropagation();
        speakOnce(speakText(w.w));
      });
      row.addEventListener("click", function () { openDetails(item); });
      row.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openDetails(item);
        }
      });
      frag.appendChild(row);
    });
    el.list.appendChild(frag);
    highlightList();
  }

  function selectGroup(gid, startIndex, keepPlaylist) {
    viewGroup = gid;
    if (!keepPlaylist) {
      playSource = { type: "group", id: gid };
      playlist = buildPlaylist(gid, randomOn);
      index = Math.max(0, Math.min(startIndex || 0, Math.max(0, playlist.length - 1)));
    }
    renderCats();
    renderList();
    showNow(currentItem());
    highlightList();
    saveSettings();
    updateButtons();
  }

  function updateButtons() {
    var has = playlist.length > 0;
    el.btnPrev.disabled = !has;
    el.btnNext.disabled = !has;
    el.btnStop.disabled = !playing && !paused;
    if (playing && !paused) {
      el.btnPlay.textContent = "暂停";
      el.btnPlay.setAttribute("aria-label", "暂停");
    } else if (playing && paused) {
      el.btnPlay.textContent = "继续";
      el.btnPlay.setAttribute("aria-label", "继续");
    } else {
      el.btnPlay.textContent = "▶ 播放";
      el.btnPlay.setAttribute("aria-label", "播放");
    }
    el.optSlow.classList.toggle("on", rate < 0.95);
    el.optSlow.setAttribute("aria-pressed", rate < 0.95 ? "true" : "false");
    el.optNormal.classList.toggle("on", rate >= 0.95);
    el.optNormal.setAttribute("aria-pressed", rate >= 0.95 ? "true" : "false");
    el.optTwice.classList.toggle("on", twice);
    el.optTwice.setAttribute("aria-pressed", twice ? "true" : "false");
    el.optLoop.classList.toggle("on", loopOn);
    el.optLoop.setAttribute("aria-pressed", loopOn ? "true" : "false");
    el.optRandom.classList.toggle("on", randomOn);
    el.optRandom.setAttribute("aria-pressed", randomOn ? "true" : "false");
  }

  function cancelSpeech() {
    clearGap();
    currentUtterance = null;
    if (window.speechSynthesis) {
      try { speechSynthesis.cancel(); } catch (e) {}
    }
  }

  function startGroup(gid, startIndex) {
    el.search.value = "";
    searchQuery = "";
    viewGroup = gid;
    playSource = { type: "group", id: gid };
    playlist = buildPlaylist(gid, randomOn);
    index = Math.max(0, Math.min(startIndex || 0, Math.max(0, playlist.length - 1)));
    pass = 1;
    renderCats();
    renderList();
    beginPlay();
  }

  function startVisible(startIndex) {
    var items = visibleWords();
    if (searchQuery.trim()) {
      playSource = { type: "search", q: searchQuery.trim() };
      playlist = randomOn ? shuffle(items.slice()) : items.slice();
    } else {
      var gid = viewGroup || (filteredGroups[0] && filteredGroups[0].id);
      playSource = { type: "group", id: gid };
      playlist = buildPlaylist(gid, randomOn);
    }
    index = Math.max(0, Math.min(startIndex || 0, Math.max(0, playlist.length - 1)));
    pass = 1;
    beginPlay();
  }

  function beginPlay() {
    if (!playlist.length) return;
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
      el.status.hidden = false;
      el.status.textContent = "这个浏览器不支持朗读。请改用 Safari 或 Chrome。";
      return;
    }
    cmd = null;
    cancelSpeech();
    playing = true;
    paused = false;
    pickVoice();
    requestWake();
    startResumeWatch();
    showNow(currentItem());
    highlightList();
    saveSettings();
    updateButtons();
    speakCurrent();
  }

  function speakCurrent() {
    var item = currentItem();
    if (!item) { stopPlay(false); return; }
    showNow(item);
    highlightList();
    saveSettings();
    speakUtterance(speakText(item.word.w), function (kind) { onEnded(kind); });
  }

  function speakUtterance(text, done) {
    var u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = rate;
    if (jaVoice) u.voice = jaVoice;
    currentUtterance = u;
    u.onend = function () {
      if (currentUtterance !== u) return;
      currentUtterance = null;
      if (done) done("end");
    };
    u.onerror = function (ev) {
      if (currentUtterance !== u) return;
      currentUtterance = null;
      var err = ev && ev.error;
      if (done) done(err === "canceled" || err === "interrupted" ? "cancel" : "error");
    };
    try { speechSynthesis.speak(u); }
    catch (e) { if (done) done("error"); }
  }

  function onEnded(kind) {
    if (cmd === "stop" || !playing) return;
    if (cmd === "pause") return;
    if (cmd === "skip") {
      cmd = null;
      pass = 1;
      if (playing && !paused) speakCurrent();
      return;
    }
    if (kind === "cancel") return;
    if (kind !== "end") {
      paused = true;
      cmd = "pause";
      clearGap();
      updateButtons();
      return;
    }
    if (twice && pass === 1) {
      pass = 2;
      scheduleGap(REPEAT_GAP_MS, function () {
        if (playing && !paused && cmd == null) speakCurrent();
      });
      return;
    }
    scheduleGap(GAP_MS, advanceAndSpeak);
  }

  function scheduleGap(ms, fn) {
    clearGap();
    if (ms <= 0) { fn(); return; }
    gapTimer = setTimeout(function () { gapTimer = null; fn(); }, ms);
  }

  function advanceAndSpeak() {
    if (!playing || paused || cmd === "stop") return;
    if (cmd === "skip") {
      cmd = null;
      pass = 1;
      speakCurrent();
      return;
    }
    if (cmd === "pause") return;
    index += 1;
    if (index >= playlist.length) {
      if (loopOn) {
        index = 0;
      } else {
        index = Math.max(0, playlist.length - 1);
        stopPlay(false);
        showNow(currentItem());
        highlightList();
        return;
      }
    }
    pass = 1;
    speakCurrent();
  }

  function stopPlay(resetIndex) {
    cmd = "stop";
    playing = false;
    paused = false;
    pass = 1;
    cancelSpeech();
    stopResumeWatch();
    releaseWake();
    if (resetIndex) {
      index = 0;
      showNow(currentItem());
      highlightList();
    }
    saveSettings();
    updateButtons();
  }

  function pausePlay() {
    if (!playing || paused) return;
    paused = true;
    cmd = "pause";
    clearGap();
    if (window.speechSynthesis) {
      try { speechSynthesis.pause(); } catch (e) {}
      setTimeout(function () {
        if (playing && paused && speechSynthesis.speaking && !speechSynthesis.paused) {
          try { speechSynthesis.cancel(); } catch (e) {}
        }
      }, 120);
    }
    updateButtons();
  }

  function resumePlay() {
    if (!playing || !paused) return;
    paused = false;
    cmd = null;
    pickVoice();
    requestWake();
    startResumeWatch();
    updateButtons();
    if (window.speechSynthesis && speechSynthesis.paused) {
      try { speechSynthesis.resume(); return; } catch (e) {}
    }
    pass = 1;
    speakCurrent();
  }

  function skipTo(nextIndex) {
    if (!playlist.length) return;
    index = Math.max(0, Math.min(nextIndex, playlist.length - 1));
    pass = 1;
    showNow(currentItem());
    highlightList();
    saveSettings();
    if (playing && !paused) {
      cmd = "skip";
      cancelSpeech();
      speakCurrent();
    }
    updateButtons();
  }

  function speakOnce(text) {
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return;
    pickVoice();
    var keepPlaying = playing && !paused;
    if (keepPlaying) {
      cmd = "pause";
      paused = true;
      clearGap();
    }
    try { speechSynthesis.cancel(); } catch (e) {}
    currentUtterance = null;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = rate;
    if (jaVoice) u.voice = jaVoice;
    if (keepPlaying) {
      u.onend = function () { resumePlay(); };
      u.onerror = function () { resumePlay(); };
    }
    speechSynthesis.speak(u);
    updateButtons();
  }

  function togglePlay() {
    if (playing && !paused) { pausePlay(); return; }
    if (playing && paused) { resumePlay(); return; }
    if (!playlist.length || (searchQuery.trim() && playSource.type !== "search")) {
      startVisible(index);
      return;
    }
    beginPlay();
  }

  function levelBadgeHtml(w) {
    var map = cfg.levelBadges || {
      shokyu: { label: "初級", cls: "lv-sk" },
      shochukyu: { label: "初中級", cls: "lv-sc" }
    };
    var html = "";
    (w.levels || []).forEach(function (lv) {
      var meta = map[lv];
      if (meta) html += badgeHtml(meta.label, meta.cls || "");
    });
    return html;
  }

  function wordInFilter(w) {
    if (filterLevel === "all") return true;
    return (w.levels || []).indexOf(filterLevel) !== -1;
  }

  function rebuildGroups() {
    groupsById = {};
    filteredGroups = [];
    if (!data) return;
    (data.groups || []).forEach(function (g) {
      var words = (g.words || []).filter(wordInFilter);
      if (!words.length) return;
      var ng = { id: g.id, count: words.length, words: words };
      filteredGroups.push(ng);
      groupsById[g.id] = ng;
    });
  }

  function filteredTotal() {
    var n = 0;
    filteredGroups.forEach(function (g) { n += g.count; });
    return n;
  }

  function updateChrome() {
    var theme = cfg.theme || "";
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-level", filterLevel === "all" ? (theme || "all") : filterLevel);
    var buttons = document.querySelectorAll(".level-filters button");
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute("data-level") === filterLevel;
      buttons[i].classList.toggle("on", on);
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    var titles = cfg.titles || {
      all: "できる日本語 初級＋初中級",
      shokyu: "できる日本語 初級",
      shochukyu: "できる日本語 初中級"
    };
    var h1 = document.getElementById("page-title");
    var lead = document.getElementById("lead");
    if (h1) h1.textContent = titles[filterLevel] || titles.all || "";
    var n = filteredTotal();
    if (lead) {
      var leads = cfg.leads || {
        all: "初級与初中級共 {n} 个单词（同一词、同一读音已合并），按五十音统一复习。也可以只看初級或初中級。点一类的 ▶ 播放会慢慢读完；点单词可看详情。",
        shokyu: "初級 {n} 个单词按五十音分组。点一类的 ▶ 播放，会慢慢把这类词全部读出来；点单词可看详情。",
        shochukyu: "初中級 {n} 个单词（含第7–9课课内短语）按五十音分组。点一类的 ▶ 播放，会慢慢把这类词全部读出来；点单词可看详情。"
      };
      var tpl = leads[filterLevel] || leads.all || "";
      lead.textContent = tpl.replace(/\{n\}/g, String(n));
    }
    document.title = (titles[filterLevel] || titles.all || "") + (cfg.titleSuffix || "单词朗读｜按五十音");
  }

  function syncUrl() {
    try {
      var url = new URL(location.href);
      url.searchParams.set("level", filterLevel);
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (e) {}
  }

  function knownFilters() {
    var list = (cfg.filters && cfg.filters.length) ? cfg.filters : [
      { id: "all", label: "全部" },
      { id: "shokyu", label: "初級" },
      { id: "shochukyu", label: "初中級" }
    ];
    return list.map(function (f) { return typeof f === "string" ? f : f.id; });
  }

  function isKnownFilter(lv) {
    if (!lv) return false;
    return knownFilters().indexOf(lv) !== -1;
  }

  function setFilter(lv) {
    if (!isKnownFilter(lv)) lv = "all";
    var cur = currentItem();
    if (playing) stopPlay(false);
    filterLevel = lv;
    rebuildGroups();
    var gid = null;
    var start = 0;
    if (cur) {
      for (var i = 0; i < filteredGroups.length; i++) {
        var g = filteredGroups[i];
        for (var j = 0; j < g.words.length; j++) {
          var w = g.words[j];
          if (w.id === cur.word.id || (w.w === cur.word.w && w.r === cur.word.r)) {
            gid = g.id;
            start = j;
            break;
          }
        }
        if (gid) break;
      }
    }
    if (!gid) {
      gid = groupsById[viewGroup] ? viewGroup : (filteredGroups[0] && filteredGroups[0].id);
      start = 0;
    }
    if (gid) selectGroup(gid, start, false);
    else {
      playlist = [];
      index = 0;
      renderCats();
      renderList();
      showNow(null);
      updateButtons();
    }
    updateChrome();
    syncUrl();
    saveSettings();
  }

  function badgeHtml(text, cls) {
    if (!text) return "";
    return '<span class="badge ' + (cls || "") + '">' + esc(text) + "</span>";
  }

  function openDetails(item) {
    sheetItem = item;
    var w = item.word;
    var html = "";
    html += '<div class="sheet-handle"></div>';
    html += '<div class="sheet-top">';
    html += '<div><div class="sheet-word"></div><div class="sheet-reading"></div></div>';
    html += '<button type="button" class="say" data-say="' + esc(speakText(w.w)) + '" aria-label="朗读单词">🔊</button>';
    html += '<button type="button" class="sheet-close" aria-label="关闭">关闭</button>';
    html += "</div>";
    html += '<div class="sheet-zh"></div>';
    html += '<div class="sheet-row">';
    html += levelBadgeHtml(w);
    html += badgeHtml(w.posd ? w.pos + " · " + w.posd : w.pos, posClass(w.pos));
    if (w.star) html += badgeHtml("⭐", "star");
    if (w.vt) html += badgeHtml(w.vt, "verb");
    if (w.learned) html += badgeHtml("已学：" + w.learned, "book");
    (w.lessons || []).forEach(function (ls) { html += badgeHtml(ls, "book"); });
    html += badgeHtml(w.book === false ? "书里没有" : (w.book ? "课本" : ""), w.book === false ? "extra" : "book");
    if (w.suru) html += badgeHtml("する动词", "verb");
    html += "</div>";
    if (w.origin) {
      html += "<h3>外来语来源</h3><div class=\"note note-origin\"></div>";
    }
    if (w.en) {
      html += "<h3>英语</h3><div class=\"note note-en\"></div>";
    }
    if (w.note) {
      html += "<h3>说明</h3><div class=\"note note-text\"></div>";
    }
    if (w.confuse && w.confuse.length) {
      html += "<h3>近义／易混</h3>";
      w.confuse.forEach(function (j, i) {
        html += '<div class="pair" data-confuse="' + i + '"></div>';
      });
    }
    if (w.jita && w.jita.length) {
      html += "<h3>自他对照</h3>";
      w.jita.forEach(function (j, i) {
        html += '<div class="pair" data-jita="' + i + '"></div>';
      });
    }
    if (w.pairs && w.pairs.length) {
      html += "<h3>对照・反义</h3>";
      w.pairs.forEach(function (j, i) {
        html += '<div class="pair" data-pair="' + i + '"></div>';
      });
    }
    if (w.forms && w.forms.length) {
      html += "<h3>活用</h3><div class=\"sheet-row forms\"></div>";
    }
    if (w.coll && w.coll.length) {
      html += "<h3>搭配</h3>";
      w.coll.forEach(function (c, i) {
        html += '<div class="coll" data-coll="' + i + '"></div>';
      });
    }
    if (w.ex && w.ex.length) {
      html += "<h3>例句</h3>";
      w.ex.forEach(function (c, i) {
        html += '<div class="ex" data-ex="' + i + '"></div>';
      });
    } else {
      html += '<p class="hint">这条在现有词表里没有例句。</p>';
    }
    if (w.also && w.also.length) {
      html += "<h3>另见</h3><div class=\"note also\"></div>";
    }

    el.sheet.innerHTML = html;
    el.sheet.querySelector(".sheet-word").textContent = w.w;
    el.sheet.querySelector(".sheet-reading").textContent = w.r;
    var zhText = w.zh || "";
    if (zhText && w.zhtag) zhText += "  ·  " + w.zhtag;
    el.sheet.querySelector(".sheet-zh").textContent = zhText;
    if (w.origin) {
      var oBox = el.sheet.querySelector(".note-origin");
      if (oBox) oBox.textContent = w.origin;
    }
    if (w.en) {
      var enBox = el.sheet.querySelector(".note-en");
      if (enBox) enBox.textContent = w.en;
    }
    if (w.note) el.sheet.querySelector(".note-text").textContent = w.note;
    (w.confuse || []).forEach(function (j, i) {
      var box = el.sheet.querySelector('[data-confuse="' + i + '"]');
      if (!box) return;
      var line = (j.w || "") + (j.r ? "  " + j.r : "") + (j.zh ? "  " + j.zh : "");
      box.innerHTML = "<b></b>" + (j.tip || j.exp ? "<div></div>" : "");
      box.querySelector("b").textContent = line;
      if (j.tip || j.exp) box.querySelector("div:last-child").textContent = j.tip || j.exp;
    });
    (w.jita || []).forEach(function (j, i) {
      var box = el.sheet.querySelector('[data-jita="' + i + '"]');
      var role = j.role ? "（" + j.role + "）" : "";
      var orole = j.orole ? "（" + j.orole + "）" : "";
      var line = (w.w + role) + "  ↔  " + (j.w || "") + orole;
      var extra = [];
      if (j.r) extra.push(j.r);
      if (j.zh) extra.push(j.zh);
      if (j.status) extra.push(j.status);
      box.innerHTML = "<b></b>" + (extra.length ? '<div class="ex-yomi"></div>' : "") + (j.exp ? "<div></div>" : "");
      box.querySelector("b").textContent = line;
      if (extra.length) box.querySelector(".ex-yomi").textContent = extra.join(" · ");
      if (j.exp) box.querySelector("div:last-child").textContent = j.exp;
    });
    (w.pairs || []).forEach(function (j, i) {
      var box = el.sheet.querySelector('[data-pair="' + i + '"]');
      var line = (j.kind ? j.kind + "： " : "") + w.w + "  ↔  " + (j.w || "");
      box.innerHTML = "<b></b>" + ((j.r || j.zh) ? '<div class="ex-yomi"></div>' : "") + (j.exp ? "<div></div>" : "");
      box.querySelector("b").textContent = line;
      if (j.r || j.zh) box.querySelector(".ex-yomi").textContent = [j.r, j.zh].filter(Boolean).join(" · ");
      if (j.exp) box.querySelector("div:last-child").textContent = j.exp;
    });
    if (w.forms && w.forms.length) {
      var frow = el.sheet.querySelector(".forms");
      w.forms.forEach(function (f) {
        var span = document.createElement("span");
        span.className = "badge book";
        span.textContent = f.k + " " + f.w + (f.r && f.r !== f.w ? " " + f.r : "");
        frow.appendChild(span);
      });
    }
    function fillLine(sel, c) {
      var box = el.sheet.querySelector(sel);
      var say = speakable(c.ruby);
      box.innerHTML = '<div class="ex-head"><div class="txt"><div class="ex-jp"></div><div class="ex-yomi"></div>'
        + (c.zh ? '<div class="ex-zh"></div>' : "")
        + (c.tag || c.zhtag ? '<div class="sheet-row tags"></div>' : "")
        + '</div><button type="button" class="say" aria-label="朗读例句">🔊</button></div>';
      box.querySelector(".ex-jp").innerHTML = ruby(c.ruby);
      var ym = yomi(c.ruby);
      var surface = plain(c.ruby);
      box.querySelector(".ex-yomi").textContent = (ym && ym !== surface) ? ym : "";
      if (c.zh) {
        var zhEl = box.querySelector(".ex-zh");
        zhEl.textContent = c.zh + (c.zhtag ? "  ·  " + c.zhtag : "");
      }
      var tags = box.querySelector(".tags");
      if (tags && c.tag) tags.innerHTML = badgeHtml(c.tag, c.tag.indexOf("新") !== -1 ? "nw" : "tb");
      box.querySelector(".say").setAttribute("data-say", say);
    }
    (w.coll || []).forEach(function (c, i) { fillLine('[data-coll="' + i + '"]', c); });
    (w.ex || []).forEach(function (c, i) { fillLine('[data-ex="' + i + '"]', c); });
    if (w.also && w.also.length) {
      el.sheet.querySelector(".also").textContent = w.also.map(function (a) {
        return (a.lesson ? a.lesson + " " : "") + (a.text || "");
      }).join("；");
    }

    el.sheet.querySelectorAll(".say[data-say]").forEach(function (btn) {
      btn.addEventListener("click", function () { speakOnce(btn.getAttribute("data-say") || ""); });
    });
    el.sheet.querySelector(".sheet-close").addEventListener("click", closeDetails);

    el.backdrop.hidden = false;
    el.sheet.hidden = false;
    el.sheet.setAttribute("aria-hidden", "false");
    el.backdrop.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    el.sheet.querySelector(".sheet-close").focus();
  }

  function closeDetails() {
    el.sheet.hidden = true;
    el.backdrop.hidden = true;
    el.sheet.setAttribute("aria-hidden", "true");
    el.backdrop.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    sheetItem = null;
  }

  function bind() {
    el = {
      cats: $("cats"),
      list: $("list"),
      status: $("status"),
      listTitle: $("list-title"),
      listCount: $("list-count"),
      nowWord: $("now-word"),
      nowReading: $("now-reading"),
      nowZh: $("now-zh"),
      nowProgress: $("now-progress"),
      btnPlay: $("btn-play"),
      btnPrev: $("btn-prev"),
      btnNext: $("btn-next"),
      btnStop: $("btn-stop"),
      optSlow: $("opt-slow"),
      optNormal: $("opt-normal"),
      optTwice: $("opt-twice"),
      optLoop: $("opt-loop"),
      optRandom: $("opt-random"),
      optRestart: $("opt-restart"),
      search: $("search"),
      sheet: $("sheet"),
      backdrop: $("backdrop")
    };

    el.btnPlay.addEventListener("click", togglePlay);
    el.btnStop.addEventListener("click", function () { stopPlay(false); });
    el.btnPrev.addEventListener("click", function () { skipTo(index - 1); });
    el.btnNext.addEventListener("click", function () { skipTo(index + 1); });
    el.optSlow.addEventListener("click", function () { rate = 0.7; saveSettings(); updateButtons(); });
    el.optNormal.addEventListener("click", function () { rate = 1; saveSettings(); updateButtons(); });
    el.optTwice.addEventListener("click", function () { twice = !twice; saveSettings(); updateButtons(); });
    el.optLoop.addEventListener("click", function () { loopOn = !loopOn; saveSettings(); updateButtons(); });
    el.optRandom.addEventListener("click", function () {
      randomOn = !randomOn;
      var cur = currentItem();
      if (playSource.type === "group" && playSource.id) {
        playlist = buildPlaylist(playSource.id, randomOn);
      } else if (playSource.type === "search") {
        playlist = randomOn ? shuffle(visibleWords().slice()) : visibleWords().slice();
      }
      if (cur) {
        var found = -1;
        for (var i = 0; i < playlist.length; i++) {
          if (playlist[i].group === cur.group && playlist[i].orig === cur.orig) { found = i; break; }
        }
        index = found >= 0 ? found : 0;
      } else index = 0;
      showNow(currentItem());
      highlightList();
      saveSettings();
      updateButtons();
    });
    el.optRestart.addEventListener("click", function () {
      index = 0;
      pass = 1;
      showNow(currentItem());
      highlightList();
      saveSettings();
      if (playing && !paused) {
        cmd = "skip";
        cancelSpeech();
        speakCurrent();
      }
      updateButtons();
    });

    var searchTimer = null;
    el.search.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchQuery = el.search.value || "";
        renderCats();
        renderList();
      }, 120);
    });

    el.backdrop.addEventListener("click", closeDetails);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !el.sheet.hidden) closeDetails();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && playing && !paused) {
        requestWake();
        try { if (window.speechSynthesis) speechSynthesis.resume(); } catch (e) {}
      }
    });
  }

  window.__dekiruPlayer = {
    getState: function () {
      var item = currentItem();
      return {
        playing: playing,
        paused: paused,
        index: index,
        group: playSource.id,
        source: playSource.type,
        rate: rate,
        twice: twice,
        loop: loopOn,
        random: randomOn,
        total: playlist.length,
        word: item ? item.word.w : null,
        reading: item ? item.word.r : null,
        speakText: item ? speakText(item.word.w) : null,
        gap: GAP_MS,
        sheetOpen: !!(el.sheet && !el.sheet.hidden),
        sheetWord: sheetItem ? sheetItem.word.w : null,
        filter: filterLevel,
        filteredTotal: filteredTotal()
      };
    },
    setFilter: setFilter,
    setGap: function (ms) { GAP_MS = Number(ms) || 0; REPEAT_GAP_MS = Math.min(REPEAT_GAP_MS, GAP_MS); },
    playGroup: function (id, start) { startGroup(id, start || 0); },
    next: function () { skipTo(index + 1); },
    prev: function () { skipTo(index - 1); },
    stop: function () { stopPlay(false); },
    pause: function () { pausePlay(); },
    resume: function () { resumePlay(); },
    openFirstDetails: function () {
      var items = visibleWords();
      if (items[0]) openDetails(items[0]);
    },
    closeDetails: closeDetails,
    speakText: speakText
  };

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL(cfg.swUrl || "../sw.js", location.href)).catch(function () {});
  }

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    fetch(cfg.dataUrl || "words.json")
      .then(function (res) {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then(function (json) {
        data = json;
        var s = loadSettings();
        if (typeof s.rate === "number") rate = s.rate >= 0.95 ? 1 : 0.7;
        if (s.twice) twice = true;
        if (s.loop) loopOn = true;
        if (s.random) randomOn = true;
        var q = "";
        try { q = new URLSearchParams(location.search).get("level") || ""; } catch (e) {}
        if (isKnownFilter(q)) filterLevel = q;
        else if (isKnownFilter(s.filter)) filterLevel = s.filter;
        else filterLevel = "all";
        rebuildGroups();
        updateChrome();
        var gid = s.group && groupsById[s.group] ? s.group : (filteredGroups[0] && filteredGroups[0].id);
        var start = typeof s.index === "number" ? s.index : 0;
        if (gid && start >= (groupsById[gid] && groupsById[gid].count || 0)) start = 0;
        el.status.hidden = true;
        if (gid) selectGroup(gid, start, false);
        syncUrl();
        waitForVoices();
      })
      .catch(function () {
        el.status.hidden = false;
        el.status.textContent = "词表载入失败。请检查网络后刷新。";
      });
  });
})();
