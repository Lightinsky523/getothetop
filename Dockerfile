# 魔搭创空间 Docker 部署（参见 https://www.modelscope.cn/docs/studios/quick-create）
# 要求：服务必须监听 0.0.0.0:7860
FROM modelscope-registry.cn-beijing.cr.aliyuncs.com/modelscope-repo/python:3.10

# 安装 Node.js 18
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /home/user/app
COPY ./ /home/user/app

# 安装 Node.js 依赖
RUN npm install

# 创建数据目录并设置权限
RUN mkdir -p /home/user/app/data && chmod 777 /home/user/app/data

# 创空间要求端口为 7860
ENV PORT=7860

VOLUME ["/home/user/app/data"]
EXPOSE 7860
ENTRYPOINT ["node", "app.js"]
