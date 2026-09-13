# 微信云托管 / 通用容器部署
# 使用完整版 node 镜像（自带 g++、make、python3，便于编译 better-sqlite3 原生模块）
FROM node:20

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package*.json ./
RUN npm install

# 再拷贝源码
COPY . .

ENV NODE_ENV=production
ENV PORT=3100
ENV MOCK_WECHAT=true

EXPOSE 3100

CMD ["node", "src/index.js"]
