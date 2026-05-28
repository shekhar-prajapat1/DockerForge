import { GoogleGenerativeAI } from '@google/generative-ai';

/* ---------------- API INIT ---------------- */

function getGenAI(userApiKey) {
  const apiKey = userApiKey || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'Gemini API key missing. Add GEMINI_API_KEY in .env or provide via UI.'
    );
  }

  return new GoogleGenerativeAI(apiKey);
}

/* ---------------- UTILITIES ---------------- */

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------- SAFE JSON PARSER ---------- */

function parseJsonFromResponse(text) {

  // direct parse
  try {
    return JSON.parse(text);
  } catch {}

  // markdown block recovery
  const jsonMatch =
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);

  if (jsonMatch?.[1]) {

    let cleaned = jsonMatch[1];

    cleaned = cleaned.replace(/,\s*}/g, '}');
    cleaned = cleaned.replace(/,\s*]/g, ']');

    try {
      return JSON.parse(cleaned);
    } catch {}
  }

  // substring recovery
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start !== -1 && end !== -1 && end > start) {

    let cleaned =
      text.substring(start, end + 1);

    cleaned = cleaned.replace(/,\s*}/g, '}');
    cleaned = cleaned.replace(/,\s*]/g, ']');

    try {
      return JSON.parse(cleaned);
    } catch {}
  }

  throw new Error(
    'Gemini returned malformed JSON'
  );
}

/* ---------- VALIDATION ---------- */

function validateLLMResponse(parsed) {

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      'Gemini returned invalid JSON object.'
    );
  }

  if (
    !parsed.dockerfile ||
    typeof parsed.dockerfile !== 'string'
  ) {
    throw new Error(
      'Gemini response missing dockerfile.'
    );
  }

  if (!parsed.explanation) {
    parsed.explanation =
      'No explanation provided.';
  }

  if (!parsed.dockerCompose) {
    parsed.dockerCompose = '';
  }

  return parsed;
}

/* ---------------- GEMINI CALL ---------------- */

async function callGeminiWithFallback(
  genAI,
  prompt,
  logCallback
) {

  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-pro'
  ];

  let lastError = null;

  for (const modelName of models) {

    for (let retry = 1; retry <= 3; retry++) {

      try {

        logCallback(
          `Contacting Gemini using model: ${modelName} (try ${retry}/3)...`
        );

        const model =
          genAI.getGenerativeModel({
            model: modelName
          });

        const result =
          await model.generateContent(prompt);

        const text =
          result.response.text();

        logCallback(
          `Successfully generated content using ${modelName}`
        );

        return text;

      } catch (err) {

        const msg = err.message || '';

        logCallback(
          `[Model Notice] ${modelName} failed: ${msg}`
        );

        lastError = err;

        /* ----- FAIL FAST ----- */

        if (
          msg.includes('API_KEY_INVALID') ||
          msg.includes('API key not valid') ||
          msg.includes('403') ||
          msg.includes('429') ||
          msg.includes('quota')
        ) {
          throw err;
        }

        /* ----- RETRY 503 ----- */

        if (
          msg.includes('503') ||
          msg.includes('Service Unavailable') ||
          msg.includes('high demand')
        ) {

          if (retry < 3) {

            logCallback(
              `Gemini overloaded. Retrying ${modelName} in 3 seconds...`
            );

            await delay(3000);
            continue;
          }
        }

        break;
      }
    }
  }

  throw new Error(
    `All Gemini models failed. Last error: ${
      lastError?.message || 'Unknown'
    }`
  );
}

/* ---------------- GENERATE ---------------- */

export async function generateDockerConfig(
  signature,
  userApiKey,
  logCallback
) {

  logCallback(
    'Contacting Gemini AI to generate Docker configuration...'
  );

  const genAI =
    getGenAI(userApiKey);

  const prompt = `
You are an expert DevOps and Docker engineer.

Analyze the repository and generate:

1. Dockerfile
2. docker-compose.yml
3. Short explanation

Requirements:
- optimized
- secure
- correct EXPOSE
- correct CMD
- dependency caching
- multi-stage if useful

Codebase:

Languages:
${JSON.stringify(signature.primaryLanguages, null, 2)}

Tree:
${signature.treeSummary}

Configs:
${Object.entries(signature.keyConfigs)
  .map(
    ([file, content]) =>
      `FILE: ${file}\n${content}`
  )
  .join('\n')}

Return ONLY JSON markdown.

DO NOT include:
- comments
- markdown outside JSON
- extra explanation
- trailing commas

Return strict RFC8259 JSON only.

\`\`\`json
{
  "dockerfile":"...",
  "dockerCompose":"...",
  "explanation":"..."
}
\`\`\`
`;

  try {

    const responseText =
      await callGeminiWithFallback(
        genAI,
        prompt,
        logCallback
      );

    const parsed =
      validateLLMResponse(
        parseJsonFromResponse(
          responseText
        )
      );

    logCallback(
      'Docker configuration generated successfully.'
    );

    return {
      dockerfile:
        parsed.dockerfile,
      dockerCompose:
        parsed.dockerCompose,
      explanation:
        parsed.explanation
    };

  } catch (error) {

    logCallback(
      `[ERROR] Docker generation failed: ${error.message}`
    );

    throw error;
  }
}

/* ---------------- SELF HEAL ---------------- */

export async function repairDockerConfig(
  signature,
  failingDockerfile,
  buildErrorLogs,
  attempt,
  userApiKey,
  logCallback
) {

  logCallback(
    `[Self-Healing] Diagnosing failure (Attempt ${attempt}/3)...`
  );

  const genAI =
    getGenAI(userApiKey);

  const prompt = `
You are a self-healing Docker AI.

The Dockerfile failed.

Analyze:

Dockerfile:
${failingDockerfile}

Build logs:
${buildErrorLogs}

Repository:
${JSON.stringify(signature.primaryLanguages)}

Fix the Dockerfile.

Return ONLY JSON.

DO NOT include:
- comments
- markdown outside JSON
- extra explanation
- trailing commas

Return strict RFC8259 JSON only.

\`\`\`json
{
  "dockerfile":"...",
  "dockerCompose":"...",
  "explanation":"..."
}
\`\`\`
`;

  try {

    const responseText =
      await callGeminiWithFallback(
        genAI,
        prompt,
        logCallback
      );

    const parsed =
      validateLLMResponse(
        parseJsonFromResponse(
          responseText
        )
      );

    logCallback(
      `[Self-Healing] ${parsed.explanation}`
    );

    return {
      dockerfile:
        parsed.dockerfile,
      dockerCompose:
        parsed.dockerCompose,
      explanation:
        parsed.explanation
    };

  } catch (error) {

    logCallback(
      `[ERROR] Self-healing failed: ${error.message}`
    );

    throw error;
  }
}