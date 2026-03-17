// scripts/fetch-rss.js
const { createClient } = require('@supabase/supabase-js');
const Parser           = require('rss-parser');
const { scoreWithCCO } = require('./ai-scorer.js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DRY_RUN = process.env.DRY_RUN === 'true';
if (DRY_RUN) console.log('[CCO] DRY RUN MODE — no database writes');

// Source reputation — used as tiebreaker when CCO score lands exactly on a threshold
const TIER1_SOURCES = new Set([
  'BBC News', 'Reuters', 'AP News', 'The Guardian', 'NPR',
  'Ars Technica', 'Wired', 'The Verge', 'MIT Technology Review',
  'Science', 'Nature', 'Scientific American', 'New Scientist',
  'Smithsonian Magazine', 'National Geographic',
  'The Atlantic', 'New York Times', 'Washington Post',
  'Financial Times', 'Bloomberg', 'The Economist',
]);

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY: Rule-based scoring — kept as fallback reference
// ─────────────────────────────────────────────────────────────────────────────
// const SECTION_KEYWORDS = {
//   'history-origins':     ['history', 'ancient', 'civilization', 'archaeology', 'origins', 'historical', 'century', 'dynasty', 'empire', 'medieval', 'origin', 'invention', 'how', 'why', 'created', 'founded', 'first', 'discovered', 'began', 'tradition', 'custom', 'ritual'],
//   'psychology-behavior': ['psychology', 'brain', 'neuroscience', 'cognition', 'memory', 'emotion', 'consciousness', 'mental', 'behavior', 'bias', 'identity', 'belief', 'social', 'philosophy', 'culture', 'society', 'perception', 'decision', 'habit', 'anxiety', 'attention', 'motivation'],
//   'science-nature':      ['nature', 'wildlife', 'environment', 'climate', 'species', 'ocean', 'forest', 'animal', 'plant', 'ecology', 'science', 'physics', 'engineering', 'biology', 'chemistry', 'geology', 'weather', 'space', 'how', 'works', 'explained', 'mechanism'],
//   'food-culture':        ['food', 'recipe', 'cuisine', 'ingredient', 'cooking', 'flavor', 'origin', 'dish', 'agricultural', 'spice', 'ferment', 'bread', 'culture', 'tradition', 'culinary', 'harvest', 'drink', 'meal', 'kitchen', 'history'],
//   'technology-systems':  ['ai', 'artificial intelligence', 'machine learning', 'robot', 'algorithm', 'software', 'tech', 'model', 'data', 'automation', 'infrastructure', 'grid', 'supply chain', 'privacy', 'surveillance', 'digital', 'system', 'network', 'internet', 'platform', 'cognitive', 'dependency'],
//   'rabbit-hole':         ['bizarre', 'fascinating', 'mysterious', 'deep dive', 'investigation', 'obscure', 'forgotten', 'strange', 'remarkable', 'unexplained', 'viral', 'visual', 'photo', 'infographic', 'data', 'chart'],
// };
//
// function scoreArticle(item, section, sourceName, blurb) {
//   let score = 0;
//   const blurbLen = blurb.trim().length;
//   if      (blurbLen >= 150) score += 3;
//   else if (blurbLen >= 80)  score += 2;
//   else if (blurbLen >= 20)  score += 1;
//   if      (TIER1_SOURCES.has(sourceName)) score += 3;
//   else if (sourceName)                    score += 2;
//   else                                    score += 1;
//   const pubDate = item.pubDate ? new Date(item.pubDate) : null;
//   if (pubDate && !isNaN(pubDate)) {
//     const ageHrs = (Date.now() - pubDate.getTime()) / 36e5;
//     if      (ageHrs < 6)  score += 2;
//     else if (ageHrs < 24) score += 1;
//   }
//   const keywords = SECTION_KEYWORDS[section] || [];
//   if (keywords.length) {
//     const text = `${item.title || ''} ${blurb}`.toLowerCase();
//     const matches = keywords.filter(kw => text.includes(kw)).length;
//     if      (matches >= 2) score += 2;
//     else if (matches >= 1) score += 1;
//   }
//   return score;
// }
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeOgImage(articleUrl) {
  try {
    const res = await fetch(articleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000)
    });
    const html = await res.text();
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function fetchAndStore() {
  const parser = new Parser();

  const VALID_SECTIONS = [
    'history-origins', 'psychology-behavior', 'science-nature',
    'food-culture', 'technology-systems', 'rabbit-hole',
  ];

  const { data: sources, error: sourcesError } = await supabase
    .from('rss_sources')
    .select('*')
    .eq('active', true)
    .in('section', VALID_SECTIONS);

  if (sourcesError) {
    console.error('Error loading sources:', sourcesError);
    process.exit(1);
  }

  // Pre-fetch all existing source_urls once — used to skip duplicates
  const { data: existingRows } = await supabase
    .from('articles')
    .select('source_url');
  const existingUrls = new Set((existingRows || []).map(r => r.source_url));

  // Run metrics
  let totalAttempted     = 0;
  let totalSkipped       = 0;
  let totalInsertErrors  = 0;
  let feedParseFailures  = 0;
  let apiCallsOk         = 0;
  let apiCallsFailed     = 0;
  let statusCounts       = { pipeline: 0, queue: 0, skipped: 0 };
  let reassignedCount    = 0;
  let totalInputChars    = 0;
  let totalOutputChars   = 0;

  // Circuit breaker — if 50+ API failures, stop making API calls
  const CIRCUIT_BREAKER_LIMIT = 50;
  let circuitBroken = false;

  const BLURB_JUNK = ['Article URL:', 'Comments URL:', 'Points:', '# Comments'];

  for (const source of sources || []) {
    let feed;
    try {
      feed = await parser.parseURL(source.url);
    } catch (e) {
      feedParseFailures += 1;
      console.error(`[FEED ERROR] "${source.name}" — ${source.url} — ${e.message}`);
      continue;
    }

    // Filter and extract raw candidates (synchronous — dedup + blurb checks)
    const candidates = (feed.items || []).slice(0, 5)
      .filter(item => item.title && item.title.length >= 10)
      .filter(item => {
        if (!item.link || existingUrls.has(item.link)) { totalSkipped++; return false; }
        return true;
      })
      .map(item => {
        let blurb = item.contentSnippet?.slice(0, 300) || '';
        if (BLURB_JUNK.some(s => blurb.includes(s))) blurb = '';
        return { blurb, item };
      })
      .filter(({ blurb }) => {
        if (blurb.trim().length < 20) { totalSkipped++; return false; }
        return true;
      });

    const articlesToInsert = [];

    for (const { blurb, item } of candidates) {
      // Circuit breaker: too many API failures — queue remaining without scoring
      if (!circuitBroken && apiCallsFailed >= CIRCUIT_BREAKER_LIMIT) {
        circuitBroken = true;
        console.warn('[CCO] CIRCUIT BREAKER: 50+ API failures, falling back to queue-all mode');
      }

      let finalScore, assignedSection, ccoBlurb, ccoReasoning, sectionReassigned;

      if (circuitBroken) {
        // Fallback: queue everything without API call
        finalScore        = 5;
        assignedSection   = source.section;
        ccoBlurb          = null;
        ccoReasoning      = 'Circuit breaker active — queued without CCO scoring';
        sectionReassigned = false;
      } else {
        // Track input size for cost estimation
        const inputStr = `${item.title} ${blurb} ${source.name} ${source.section}`;
        totalInputChars += inputStr.length;

        const cco = await scoreWithCCO(item.title, blurb, source.name, source.section);

        // Detect fallback response (api failure)
        if (cco.reasoning?.includes('CCO scoring failed')) {
          apiCallsFailed++;
        } else {
          apiCallsOk++;
          totalOutputChars += JSON.stringify(cco).length;
        }

        // Source reputation tiebreaker at exact thresholds 6 and 8
        let score = cco.score;
        if (score === 6 || score === 8) {
          score += TIER1_SOURCES.has(source.name) ? 0.5 : -0.5;
        }

        finalScore        = score;
        assignedSection   = cco.assigned_section || source.section;
        ccoBlurb          = cco.blurb || null;
        ccoReasoning      = cco.reasoning || null;
        sectionReassigned = cco.section_reassigned || false;
      }

      // Status thresholds: 8+ → pipeline, 6–7.9 → queue, <6 → skip
      const status = finalScore >= 8 ? 'pipeline' : finalScore >= 6 ? 'queue' : null;
      if (!status) {
        totalSkipped++;
        statusCounts.skipped++;
        continue;
      }

      if (sectionReassigned) reassignedCount++;
      statusCounts[status]++;

      articlesToInsert.push({
        section:        assignedSection,
        headline:       item.title,
        blurb:          ccoBlurb || blurb,
        source_name:    source.name,
        source_url:     item.link,
        status,
        score:          finalScore,
        score_reasoning: ccoReasoning,
        published_at:   item.pubDate || new Date().toISOString(),
      });
    }

    if (!articlesToInsert.length) continue;

    // Scrape og:image for each article (best-effort)
    const articlesWithImages = await Promise.all(
      articlesToInsert.map(async (a) => ({
        ...a,
        image_url: await scrapeOgImage(a.source_url),
      }))
    );

    totalAttempted += articlesWithImages.length;

    if (!DRY_RUN) {
      const { error: insertError } = await supabase
        .from('articles')
        .insert(articlesWithImages);

      if (insertError) {
        totalInsertErrors++;
        console.error(`[INSERT ERROR] "${source.name}" — ${insertError.message}`);
      }
    } else {
      articlesWithImages.forEach(a =>
        console.log(`[DRY RUN] Would insert: [${a.status}] ${a.section} — ${a.headline.substring(0, 60)}`)
      );
    }
  }

  // ── Run summary ─────────────────────────────────────────────────────────────
  const estimatedCost =
    (totalInputChars  / 4 / 1_000_000) * 0.25 +
    (totalOutputChars / 4 / 1_000_000) * 1.25;

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[CCO] RUN SUMMARY${DRY_RUN ? ' (DRY RUN)' : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Active sources:       ${sources?.length || 0}
Feed parse failures:  ${feedParseFailures}
Articles processed:   ${totalAttempted}
Duplicates skipped:   ${totalSkipped}

Status breakdown:
  → Pipeline (8+):   ${statusCounts.pipeline}
  → Queue (6–7):     ${statusCounts.queue}
  → Skipped (<6):    ${statusCounts.skipped}

Section reassignments: ${reassignedCount}

API calls:
  Successful:        ${apiCallsOk}
  Failed/fallback:   ${apiCallsFailed}
  Circuit breaker:   ${circuitBroken ? 'TRIPPED' : 'OK'}

Insert errors:       ${totalInsertErrors}
Est. API cost:       $${estimatedCost.toFixed(4)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

fetchAndStore();
