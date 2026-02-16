FROM node:18-alpine
WORKDIR /home/user/app
COPY ./ /home/user/app
RUN npm install express sqlite3 cors node-fetch

# 创建数据目录并设置权限
RUN mkdir -p /home/user/app/data && chmod 777 /home/user/app/data

# 声明数据卷，确保数据持久化
VOLUME ["/home/user/app/data"]

EXPOSE 7860
ENTRYPOINT ["node", "app.js"]
