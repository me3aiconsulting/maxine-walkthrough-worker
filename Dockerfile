# Maxine Walkthrough Worker — Railway/Fly.io deployable
FROM node:20-slim

# ffmpeg + ffprobe (the only system dependency this worker needs)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Railway injects PORT; default for local runs
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
