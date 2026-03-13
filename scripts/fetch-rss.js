// scripts/fetch-rss.js
const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function fetchAndStore() {
  const parser = new Parser();

  const { data: sources, error: sourcesError } = await supabase
    .from('rss_sources')
    .select('*')
    .eq('active', true);

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
      .map(({ blurb, item }) => ({
        section: source.section,
        headline: item.title,
        blurb,
        source_name: source.name,
        source_url: item.link,
        status: 'draft',
        published_at: item.pubDate || new Date().toISOString()
      }));

    if (!articles.length) continue;

    totalAttempted += articles.length;

    const { error: insertError } = await supabase
      .from('articles')
      .insert(articles);

    if (insertError) {
      totalInsertErrors += 1;
    }
  }

  console.log(
    `RSS fetch complete. Active sources: ${sources?.length || 0}. New articles inserted: ${totalAttempted}. Duplicates skipped: ${totalSkipped}. Feed failures: ${feedParseFailures}. Insert errors: ${totalInsertErrors}.`
  );
}

fetchAndStore();
