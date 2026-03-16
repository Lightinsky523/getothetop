FROM node:20-alpine

WORKDIR /app

# 安装 Python 和构建工具（用于 sqlite3 等 native 模块）
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --registry=https://registry.npmmirror.com

COPY . .

EXPOSE 3000

CMD ["node", "app.js"]
