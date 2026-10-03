// /api/waqi/*  →  https://api.waqi.info/*  (ใส่ token จาก secret WAQI_TOKEN)
import { forward, joinPath, missingSecret, text } from '../../_lib/proxy.js';

// อนุญาตเฉพาะ endpoint ที่หน้าเว็บใช้
const ALLOWED = /^(map\/bounds|feed\/(@-?\d+|geo:-?\d+(\.\d+)?;-?\d+(\.\d+)?))\/?$/;

export async function onRequestGet({ request, params, env }) {
  const miss = missingSecret(env, 'WAQI_TOKEN');
  if (miss) return miss;
  const path = joinPath(params);
  if (!ALLOWED.test(path)) return text(400, 'path not allowed');

  const q = new URL(request.url).searchParams, up = new URLSearchParams();
  const latlng = q.get('latlng');
  if (latlng) {
    if (!/^-?[\d.]+(,-?[\d.]+){3}$/.test(latlng)) return text(400, 'invalid latlng');
    up.set('latlng', latlng);
  }
  if (q.get('networks') === 'all') up.set('networks', 'all');
  up.set('token', env.WAQI_TOKEN);

  return forward(`https://api.waqi.info/${path.replace(/\/?$/, '/')}?${up}`, { ttl: 600, secret: env.WAQI_TOKEN });
}
