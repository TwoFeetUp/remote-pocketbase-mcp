# Use an official Node.js image as a base
FROM oven/bun:1.4.4-alpine AS bun
FROM node:20-alpine
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Set the working directory in the container
WORKDIR /app

# Copy package.json and tsconfig.json to the working directory
COPY package.json bun.lock tsconfig.json ./

# Install project dependencies
RUN bun install --frozen-lockfile --network-concurrency=1

# Copy the rest of the application's source code
COPY src/ ./src/

# Expose the port on which the HTTP server will run
EXPOSE 3000

# Set the environment variables for the PocketBase connection
ENV POCKETBASE_URL=http://127.0.0.1:8090

# Start the HTTP server
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
