// Speaking coach (English and Hindi): a tiny local server that serves the web app and
// talks to Gemini. Speech recognition and text-to-speech run in the browser.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, ApiError } from "@google/genai";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
let MODEL = process.env.GEMINI_MODEL || ""; // chosen from the key's available models when empty
let API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
// Fail fast: the SDK's default is 5 attempts with up to a minute between them, which leaves a
// learner waiting for minutes when Gemini is overloaded. We fall back to other models instead.
const makeClient = (apiKey) => new GoogleGenAI({ apiKey, httpOptions: { timeout: 20000, retryOptions: { attempts: 1 } } });
let ai = makeClient(API_KEY || "missing");
let CANDIDATES = []; // models this key can use, best first
const GONE = new Set(); // models Google says this key can't use (404)
const cooldown = new Map(); // model -> time until which we skip it because Google said it was overloaded
const coolingDown = (m) => (cooldown.get(m) || 0) > Date.now();
// On a public host (Render sets RENDER), visitors can't change the key and usage is limited per visitor.
const HOSTED = Boolean(process.env.RENDER || process.env.HOSTED);
const LIMIT_PER_HOUR = Number(process.env.LIMIT_PER_HOUR || 60);
const usage = new Map(); // ip -> timestamps of AI requests in the last hour
function overLimit(req) {
  if (!HOSTED) return false;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const recent = (usage.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= LIMIT_PER_HOUR) { usage.set(ip, recent); return true; }
  recent.push(now);
  usage.set(ip, recent);
  if (usage.size > 5000) for (const [k, v] of usage) if (!v.some((t) => now - t < 3600_000)) usage.delete(k);
  return false;
}
async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 300_000) throw new Error("That request was too large.");
  }
  return body;
}

// Turn Google's error into advice a learner can act on, keeping Google's own words.
function explainGoogleError(status, reason, message) {
  const g = message ? ` (Google says: ${message})` : "";
  if (reason === "API_KEY_INVALID" || /API key not valid/i.test(message))
    return `Google says this isn't a valid Gemini API key. Copy it again from aistudio.google.com/apikey using the copy button next to the key. Make sure it's the API key itself, not the project name or ID.`;
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(reason + message))
    return `This key's Google Cloud project doesn't have the Gemini API turned on. The easiest fix: create a new key at aistudio.google.com/apikey (choose "Create API key in new project").${g}`;
  if (status === 403 && /API_KEY_SERVICE_BLOCKED|restricted|referer|IP address/i.test(reason + message))
    return `This key is restricted so it can't call the Gemini API. Create an unrestricted key at aistudio.google.com/apikey.${g}`;
  if (status === 400 && /location|region|not supported/i.test(message))
    return `The Gemini API isn't available in your country or region for this key.${g}`;
  if (status === 503 || status === 500)
    return `Gemini is very busy right now. Wait a few seconds and try again.`;
  if (status === 429)
    return `This key has used up its free quota for now. Wait a minute and try again, or check your limits in Google AI Studio.${g}`;
  return `Gemini returned error ${status}.${g}`;
}

