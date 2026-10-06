FROM node:22-alpine

WORKDIR /app
COPY . .

RUN npm i
RUN npm run build

EXPOSE 8080

CMD ["npm", "start"]