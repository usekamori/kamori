# Build context: kamori/ root
# docker build -f kamori-demo/fastify-api/Dockerfile .
FROM node:22-alpine
WORKDIR /project

# Copy SDK source (local file: dependency — not yet published to npm)
COPY packages/sdk ./packages/sdk

# Copy service and install
COPY kamori-demo/fastify-api ./kamori-demo/fastify-api
WORKDIR /project/kamori-demo/fastify-api
RUN --mount=type=cache,target=/root/.npm \
    npm install

CMD ["npx", "tsx", "src/index.ts"]