// Check a key against Google and choose a model it can actually use.
async function checkKey(key) {
  let res;
  try {
    res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
  } catch {
    throw new Error("Couldn't reach Google to check the key. Check your internet connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const reason = (e.details || []).map((d) => d.reason || "").join(" ") + " " + (e.status || "");
    console.error("[key check]", res.status, JSON.stringify(e));
    const shape = ` You pasted ${key.length} characters starting with "${key.slice(0, 4)}"; Gemini keys are usually 39 characters starting with "AIza".`;
    throw new Error(explainGoogleError(res.status, reason, e.message || "") + (reason.includes("API_KEY_INVALID") ? shape : ""));
  }
  const names = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
  if (!names.length) throw new Error("This key works but can't use any Gemini text models. Create a new key at aistudio.google.com/apikey.");
  // Newest stable Flash models first (fast replies matter for a voice coach), then other Gemini models.
  const version = (n) => Number((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const byNewest = (a, b) => version(b) - version(a);
  const stableFlash = names.filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort(byNewest);
  const liteFlash = names.filter((n) => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n)).sort(byNewest);
  const otherFlash = names.filter((n) => /^gemini-.*flash/.test(n) && !/image|tts|audio|live|lite|exp|preview/.test(n) && !stableFlash.includes(n)).sort(byNewest);
  const others = names.filter((n) => /^gemini-/.test(n) && !/image|tts|audio|live|embedding|exp/.test(n)).sort(byNewest);
  const candidates = [...new Set([...(MODEL && names.includes(MODEL) ? [MODEL] : []), ...stableFlash, ...liteFlash, ...otherFlash, ...others])];
  if (!candidates.length) throw new Error("This key works but can't use any Gemini text models. Create a new key at aistudio.google.com/apikey.");
  return candidates;
}

// Try models in order until one answers. Google lists some retired models that new keys can't use (404).
async function pickWorkingModel(key, candidates) {
  const test = makeClient(key);
  let lastErr;
  let busyModel = null; // the key works but this model was overloaded: usable later
  const ordered = candidates.filter((m) => !GONE.has(m)).sort((a, b) => coolingDown(a) - coolingDown(b));
  for (const model of ordered.slice(0, 10)) {
    try {
      await test.models.generateContent({ model, contents: "Reply with OK." });
      return { model, client: test };
    } catch (err) {
      lastErr = err;
      if (err instanceof ApiError && (err.status === 404 || err.status === 403 && /model/i.test(err.message))) {
        console.log(`Model ${model} isn't available for this key, trying the next one`);
        GONE.add(model);
        continue;
      }
      if (err instanceof ApiError && [429, 500, 503].includes(err.status)) {
        console.log(`Model ${model} is busy (${err.status}), trying the next one`);
        busyModel ??= model;
        cooldown.set(model, Date.now() + 90_000);
        continue;
      }
      console.error("[key test]", err);
      if (err instanceof ApiError) throw new Error(explainGoogleError(err.status, "", err.message));
      throw new Error(`Couldn't test the key: ${err.message}`);
    }
  }
  if (busyModel) { console.log(`All models busy; using ${busyModel} anyway`); return { model: busyModel, client: test }; }
  throw new Error(`None of the Gemini models tried worked with this key. Last error: ${lastErr?.message || "unknown"}`);
}

// Save a key pasted in the page: check it works, then write it to .env.
async function setKey(key) {
  key = String(key || "").trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("Paste your Gemini API key first.");
  const candidates = await checkKey(key);
  const { model, client: test } = await pickWorkingModel(key, candidates);
  CANDIDATES = candidates.filter((m) => !GONE.has(m));
  console.log(`Models to use, best first: ${CANDIDATES.join(", ")}`);
  API_KEY = key;
  MODEL = model;
  ai = test;
  const envPath = path.join(here, ".env");
  let lines = [];
  try { lines = (await fs.readFile(envPath, "utf8")).split("\n").filter((l) => l && !/^GEMINI_(API_KEY|MODEL)=/.test(l)); } catch {}
  await fs.writeFile(envPath, [`GEMINI_API_KEY=${key}`, `GEMINI_MODEL=${model}`, ...lines].join("\n") + "\n", { mode: 0o600 });
  return { hasKey: true, model: MODEL };
}

const ENGLISH_RULES = `You are Maya, a warm, encouraging English speaking coach.
The learner is practising spoken English through speech recognition, so their text is a transcript:
- Ignore capitalisation and punctuation; the recogniser adds those, not the learner.
- A word that makes no sense in context is often a pronunciation problem: the recogniser heard a different word. Flag it as a likely pronunciation issue, not a vocabulary mistake.
- Correct real problems only: grammar, wrong word choice, unnatural phrasing, missing articles, tense, prepositions. Do not nitpick casual but correct speech.
- Give at most 3 corrections per turn, the most important first.
- Everything you write in "spoken" fields will be read aloud by a text-to-speech voice. Write it the way a person talks: short sentences, no lists, no markdown, no emoji, no quotation marks around words longer than a phrase.
- Fields marked "Hindi only" must be empty strings (or empty lists).
Reply only with JSON matching the requested schema.`;

const HINDI_RULES = `You are Meera, a warm, encouraging Hindi speaking coach.
The learner reads English well and is practising spoken Hindi through speech recognition (hi-IN), so their text is a transcript in Devanagari:
- Ignore punctuation, missing nukta dots and chandrabindu/anusvara differences; the recogniser causes those, not the learner.
- A word that makes no sense in context is often a pronunciation problem: the recogniser heard a different word. Flag it as a likely pronunciation issue.
- English words that Hindi speakers use every day (station, ticket, phone, office) are fine. If the learner says a whole phrase in English because they don't know the Hindi, give them the Hindi as a "word choice" correction.
- Correct real problems only: gender agreement of verbs and adjectives, postpositions (ने, को, में, पर, से), tense and verb endings, word order, mixing aap/tum, wrong word choice, unnatural phrasing. Do not nitpick casual but correct speech.
- Give at most 3 corrections per turn, the most important first.
- Use everyday spoken Hindi (Hindustani), not formal Sanskrit-heavy words, especially for beginners.
- Write all Hindi in Devanagari. Fields that ask for romanized text use simple everyday romanization without diacritics, e.g. "main ghar ja raha hoon".
- Explanations (why, tip, meaning, strengths, focus areas, overall) are in simple English, because the learner reads them.
- Fields named "spoken" and the conversational reply are read aloud by a Hindi voice: write them in Hindi at the learner's level, short sentences, no lists, no markdown, no emoji, no English explanations.
Reply only with JSON matching the requested schema.`;

const LANGS = {
  en: { name: "English", rules: ENGLISH_RULES },
  hi: { name: "Hindi", rules: HINDI_RULES },
};
const lang = (code) => LANGS[code] || LANGS.en;

const LEVEL_GUIDE = {
  beginner: "CEFR A2: short sentences, everyday words, present and past simple.",
  intermediate: "CEFR B1-B2: varied sentences, some idioms, common phrasal verbs or expressions.",
  advanced: "CEFR C1: rich vocabulary, nuance, complex structures.",
};

// ---------- Schemas ----------
const HINDI_ONLY = "Hindi only; empty string for English";
const Vocab = z.object({
  word: z.string(),
  romanized: z.string().describe(`${HINDI_ONLY}. The word in Roman letters`),
  meaning: z.string().describe("short meaning in English"),
  example: z.string().describe("example sentence in the language being learned"),
});

const PassageSchema = z.object({
  title: z.string(),
  passage: z.string().describe("100-170 words, plain prose, no headings, no hyphenated compounds, numbers written as words"),
  romanized: z.string().describe(`${HINDI_ONLY}. The whole passage in Roman letters`),
  english: z.string().describe(`${HINDI_ONLY}. English translation of the passage`),
  vocabulary: z.array(Vocab).describe("4-6 useful words from the passage"),
  discussion_question: z.string().describe("One open question to start a conversation about the passage, in the language being learned"),
  discussion_question_english: z.string().describe(`${HINDI_ONLY}. English translation of the question`),
});

const ReadingSchema = z.object({
  score: z.number().describe("0-100 reading accuracy and fluency"),
  spoken_feedback: z.string().describe("2-4 spoken sentences: praise, the main issues, one tip"),
  feedback_english: z.string().describe(`${HINDI_ONLY}. English translation of spoken_feedback`),
  problem_words: z.array(
    z.object({
      word: z.string().describe("word from the passage"),
      heard_as: z.string().describe("what the recogniser heard, or 'skipped'"),
      tip: z.string().describe("short pronunciation tip in English, e.g. stress or sound"),
    }),
  ),
});

const ChatSchema = z.object({
  corrections: z.array(
    z.object({
      you_said: z.string(),
      better: z.string(),
      better_romanized: z.string().describe(`${HINDI_ONLY}. "better" in Roman letters`),
      why: z.string().describe("one short sentence in English"),
      kind: z.enum(["grammar", "word choice", "phrasing", "pronunciation"]),
    }),
  ),
  spoken_correction: z
    .string()
    .describe("If there are corrections: a short friendly spoken tip saying the better version. Empty string if none."),
  reply: z.string().describe("Your conversational reply: react to what they said and ask one follow-up question. 1-3 sentences."),
  reply_romanized: z.string().describe(`${HINDI_ONLY}. reply in Roman letters`),
  reply_english: z.string().describe(`${HINDI_ONLY}. English translation of reply`),
  new_words: z.array(Vocab).describe("0-2 words or phrases they could use to sound more natural on this topic"),
  fluency_note: z.string().describe("A few words in English on fluency or confidence, or empty string"),
});

const SummarySchema = z.object({
  overall: z.string().describe("2-3 sentences in English summarising the session, written to be read aloud"),
  strengths: z.array(z.string()),
  focus_areas: z.array(z.string()),
  practice_sentences: z.array(z.string()).describe("3 sentences in the language being learned to read aloud that target the focus areas"),
  practice_romanized: z.array(z.string()).describe(`${HINDI_ONLY}: the same sentences in Roman letters; empty list for English`),
});

// ---------- Gemini call ----------
function toGeminiSchema(schema) {
  const json = z.toJSONSchema(schema);
  delete json.$schema; // not supported by Gemini
  return json;
}

// messages: [{role:"user"|"assistant", content:string}]
// If choosing a model failed at startup (e.g. Google was busy), try again when someone needs it.
let settingUp = null;
async function ensureModel() {
  if (MODEL || !API_KEY) return;
  settingUp ??= setKey(API_KEY).finally(() => { settingUp = null; });
  await settingUp;
}

const isBusy = (err) =>
  (err instanceof ApiError && [429, 500, 503, 504].includes(err.status)) ||
  (!(err instanceof ApiError) && /time|abort/i.test(`${err?.name} ${err?.message}`));

// Keep live turns fast: think as little as the model allows, unless we want a deeper answer.
function thinkingFor(model, deeper) {
  if (deeper) return undefined;
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  const major = Number((model.match(/^gemini-(\d+)/) || [])[1] || 0);
  return major >= 3 ? { thinkingLevel: "LOW" } : undefined;
}

// Try the current model, and if Google says it's overloaded, move on to the next one that answers.
// Overloaded models are skipped for 90 seconds so the next reply doesn't wait on them again.
async function generate(contents, baseConfig, deeper) {
  const order = [MODEL, ...CANDIDATES.filter((m) => m !== MODEL)]
    .filter((m) => !GONE.has(m))
    .sort((a, b) => coolingDown(a) - coolingDown(b))
    .slice(0, 8);
  const started = Date.now();
  let busyErr, lastErr;
  for (const model of order) {
    if (Date.now() - started > 50_000) break; // don't keep the learner waiting forever
    const config = { ...baseConfig };
    const thinking = thinkingFor(model, deeper);
    if (thinking) config.thinkingConfig = thinking;
    try {
      let response;
      try {
        response = await ai.models.generateContent({ model, contents, config });
      } catch (err) {
        // If this model doesn't accept the thinking setting, retry once without it.
        if (!(err instanceof ApiError) || err.status !== 400 || !config.thinkingConfig || !/think/i.test(err.message)) throw err;
        delete config.thinkingConfig;
        response = await ai.models.generateContent({ model, contents, config });
      }
      cooldown.delete(model);
      if (model !== MODEL) { console.log(`Switched to ${model} because ${MODEL} was busy`); MODEL = model; }
      return response;
    } catch (err) {
      lastErr = err;
      if (err instanceof ApiError && err.status === 404) {
        console.log(`${model} isn't available for this key; won't try it again`);
        GONE.add(model);
        continue;
      }
      if (!isBusy(err)) throw err;
      busyErr = err;
      cooldown.set(model, Date.now() + 90_000);
      console.log(`${model} is busy (${err.status || err.name}), trying the next model`);
    }
  }
  if (busyErr || !lastErr) throw new Error("Gemini is very busy right now. Wait a few seconds and try again.");
  throw lastErr;
}

async function ask(schema, system, messages, deeper = false) {
  await ensureModel();
  if (!API_KEY || !MODEL) throw new Error(HOSTED
    ? "The coach isn't connected to Gemini yet. Ask the person who shared this link to set the GEMINI_API_KEY."
    : "No Gemini API key yet. Paste your key in the box at the top of the page and press Save.");
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const config = {
    systemInstruction: system,
    responseMimeType: "application/json",
    responseJsonSchema: toGeminiSchema(schema),
  };
  const response = await generate(contents, config, deeper);
  const text = response.text;
  if (!text) throw new Error("The coach could not answer that. Try rephrasing.");
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new Error("The coach returned an unreadable answer. Try again.");
  }
}

const handlers = {
  async passage({ topic, level, language }) {
    const L = lang(language);
    return ask(
      PassageSchema,
      L.rules,
      [{ role: "user", content: `Write a reading-aloud passage in ${L.name} about "${topic}" for a ${level} learner (${LEVEL_GUIDE[level]}). Make it interesting and concrete, with natural rhythm for reading aloud.` }],
    );
  },

  async reading({ passage, transcript, level, seconds, language }) {
    const L = lang(language);
    return ask(
      ReadingSchema,
      L.rules,
      [{
        role: "user",
        content: `Level: ${level}. The learner read this ${L.name} passage aloud in ${seconds} seconds.\n\n<passage>\n${passage}\n</passage>\n\n<transcript>\n${transcript}\n</transcript>\n\nCompare them. Words that differ were probably mispronounced or skipped. List up to 6 problem words. Ignore punctuation and number formatting differences.`,
      }],
    );
  },

  async chat({ topic, level, history, passage, language }) {
    // history: [{role:"user"|"assistant", content:string}], last entry is the learner's new turn
    const L = lang(language);
    const context = `The learner is practising ${L.name}. Topic: ${topic}. Learner level: ${level} (${LEVEL_GUIDE[level]}).` +
      (passage ? `\nThey just read this passage:\n<passage>\n${passage}\n</passage>` : "") +
      `\nSpeak ${L.name} with them, keep the conversation on the topic, match your language to their level, and keep it flowing.`;
    return ask(ChatSchema, `${L.rules}\n\n${context}`, history);
  },

  async summary({ topic, level, history, corrections, language }) {
    const L = lang(language);
    const transcript = history.map((m) => `${m.role === "user" ? "Learner" : "Coach"}: ${m.content}`).join("\n");
    return ask(
      SummarySchema,
      L.rules,
      [{
        role: "user",
        content: `Summarise this ${level} learner's ${L.name} speaking session on "${topic}".\n\n<conversation>\n${transcript}\n</conversation>\n\n<corrections_given>\n${JSON.stringify(corrections)}\n</corrections_given>`,
      }],
      true,
    );
  },
};

// ---------- HTTP ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    if (API_KEY && !MODEL) ensureModel().catch((e) => console.error("Model setup:", e.message));
    return send(res, 200, { hasKey: Boolean(API_KEY && MODEL), model: MODEL, locked: HOSTED });
  }
  if (req.method === "POST" && url.pathname === "/api/key") {
    if (HOSTED) return send(res, 403, { error: "The key can't be changed on the shared site." });
    try {
      const body = await readBody(req);
      return send(res, 200, await setKey(JSON.parse(body || "{}").key));
    } catch (err) { return send(res, 400, { error: err.message }); }
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5);
    if (!handlers[name]) return send(res, 404, { error: "Unknown endpoint" });
    if (overLimit(req)) return send(res, 429, { error: "You've practised a lot this hour! Take a short break and try again in a little while." });
    try {
      const body = await readBody(req);
      const data = await handlers[name](JSON.parse(body || "{}"));
      send(res, 200, data);
    } catch (err) {
      let message = err.message;
      if (err instanceof ApiError) {
        message = explainGoogleError(err.status, "", err.message);
      }
      console.error(`[${name}]`, err);
      send(res, 500, { error: message });
    }
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(here, "public", path.normalize(file));
  if (!full.startsWith(path.join(here, "public"))) return send(res, 403, "Forbidden", "text/plain");
  try {
    const content = await fs.readFile(full);
    send(res, 200, content, MIME[path.extname(full)] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
});

server.listen(PORT, HOSTED ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`English coach running at http://localhost:${PORT}`);
  if (API_KEY && !MODEL) {
    ensureModel().then(() => console.log(`Model: ${MODEL}`)).catch((e) => console.error("Saved key problem:", e.message));
  } else console.log(`Model: ${MODEL || "chosen when you add a key"}`);
  if (!API_KEY) console.warn("No Gemini key yet: paste it in the page, or put GEMINI_API_KEY=... in .env");
});
