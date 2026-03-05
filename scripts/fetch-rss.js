// scripts/fetch-rss.js
const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function fetchAndStore() {
  const parser = new Parser();
  // Get all active sources from database
  const { data: sources, error: sourcesError } = await supabase
    .from('rss_sources').select('*').eq('active', true);

  if (sourcesError) {
    console.error('Error loading sources:', sourcesError);
    process.exit(1);
  }

  for (const source of sources || []) {
    const feed = await parser.parseURL(source.url);
    const articles = (feed.items || []).slice(0, 5).map(item => ({
      section: source.section,
      headline: item.title,
      blurb: item.contentSnippet?.slice(0, 300) || '',
      source_name: source.name,
      source_url: item.link,
      status: 'draft',
      published_at: item.pubDate || new Date().toISOString()
    }));
    // Insert, skip duplicates based on source_url
    const { error: upsertError } = await supabase.from('articles')
      .upsert(articles, { onConflict: 'source_url', ignoreDuplicates: true });

    if (upsertError) {
      console.error(`Upsert error for ${source.name}:`, upsertError);
    }
  }
  console.log('RSS fetch complete');
}

fetchAndStore();
