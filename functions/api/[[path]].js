/**
 * Cloudflare Pages Functions 入口
 *
 * Pages 会把 functions/api/* 挂到 /api/*，这里把请求原样交给
 * worker/worker.js 里的同一套逻辑（和 Workers 版完全一致）。
 *
 * 绑定（Pages 项目 → Settings → Functions）：
 *   KV 命名空间 → 变量名 USERS
 * 环境变量（Settings → Environment variables）：
 *   DEEPSEEK_API_KEY / ACCOUNTS / ADMIN_PASSWORD / SESSION_SECRET
 */
import app from '../../worker/worker.js';

export async function onRequest(context) {
  const ctx = {
    waitUntil(promise) {
      if (typeof context.waitUntil === 'function') context.waitUntil(promise);
      else Promise.resolve(promise).catch(() => {});
    },
    passThroughOnException() {
      if (typeof context.passThroughOnException === 'function') context.passThroughOnException();
    },
  };
  return app.fetch(context.request, context.env, ctx);
}
