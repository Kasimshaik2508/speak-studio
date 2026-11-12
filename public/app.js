"use strict";

// ================= helpers =================
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
// Works for English and Devanagari. For Hindi, ignore nukta dots and chandrabindu vs anusvara,
// which speech recognition gets inconsistent.
const norm = (w) => w.normalize("NFC").toLowerCase().replace(/[’']/g, "'")
  .replace(/\u093C/g, "").replace(/\u0901/g, "\u0902")
  .replace(/[^\p{L}\p{M}\p{N}']/gu, "");
const words = (s) => s.split(/\s+/).map(norm).filter(Boolean);

// ================= languages =================
const LANG = {
  en: {
    name: "English", coach: "Maya", voice: "en",
    accents: [["en-US", "English (US)"], ["en-GB", "English (UK)"], ["en-IN", "English (India)"], ["en-AU", "English (Australia)"]],
    topics: ["Job interviews", "Ordering at a restaurant", "Your hometown", "Technology in daily life", "Climate change", "Favourite films", "Healthy habits", "Working from home"],
    fillers: /\b(um+|uh+|erm*|hmm+|you know)\b/gi,
    opener: "Nice reading! Let's talk about it.",
    say: (t) => `Say: ${t}`, perfect: "Perfect. That's exactly it.", close: "Close. Let's try that once more.",
    noVoice: "No English voice found on this computer.",
  },
  hi: {
    name: "Hindi", coach: "Meera", voice: "hi",
    accents: [["hi-IN", "Hindi (India)"]],
    topics: ["Your family", "Indian food", "Festivals", "Shopping at a market", "Bollywood films", "Your daily routine", "Travelling by train", "Cricket"],
    fillers: /(^|\s)(उम्म*|अं+|हम्म*|मतलब)(?=[\s,।.]|$)/g,
    opener: "बहुत अच्छा पढ़ा! अब इसके बारे में बात करते हैं।",
    openerEnglish: "Well read! Now let's talk about it.",
    say: (t) => `बोलिए: ${t}`, perfect: "बहुत बढ़िया! बिल्कुल सही।", close: "क़रीब है। एक बार फिर कोशिश कीजिए।",
    noVoice: "No Hindi voice found. On a Mac: System Settings › Accessibility › Spoken Content › System voice › Manage Voices › Hindi (Lekha). In Chrome, “Google हिन्दी” appears when you're online.",
  },
};
const L = () => LANG[state.learn];
const vocabKey = (code) => (code === "en" ? "vocab" : "vocab:" + code);

const store = {
  get(k, d) { try { const v = localStorage.getItem("speak:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("speak:" + k, JSON.stringify(v)); } catch {} },
};

let statusTimer;
function status(msg, isError = false, ms = 4000) {
  const s = $("status");
  s.textContent = msg;
  s.className = "status" + (isError ? " error" : "");
  s.hidden = false;
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => (s.hidden = true), ms);
}

async function api(name, body) {
  const res = await fetch("/api/" + name, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, language: state.learn }),
  });
  const data = await res.json().catch(() => ({ error: "The server sent an unreadable reply." }));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// Longest-common-subsequence alignment: which passage words were heard.
function align(target, heard) {
  const n = target.length, m = heard.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = target[i] === heard[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const matched = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (target[i] === heard[j]) { matched[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { matched, count: dp[0][0] };
}
const similarity = (a, b) => {
  const t = words(a), h = words(b);
  return t.length ? align(t, h).count / Math.max(t.length, h.length) : 0;
};

// ================= state =================
const state = {
  learn: LANG[store.get("learn", "en")] ? store.get("learn", "en") : "en",
  level: store.get("level", "intermediate"),
  passage: null,           // { title, passage, vocabulary, discussion_question }
  passageWords: [],        // normalized tokens
  history: [],             // [{role, content}] sent to the model
  corrections: [],
  turns: 0,
  fillers: 0,
  wpmSamples: [],
  vocab: [],
  busy: false,
};
const START = "(The learner just opened the session. Greet them in one short sentence and ask one opening question about the topic. There is nothing to correct yet.)";

// ================= speech out (text-to-speech) =================
const tts = {
  voices: [],
  all: [],
  load() {
    this.all = speechSynthesis.getVoices();
    this.voices = this.all.filter((v) => v.lang.toLowerCase().startsWith(L().voice));
    const sel = $("voice");
    const saved = store.get("voice:" + state.learn, store.get("voice", null));
    sel.innerHTML = "";
    const preferred = (v) => /natural|neural|premium|enhanced|samantha|google/i.test(v.name);
    const sorted = [...this.voices].sort((a, b) => preferred(b) - preferred(a));
    for (const v of sorted) {
      const o = el("option", null, `${v.name} (${v.lang})`);
      o.value = v.name;
      sel.append(o);
    }
    if (saved && this.voices.some((v) => v.name === saved)) sel.value = saved;
    const missing = this.all.length > 0 && this.voices.length === 0;
    $("voiceTip").hidden = !missing;
    $("voiceTip").textContent = missing ? L().noVoice : "";
  },
  voice(lang) {
    if (lang && lang !== L().voice) {
      const list = this.all.filter((v) => v.lang.toLowerCase().startsWith(lang));
      return list.find((v) => /natural|neural|premium|enhanced|samantha|google/i.test(v.name)) || list[0] || null;
    }
    return this.voices.find((v) => v.name === $("voice").value) || null;
  },
  // Chrome cuts off long utterances, so speak sentence by sentence.
  speak(text, { onWord, lang } = {}) {
    speechSynthesis.cancel();
    const chunks = text.match(/[^.!?।]+[.!?।]*["')\]]*\s*/g) || [text];
    let wordOffset = 0;
    setCoachSpeaking(true);
    return new Promise((resolve) => {
      const done = () => { setCoachSpeaking(false); resolve(); };
      chunks.forEach((chunk, idx) => {
        const u = new SpeechSynthesisUtterance(chunk.trim());
        const v = this.voice(lang);
        if (v) { u.voice = v; u.lang = v.lang; }
        else u.lang = lang === "en" ? "en-US" : L().accents[0][0];
        u.rate = Number($("rate").value);
        const base = wordOffset;
        wordOffset += chunk.trim().split(/\s+/).length;
        if (onWord) u.onboundary = (e) => {
          if (e.name && e.name !== "word") return;
          onWord(base + chunk.trim().slice(0, e.charIndex).split(/\s+/).filter(Boolean).length);
        };
        if (idx === chunks.length - 1) { u.onend = done; u.onerror = done; }
        speechSynthesis.speak(u);
      });
    });
  },
  stop() { speechSynthesis.cancel(); setCoachSpeaking(false); },
};

function setCoachSpeaking(on) {
  for (const id of ["talkMic", "readMic"]) $(id).classList.toggle("coach-speaking", on);
  if (on) $("talkMic").querySelector(".mic-label").textContent = `${L().coach} is speaking · tap to interrupt`;
  else if (!listener.active) $("talkMic").querySelector(".mic-label").textContent = "Tap to speak";
}

// ================= speech in (recognition) =================
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Live microphone level, so the learner can see whether any sound reaches the browser.
const micMeter = {
  stream: null, ctx: null, raf: 0, peak: 0,
  async start() {
    this.peak = 0;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err.name === "NotAllowedError") throw new Error(MIC_BLOCKED);
      if (err.name === "NotFoundError") throw new Error("No microphone was found. Plug one in or pick one in your computer's sound settings, then try again.");
      return; // the meter is only a helper; recognition may still work
    }
    this.ctx = new AudioContext();
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let m = 0;
      for (const v of buf) m = Math.max(m, Math.abs(v - 128));
      const lvl = m / 128;
      this.peak = Math.max(this.peak, lvl);
      document.querySelectorAll(".mic-level i").forEach((i) => (i.style.width = Math.min(100, lvl * 250) + "%"));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  },
  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = this.ctx = null;
    document.querySelectorAll(".mic-level i").forEach((i) => (i.style.width = "0"));
  },
};

const MIC_BLOCKED = "Microphone access is blocked. Click the microphone or lock icon in the address bar, allow the microphone, and reload. On a Mac, also check System Settings › Privacy & Security › Microphone and switch on your browser.";

// Explain why no words are arriving, using what the level meter saw.
function whyNoWords(lastError) {
  if (lastError === "network") return SPEECH_NETWORK;
  if (micMeter.stream && micMeter.peak < 0.02)
    return "Your microphone isn't picking up any sound. Check it isn't muted, and that the right microphone is chosen: click the microphone icon in Chrome's address bar, or your computer's sound settings.";
  return "Sound is reaching the microphone but no words are being recognised. Speak a little louder and closer, and check the accent setting matches the language you're speaking.";
}
const SPEECH_NETWORK = "Speech recognition couldn't connect to its service. It works in Google Chrome or Microsoft Edge with an internet connection; Brave, Arc, Opera, Firefox and in-app browsers don't support it.";

const listener = {
  active: false,
  rec: null,
  // Resolves with { text, seconds } when listening stops.
  async start({ onUpdate, onHint, autoStopMs = 0, maxMs = 0 } = {}) {
    if (!SR) throw new Error("Speech recognition isn't supported in this browser. Open this page in Google Chrome or Microsoft Edge.");
    tts.stop();
    this.active = true;
    await micMeter.start().catch((err) => { this.active = false; throw err; });
    if (!this.active) { micMeter.stop(); return { text: "", seconds: 0 }; }
    let committed = "";
    let current = "";
    let silence, hintTimer, maxTimer;
    let startedAt = 0;
    let lastSpeech = 0;
    let lastError = "";
    let quickEnds = 0;
    let launchedAt = 0;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(silence); clearTimeout(hintTimer); clearTimeout(maxTimer); micMeter.stop(); };
      const finish = () => {
        cleanup();
        const text = (committed + " " + current).replace(/\s+/g, " ").trim();
        const end = lastSpeech || Date.now();
        resolve({ text, seconds: startedAt ? Math.max(1, (end - startedAt) / 1000) : 0 });
      };
      const fail = (msg) => {
        this.active = false;
        cleanup();
        try { this.rec?.abort(); } catch {}
        reject(new Error(msg));
      };
      hintTimer = setTimeout(() => { if (!startedAt && this.active) onHint?.(whyNoWords(lastError)); }, 6000);
      if (maxMs) maxTimer = setTimeout(() => this.stop(), maxMs);
      const launch = () => {
        const rec = new SR();
        rec.lang = $("lang").value;
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (e) => {
          let finals = "", interim = "";
          for (const r of e.results) (r.isFinal ? (finals += r[0].transcript + " ") : (interim += r[0].transcript));
          current = finals + interim;
          if (!startedAt) startedAt = Date.now();
          lastSpeech = Date.now();
          quickEnds = 0;
          onUpdate?.((committed + " " + current).trim());
          if (autoStopMs) { clearTimeout(silence); silence = setTimeout(() => this.stop(), autoStopMs); }
        };
        rec.onerror = (e) => {
          lastError = e.error;
          console.warn("speech recognition error:", e.error, e.message || "");
          if (e.error === "not-allowed" || e.error === "service-not-allowed")
            fail(/safari/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent)
              ? "Safari blocked speech recognition. Turn on Siri in System Settings, or use Google Chrome."
              : MIC_BLOCKED);
          else if (e.error === "audio-capture") fail("No microphone was found. Plug one in and try again.");
          else if (e.error === "network") fail(SPEECH_NETWORK);
          else if (e.error === "language-not-supported") fail(`This browser can't recognise ${$("lang").selectedOptions[0]?.textContent || "this language"}. Use Google Chrome.`);
          // "no-speech" and "aborted" are normal; onend handles them.
        };
        rec.onend = () => {
          if (!this.active) return finish();
          // Browsers end recognition after a pause; keep going until the user stops,
          // but don't spin forever if it keeps ending straight away.
          quickEnds = Date.now() - launchedAt < 1500 ? quickEnds + 1 : 0;
          if (quickEnds >= 4) return fail(`Speech recognition keeps stopping${lastError ? ` (${lastError})` : ""}. ${whyNoWords(lastError)}`);
          committed += " " + current;
          current = "";
          launch();
        };
        this.rec = rec;
        launchedAt = Date.now();
        try { rec.start(); } catch (err) { fail("Couldn't start listening: " + err.message); }
      };
      launch();
    });
  },
  stop() {
    if (!this.active) return;
    this.active = false;
    try { this.rec?.stop(); } catch {}
  },
};

function setMic(id, recording, label) {
  const b = $(id);
  b.setAttribute("aria-pressed", String(recording));
  b.querySelector(".mic-label").textContent = label;
}

// ================= settings =================
function renderTopics() {
  $("topicChips").innerHTML = "";
  for (const t of L().topics) {
    const c = el("button", "chip", t);
    c.type = "button";
    c.onclick = () => { $("topic").value = t; store.set("topic", t); };
    $("topicChips").append(c);
  }
}
function renderAccents() {
  const sel = $("lang");
  sel.innerHTML = "";
  for (const [code, label] of L().accents) { const o = el("option", null, label); o.value = code; sel.append(o); }
  const saved = store.get("lang:" + state.learn, state.learn === "en" ? store.get("lang", "en-US") : null);
  if (saved && L().accents.some(([c]) => c === saved)) sel.value = saved;
}
$("topic").value = store.get("topic", $("topic").value);
$("topic").onchange = () => store.set("topic", $("topic").value);

function setLevel(v) {
  state.level = v;
  store.set("level", v);
  for (const b of $("level").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === v));
}
$("level").onclick = (e) => { const b = e.target.closest("button"); if (b) setLevel(b.dataset.value); };
setLevel(state.level);

$("rate").value = store.get("rate", 0.95);
$("rateOut").textContent = Number($("rate").value).toFixed(2) + "×";
$("rate").oninput = () => { $("rateOut").textContent = Number($("rate").value).toFixed(2) + "×"; store.set("rate", $("rate").value); };
$("lang").onchange = () => store.set("lang:" + state.learn, $("lang").value);
$("handsFree").checked = store.get("handsFree", true);
$("handsFree").onchange = () => store.set("handsFree", $("handsFree").checked);
$("voice").onchange = () => store.set("voice:" + state.learn, $("voice").value);

speechSynthesis.onvoiceschanged = () => tts.load();
// Speech recognition only really works in Chrome, Edge and (with Siri on) Safari.
const ua = navigator.userAgent;
const badBrowser = !SR ? "Speech recognition isn't available in this browser."
  : navigator.brave ? "Brave doesn't support speech recognition."
  : /Electron|Claude\//.test(ua) ? "This in-app browser can't use the microphone."
  : /OPR\/|Arc\//.test(ua) ? "This browser may not support speech recognition."
  : "";
if (badBrowser) {
  $("supportWarning").textContent = `${badBrowser} Open this page in Google Chrome or Microsoft Edge to speak. You can still type your answers.`;
  $("supportWarning").hidden = false;
}
for (const b of document.querySelectorAll(".mic")) b.append(Object.assign(el("span", "mic-level"), { ariaHidden: "true" }), );
document.querySelectorAll(".mic-level").forEach((n) => n.append(el("i")));

$("micTest").onclick = async () => {
  if (listener.active) return listener.stop();
  const out = $("micTestResult");
  $("micTest").textContent = "Listening… say something";
  out.className = "small";
  out.textContent = "";
  try {
    const { text } = await listener.start({ autoStopMs: 2000, maxMs: 9000, onUpdate: (t) => (out.textContent = "Heard: " + t), onHint: (h) => (out.textContent = h) });
    if (text) { out.className = "small okmsg"; out.textContent = `✓ It works. Heard: “${text}”`; }
    else { out.className = "small err"; out.textContent = whyNoWords(""); }
  } catch (err) {
    out.className = "small err";
    out.textContent = err.message;
  } finally {
    $("micTest").textContent = "Test microphone";
  }
};

const topic = () => $("topic").value.trim() || "Everyday life";

// ================= stats & word bank =================
function renderStats() {
  $("statTurns").textContent = state.turns;
  $("statFixes").textContent = state.corrections.length;
  $("statFillers").textContent = state.fillers;
  $("statWpm").textContent = state.wpmSamples.length
    ? Math.round(state.wpmSamples.reduce((a, b) => a + b, 0) / state.wpmSamples.length)
    : "–";
}
function addVocab(list) {
  for (const v of list || []) {
    if (!v?.word || state.vocab.some((x) => x.word.toLowerCase() === v.word.toLowerCase())) continue;
    state.vocab.unshift(v);
  }
  state.vocab = state.vocab.slice(0, 60);
  store.set(vocabKey(state.learn), state.vocab);
  renderVocab();
}
function renderVocab() {
  const ul = $("vocabList");
  ul.innerHTML = "";
  for (const v of state.vocab) {
    const li = el("li");
    li.title = v.example || "";
    li.append(el("strong", null, v.word));
    if (v.romanized) li.append(document.createTextNode(" "), el("span", "roman", v.romanized));
    li.append(el("span", "meaning", v.meaning));
    li.onclick = () => tts.speak(`${v.word}. ${v.example || ""}`);
    ul.append(li);
  }
  $("vocabEmpty").hidden = state.vocab.length > 0;
  $("vocabCount").textContent = state.vocab.length ? `· ${state.vocab.length}` : "";
}
renderStats();

function trackSpeech(text, seconds) {
  const n = words(text).length;
  if (n >= 5 && seconds > 0) state.wpmSamples.push((n / seconds) * 60);
  state.fillers += (text.match(L().fillers) || []).length;
}

// ================= tabs =================
function showTab(which) {
  const read = which === "read";
  $("tabRead").setAttribute("aria-selected", String(read));
  $("tabTalk").setAttribute("aria-selected", String(!read));
  $("readView").hidden = !read;
  $("talkView").hidden = read;
}
$("tabRead").onclick = () => showTab("read");
$("tabTalk").onclick = () => showTab("talk");

// ================= reading =================
function renderPassage() {
  const box = $("passage");
  box.innerHTML = "";
  const p = el("p");
  const vocabSet = new Set((state.passage.vocabulary || []).map((v) => norm(v.word)));
  const tokens = state.passage.passage.split(/\s+/).filter(Boolean);
  state.passageWords = [];
  tokens.forEach((tok, i) => {
    const s = el("span", "w", tok);
    s.dataset.i = state.passageWords.length;
    if (vocabSet.has(norm(tok))) s.classList.add("vocab-word");
    p.append(s, document.createTextNode(i < tokens.length - 1 ? " " : ""));
    state.passageWords.push(norm(tok));
  });
  box.append(p);
  box.lang = state.learn;
  const hasHelp = Boolean(state.passage.romanized || state.passage.english);
  $("passageHelp").hidden = !hasHelp;
  $("passageRoman").textContent = state.passage.romanized || "";
  $("passageEnglish").textContent = state.passage.english || "";
}
const wordSpans = () => $("passage").querySelectorAll(".w");

$("newPassageBtn").onclick = async () => {
  if (state.busy) return;
  state.busy = true;
  $("newPassageBtn").disabled = true;
  $("readResult").hidden = true;
  $("passageTitle").textContent = "Writing a passage…";
  try {
    state.passage = await api("passage", { topic: topic(), level: state.level });
    $("passageTitle").textContent = state.passage.title;
    $("passageMeta").textContent = `${state.level} · ${state.passage.passage.split(/\s+/).length} words · dotted words go to your word bank`;
    renderPassage();
    addVocab(state.passage.vocabulary);
    $("listenBtn").disabled = false;
    $("readMic").disabled = false;
  } catch (err) {
    $("passageTitle").textContent = "Get a passage on your topic";
    status(err.message, true, 7000);
  } finally {
    state.busy = false;
    $("newPassageBtn").disabled = false;
  }
};

$("listenBtn").onclick = async () => {
  if (!state.passage) return;
  const spans = wordSpans();
  await tts.speak(state.passage.passage, {
    onWord: (i) => spans.forEach((s, k) => s.classList.toggle("speaking", k === i)),
  });
  spans.forEach((s) => s.classList.remove("speaking"));
};

$("readMic").onclick = async () => {
  if (listener.active) return listener.stop();
  if (!state.passage) return;
  const spans = wordSpans();
  spans.forEach((s) => s.classList.remove("ok", "miss", "reached"));
  $("readResult").hidden = true;
  setMic("readMic", true, "Stop — I'm done");
  $("readLive").textContent = "Listening… read the passage out loud.";
  let reached = 0;
  try {
    const { text, seconds } = await listener.start({
      autoStopMs: $("handsFree").checked ? 3500 : 0,
      onHint: (h) => ($("readLive").textContent = h),
      onUpdate: (t) => {
        // Follow along: move a cursor forward through the passage as words match.
        const heard = words(t);
        let p = 0;
        for (const h of heard) {
          for (let k = p; k < Math.min(p + 5, state.passageWords.length); k++)
            if (state.passageWords[k] === h) { p = k + 1; break; }
        }
        reached = p;
        spans.forEach((s, k) => s.classList.toggle("reached", k < reached));
        $("readLive").textContent = "…" + t.split(" ").slice(-10).join(" ");
      },
    });
    setMic("readMic", false, "Start reading");
    spans.forEach((s) => s.classList.remove("reached"));
    if (!text) { $("readLive").textContent = "I didn't hear anything. Check your microphone and try again."; return; }
    await gradeReading(text, seconds);
  } catch (err) {
    setMic("readMic", false, "Start reading");
    $("readLive").textContent = "";
    status(err.message, true, 8000);
  }
};

async function gradeReading(text, seconds) {
  const heard = words(text);
  const { matched, count } = align(state.passageWords, heard);
  const spans = wordSpans();
  matched.forEach((ok, i) => spans[i].classList.add(ok ? "ok" : "miss"));
  spans.forEach((s, i) => { if (!matched[i]) s.onclick = () => tts.speak(s.textContent.replace(/[^\p{L}\p{M}\p{N}'’-]/gu, "")); });
  const wpm = Math.round((heard.length / seconds) * 60);
  trackSpeech(text, seconds);
  state.turns++;
  renderStats();
  const accuracy = Math.round((count / state.passageWords.length) * 100);

  // Show what we can work out in the browser straight away.
  $("readResult").hidden = false;
  $("readScore").textContent = accuracy;
  $("readFeedback").textContent = "Words in red weren't clear. Tap one to hear it. Getting tips from your coach…";
  $("readFacts").textContent = "";
  $("readFacts").append(
    el("span", null, `${accuracy}% words recognised`),
    el("span", null, `${wpm} words/min`),
    el("span", null, wpm < 100 ? "pace: slow, that's fine" : wpm > 170 ? "pace: fast, slow down a little" : "pace: natural"),
  );
  $("problemWords").innerHTML = "";
  $("readLive").textContent = "";
  try {
    const fb = await api("reading", { passage: state.passage.passage, transcript: text, level: state.level, seconds: Math.round(seconds) });
    $("readScore").textContent = Math.round(fb.score);
    $("readFeedback").textContent = fb.spoken_feedback;
    if (fb.feedback_english) $("readFeedback").append(el("span", "gloss", fb.feedback_english));
    const ul = $("problemWords");
    ul.innerHTML = "";
    for (const pw of fb.problem_words) {
      const li = el("li");
      li.append(el("strong", null, pw.word), document.createTextNode(" "), el("span", "heard", pw.heard_as === "skipped" ? "skipped" : `heard as “${pw.heard_as}”`), el("span", "tip", pw.tip));
      li.title = "Hear it";
      li.onclick = () => tts.speak(pw.word);
      ul.append(li);
    }
    await tts.speak(fb.spoken_feedback);
  } catch (err) {
    const missed = matched.filter((ok) => !ok).length;
    $("readFeedback").textContent = `You read ${count} of ${state.passageWords.length} words clearly${missed ? `; ${missed} are marked in red` : ""}. Spoken tips need the AI: ${err.message}`;
    if (!serverHasKey) showKeyBox();
  }
}

$("retryReadBtn").onclick = () => $("readMic").click();
$("discussBtn").onclick = () => { showTab("talk"); startConversation(true); };

// ================= conversation =================
function addMsg(who, text, { speakable = true, romanized = "", english = "" } = {}) {
  $("chatEmpty").hidden = true;
  const m = el("div", "msg " + who);
  m.append(el("span", "who", who === "coach" ? L().coach : "You"));
  const b = el("div", "bubble", text);
  b.lang = state.learn;
  m.append(b);
  if (romanized || english) {
    const g = el("div", "gloss");
    if (romanized) g.append(el("span", "roman", romanized));
    if (english) g.append(el("span", "en", english));
    m.append(g);
  }
  if (who === "coach" && speakable) {
    const r = el("button", "replay", "Hear again");
    r.type = "button";
    r.onclick = () => tts.speak(text);
    m.append(r);
  }
  $("chat").append(m);
  $("chat").scrollTop = $("chat").scrollHeight;
  return m;
}

function setTalkEnabled(on) {
  $("talkMic").disabled = !on || !SR;
  $("typeInput").disabled = !on;
  $("typeSend").disabled = !on;
}

async function startConversation(fromPassage = false) {
  if (state.busy) return;
  tts.stop();
  $("chat").querySelectorAll(".msg").forEach((n) => n.remove());
  $("report").hidden = true;
  state.history = [{ role: "user", content: START }];
  $("talkTitle").textContent = fromPassage && state.passage ? `Discussing “${state.passage.title}”` : `Talking about ${topic().toLowerCase()}`;
  $("startTalkBtn").textContent = "Restart conversation";

  if (fromPassage && state.passage) {
    const opener = `${L().opener} ${state.passage.discussion_question}`;
    state.history.push({ role: "assistant", content: opener });
    const english = state.passage.discussion_question_english ? `${L().openerEnglish} ${state.passage.discussion_question_english}` : "";
    addMsg("coach", opener, { english });
    setTalkEnabled(true);
    await tts.speak(opener);
    autoListen();
    return;
  }
  await coachTurn();
}
$("startTalkBtn").onclick = () => startConversation(false);

async function coachTurn(userMsgEl) {
  state.busy = true;
  setTalkEnabled(false);
  const thinking = addMsg("coach", "…", { speakable: false });
  thinking.classList.add("thinking");
  try {
    const data = await api("chat", {
      topic: topic(),
      level: state.level,
      history: state.history,
      passage: $("talkTitle").textContent.startsWith("Discussing") ? state.passage?.passage : undefined,
    });
    thinking.remove();

    if (userMsgEl) renderCorrections(userMsgEl, data);
    state.history.push({ role: "assistant", content: data.reply });
    const coachEl = addMsg("coach", data.reply, { romanized: data.reply_romanized, english: data.reply_english });
    if (data.new_words?.length) {
      const nw = el("div", "newwords");
      nw.append(document.createTextNode("Try using: "));
      data.new_words.forEach((v, i) => {
        if (i) nw.append(document.createTextNode(", "));
        nw.append(el("strong", null, v.word), document.createTextNode(` (${v.romanized ? v.romanized + ": " : ""}${v.meaning})`));
      });
      coachEl.append(nw);
      addVocab(data.new_words);
    }
    state.busy = false;
    setTalkEnabled(true);
    const spoken = [data.spoken_correction, data.reply].filter(Boolean).join(" ");
    await tts.speak(spoken);
    autoListen();
  } catch (err) {
    thinking.remove();
    state.busy = false;
    setTalkEnabled(true);
    // Drop the unanswered turn so the learner can try again.
    if (state.history.at(-1)?.role === "user" && state.history.length > 1) state.history.pop();
    status(err.message, true, 8000);
  }
}

function renderCorrections(userMsgEl, data) {
  if (!data.corrections?.length) {
    userMsgEl.append(el("div", "good", "✓ That sounded natural" + (data.fluency_note ? ` · ${data.fluency_note}` : "")));
    return;
  }
  for (const c of data.corrections) {
    state.corrections.push(c);
    const f = el("div", "fix");
    f.append(el("span", "kind", c.kind));
    const line = el("div");
    line.lang = state.learn;
    line.append(el("del", null, c.you_said), document.createTextNode("  →  "), el("ins", null, c.better));
    f.append(line);
    if (c.better_romanized) f.append(el("span", "roman", c.better_romanized));
    f.append(el("span", "why", c.why));
    const rep = el("button", "repeat", "Repeat it");
    rep.type = "button";
    const out = el("span", "repeat-result");
    rep.onclick = () => practise(c.better, rep, out);
    f.append(rep, out);
    userMsgEl.append(f);
  }
  if (data.fluency_note) userMsgEl.append(el("span", "small muted", data.fluency_note));
  renderStats();
}

async function practise(target, btn, out) {
  if (listener.active) return listener.stop();
  await tts.speak(L().say(target));
  btn.textContent = "Listening… (tap to stop)";
  out.textContent = "";
  try {
    const { text } = await listener.start({ autoStopMs: 1600 });
    btn.textContent = "Repeat it";
    const score = similarity(target, text);
    if (score >= 0.8) { out.textContent = " ✓ Perfect"; out.style.color = "var(--ok)"; tts.speak(L().perfect); }
    else { out.textContent = ` I heard: “${text || "nothing"}”. Try again.`; out.style.color = "var(--bad)"; tts.speak(L().close); }
  } catch (err) {
    btn.textContent = "Repeat it";
    status(err.message, true, 8000);
  }
}

function autoListen() {
  if ($("handsFree").checked && SR && !state.busy && !$("talkView").hidden) $("talkMic").click();
}

async function sendLearnerTurn(text, seconds) {
  text = text.trim();
  if (!text || state.busy) return;
  if (seconds) trackSpeech(text, seconds);
  state.turns++;
  renderStats();
  const msg = addMsg("me", text);
  state.history.push({ role: "user", content: text });
  await coachTurn(msg);
}

$("talkMic").onclick = async () => {
  if (listener.active) return listener.stop();
  if (speechSynthesis.speaking) tts.stop();
  if (state.busy) return;
  if (state.history.length === 0) return startConversation(false);
  setMic("talkMic", true, "Listening · tap when done");
  $("talkLive").textContent = "Listening…";
  try {
    const { text, seconds } = await listener.start({
      autoStopMs: $("handsFree").checked ? 1800 : 0,
      onUpdate: (t) => ($("talkLive").textContent = t),
      onHint: (h) => ($("talkLive").textContent = h),
    });
    setMic("talkMic", false, "Tap to speak");
    $("talkLive").textContent = "";
    if (text) await sendLearnerTurn(text, seconds);
  } catch (err) {
    setMic("talkMic", false, "Tap to speak");
    $("talkLive").textContent = "";
    status(err.message, true, 8000);
  }
};

$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("typeInput").value;
  $("typeInput").value = "";
  sendLearnerTurn(v, 0);
};

// ================= report =================
$("endBtn").onclick = async () => {
  tts.stop();
  listener.stop();
  const spoken = state.history.filter((m) => m.role === "user" && m.content !== START);
  if (!spoken.length && !state.turns) return status("Read a passage or have a short conversation first, then end the session.");
  $("endBtn").disabled = true;
  status("Preparing your report…", false, 0);
  try {
    const r = await api("summary", {
      topic: topic(),
      level: state.level,
      history: state.history.filter((m) => m.content !== START),
      corrections: state.corrections,
    });
    $("status").hidden = true;
    $("reportOverall").textContent = r.overall;
    const fill = (id, items) => { const ul = $(id); ul.innerHTML = ""; items.forEach((t) => ul.append(el("li", null, t))); };
    fill("reportStrengths", r.strengths);
    fill("reportFocus", r.focus_areas);
    const pr = $("reportPractice");
    pr.innerHTML = "";
    r.practice_sentences.forEach((t, i) => {
      const li = el("li");
      const said = el("span", null, t);
      said.lang = state.learn;
      li.append(said);
      if (r.practice_romanized?.[i]) li.append(el("span", "roman", r.practice_romanized[i]));
      li.title = "Hear it";
      li.onclick = () => tts.speak(t);
      pr.append(li);
    });
    $("report").hidden = false;
    $("report").scrollIntoView({ behavior: "smooth" });
    tts.speak(r.overall, { lang: "en" });
  } catch (err) {
    status(err.message, true, 8000);
  } finally {
    $("endBtn").disabled = false;
  }
};
$("closeReport").onclick = () => ($("report").hidden = true);

// ================= API key =================
let serverHasKey = false;
// The shared, hosted site never asks visitors for a key: the owner sets it on the host.
// Only a copy running on this computer (localhost) lets you paste one.
let keyLocked = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
if (keyLocked) $("changeKey").hidden = true;
function showKeyBox(canCancel = false) {
  if (keyLocked) return;
  $("keyBox").hidden = false;
  $("keyCancel").hidden = !canCancel;
  $("keyMsg").textContent = "";
  $("keyInput").focus();
}
function setKeyState(has, model) {
  serverHasKey = has;
  $("keyState").textContent = has ? `connected (${model})` : "not connected";
  $("keyBox").hidden = has;
}
$("changeKey").onclick = () => showKeyBox(serverHasKey);
$("keyCancel").onclick = () => ($("keyBox").hidden = true);
$("keyBox").onsubmit = async (e) => {
  e.preventDefault();
  $("keySave").disabled = true;
  $("keyMsg").className = "small";
  $("keyMsg").textContent = "Checking the key with Gemini…";
  try {
    const r = await fetch("/api/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: $("keyInput").value }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    $("keyInput").value = "";
    setKeyState(true, data.model);
    status("Key saved. Press New passage or Start conversation.");
  } catch (err) {
    $("keyMsg").className = "small err";
    $("keyMsg").textContent = err.message || "Couldn't save the key.";
  } finally {
    $("keySave").disabled = false;
  }
};
// The free host sleeps when idle, so the first check can fail while it wakes up: keep trying.
async function checkStatus(attempt = 0) {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    keyLocked = keyLocked || Boolean(d.locked);
    if (keyLocked) {
      $("changeKey").hidden = true;
      $("keyBox").hidden = true;
      serverHasKey = d.hasKey;
      $("keyState").textContent = d.hasKey ? "connected" : "not set up yet";
    } else setKeyState(d.hasKey, d.model);
  } catch {
    $("keyState").textContent = attempt < 20 ? "waking up the server…" : "server not reachable";
    if (attempt < 20) setTimeout(() => checkStatus(attempt + 1), 5000);
  }
}
checkStatus();

// ================= starter passages =================
// So "Start reading" works right away, before any passage has been generated.
const SAMPLES = {
  en: {
    title: "A Weekend in Lisbon on a Budget",
    passage: "Last spring, my friend and I spent a long weekend in Lisbon without spending much money. We stayed in a small hostel near the river and walked almost everywhere. In the mornings, we bought fresh bread and coffee from a local bakery. The city is full of hills, so our legs were tired, but the views from the top were worth every step. We visited free museums on Sunday, listened to street musicians, and watched the sunset from a quiet viewpoint. On our last evening, we shared a simple dinner of grilled sardines and salad. It cost less than a cinema ticket at home. I learned that travelling cheaply is not about missing out. It is about slowing down and noticing the small things.",
    vocabulary: [
      { word: "hostel", meaning: "a cheap place to stay, often with shared rooms", example: "We booked a hostel near the station." },
      { word: "viewpoint", meaning: "a high place with a good view", example: "The viewpoint was crowded at sunset." },
      { word: "worth", meaning: "good enough to justify the effort or cost", example: "The long walk was worth it." },
    ],
    discussion_question: "Have you ever travelled somewhere on a small budget? What did you do to save money?",
  },
  hi: {
    title: "कम पैसों में जयपुर की सैर",
    passage: "पिछली सर्दियों में मैं और मेरी दोस्त तीन दिन के लिए जयपुर गए। हमने ज़्यादा पैसे खर्च नहीं किए। हम स्टेशन के पास एक छोटे से गेस्टहाउस में रुके और ज़्यादातर जगह पैदल घूमे। सुबह हम सड़क किनारे की दुकान से गरम चाय और कचौड़ी खाते थे। दिन में हमने पुराने किले और रंगीन बाज़ार देखे। शाम को हम एक ऊँची जगह से सूरज ढलते हुए देखते थे। आख़िरी रात हमने एक ढाबे पर दाल, रोटी और सब्ज़ी खाई। पूरा खाना एक फ़िल्म के टिकट से भी सस्ता था। इस सफ़र से मैंने सीखा कि कम पैसों में भी बहुत मज़ा किया जा सकता है।",
    romanized: "Pichhli sardiyon mein main aur meri dost teen din ke liye Jaipur gaye. Humne zyada paise kharch nahin kiye. Hum station ke paas ek chhote se guesthouse mein ruke aur zyadatar jagah paidal ghoome. Subah hum sadak kinare ki dukaan se garam chai aur kachori khaate the. Din mein humne purane kile aur rangeen bazaar dekhe. Shaam ko hum ek oonchi jagah se sooraj dhalte hue dekhte the. Aakhiri raat humne ek dhaabe par daal, roti aur sabzi khaayi. Poora khaana ek film ke ticket se bhi sasta tha. Is safar se maine seekha ki kam paison mein bhi bahut maza kiya ja sakta hai.",
    english: "Last winter, my friend and I went to Jaipur for three days. We didn't spend much money. We stayed in a small guesthouse near the station and walked to most places. In the mornings we had hot tea and kachori from a roadside stall. During the day we saw old forts and colourful markets. In the evenings we watched the sunset from a high spot. On the last night we ate dal, roti and vegetables at a dhaba. The whole meal was cheaper than a film ticket. On this trip I learned that you can have a lot of fun even with little money.",
    vocabulary: [
      { word: "सफ़र", romanized: "safar", meaning: "journey, trip", example: "यह सफ़र बहुत अच्छा था।" },
      { word: "पैदल", romanized: "paidal", meaning: "on foot", example: "हम पैदल बाज़ार गए।" },
      { word: "सस्ता", romanized: "sasta", meaning: "cheap", example: "यहाँ खाना सस्ता है।" },
      { word: "खर्च करना", romanized: "kharch karna", meaning: "to spend (money)", example: "मैंने ज़्यादा पैसे खर्च नहीं किए।" },
    ],
    discussion_question: "क्या आप कभी कम पैसों में कहीं घूमने गए हैं? आपने पैसे कैसे बचाए?",
    discussion_question_english: "Have you ever travelled somewhere on little money? How did you save money?",
  },
};

function loadSample() {
  state.passage = SAMPLES[state.learn];
  $("passageTitle").textContent = state.passage.title;
  $("passageTitle").lang = state.learn;
  $("passageMeta").textContent = "Sample passage · read it now, or press New passage for one on your topic";
  $("readResult").hidden = true;
  renderPassage();
  $("listenBtn").disabled = false;
  $("readMic").disabled = !SR;
}

function resetConversation() {
  tts.stop();
  listener.stop();
  state.history = [];
  state.corrections = [];
  $("chat").querySelectorAll(".msg").forEach((n) => n.remove());
  $("chatEmpty").hidden = false;
  $("startTalkBtn").textContent = "Start conversation";
  $("talkTitle").textContent = "Talk about your topic";
  $("report").hidden = true;
  setTalkEnabled(false);
  $("talkMic").disabled = !SR;
}

// Switch between learning English and Hindi.
function setLearn(code, { initial = false } = {}) {
  state.learn = code;
  store.set("learn", code);
  for (const b of $("learn").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === code));
  document.querySelectorAll(".coachName").forEach((n) => (n.textContent = L().coach));
  $("talkMic").querySelector(".mic-label").textContent = "Tap to speak";
  state.vocab = store.get(vocabKey(code), []);
  renderVocab();
  renderTopics();
  renderAccents();
  tts.load();
  loadSample();
  if (!initial) { resetConversation(); status(`Now practising ${L().name}. Your coach is ${L().coach}.`); }
}
$("learn").onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.value !== state.learn) setLearn(b.dataset.value); };

setLearn(state.learn, { initial: true });
setTalkEnabled(false);
$("talkMic").disabled = !SR;
