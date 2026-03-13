// scripts/fetch-rss.js
const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TIER1_SOURCES = new Set([
  'BBC News', 'Reuters', 'AP News', 'The Guardian', 'NPR',
  'Ars Technica', 'Wired', 'The Verge', 'MIT Technology Review',
  'Science', 'Nature', 'Scientific American', 'New Scientist',
  'Smithsonian Magazine', 'National Geographic',
  'The Atlantic', 'New York Times', 'Washington Post',
  'Financial Times', 'Bloomberg', 'The Economist',
]);

const SECTION_KEYWORDS = {
  'tech':            ['software', 'ai', 'data', 'cloud', 'developer', 'programming', 'tech', 'algorithm', 'cybersecurity', 'startup', 'hardware', 'code', 'internet', 'digital'],
  'tech-ai':         ['software', 'ai', 'data', 'cloud', 'developer', 'programming', 'tech', 'algorithm', 'cybersecurity', 'startup', 'hardware', 'code', 'internet', 'digital'],
  'curious':         ['history', 'discovery', 'ancient', 'mystery', 'science', 'research', 'study', 'found', 'origins', 'culture'],
  'curious-history': ['history', 'discovery', 'ancient', 'mystery', 'science', 'research', 'study', 'found', 'origins', 'culture'],
  'mind':            ['psychology', 'brain', 'mental', 'cognitive', 'behavior', 'emotion', 'therapy', 'stress', 'anxiety', 'habit'],
  'human-mind':      ['psychology', 'brain', 'mental', 'cognitive', 'behavior', 'emotion', 'therapy', 'stress', 'anxiety', 'habit'],
  'food':            ['food', 'recipe', 'cooking', 'restaurant', 'diet', 'nutrition', 'meal', 'flavor', 'ingredient', 'cuisine'],
  'food-origins':    ['food', 'recipe', 'cooking', 'restaurant', 'diet', 'nutrition', 'meal', 'flavor', 'ingredient', 'cuisine'],
  'good':            ['rescue', 'donation', 'volunteer', 'charity', 'community', 'breakthrough', 'hope', 'positive', 'success', 'achievement'],
  'good-news':       ['rescue', 'donation', 'volunteer', 'charity', 'community', 'breakthrough', 'hope', 'positive', 'success', 'achievement'],
  'nature-outdoors': ['nature', 'wildlife', 'environment', 'climate', 'ocean', 'forest', 'animal', 'conservation', 'outdoor', 'ecosystem'],
  'origin-story':    ['origin', 'history', 'founding', 'creation', 'invented', 'first', 'story', 'began', 'started', 'developed'],
};

function scoreArticle(item, section, sourceName, blurb) {
  let score = 0;

  // 1. Blurb quality (0–3 pts)
  const blurbLen = blurb.trim().length;
  if      (blurbLen >= 150) score += 3;
  else if (blurbLen >= 80)  score += 2;
  else if (blurbLen >= 20)  score += 1;

  // 2. Source reputation (0–3 pts)
  if      (TIER1_SOURCES.has(sourceName)) score += 3;
  else if (sourceName)                    score += 2;
  else                                    score += 1;

  // 3. Recency (0–2 pts)
  const pubDate = item.pubDate ? new Date(item.pubDate) : null;
  if (pubDate && !isNaN(pubDate)) {
    const ageHrs = (Date.now() - pubDate.getTime()) / 36e5;
    if      (ageHrs < 6)  score += 2;
    else if (ageHrs < 24) score += 1;
  }

  // 4. Section relevance (0–2 pts)
  const keywords = SECTION_KEYWORDS[section] || [];
  if (keywords.length) {
    const text = `${item.title || ''} ${blurb}`.toLowerCase();
    const matches = keywords.filter(kw => text.includes(kw)).length;
    if      (matches >= 2) score += 2;
    else if (matches >= 1) score += 1;
  }

  return score;
}

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
    'tech-ai', 'curious-history', 'mind-culture', 'food-origins',
    'good-news', 'nature-outdoors', 'origin-story', 'human-mind',
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

  // Pre-fetch all existing source_urls once — used to skip duplicates before inserting
  const { data: existingRows } = await supabase
    .from('articles')
    .select('source_url');
  const existingUrls = new Set((existingRows || []).map(r => r.source_url));

  let totalAttempted = 0;
  let totalSkipped   = 0;
  let totalInsertErrors = 0;
  let feedParseFailures = 0;

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

    const articles = (feed.items || []).slice(0, 5)
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
      })
      .map(({ blurb, item }) => {
        const score = scoreArticle(item, source.section, source.name, blurb);
        return { blurb, item, score };
      })
      .filter(({ score, blurb }) => {
        if (score === 0 || !blurb) { totalSkipped++; return false; }
        return true;
      })
      .map(({ blurb, item, score }) => ({
        section: source.section,
        headline: item.title,
        blurb,
        source_name: source.name,
        source_url: item.link,
        status: score >= 8 ? 'pipeline' : 'queue',
        score,
        published_at: item.pubDate || new Date().toISOString()
      }));

    if (!articles.length) continue;

    // Scrape og:image for each article (best-effort, null if unavailable)
    const articlesWithImages = await Promise.all(
      articles.map(async (a) => ({
        ...a,
        image_url: await scrapeOgImage(a.source_url),
      }))
    );

    totalAttempted += articlesWithImages.length;

    const { error: insertError } = await supabase
      .from('articles')
      .insert(articlesWithImages);

    if (insertError) {
      totalInsertErrors += 1;
      console.error(`[INSERT ERROR] "${source.name}" — ${source.url} — ${insertError.message}`);
    }
  }

  console.log(
    `RSS fetch complete. Active sources: ${sources?.length || 0}. New articles inserted: ${totalAttempted}. Duplicates skipped: ${totalSkipped}. Feed failures: ${feedParseFailures}. Insert errors: ${totalInsertErrors}.`
  );
}

fetchAndStore();
