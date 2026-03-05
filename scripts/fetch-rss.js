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

  console.log(`Active sources found: ${sources?.length || 0}`);

  let totalAttempted = 0;
  let totalUpsertErrors = 0;

  for (const source of sources || []) {
    console.log(`Fetching: ${source.name} | ${source.url}`);

    let feed;
    try {
      feed = await parser.parseURL(source.url);
    } catch (e) {
      console.error(`Feed parse failed for ${source.name}:`, e?.message || e);
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

    console.log(`Items prepared for ${source.name}: ${articles.length}`);
    totalAttempted += articles.length;

    const { error: upsertError } = await supabase
      .from('articles')
      .upsert(articles, { onConflict: 'source_url', ignoreDuplicates: true });

    if (upsertError) {
      totalUpsertErrors += 1;
      console.error(`Upsert error for ${source.name}:`, upsertError);
    }
  }

  console.log(`Done. Articles attempted: ${totalAttempted}. Upsert errors: ${totalUpsertErrors}.`);
}

fetchAndStore();
