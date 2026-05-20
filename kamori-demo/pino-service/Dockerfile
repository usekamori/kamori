# Build context: kamori/ root
# docker build -f kamori-demo/pino-service/Dockerfile .
FROM node:22-alpine
WORKDIR /project

# Copy SDK source (local file: dependency — not yet published to npm)
COPY packages/sdk ./packages/sdk

# Copy service and install
COPY kamori-demo/pino-service ./kamori-demo/pino-service
WORKDIR /project/kamori-demo/pino-service
RUN --mount=type=cache,target=/root/.npm \
    npm install

CMD ["npx", "tsx", "src/index.ts"]
