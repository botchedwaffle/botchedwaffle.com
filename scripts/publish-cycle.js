// scripts/publish-cycle.js — runs every 4 hours
// Handles: retire expired articles, promote top-ranked pending, generate blurbs

const { createClient } = require('@supabase/supabase-js');
const { generateBlurb } = require('./ai-scorer.js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DRY_RUN = process.env.DRY_RUN === 'true';
if (DRY_RUN) console.log('[PUBLISH] DRY RUN MODE — no database writes');

const SECTIONS = [
  'history-origins', 'psychology-behavior', 'science-nature',
  'food-culture', 'technology-systems', 'rabbit-hole',
];

// Hardcoded defaults — overridden by site_settings if available
const DEFAULT_SECTION_CONFIG = {
  'history-origins':     { lifespan_hours: 72, max_hours: 96 },
  'psychology-behavior': { lifespan_hours: 48, max_hours: 72 },
  'science-nature':      { lifespan_hours: 48, max_hours: 72 },
  'food-culture':        { lifespan_hours: 72, max_hours: 96 },
  'technology-systems':  { lifespan_hours: 24, max_hours: 48 },
  'rabbit-hole':         { lifespan_hours: 48, max_hours: 72 },
};
const DEFAULT_ARTICLES_PER_SECTION = 4;
const DEFAULT_PENDING_EXPIRY_DAYS  = 7;

// ── Config loader ─────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const { data, error } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'section_config')
      .single();

    if (error || !data) {
      console.log('[PUBLISH] site_settings not found — using hardcoded defaults');
      return {
        section_config:       DEFAULT_SECTION_CONFIG,
        articles_per_section: DEFAULT_ARTICLES_PER_SECTION,
        pending_expiry_days:  DEFAULT_PENDING_EXPIRY_DAYS,
      };
    }

    const cfg = JSON.parse(data.value);
    return {
      section_config:       cfg.sections || DEFAULT_SECTION_CONFIG,
      articles_per_section: cfg.articles_per_section || DEFAULT_ARTICLES_PER_SECTION,
      pending_expiry_days:  cfg.pending_expiry_days  || DEFAULT_PENDING_EXPIRY_DAYS,
    };
  } catch (err) {
    console.warn('[PUBLISH] Config load error — using defaults:', err.message);
    return {
      section_config:       DEFAULT_SECTION_CONFIG,
      articles_per_section: DEFAULT_ARTICLES_PER_SECTION,
      pending_expiry_days:  DEFAULT_PENDING_EXPIRY_DAYS,
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runPublishCycle() {
  const config = await loadConfig();
  const { section_config, articles_per_section, pending_expiry_days } = config;

  let retiredCount    = 0;
  let promotedCount   = 0;
  let blurbsGenerated = 0;
  let expiredPending  = 0;
  let blurbFailures   = 0;
  const BLURB_CIRCUIT_BREAKER = 10;

  // ── Step 1: Retire expired articles ────────────────────────────────────────

  // By expires_at
  if (!DRY_RUN) {
    const { data: expiredByDate, error: expErr1 } = await supabase
      .from('articles')
      .update({ status: 'retired' })
      .eq('status', 'active')
      .lt('expires_at', new Date().toISOString())
      .select('id, headline, section');

    if (expErr1) console.error('[PUBLISH] Error retiring by expires_at:', expErr1.message);
    for (const a of expiredByDate || []) {
      console.log(`[PUBLISH] RETIRE: ${a.headline.substring(0, 50)} (${a.section})`);
      retiredCount++;
    }
  }

  // Hard max safety net — per section
  for (const [section, cfg] of Object.entries(section_config)) {
    if (!cfg.max_hours) continue;
    const maxDate = new Date(Date.now() - cfg.max_hours * 3600000).toISOString();

    if (!DRY_RUN) {
      const { data: hardExpired, error: expErr2 } = await supabase
        .from('articles')
        .update({ status: 'retired' })
        .eq('status', 'active')
        .eq('section', section)
        .lt('promoted_at', maxDate)
        .select('id, headline, section');

      if (expErr2) console.error(`[PUBLISH] Hard-max retire error (${section}):`, expErr2.message);
      for (const a of hardExpired || []) {
        console.log(`[PUBLISH] RETIRE (hard max): ${a.headline.substring(0, 50)} (${a.section})`);
        retiredCount++;
      }
    }
  }

  // ── Step 2: Count active per section ───────────────────────────────────────
  const { data: activeArticles, error: activeErr } = await supabase
    .from('articles')
    .select('id, headline, section, rank_score')
    .eq('status', 'active');

  if (activeErr) {
    console.error('[PUBLISH] Fatal: cannot fetch active articles:', activeErr.message);
    process.exit(1);
  }

  const activeBySection = {};
  for (const section of SECTIONS) activeBySection[section] = [];
  for (const a of activeArticles || []) {
    if (activeBySection[a.section] !== undefined) activeBySection[a.section].push(a);
  }

  // ── Step 3: Promote top-ranked pending ─────────────────────────────────────
  for (const section of SECTIONS) {
    const currentActive = activeBySection[section].length;
    const openSlots     = articles_per_section - currentActive;
    if (openSlots <= 0) continue;

    const { data: candidates, error: candErr } = await supabase
      .from('articles')
      .select('id, headline, blurb, section, rank_score')
      .eq('status', 'pending')
      .eq('section', section)
      .order('rank_score', { ascending: false })
      .limit(openSlots);

    if (candErr) {
      console.error(`[PUBLISH] Error fetching pending for ${section}:`, candErr.message);
      continue;
    }

    for (const article of candidates || []) {
      const now         = new Date().toISOString();
      const lifespanHrs = section_config[section]?.lifespan_hours || 48;
      const expiresAt   = new Date(Date.now() + lifespanHrs * 3600000).toISOString();

      // Generate BW-voice blurb (circuit breaker: stop after 10 consecutive failures)
      let finalBlurb = article.blurb;
      if (blurbFailures < BLURB_CIRCUIT_BREAKER) {
        const generated = await generateBlurb(article.headline, article.blurb, section);
        if (generated && generated !== article.blurb) {
          finalBlurb = generated;
          blurbsGenerated++;
        } else {
          blurbFailures++;
          if (blurbFailures >= BLURB_CIRCUIT_BREAKER) {
            console.warn('[PUBLISH] BLURB CIRCUIT BREAKER: 10+ failures — using original blurbs for remaining articles');
          }
        }
      }

      if (!DRY_RUN) {
        const { error: promoteErr } = await supabase
          .from('articles')
          .update({
            status:      'active',
            promoted_at: now,
            expires_at:  expiresAt,
            blurb:       finalBlurb,
          })
          .eq('id', article.id);

        if (promoteErr) {
          console.error(`[PUBLISH] Error promoting article ${article.id}:`, promoteErr.message);
          continue;
        }
      }

      console.log(`[PUBLISH] PROMOTE: ${article.headline.substring(0, 50)} → ${section} (rank: ${article.rank_score})`);
      promotedCount++;

      // Track in memory for over-capacity check
      activeBySection[section].push(article);
    }
  }

  // ── Step 4: Expire old pending → rejected ──────────────────────────────────
  const pendingExpiryCutoff = new Date(Date.now() - pending_expiry_days * 86400000).toISOString();

  if (!DRY_RUN) {
    const { data: expiredPendingRows, error: expPendErr } = await supabase
      .from('articles')
      .update({ status: 'rejected' })
      .eq('status', 'pending')
      .lt('published_at', pendingExpiryCutoff)
      .select('id, headline');

    if (expPendErr) console.error('[PUBLISH] Error expiring old pending:', expPendErr.message);
    for (const a of expiredPendingRows || []) {
      console.log(`[PUBLISH] EXPIRE PENDING: ${a.headline.substring(0, 50)} (pending > ${pending_expiry_days} days)`);
      expiredPending++;
    }
  }

  // ── Step 5: Over-capacity safety ───────────────────────────────────────────
  for (const [section, articles] of Object.entries(activeBySection)) {
    if (articles.length > articles_per_section) {
      const sorted   = [...articles].sort((a, b) => (a.rank_score || 0) - (b.rank_score || 0));
      const toRetire = sorted.slice(0, articles.length - articles_per_section);

      for (const a of toRetire) {
        console.log(`[PUBLISH] FORCE RETIRE: ${(a.headline || '').substring(0, 50)} (over capacity in ${section})`);
        if (!DRY_RUN) {
          const { error: forceErr } = await supabase
            .from('articles')
            .update({ status: 'retired' })
            .eq('id', a.id);
          if (forceErr) console.error(`[PUBLISH] Force retire error:`, forceErr.message);
        }
        retiredCount++;
      }
    }
  }

  // ── Step 6: Build summary data ─────────────────────────────────────────────

  // Final active counts (after all changes)
  const { data: finalActive } = await supabase
    .from('articles')
    .select('section')
    .eq('status', 'active');

  const finalActiveBySection = {};
  for (const s of SECTIONS) finalActiveBySection[s] = 0;
  for (const r of finalActive || []) {
    if (finalActiveBySection[r.section] !== undefined) finalActiveBySection[r.section]++;
  }

  // Pending counts
  const { data: pendingRows } = await supabase
    .from('articles')
    .select('section')
    .eq('status', 'pending');

  const pendingBySection = {};
  for (const s of SECTIONS) pendingBySection[s] = 0;
  for (const r of pendingRows || []) {
    if (pendingBySection[r.section] !== undefined) pendingBySection[r.section]++;
  }

  // Rough blurb API cost estimate (haiku output tokens ~ 80 per blurb)
  const blurbCostEst = blurbsGenerated * (80 / 4 / 1_000_000) * 1.25;

  // ── Summary ────────────────────────────────────────────────────────────────
  const D = '━'.repeat(52);
  console.log(`
${D}
[PUBLISH] CYCLE SUMMARY${DRY_RUN ? ' (DRY RUN)' : ''}
${D}
Articles retired:     ${retiredCount}
Articles promoted:    ${promotedCount}
Blurbs generated:     ${blurbsGenerated}
Pending expired:      ${expiredPending}

Section health:`);

  const maxLabelLen = Math.max(...SECTIONS.map(s => s.length));
  for (const section of SECTIONS) {
    const label   = section.padEnd(maxLabelLen + 2);
    const active  = finalActiveBySection[section];
    const pending = pendingBySection[section];
    console.log(`  ${label} ${active}/${articles_per_section} active, ${pending} pending`);
  }

  console.log(`
Est. API cost (blurbs): $${blurbCostEst.toFixed(4)}
${D}
`);
}

runPublishCycle();
