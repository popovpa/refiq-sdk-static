FROM node:20-alpine AS build

ARG REFIQ_CS_BACKEND_URL=https://events.refiq.ru/event
ENV REFIQ_CS_BACKEND_URL=$REFIQ_CS_BACKEND_URL

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY build.js sdk.js ./
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/sdk.js /usr/share/nginx/html/sdk.js

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
