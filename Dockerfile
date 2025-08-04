# Use an official Node.js image as a base
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and tsconfig.json to the working directory
COPY package.json tsconfig.json ./

# Install project dependencies
RUN npm install

# Install tsx for running TypeScript directly
RUN npm install -g tsx

# Copy the rest of the application's source code
COPY src/ ./src/
COPY playground/ ./playground/

# Expose the port on which the HTTP server will run
EXPOSE 3000

# Set the environment variables for the PocketBase connection
ENV POCKETBASE_URL=http://127.0.0.1:8090

# Start the HTTP server
CMD ["tsx", "playground/http-server/index-complete.ts"]
