/* 后端地址（社团服务器）
 *
 * GitHub Pages 是纯静态的，账号登录和额度都在 server/server.mjs 里。
 * 把 server/ 部署到 Render 等平台后，把地址填到下面（结尾不要带斜杠）：
 *
 *   window.DS_API_BASE = 'https://shetuankaifang.onrender.com';
 *
 * 留空则使用当前页面的同源地址：
 *   - 直接打开 Node 服务（http://127.0.0.1:3000）时，留空即可
 *   - GitHub Pages 上留空 = 退回「每人自己填 Key」的静态模式
 */
window.DS_API_BASE = '';
