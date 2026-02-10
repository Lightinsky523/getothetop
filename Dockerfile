FROM node:18-alpine
WORKDIR /home/user/app
COPY ./ /home/user/app
RUN npm install express mysql2 cors node-fetch
EXPOSE 7860
ENTRYPOINT ["node", "app.js"]
