// scripts/list-sources.js
// One-off utility — run locally with your service key to inspect rss_sources.
// Usage (PowerShell):
//   $env:SUPABASE_URL="https://..."; $env:SUPABASE_SERVICE_KEY="..."; node scripts/list-sources.js
// Usage (Git Bash / bash):
//   SUPABASE_URL="https://..." SUPABASE_SERVICE_KEY="..." node scripts/list-sources.js

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function listSources() {
  const { data, error } = await supabase
    .from('rss_sources')
    .select('id, name, section, url, active')
    .order('section', { ascending: true })
    .order('name',    { ascending: true });

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('No sources found in rss_sources.');
    return;
  }

  console.log(`\n${'#'.padEnd(4)} ${'ACTIVE'.padEnd(7)} ${'SECTION'.padEnd(20)} ${'NAME'.padEnd(30)} URL`);
  console.log('-'.repeat(120));

  for (const s of data) {
    const active = s.active ? '✓' : '✗';
    console.log(
      `${String(s.id).padEnd(4)} ${active.padEnd(7)} ${(s.section || '').padEnd(20)} ${(s.name || '').padEnd(30)} ${s.url}`
    );
  }

  console.log(`\nTotal: ${data.length} source(s). Active: ${data.filter(s => s.active).length}.`);
}

listSources();
