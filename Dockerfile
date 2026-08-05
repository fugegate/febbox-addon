FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY web/package*.json web/
RUN npm --prefix web install --include=dev

COPY . .
RUN npm run build

EXPOSE 7000
CMD ["npm", "start"]
