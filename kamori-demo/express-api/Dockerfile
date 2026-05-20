# Build context: kamori/ root
# docker build -f kamori-demo/express-api/Dockerfile .
FROM node:22-alpine
WORKDIR /project

# Copy SDK source (local file: dependency — not yet published to npm)
COPY packages/sdk ./packages/sdk

# Copy service and install
COPY kamori-demo/express-api ./kamori-demo/express-api
WORKDIR /project/kamori-demo/express-api
RUN --mount=type=cache,target=/root/.npm \
    npm install

CMD ["npx", "tsx", "src/index.ts"]
