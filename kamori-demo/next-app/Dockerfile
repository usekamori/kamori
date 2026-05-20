# Build context: kamori/ root
# docker build -f kamori-demo/next-app/Dockerfile .
FROM node:22-alpine
WORKDIR /project

# Copy SDK source (local file: dependency — not yet published to npm)
COPY packages/sdk ./packages/sdk

# Copy service and install
COPY kamori-demo/next-app ./kamori-demo/next-app
WORKDIR /project/kamori-demo/next-app
RUN --mount=type=cache,target=/root/.npm \
    npm install

CMD ["npm", "run", "dev"]
