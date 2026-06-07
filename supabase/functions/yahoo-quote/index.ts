const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  const symbols = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean);
  const range   = url.searchParams.get('range')    || '1d';
  const interval = url.searchParams.get('interval') || '1d';
  const mode    = url.searchParams.get('mode')     || 'quote'; // quote | history

  if (!symbols.length) {
    return new Response(JSON.stringify({ error: 'symbols required' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  const YH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0';

  const results = await Promise.all(symbols.map(async (sym) => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`,
        { headers: { 'User-Agent': YH_UA } }
      );
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) return null;

      const meta = result.meta;
      const q    = result.indicators?.quote?.[0] || {};
      const ts   = result.timestamp || [];

      if (mode === 'history') {
        return {
          symbol: meta.symbol,
          history: ts.map((t: number, i: number) => ({
            date:   new Date(t * 1000).toISOString().slice(0, 10),
            open:   q.open?.[i]   ?? null,
            high:   q.high?.[i]   ?? null,
            low:    q.low?.[i]    ?? null,
            close:  q.close?.[i]  ?? null,
            volume: q.volume?.[i] ?? null,
          })).filter((r: Record<string, unknown>) => r.close != null),
        };
      }

      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose;
      return {
        symbol:                     meta.symbol,
        shortName:                  meta.longName || meta.shortName || sym,
        currency:                   meta.currency,
        regularMarketPrice:         price,
        regularMarketOpen:          q.open?.[0]   ?? null,
        regularMarketDayHigh:       q.high?.[0]   ?? null,
        regularMarketDayLow:        q.low?.[0]    ?? null,
        regularMarketVolume:        q.volume?.[0] ?? null,
        regularMarketPreviousClose: prev,
        regularMarketChange:        prev != null ? price - prev : null,
        regularMarketChangePercent: prev != null ? ((price - prev) / prev) * 100 : null,
        fiftyTwoWeekHigh:           meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow:            meta.fiftyTwoWeekLow  ?? null,
      };
    } catch {
      return null;
    }
  }));

  return new Response(
    JSON.stringify({ quoteResponse: { result: results.filter(Boolean) } }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
});
