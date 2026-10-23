FROM node:24-alpine

WORKDIR /app

# 静态页面在仓库根目录，server.mjs 放在 /app/server/ 下，
# 这样 server.mjs 里的 PUBLIC_DIR = __dirname/.. 正好指向 /app
COPY index.html app.js style.css auth.css favicon.svg runtime.js config.js ./
COPY server/package.json ./server/package.json
COPY server/server.mjs ./server/server.mjs

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV PUBLIC_DIR=/app

EXPOSE 3000

# server/data 里保存 API Key 配置与访问日志，建议挂载卷持久化
VOLUME ["/app/server/data"]

CMD ["node", "server/server.mjs"]
