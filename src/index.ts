#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import PocketBase from 'pocketbase';
import express from 'express';
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Error handling functions
function flattenErrors(errors: unknown): string[] {
  if (Array.isArray(errors)) {
    return errors.flatMap(flattenErrors);
  } else if (typeof errors === "object" && errors !== null) {
    const errorObject = errors as Record<string, any>;

    // Handle objects with message property directly
    if (errorObject.message) {
      return [errorObject.message, ...flattenErrors(errorObject.data || {})];
    }

    // Handle nested objects with code/message structure
    if (errorObject.data) {
      const messages: string[] = [];

      for (const key in errorObject.data) {
        const value = errorObject.data[key];
        if (typeof value === "object" && value !== null) {
          // Always recursively process the value to extract all messages
          messages.push(...flattenErrors(value));
        }
      }

      if (messages.length > 0) {
        return messages;
      }
    }

    // Process all object values recursively
    return Object.values(errorObject).flatMap(flattenErrors);
  } else if (typeof errors === "string") {
    return [errors];
  } else {
    return [];
  }
}

function pocketbaseErrorMessage(errors: unknown): string {
  const messages = flattenErrors(errors);
  return messages.length > 0 ? messages.join("\n") : "No errors found";
}

// Session state management
interface SessionState {
  userPb?: PocketBase; // For authenticated user operations
  adminPb?: PocketBase; // For admin operations
  currentAuthToken?: string;
  currentAuthRecord?: any;
}

class PocketBaseHTTPServer {
  private app: express.Application;
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private servers: Map<string, Server> = new Map();
  private sessionStates: Map<string, SessionState> = new Map();

  constructor() {
    // Verify PocketBase URL is set
    const url = process.env.POCKETBASE_URL;
    if (!url) {
      throw new Error('POCKETBASE_URL environment variable is required');
    }

    // Initialize Express app
    this.app = express();
    this.app.use(express.json());
    
    // Configure CORS for browser-based clients
    this.app.use(cors({
      origin: '*', // Configure appropriately for production
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: ['Content-Type', 'mcp-session-id', 'MCP-Protocol-Version'],
    }));

    this.setupHTTPEndpoints();
  }

  private getSessionState(sessionId: string): SessionState {
    if (!this.sessionStates.has(sessionId)) {
      this.sessionStates.set(sessionId, {});
    }
    return this.sessionStates.get(sessionId)!;
  }

  private getUserPocketBase(sessionId: string): PocketBase {
    const state = this.getSessionState(sessionId);
    if (!state.userPb) {
      state.userPb = new PocketBase(process.env.POCKETBASE_URL!);
      // Restore auth if we have a token
      if (state.currentAuthToken && state.currentAuthRecord) {
        state.userPb.authStore.save(state.currentAuthToken, state.currentAuthRecord);
      }
    }
    return state.userPb;
  }

  private getAdminPocketBase(sessionId: string): PocketBase {
    const state = this.getSessionState(sessionId);
    if (!state.adminPb) {
      state.adminPb = new PocketBase(process.env.POCKETBASE_URL!);
    }
    return state.adminPb;
  }

