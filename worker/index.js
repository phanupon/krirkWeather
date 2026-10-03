// จุดเริ่มต้นของ Cloudflare Worker
// - /api/* และ /proxy/* → ใช้ handler ชุดเดียวกับ functions/ (Pages Functions)
// - เส้นทางอื่น → ไฟล์ static ใน public/ (ผ่าน binding ASSETS)
import { onRequestGet as waqi } from '../functions/api/waqi/[[path]].js';
import { onRequestGet as firms } from '../functions/api/firms/[[path]].js';
import { onRequestGet as gistda } from '../functions/api/gistda/[[path]].js';
import { onRequestGet as royalrain } from '../functions/proxy/royalrain.js';

const PATH_ROUTES = [['/api/waqi/', waqi], ['/api/firms/', firms], ['/api/gistda/', gistda]];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/proxy/');
    if (!isApi) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

    for (const [prefix, handler] of PATH_ROUTES) {
      if (url.pathname.startsWith(prefix)) {
        // จำลอง params แบบ [[path]] ของ Pages Functions
        const path = url.pathname.slice(prefix.length).split('/').filter(Boolean);
        return handler({ request, env, params: { path } });
      }
    }
    if (url.pathname === '/proxy/royalrain') return royalrain({ request, env, params: {} });
    return new Response('not found', { status: 404 });
  },
};
