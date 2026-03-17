// scripts/ai-scorer.js
// Handles all Claude API calls for the Chief Content Officer (CCO)

const CCO_SYSTEM_PROMPT = require('./cco-prompt.js');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-haiku-4-5-20251001';
const MAX_TOKENS        = 400;
const RETRY_WAIT_MS     = 5000;
const RATE_LIMIT_MS     = 200;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fallbackResponse(defaultSection) {
  return {
    score:            5,
    assigned_section: defaultSection,
    editorial_fit:    2,
    interestingness:  2,
    writing_quality:  1,
    uniqueness:       0,
    reasoning:        'CCO scoring failed — defaulting to queue',
    blurb:            null,
    section_reassigned: false,
  };
}

async function callCCO(headline, blurb, sourceName, defaultSection) {
  const userMessage = `Default section: ${defaultSection}\nHeadline: ${headline}\nBlurb: ${blurb}\nSource: ${sourceName}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     CCO_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });

  return res;
}

/**
 * Score a single article via the CCO.
 * @param {string} headline
 * @param {string} blurb
 * @param {string} sourceName
 * @param {string} defaultSection
 * @returns {Promise<object>} CCO result object
 */
async function scoreWithCCO(headline, blurb, sourceName, defaultSection) {
  await sleep(RATE_LIMIT_MS);

  let res;
  try {
    res = await callCCO(headline, blurb, sourceName, defaultSection);

    // Retry once on 429 (rate limit) or 529 (overloaded)
    if (res.status === 429 || res.status === 529) {
      console.warn(`[CCO] Rate limited (${res.status}) — retrying in ${RETRY_WAIT_MS}ms`);
      await sleep(RETRY_WAIT_MS);
      res = await callCCO(headline, blurb, sourceName, defaultSection);
    }

    if (!res.ok) {
      console.error(`[CCO] API error ${res.status} for: ${headline.substring(0, 50)}`);
      return fallbackResponse(defaultSection);
    }
  } catch (err) {
    console.error(`[CCO] Network error for: ${headline.substring(0, 50)} — ${err.message}`);
    return fallbackResponse(defaultSection);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    console.error(`[CCO] Failed to parse API response body — ${err.message}`);
    return fallbackResponse(defaultSection);
  }

  const rawText = body?.content?.[0]?.text || '';

  // Strip any markdown backtick fencing the model might add
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch (err) {
    console.error(`[CCO] Invalid JSON response for: ${headline.substring(0, 50)}\n  Raw: ${rawText.substring(0, 200)}`);
    return fallbackResponse(defaultSection);
  }

  const { score, assigned_section, section_reassigned } = result;
  console.log(
    `[CCO] ${headline.substring(0, 50)} → ${assigned_section} (${score}/10)${section_reassigned ? ' [REASSIGNED]' : ''}`
  );

  return result;
}

module.exports = { scoreWithCCO };
