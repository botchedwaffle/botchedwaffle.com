// scripts/pipeline.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MAX_ACTIVE_PER_SECTION = 6;

// Helper: timestamp N hours ago as ISO string
function hoursAgo(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

// Helper: timestamp N days ago as ISO string
function daysAgo(n) {
  return hoursAgo(n * 24);
}

// ─── Step 1 ──────────────────────────────────────────────────────────────────
// Promote pipeline → active: status='pipeline' AND created_at older than 6 hrs
async function promoteToActive() {
  const { data, error } = await supabase
    .from('articles')
    .update({ status: 'active' })
    .eq('status', 'pipeline')
    .lt('created_at', hoursAgo(6))
    .select('id');

  if (error) {
    console.error('Step 1 error (promote pipeline→active):', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

// ─── Step 2 ──────────────────────────────────────────────────────────────────
// Per-section active cap: if a section has > MAX_ACTIVE_PER_SECTION active
// articles, retire the lowest-scoring ones until the count is at the cap.
async function enforceActiveCap() {
  // Fetch all active articles ordered by section, then score DESC
  const { data: activeArticles, error } = await supabase
    .from('articles')
    .select('id, section, score')
    .eq('status', 'active')
    .order('section', { ascending: true })
    .order('score',   { ascending: false });

  if (error) {
    console.error('Step 2 error (fetch active articles):', error.message);
    return 0;
  }

  // Group by section
  const bySection = {};
  for (const row of activeArticles || []) {
    (bySection[row.section] = bySection[row.section] || []).push(row);
  }

  // Collect IDs to retire (those ranked beyond the cap per section)
  const retireIds = [];
  for (const [section, articles] of Object.entries(bySection)) {
    if (articles.length > MAX_ACTIVE_PER_SECTION) {
      // articles is already sorted score DESC; slice off the tail
      const overflow = articles.slice(MAX_ACTIVE_PER_SECTION);
      retireIds.push(...overflow.map(a => a.id));
    }
  }

  if (!retireIds.length) return 0;

  const { data: retired, error: retireError } = await supabase
    .from('articles')
    .update({ status: 'retired' })
    .in('id', retireIds)
    .select('id');

  if (retireError) {
    console.error('Step 2 error (retire overflow):', retireError.message);
    return 0;
  }
  return retired?.length ?? 0;
}

// ─── Step 3 ──────────────────────────────────────────────────────────────────
// Expire stale queue: status='queue' AND created_at older than 48 hrs → 'discarded'
async function expireQueue() {
  const { data, error } = await supabase
    .from('articles')
    .update({ status: 'discarded' })
    .eq('status', 'queue')
    .lt('created_at', hoursAgo(48))
    .select('id');

  if (error) {
    console.error('Step 3 error (expire queue→discarded):', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

// ─── Step 4 ──────────────────────────────────────────────────────────────────
// Retire old active: status='active' AND created_at older than 7 days → 'retired'
async function retireOldActive() {
  const { data, error } = await supabase
    .from('articles')
    .update({ status: 'retired' })
    .eq('status', 'active')
    .lt('created_at', daysAgo(7))
    .select('id');

  if (error) {
    console.error('Step 4 error (retire old active→retired):', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function runPipeline() {
  const [promoted, capRetired, discarded, retired] = await Promise.all([
    promoteToActive(),
    enforceActiveCap(),
    expireQueue(),
    retireOldActive(),
  ]);

  console.log(
    `Pipeline complete. ` +
    `Promoted pipeline→active: ${promoted}. ` +
    `Cap-retired (overflow): ${capRetired}. ` +
    `Discarded stale queue: ${discarded}. ` +
    `Retired old active: ${retired}.`
  );
}

runPipeline();
