// /api/gistda/*  →  https://api-gateway.gistda.or.th/api/2.0/resources/features/*  (ใส่ api_key จาก secret GISTDA_KEY)
import { forward, joinPath, missingSecret, text } from '../../_lib/proxy.js';

const ALLOWED = /^(viirs\/(1day|3days|7days|30days)|burn-scar)$/;
// GISTDA ถือว่าพารามิเตอร์ที่ไม่รู้จักเป็นตัวกรอง จึงส่งต่อเฉพาะที่หน้าเว็บใช้
const FILTERS = ['ct_en', 'ct_tn', 'pv_tn', 'pv_en'];

export async function onRequestGet({ request, params, env }) {
  const miss = missingSecret(env, 'GISTDA_KEY');
  if (miss) return miss;
  const path = joinPath(params);
  if (!ALLOWED.test(path)) return text(400, 'path not allowed');

  const q = new URL(request.url).searchParams, up = new URLSearchParams();
  const limit = +(q.get('limit') ?? 1000), offset = +(q.get('offset') ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
    return text(400, 'invalid limit/offset');
  }
  up.set('limit', limit);
  up.set('offset', offset);
  FILTERS.forEach(k => { if (q.get(k)) up.set(k, q.get(k)); });
  up.set('api_key', env.GISTDA_KEY);

  const ttl = path === 'burn-scar' ? 3600 : 300;
  return forward(`https://api-gateway.gistda.or.th/api/2.0/resources/features/${path}?${up}`, { ttl, secret: env.GISTDA_KEY });
}
