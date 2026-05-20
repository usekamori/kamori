# Build context: kamori/ root
# docker build -f kamori-demo/winston-service/Dockerfile .
FROM node:22-alpine
WORKDIR /project

# Copy SDK source (local file: dependency — not yet published to npm)
COPY packages/sdk ./packages/sdk

# Copy service and install
COPY kamori-demo/winston-service ./kamori-demo/winston-service
WORKDIR /project/kamori-demo/winston-service
RUN --mount=type=cache,target=/root/.npm \
    npm install

CMD ["npx", "tsx", "src/index.ts"]
