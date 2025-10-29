# Remote PocketBase MCP

An HTTP-based Model Context Protocol (MCP) server that bridges Claude with PocketBase, allowing AI-powered interactions with your self-hosted PocketBase backend.

## Overview

This project exposes PocketBase functionality through the Model Context Protocol (developed by Anthropic) via an HTTP interface. It enables Claude to perform database operations, manage collections, handle authentication, and more through a standardized web API.

## Features

### Collection Management
- Create, read, update, and delete collections
- Configure custom fields and schemas
- List and filter collections

### Record Management
- CRUD operations on records
- Advanced querying with pagination, filtering, and sorting
- Bulk data import with multiple modes (create, update, upsert)

### Authentication & User Management
- Email/password authentication
- OAuth2 provider support
- One-time password (OTP) authentication
- Token refresh and session management
- Email verification and password reset flows
- User impersonation (admin)

### Database Operations
- Database backups
- Server log retrieval and filtering
- Comprehensive error handling

## Prerequisites

- Node.js 20 or higher
- A running PocketBase instance
- Admin credentials for your PocketBase instance

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file based on `.env.example`:

```env
POCKETBASE_URL=https://your-pocketbase-instance.com
POCKETBASE_ADMIN_EMAIL=admin@example.com
POCKETBASE_ADMIN_PASSWORD=your-secure-password
```

### Optional Environment Variables

- `PORT` - HTTP server port (default: 3000)
- `HOST` - Bind address (default: 0.0.0.0)

## Usage

### Local Development

```bash
# Build the project
npm run build

# Start the server
npm start

# Or run in development mode with watch
npm run dev
```

The server will start on `http://localhost:3000`.

### HTTP Endpoints

- `POST /mcp` - MCP request handling (client-to-server)
- `GET /mcp` - Server-Sent Events for server-to-client notifications
- `DELETE /mcp` - Session termination

### Connecting with Claude

Configure your MCP client to connect to the HTTP endpoint:

```json
{
  "mcpServers": {
    "pocketbase": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Available Tools

The server exposes 24 tools for PocketBase operations:

### Collection Tools
- `create_collection` - Create new collections with custom fields
- `update_collection` - Modify existing collections (admin only)
- `get_collection` - Retrieve collection details
- `list_collections` - List all collections with filtering/sorting
- `delete_collection` - Remove collections (admin only)

### Record Tools
- `create_record` - Add new records
- `list_records` - Query records with advanced filtering
- `update_record` - Modify existing records
- `delete_record` - Remove records

### Authentication Tools
- `authenticate_user` - Login with email/password
- `authenticate_with_oauth2` - OAuth2 authentication
- `authenticate_with_otp` - One-time password authentication
- `auth_refresh` - Refresh authentication tokens
- `create_user` - Register new users
- `list_auth_methods` - Get available authentication methods
- `request_verification` - Request email verification
- `confirm_verification` - Confirm email with token
- `request_password_reset` - Initiate password reset
- `confirm_password_reset` - Complete password reset
- `request_email_change` - Request email change
- `confirm_email_change` - Confirm email change
- `impersonate_user` - Admin user impersonation

### Data Management Tools
- `backup_database` - Create database backups
- `import_data` - Bulk import records
- `fetch_logs` - Retrieve and filter server logs

## Docker Deployment

### Build the Docker Image

```bash
docker build -t pocketbase-mcp .
```

### Run the Container

```bash
docker run -p 3000:3000 \
  -e POCKETBASE_URL=https://your-instance.com \
  -e POCKETBASE_ADMIN_EMAIL=admin@example.com \
  -e POCKETBASE_ADMIN_PASSWORD=your-password \
  pocketbase-mcp
```

## Development

### Project Structure

```
remote-pocketbase-mcp/
├── src/
│   ├── index.ts           # Main server implementation
│   └── http-server.ts     # HTTP server (duplicate of index.ts)
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── Dockerfile             # Docker containerization
└── .env.example           # Environment template
```

### Tech Stack

- **TypeScript** - Type-safe development
- **Express** - HTTP web framework
- **PocketBase SDK** - Official PocketBase client
- **MCP SDK** - Model Context Protocol implementation
- **Docker** - Containerized deployment

### Building

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `build/` directory and sets executable permissions on the entry point.

## Session Management

The server maintains stateful sessions for each client connection:
- Unique session IDs (UUID)
- Separate PocketBase instances for user and admin operations
- Automatic cleanup on disconnect

## MCP Protocol Support

Supports MCP protocol versions:
- 2025-06-18
- 2025-03-26

## License

See repository for license information.

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