  private createServer(sessionId: string): Server {
    const server = new Server(
      {
        name: 'pocketbase-http-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlersForServer(server, sessionId);
    server.onerror = (error) => console.error('[MCP Error]', error);
    
    return server;
  }

  private setupToolHandlersForServer(server: Server, sessionId: string) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_collection',
          description: 'Create a new collection in PocketBase note never use created and updated because these are already created',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Unique collection name (used as a table name for the records table)',
              },
              type: {
                type: 'string',
                description: 'Type of the collection',
                enum: ['base', 'view', 'auth'],
                default: 'base',
              },
              fields: {
                type: 'array',
                description: 'List with the collection fields',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name' },
                    type: { type: 'string', description: 'Field type', enum: ['bool', 'date', 'number', 'text', 'email', 'url', 'editor', 'autodate', 'select', 'file', 'relation', 'json'] },
                    required: { type: 'boolean', description: 'Is field required?' },
                    values: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Allowed values for select type fields',
                    },
                    collectionId: { type: 'string', description: 'Collection ID for relation type fields' }
                  },
                },
              },
              createRule: {
                type: 'string',
                description: 'API rule for creating records',
              },
              updateRule: {
                type: 'string',
                description: 'API rule for updating records',
              },
              deleteRule: {
                type: 'string',
                description: 'API rule for deleting records',
              },
              listRule: {
                type: 'string',
                description: 'API rule for listing and viewing records',
              },
              viewRule: {
                type: 'string',
                description: 'API rule for viewing a single record',
              },
              viewQuery: {
                type: 'string',
                description: 'SQL query for view collections',
              },
              passwordAuth: {
                type: 'object',
                description: 'Password authentication options',
                properties: {
                  enabled: { type: 'boolean', description: 'Is password authentication enabled?' },
                  identityFields: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Fields used for identity in password authentication',
                  },
                },
              },
            },
            required: ['name', 'fields'],
          },
        },
        {
          name: 'update_collection',
          description: 'Update an existing collection in PocketBase (admin only)',
          inputSchema: {
            type: 'object',
            properties: {
              collectionIdOrName: {
                type: 'string',
                description: 'ID or name of the collection to update',
              },
              name: {
                type: 'string',
                description: 'New unique collection name',
              },
              type: {
                type: 'string',
                description: 'Type of the collection',
                enum: ['base', 'view', 'auth'],
              },
              fields: {
                type: 'array',
                description: 'List with the new collection fields. If not empty, the old schema will be replaced with the new one.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name' },
                    type: { type: 'string', description: 'Field type', enum: ['bool', 'date', 'number', 'text', 'email', 'url', 'editor', 'autodate', 'select', 'file', 'relation', 'json'] },
                    required: { type: 'boolean', description: 'Is field required?' },
                    values: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Allowed values for select type fields',
                    },
                    collectionId: { type: 'string', description: 'Collection ID for relation type fields' }
                  },
                },
              },
              createRule: {
                type: 'string',
                description: 'API rule for creating records',
              },
              updateRule: {
                type: 'string',
                description: 'API rule for updating records',
              },
              deleteRule: {
                type: 'string',
                description: 'API rule for deleting records',
              },
              listRule: {
                type: 'string',
                description: 'API rule for listing and viewing records',
              },
              viewRule: {
                type: 'string',
                description: 'API rule for viewing a single record',
              },
              viewQuery: {
                type: 'string',
                description: 'SQL query for view collections',
              },
              passwordAuth: {
                type: 'object',
                description: 'Password authentication options',
                properties: {
                  enabled: { type: 'boolean', description: 'Is password authentication enabled?' },
                  identityFields: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Fields used for identity in password authentication',
                  },
                },
              },
            },
            required: ['collectionIdOrName'],
          },
        },
        {
          name: 'get_collection',
          description: 'Get details for a collection',
          inputSchema: {
            type: 'object',
            properties: {
              collectionIdOrName: {
                type: 'string',
                description: 'ID or name of the collection to view',
              },
              fields: {
                type: 'string',
                description: 'Comma separated string of the fields to return in the JSON response',
              },
            },
            required: ['collectionIdOrName'],
          },
        },
        {
          name: 'list_collections',
          description: 'List all collections in PocketBase',
          inputSchema: {
            type: 'object',
            properties: {
              filter: {
                type: 'string',
                description: 'Filter query for collections',
              },
              sort: {
                type: 'string',
                description: 'Sort order for collections',
              },
            },
          },
        },
        {
          name: 'delete_collection',
          description: 'Delete a collection from PocketBase (admin only)',
          inputSchema: {
            type: 'object',
            properties: {
              collectionIdOrName: {
                type: 'string',
                description: 'ID or name of the collection to delete',
              },
            },
            required: ['collectionIdOrName'],
          },
        },
        {
          name: 'create_record',
          description: 'Create a new record in a collection',
          inputSchema: {
            type: 'object',
            properties: {
              collection: {
                type: 'string',
                description: 'Collection name',
              },
              data: {
                type: 'object',
                description: 'Record data',
              },
            },
            required: ['collection', 'data'],
          },
        },
        {
          name: 'list_records',
          description: 'List records from a collection with optional filters',
          inputSchema: {
            type: 'object',
            properties: {
              collection: {
                type: 'string',
                description: 'Collection name',
              },
              filter: {
                type: 'string',
                description: 'Filter query',
              },
              sort: {
                type: 'string',
                description: 'Sort field and direction',
              },
              page: {
                type: 'number',
                description: 'Page number',
              },
              perPage: {
                type: 'number',
                description: 'Items per page',
              },
            },
            required: ['collection'],
          },
        },
        {
          name: 'update_record',
          description: 'Update an existing record',
          inputSchema: {
            type: 'object',
            properties: {
              collection: {
                type: 'string',
                description: 'Collection name',
              },
              id: {
                type: 'string',
                description: 'Record ID',
              },
              data: {
                type: 'object',
                description: 'Updated record data',
              },
            },
            required: ['collection', 'id', 'data'],
          },
        },
        {
          name: 'delete_record',
          description: 'Delete a record',
          inputSchema: {
            type: 'object',
            properties: {
              collection: {
                type: 'string',
                description: 'Collection name',
              },
              id: {
                type: 'string',
                description: 'Record ID',
              },
            },
            required: ['collection', 'id'],
          },
        },
        {
          name: 'list_auth_methods',
          description: 'List all available authentication methods',
          inputSchema: {
            type: 'object',
            properties: {
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            }
          }
        },
        {
          name: 'authenticate_user',
          description: 'Authenticate a user with email and password',
          inputSchema: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                description: 'User email',
              },
              password: {
                type: 'string',
                description: 'User password',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              },
              isAdmin: {
                type: 'boolean',
                description: 'Whether to authenticate as an admin (uses _superusers collection)',
                default: false
              }
            },
            required: ['email', 'password'],
          },
        },
        {
          name: 'authenticate_with_oauth2',
          description: 'Authenticate a user with OAuth2',
          inputSchema: {
            type: 'object',
            properties: {
              provider: {
                type: 'string',
                description: 'OAuth2 provider name (e.g., google, facebook, github)',
              },
              code: {
                type: 'string',
                description: 'The authorization code returned from the OAuth2 provider',
              },
              codeVerifier: {
                type: 'string',
                description: 'PKCE code verifier',
              },
              redirectUrl: {
                type: 'string',
                description: 'The redirect URL used in the OAuth2 flow',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['provider', 'code', 'codeVerifier', 'redirectUrl'],
          },
        },
        {
          name: 'authenticate_with_otp',
          description: 'Authenticate a user with one-time password',
          inputSchema: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                description: 'User email',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['email'],
          },
        },
        {
          name: 'auth_refresh',
          description: 'Refresh authentication token',
          inputSchema: {
            type: 'object',
            properties: {
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            }
          },
        },
        {
          name: 'request_verification',
          description: 'Request email verification',
          inputSchema: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                description: 'User email',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['email'],
          },
        },
        {
          name: 'confirm_verification',
          description: 'Confirm email verification with token',
          inputSchema: {
            type: 'object',
            properties: {
              token: {
                type: 'string',
                description: 'Verification token',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['token'],
          },
        },
        {
          name: 'request_password_reset',
          description: 'Request password reset',
          inputSchema: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                description: 'User email',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['email'],
          },
        },
        {
          name: 'confirm_password_reset',
          description: 'Confirm password reset with token',
          inputSchema: {
            type: 'object',
            properties: {
              token: {
                type: 'string',
                description: 'Reset token',
              },
              password: {
                type: 'string',
                description: 'New password',
              },
              passwordConfirm: {
                type: 'string',
                description: 'Confirm new password',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['token', 'password', 'passwordConfirm'],
          },
        },
        {
          name: 'request_email_change',
          description: 'Request email change',
          inputSchema: {
            type: 'object',
            properties: {
              newEmail: {
                type: 'string',
                description: 'New email address',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['newEmail'],
          },
        },
        {
          name: 'confirm_email_change',
          description: 'Confirm email change with token',
          inputSchema: {
            type: 'object',
            properties: {
              token: {
                type: 'string',
                description: 'Email change token',
              },
              password: {
                type: 'string',
                description: 'Current password for confirmation',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['token', 'password'],
          },
        },
        {
          name: 'impersonate_user',
          description: 'Impersonate another user (admin only)',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'ID of the user to impersonate',
              },
              collectionIdOrName: {
                type: 'string',
                description: 'Collection name or id (default: users)',
                default: 'users'
              },
              duration: {
                type: 'number',
                description: 'Token expirey time (default: 3600)',
                default: 3600
              }
            },
            required: ['id'],
          },
        },
        {
          name: 'create_user',
          description: 'Create a new user account',
          inputSchema: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                description: 'User email',
              },
              password: {
                type: 'string',
                description: 'User password',
              },
              passwordConfirm: {
                type: 'string',
                description: 'Password confirmation',
              },
              name: {
                type: 'string',
                description: 'User name',
              },
              collection: {
                type: 'string',
                description: 'Collection name (default: users)',
                default: 'users'
              }
            },
            required: ['email', 'password', 'passwordConfirm'],
          },
        },
        {
          name: 'backup_database',
          description: 'Create a backup of the PocketBase database',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'backup name',
              },
            },
          },
        },
        {
          name: 'import_data',
          description: 'Import data into a collection',
          inputSchema: {
            type: 'object',
            properties: {
              collection: {
                type: 'string',
                description: 'Collection name',
              },
              data: {
                type: 'array',
                description: 'Array of records to import',
                items: {
                  type: 'object',
                },
              },
              mode: {
                type: 'string',
                enum: ['create', 'update', 'upsert'],
                description: 'Import mode (default: create)',
              },
            },
            required: ['collection', 'data'],
          },
        },
        {
          name: 'fetch_logs',
          description: 'Fetch and search PocketBase logs for debugging. This tool provides MORE DETAILED ERROR INFORMATION than standard API responses, including full stack traces, validation details, and request context. Use this when you\'re stuck debugging an issue and need to see exactly what went wrong on the server.',
          inputSchema: {
            type: 'object',
            properties: {
              filter: {
                type: 'string',
                description: 'Filter query (e.g., "data.status >= 400" for errors, "data.url ~ \'views\'" for specific endpoint)',
              },
              search: {
                type: 'string',
                description: 'Search term to find in URL, error messages, or details (searches data.url, data.error, and data.details fields)',
              },
              page: {
                type: 'number',
                description: 'Page number (default: 1)',
                default: 1,
              },
              perPage: {
                type: 'number',
                description: 'Items per page (default: 50, max: 100)',
                default: 50,
              },
              sort: {
                type: 'string',
                description: 'Sort order (default: "-created" for newest first)',
                default: '-created',
              },
              errorsOnly: {
                type: 'boolean',
                description: 'Show only errors (status >= 400). Shortcut for filter: "data.status >= 400"',
                default: false,
              },
            },
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          // Collection Management
          case 'create_collection':
            return await this.createCollection(sessionId, request.params.arguments);
          case 'update_collection':
            return await this.updateCollection(sessionId, request.params.arguments);
          case 'get_collection':
            return await this.getCollection(sessionId, request.params.arguments);
          case 'list_collections':
            return await this.listCollections(sessionId, request.params.arguments);
          case 'delete_collection':
            return await this.deleteCollection(sessionId, request.params.arguments);
          
          // Record Management
          case 'create_record':
            return await this.createRecord(sessionId, request.params.arguments);
          case 'list_records':
            return await this.listRecords(sessionId, request.params.arguments);
          case 'update_record':
            return await this.updateRecord(sessionId, request.params.arguments);
          case 'delete_record':
            return await this.deleteRecord(sessionId, request.params.arguments);
          
          // Authentication & User Management
          case 'list_auth_methods':
            return await this.listAuthMethods(sessionId, request.params.arguments);
          case 'authenticate_user':
            return await this.authenticateUser(sessionId, request.params.arguments);
          case 'authenticate_with_oauth2':
            return await this.authenticateWithOAuth2(sessionId, request.params.arguments);
          case 'authenticate_with_otp':
            return await this.authenticateWithOtp(sessionId, request.params.arguments);
          case 'auth_refresh':
            return await this.authRefresh(sessionId, request.params.arguments);
          case 'request_verification':
            return await this.requestVerification(sessionId, request.params.arguments);
          case 'confirm_verification':
            return await this.confirmVerification(sessionId, request.params.arguments);
          case 'request_password_reset':
            return await this.requestPasswordReset(sessionId, request.params.arguments);
          case 'confirm_password_reset':
            return await this.confirmPasswordReset(sessionId, request.params.arguments);
          case 'request_email_change':
            return await this.requestEmailChange(sessionId, request.params.arguments);
          case 'confirm_email_change':
            return await this.confirmEmailChange(sessionId, request.params.arguments);
          case 'impersonate_user':
            return await this.impersonateUser(sessionId, request.params.arguments);
          case 'create_user':
            return await this.createUser(sessionId, request.params.arguments);
          
          // Data Management
          case 'backup_database':
            return await this.backupDatabase(sessionId, request.params.arguments);
          case 'import_data':
            return await this.importData(sessionId, request.params.arguments);
          case 'fetch_logs':
            return await this.fetchLogs(sessionId, request.params.arguments);

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error: unknown) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `PocketBase error: ${pocketbaseErrorMessage(error)}`
        );
      }
    });
  }

  private setupHTTPEndpoints() {
    // Handle POST requests for client-to-server communication
    this.app.post('/mcp', async (req, res) => {
      // Check for required headers
      const acceptHeader = req.headers['accept'];
      if (!acceptHeader || !acceptHeader.includes('application/json') || !acceptHeader.includes('text/event-stream')) {
        res.status(406).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
          },
          id: null,
        });
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const protocolVersion = req.headers['mcp-protocol-version'] as string || '2025-06-18';

      // Validate protocol version
      if (protocolVersion !== '2025-06-18' && protocolVersion !== '2025-03-26') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: `Unsupported protocol version: ${protocolVersion}`,
          },
          id: null,
        });
        return;
      }

      let transport: StreamableHTTPServerTransport;
      let server: Server;

      if (sessionId && this.transports.has(sessionId)) {
        // Reuse existing transport and server
        transport = this.transports.get(sessionId)!;
        server = this.servers.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        const newSessionId = randomUUID();
        
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (sessionId) => {
            // Store the transport and server by session ID
            this.transports.set(sessionId, transport);
            this.servers.set(sessionId, server);
          },
          // Disable DNS rebinding protection for production deployments
          enableDnsRebindingProtection: false,
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            this.transports.delete(transport.sessionId);
            this.servers.delete(transport.sessionId);
            this.sessionStates.delete(transport.sessionId);
          }
        };

        // Create a new server instance for this session
        server = this.createServer(newSessionId);

        // Connect to the session server
        await server.connect(transport);
      } else if (sessionId && !this.transports.has(sessionId)) {
        // Session not found
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Session not found',
          },
          id: null,
        });
        return;
      } else {
        // Invalid request - no session ID for non-initialize request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Session ID required for non-initialize requests',
          },
          id: null,
        });
        return;
      }

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    });

    // Handle GET requests for server-to-client notifications via SSE
    this.app.get('/mcp', async (req, res) => {
      const acceptHeader = req.headers['accept'];
      if (!acceptHeader || !acceptHeader.includes('text/event-stream')) {
        res.status(405).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Method not allowed: GET requires Accept: text/event-stream',
          },
          id: null,
        });
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !this.transports.has(sessionId)) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      
      const transport = this.transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // Handle DELETE requests for session termination
    this.app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !this.transports.has(sessionId)) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      
      const transport = this.transports.get(sessionId)!;
      const server = this.servers.get(sessionId)!;
      
      // Clean up
      await server.close();
      transport.close();
      this.transports.delete(sessionId);
      this.servers.delete(sessionId);
      this.sessionStates.delete(sessionId);
      
      res.status(200).send('Session terminated');
    });
  }

  // Collection Management Tool implementations
  private async createCollection(sessionId: string, args: any) {
    try {
      // Admin operations always use a separate PB instance
      const adminPb = this.getAdminPocketBase(sessionId);
      
      // Ensure admin is authenticated
      if (!adminPb.authStore.isValid) {
        await adminPb.collection("_superusers").authWithPassword(
          process.env.POCKETBASE_ADMIN_EMAIL ?? '', 
          process.env.POCKETBASE_ADMIN_PASSWORD ?? ''
        );
      }

      const defaultFields = [
        {
          hidden: false,
          id: "autodate_created",
          name: "created",
          onCreate: true,
          onUpdate: false,
          presentable: false,
          system: false,
          type: "autodate"
        },
        {
          hidden: false,
          id: "autodate_updated",
          name: "updated",
          onCreate: true,
          onUpdate: true,
          presentable: false,
          system: false,
          type: "autodate"
        }
      ];

      const collectionData = {
        ...args,
        fields: [...(args.fields || []), ...defaultFields]
      };

      const result = await adminPb.collections.create(collectionData as any);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create collection: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async updateCollection(sessionId: string, args: any) {
    try {
      const adminPb = this.getAdminPocketBase(sessionId);
      
      if (!adminPb.authStore.isValid) {
        await adminPb.collection("_superusers").authWithPassword(
          process.env.POCKETBASE_ADMIN_EMAIL ?? '', 
          process.env.POCKETBASE_ADMIN_PASSWORD ?? ''
        );
      }

      const { collectionIdOrName, ...updateData } = args;
      const result = await adminPb.collections.update(collectionIdOrName, updateData as any);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to update collection: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async getCollection(sessionId: string, args: any) {
    try {
      const adminPb = this.getAdminPocketBase(sessionId);
      
      if (!adminPb.authStore.isValid) {
        await adminPb.collection("_superusers").authWithPassword(
          process.env.POCKETBASE_ADMIN_EMAIL ?? '', 
          process.env.POCKETBASE_ADMIN_PASSWORD ?? ''
        );
      }
      
      const collection = await adminPb.collections.getOne(args.collectionIdOrName, {
        fields: args.fields
      });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(collection, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get collection: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async listCollections(sessionId: string, args: any) {
    try {
      // Admin operations always use a separate PB instance
      const adminPb = this.getAdminPocketBase(sessionId);
      
      // Ensure admin is authenticated
      if (!adminPb.authStore.isValid) {
        await adminPb.collection("_superusers").authWithPassword(
          process.env.POCKETBASE_ADMIN_EMAIL ?? '', 
          process.env.POCKETBASE_ADMIN_PASSWORD ?? ''
        );
      }

      let collections;
      if (args.filter) {
        collections = await adminPb.collections.getFirstListItem(args.filter);
      } else if (args.sort) {
        collections = await adminPb.collections.getFullList({ sort: args.sort });
      } else {
        collections = await adminPb.collections.getList(1, 100);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(collections, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list collections: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async deleteCollection(sessionId: string, args: any) {
    try {
      const adminPb = this.getAdminPocketBase(sessionId);
      
      if (!adminPb.authStore.isValid) {
        await adminPb.collection("_superusers").authWithPassword(
          process.env.POCKETBASE_ADMIN_EMAIL ?? '', 
          process.env.POCKETBASE_ADMIN_PASSWORD ?? ''
        );
      }
      
      await adminPb.collections.delete(args.collectionIdOrName);
      
      return {
        content: [
          {
            type: 'text',
            text: `Successfully deleted collection ${args.collectionIdOrName}`,
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to delete collection: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  // Record Management Tool implementations
  private async createRecord(sessionId: string, args: any) {
    try {
      // Use the user's authenticated PB instance
      const pb = this.getUserPocketBase(sessionId);
      const result = await pb.collection(args.collection).create(args.data);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create record: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async listRecords(sessionId: string, args: any) {
    try {
      const options: any = {};
      if (args.filter) options.filter = args.filter;
      if (args.sort) options.sort = args.sort;
      if (args.page) options.page = args.page;
      if (args.perPage) options.perPage = args.perPage;

      // Use the user's authenticated PB instance
      const pb = this.getUserPocketBase(sessionId);
      const result = await pb.collection(args.collection).getList(
        options.page || 1,
        options.perPage || 50,
        {
          filter: options.filter,
          sort: options.sort,
        }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list records: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async updateRecord(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const result = await pb
        .collection(args.collection)
        .update(args.id, args.data);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to update record: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async deleteRecord(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      await pb.collection(args.collection).delete(args.id);
      return {
        content: [
          {
            type: 'text',
            text: `Successfully deleted record ${args.id} from collection ${args.collection}`,
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to delete record: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  // Authentication Tool implementations
  private async listAuthMethods(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      const authMethods = await pb.collection(collection).listAuthMethods();
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(authMethods, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list auth methods: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async authenticateUser(sessionId: string, args: any) {
    try {
      const state = this.getSessionState(sessionId);
      
      if (args.isAdmin) {
        // Admin authentication uses the admin PB instance
        const adminPb = this.getAdminPocketBase(sessionId);
        const collection = '_superusers';
        
        const email = args.email || process.env.POCKETBASE_ADMIN_EMAIL;
        const password = args.password || process.env.POCKETBASE_ADMIN_PASSWORD;
        
        if (!email || !password) {
          throw new Error('Email and password are required for authentication');
        }
        
        const authData = await adminPb
          .collection(collection)
          .authWithPassword(email, password);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(authData, null, 2),
            },
          ],
        };
      } else {
        // User authentication uses the user PB instance
        const userPb = this.getUserPocketBase(sessionId);
        const collection = args.collection || 'users';
        
        if (!args.email || !args.password) {
          throw new Error('Email and password are required for authentication');
        }
        
        const authData = await userPb
          .collection(collection)
          .authWithPassword(args.email, args.password);
        
        // Save the auth state
        state.currentAuthToken = userPb.authStore.token;
        state.currentAuthRecord = userPb.authStore.record;
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(authData, null, 2),
            },
          ],
        };
      }
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Authentication failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async authenticateWithOAuth2(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const authData = await pb.collection(collection).authWithOAuth2Code(
        args.provider,
        args.code,
        args.codeVerifier,
        args.redirectUrl
      );
      
      const state = this.getSessionState(sessionId);
      state.currentAuthToken = pb.authStore.token;
      state.currentAuthRecord = pb.authStore.record;
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(authData, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `OAuth2 authentication failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async authenticateWithOtp(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const result = await pb.collection(collection).requestOTP(args.email);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `OTP request failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async authRefresh(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const authData = await pb.collection(collection).authRefresh();
      
      const state = this.getSessionState(sessionId);
      state.currentAuthToken = pb.authStore.token;
      state.currentAuthRecord = pb.authStore.record;
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(authData, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Auth refresh failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async requestVerification(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const result = await pb.collection(collection).requestVerification(args.email);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Verification request failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async confirmVerification(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const result = await pb.collection(collection).confirmVerification(args.token);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Verification confirmation failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async requestPasswordReset(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const result = await pb.collection(collection).requestPasswordReset(args.email);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Password reset request failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async confirmPasswordReset(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const result = await pb.collection(collection).confirmPasswordReset(
        args.token,
        args.password,
        args.passwordConfirm
      );
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Password reset confirmation failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async requestEmailChange(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const result = await pb.collection(collection).requestEmailChange(args.newEmail);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Email change request failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async confirmEmailChange(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      
      const result = await pb.collection(collection).confirmEmailChange(
        args.token,
        args.password
      );
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Email change confirmation failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async impersonateUser(sessionId: string, args: any) {
    try {
      const adminPb = this.getAdminPocketBase(sessionId);
      
      if (!adminPb.authStore.isValid) {
        await adminPb.collection("_superusers").authWithPassword(
          process.env.POCKETBASE_ADMIN_EMAIL ?? '', 
          process.env.POCKETBASE_ADMIN_PASSWORD ?? ''
        );
      }
      
      const result = await adminPb.collections.authWithPassword(
        args.collectionIdOrName || 'users',
        args.id,
        '',
        {
          expand: args.expand,
          fields: args.fields,
        }
      );
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to impersonate user: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async createUser(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const collection = args.collection || 'users';
      const result = await pb.collection(collection).create({
        email: args.email,
        password: args.password,
        passwordConfirm: args.passwordConfirm,
        name: args.name,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create user: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  // Data Management Tool implementations
  private async backupDatabase(sessionId: string, args: any) {
    try {
      const adminPb = this.getAdminPocketBase(sessionId);
      
      if (!adminPb.authStore.isValid) {
        await adminPb.collection("_superusers").authWithPassword(
          process.env.POCKETBASE_ADMIN_EMAIL ?? '', 
          process.env.POCKETBASE_ADMIN_PASSWORD ?? ''
        );
      }
      
      const backupResult = await adminPb.backups.create(args.name ?? '', {});
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(backupResult, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to backup database: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async importData(sessionId: string, args: any) {
    try {
      const pb = this.getUserPocketBase(sessionId);
      const mode = args.mode || 'create';
      const results = [];

      for (const record of args.data) {
        try {
          let result;
          if (mode === 'create') {
            result = await pb.collection(args.collection).create(record);
          } else if (mode === 'update' && record.id) {
            result = await pb.collection(args.collection).update(record.id, record);
          } else if (mode === 'upsert') {
            if (record.id) {
              try {
                result = await pb.collection(args.collection).update(record.id, record);
              } catch {
                result = await pb.collection(args.collection).create(record);
              }
            } else {
              result = await pb.collection(args.collection).create(record);
            }
          }
          results.push({ success: true, record: result });
        } catch (error) {
          results.push({ success: false, error: pocketbaseErrorMessage(error), record });
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              imported: results.filter(r => r.success).length,
              failed: results.filter(r => !r.success).length,
              results
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Import failed: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  private async fetchLogs(sessionId: string, args: any) {
    try {
      // Authenticate with PocketBase as admin (logs require admin access)
      const adminPb = this.getAdminPocketBase(sessionId);

      if (!adminPb.authStore.isValid) {
        await adminPb.collection("_superusers").authWithPassword(
          process.env.POCKETBASE_ADMIN_EMAIL ?? '',
          process.env.POCKETBASE_ADMIN_PASSWORD ?? ''
        );
      }

      // Build filter query
      let filter = args.filter || '';

      // Handle errorsOnly shortcut
      if (args.errorsOnly) {
        filter = filter ? `(${filter}) && data.status >= 400` : 'data.status >= 400';
      }

      // Handle search parameter
      if (args.search) {
        const searchTerm = args.search;
        const searchFilter = `data.url ~ "${searchTerm}" || data.error ~ "${searchTerm}" || data.details ~ "${searchTerm}"`;
        filter = filter ? `(${filter}) && (${searchFilter})` : searchFilter;
      }

      // Build query parameters
      const params = new URLSearchParams({
        page: (args.page || 1).toString(),
        perPage: Math.min(args.perPage || 50, 100).toString(),
      });

      if (filter) params.append('filter', filter);
      if (args.sort) params.append('sort', args.sort);

      // Fetch logs via /api/logs endpoint
      const response = await adminPb.send(`/api/logs?${params.toString()}`, {
        method: 'GET',
      });

      // Format the response for better readability
      const formattedResponse = {
        summary: {
          totalItems: response.totalItems || response.items?.length || 0,
          itemsShown: response.items?.length || 0,
          page: response.page || args.page || 1,
          perPage: response.perPage || args.perPage || 50,
          filter: filter || 'none',
        },
        logs: response.items?.map((log: any) => ({
          id: log.id,
          created: log.created,
          level: log.level,
          message: log.message,
          data: {
            method: log.data?.method,
            url: log.data?.url,
            status: log.data?.status,
            error: log.data?.error,
            details: log.data?.details,
            userIP: log.data?.userIP,
            userAgent: log.data?.userAgent,
            referer: log.data?.referer,
            auth: log.data?.auth,
            execTime: log.data?.execTime,
            type: log.data?.type,
          }
        })) || [],
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(formattedResponse, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch logs: ${pocketbaseErrorMessage(error)}`
      );
    }
  }

  async run() {
    const PORT = process.env.PORT || 3000;
    
    // Bind to 0.0.0.0 to allow external access when running in Docker
    const HOST = process.env.HOST || '0.0.0.0';
    this.app.listen(PORT, HOST, () => {
      console.log(`PocketBase MCP HTTP server running on http://${HOST}:${PORT}/mcp`);
      console.log(`Protocol versions supported: 2025-06-18, 2025-03-26`);
      console.log(`All 24 tools available!`);
    });
  }
}

const server = new PocketBaseHTTPServer();
server.run().catch(console.error);