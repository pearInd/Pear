import "dotenv/config";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
];

async function testModel(model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: "Reply with one word: hello" }] }],
    }),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`non-JSON response: ${raw.slice(0, 300)}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`no text in response: ${raw.slice(0, 300)}`);
  }
  return text.trim();
}

async function main() {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in the environment.");
    process.exit(1);
  }

  for (const model of MODELS) {
    try {
      const reply = await testModel(model);
      console.log(`✓ ${model} — WORKS (reply: "${reply}")`);
    } catch (err) {
      console.log(`✗ ${model} — FAILED: ${err.message}`);
    }
  }
}

main();
