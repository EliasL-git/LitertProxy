FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm ci --only=production
COPY index.js ./

# NOTE: This image expects `litert-lm` to be present in PATH. You can either
# install `litert-lm` inside the image (using uv or pip) or mount a host
# binary at runtime. For small images it's recommended to install separately
# on the VM and run the gateway alongside.

ENV LISTEN_ADDR=0.0.0.0
ENV LISTEN_PORT=8080
ENV MAX_CONCURRENCY=4
ENV REQUEST_TIMEOUT_MS=120000

EXPOSE 8080
CMD ["node", "index.js"]
