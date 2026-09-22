// Vercel Edge Function - WS Proxy & CORS bypass + signed requests
// Frontend'den api/ws-proxy?exchange=binance&symbol=BTCUSDT gibi çağrılabilir
// Gerçek trade emri gönderimi için server-side imzalama örneği (örnek, production'da güçlendirin)

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') || 'BTCUSDT';

  // Example: proxy Binance klines to avoid CORS if needed
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, {
      headers: { 'User-Agent': 'PRIMAT-V2/1.0' }
    });
    const data = await r.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
