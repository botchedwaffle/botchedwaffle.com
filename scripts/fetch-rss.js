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

  let totalAttempted = 0;
  let totalUpsertErrors = 0;
  let feedParseFailures = 0;

  for (const source of sources || []) {
    let feed;
    try {
      feed = await parser.parseURL(source.url);
    } catch (e) {
      feedParseFailures += 1;
      continue;
    }

    const articles = (feed.items || []).slice(0, 5).map(item => ({
      section: source.section,
      headline: item.title,
      blurb: item.contentSnippet?.slice(0, 300) || '',
      source_name: source.name,
      source_url: item.link,
      status: 'draft',
      published_at: item.pubDate || new Date().toISOString()
    }));

    totalAttempted += articles.length;

    const { error: upsertError } = await supabase
      .from('articles')
      .upsert(articles, { onConflict: 'source_url', ignoreDuplicates: true });

    if (upsertError) {
      totalUpsertErrors += 1;
    }
  }

  console.log(
    `RSS fetch complete. Active sources: ${sources?.length || 0}. Articles attempted: ${totalAttempted}. Feed failures: ${feedParseFailures}. Upsert errors: ${totalUpsertErrors}.`
  );
}

fetchAndStore();
