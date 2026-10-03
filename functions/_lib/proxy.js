// ฟังก์ชันช่วยสำหรับ Pages Functions ที่เป็นตัวกลาง (proxy) ไปยัง API ภายนอก
// - คีย์ API อยู่ใน Secret ของ Cloudflare (env) ไม่ถูกส่งไปที่เบราว์เซอร์
// - แคชผลลัพธ์ที่ edge เพื่อประหยัดโควตาของคีย์

export const text = (status, msg) => new Response(msg, {
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** คืน Response แจ้งข้อผิดพลาดถ้ายังไม่ได้ตั้งค่า secret */
export const missingSecret = (env, name) =>
  (env[name] ? null : text(500, `ยังไม่ได้ตั้งค่า secret ${name} ใน Cloudflare Pages (Settings → Variables and Secrets)`));

/**
 * ส่งต่อคำขอไปยัง url และแคชไว้ ttl วินาที
 * secret: ลบค่านี้ออกจากเนื้อหาที่ตอบกลับ (เช่น GISTDA ใส่ api_key ไว้ในลิงก์ของผลลัพธ์)
 */
export async function forward(url, { ttl, secret, contentType }) {
  let res;
  try {
    res = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true } });
  } catch (e) {
    return text(502, `เชื่อมต่อ API ต้นทางไม่สำเร็จ: ${e.message}`);
  }
  let body = await res.text();
  if (secret) body = body.split(secret).join('REDACTED');
  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || contentType || 'text/plain; charset=utf-8',
      'Cache-Control': res.ok ? `public, max-age=${ttl}` : 'no-store',
    },
  });
}

/** รวม path จาก params ของเส้นทางแบบ [[path]] */
export const joinPath = params => decodeURIComponent([].concat(params.path || []).join('/'));
