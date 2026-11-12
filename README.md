# Speak Studio — English speaking coach

Practise spoken English with an AI coach (Gemini):

1. **Read aloud** — get a passage on any topic at your level, hear it read first if you like, then read it yourself. Words the coach couldn't understand are highlighted, with pronunciation tips spoken out loud.
2. **Conversation** — talk with Maya, the coach. When you make a mistake she says the correction out loud, then keeps the conversation going. Tap **Repeat it** on a correction to practise the fixed sentence.
3. **Session report** — strengths, what to work on, and practice sentences.

Also: word bank, words-per-minute, filler-word counter ("um", "uh"), hands-free mode, voice/speed/accent settings.

## Run

```bash
npm install
cp .env.example .env   # then paste your key into .env
npm start
```

Open http://localhost:5173 in **Chrome** (or Edge/Safari) and allow the microphone.

Optional: `GEMINI_MODEL=gemini-2.5-pro` for a smarter (slower) coach. Default is `gemini-2.5-flash`.

Note: browser speech recognition sends your audio to the browser vendor's service (Google for Chrome) to transcribe it.

## Learning Hindi

Use the **I'm learning** switch at the top of the settings panel to choose English or हिन्दी Hindi.
In Hindi mode the coach is Meera. She speaks Hindi, listens with Hindi (India) speech recognition,
and shows every Hindi line in Roman letters and in English. Corrections are explained in English.
You need a Hindi voice for her to talk: on a Mac, add "Lekha" under System Settings › Accessibility ›
Spoken Content › System voice › Manage Voices. In Chrome, "Google हिन्दी" also works when you're online.

## Sharing it with friends (free hosting on Render)

1. Push this folder to a GitHub repository.
2. On render.com choose **New › Blueprint**, pick the repository, and paste your Gemini key when Render asks for `GEMINI_API_KEY`.
3. Render gives you a link like `https://speak-studio.onrender.com` to share.

On the shared site visitors can't see or change your key, and each visitor gets up to 60 coach replies an hour
(change `LIMIT_PER_HOUR` in Render to adjust). The free plan sleeps when nobody uses it, so the first visit
after a while takes about a minute to load.
