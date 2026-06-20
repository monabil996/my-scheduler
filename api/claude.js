// Vercel serverless function — proxies requests to Anthropic Claude API
// Needed because Anthropic blocks direct browser-to-API calls (CORS)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, apiKey, maxTokens = 600 } = req.body || {};
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';

  if (!key) {
    return res.status(400).json({ error: 'No Claude API key provided' });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ error: data.error?.message || 'Claude API error' });
    }

    return res.status(200).json({ text: data.content?.[0]?.text ?? '' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
