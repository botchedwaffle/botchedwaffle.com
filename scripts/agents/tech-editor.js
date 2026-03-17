const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SYSTEM_PROMPT = `You are the Technology & Systems Editor for BotchedWaffle.com.

Your editorial worldview: AI, automation, infrastructure, digital society, and the systems that shape how we live. You prize contrarian takes, real-world implications over hype, and non-obvious angles about how technology embeds itself in everyday life. Keywords: ai, machine learning, algorithm, software, automation, infrastructure, grid, supply chain, privacy, surveillance, digital, platform, network.

You are NOT interested in: product launch announcements without analysis, pure speculation, anything that reads like a press release, incremental version updates.

Brand voice: "Punchy curiosity meets intellectual depth." Ask yourself: does this reveal something true about how technology is reshaping power, behavior, or society?

You will receive an article headline, source name, and blurb. Score it 0.0–10.0.

Respond ONLY with valid JSON, no other text:
{
  "score": 8.5,
  "reasoning": "One sentence explaining why."
}`;

async function runTechEditor() {
  const { data: articles, error } = await supabase
    .from('articles')
    .select('id, headline, blurb, source_name')
    .eq('section', 'technology-systems')
    .in('status', ['pipeline', 'queue'])
    .eq('scored_by', 'rule-based')
    .limit(20);

  if (error) { console.error('Supabase error:', error.message); return; }
  if (!articles.length) { console.log('No articles to score.'); return; }

  console.log(`Scoring ${articles.length} Technology & Systems articles...`);

  for (const article of articles) {
    const userMessage = `Headline: ${article.headline}
Source: ${article.source_name}
Blurb: ${article.blurb || '(none)'}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }]
        })
      });

      const data = await response.json();
      const raw = data.content?.[0]?.text;
      if (!raw) { console.error('Empty response for', article.id); continue; }

      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      await supabase
        .from('articles')
        .update({
          score: parsed.score,
          score_reasoning: parsed.reasoning,
          scored_by: 'agent'
        })
        .eq('id', article.id);

      console.log(`✓ [${parsed.score}] ${article.headline.slice(0, 60)}`);
      console.log(`  → ${parsed.reasoning}`);

    } catch (err) {
      console.error(`Error on article ${article.id}:`, err.message);
    }
  }
}

runTechEditor().catch(console.error);
