#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import mysql from "mysql2/promise";
import { z } from "zod";


// ------------------- Database Connection -------------------
// Get MySQL URI from environment variable or MCP config
import dotenv from 'dotenv';
dotenv.config();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Please provide a database URL as a command-line argument");
  process.exit(1);
}

const databaseUrl = args[0];

const mysqlUri = databaseUrl || process.env.MYSQL_URI;
if (!mysqlUri) {
  console.error("Please provide a MySQL URI as an environment variable");
  process.exit(1);
}

// Create a connection pool for MySQL
const pool = mysql.createPool("mysql://root:@localhost:3306");

// ------------------- Utility Functions -------------------

// Retrieve the list of databases from the MySQL server.
async function listDatabases(): Promise<string[]> {
  const [rows] = await pool.query(`SHOW DATABASES`);
  return (rows as any[]).map((row) => row.Database);
}
  
// Retrieve the schema (tables and columns) for a given database.
async function getDatabaseSchema(database: string): Promise<any[]> {
  const connection = await pool.getConnection();
  try {
    await connection.query(`USE \`${database}\``);
    const [tables] = await connection.query(`SHOW TABLES`);
    // Determine the key name (e.g. "Tables_in_database")
    const tableKey = Object.keys((tables as any[])[0] || {})[0];
    const tableNames = (tables as any[]).map((row) => row[tableKey]);

    const schema = [];
    for (const table of tableNames) {
      const [columns] = await connection.query(`SHOW FULL COLUMNS FROM \`${table}\``);
      schema.push({
        table,
        columns: (columns as any[]).map((col) => ({
          Field: col.Field,
          Type: col.Type,
          Comment: col.Comment || "",
        })),
      });
    }
    return schema;
  } finally {
    connection.release();
  }
}

// Execute a read-only SQL query and return the results.
async function executeSQL(query: string, database: string): Promise<any[]> {
  // TODO: prohibit query beside SELECT, SHOW, DESCRIBE, EXPLAIN
  // TODO: perform some regex checking to prevent SQL injection.

  const connection = await pool.getConnection();
  try {
    await connection.query(`USE \`${database}\``);
    const [rows] = await connection.query(query);
    return rows as any[];
  } finally {
    connection.release();
  }
}

// ------------------- MCP Server Setup -------------------
const server = new McpServer(
  { name: "database-assistant-server/mysql", version: "0.1.0", },
);

server.resource(
  "listDatabases",
  "mysql://databases",
  async (uri: URL, _extra: any) => {
    const databases = await listDatabases();

    return {
      contents: databases.map((db) => ({
        uri: `${uri.href}/${db}`,
        mimeType: "application/json",
        text: db,
      })),
    };
  }
);

// Add a resource for reading database schema (similar to the commented ReadResourceRequestSchema)
server.resource(
  "readDatabaseSchema",
  new ResourceTemplate("mysql://databases/{databaseName}", { list: undefined }),
  async (uri, { databaseName }) => {
    if (!databaseName) {
      throw new Error("Invalid resource URI: database name or table name missing");
    }
    const schema = await getDatabaseSchema(Array.isArray(databaseName) ? databaseName[0] : databaseName);
    return {
      contents: [
        {
          uri: `${uri.href}/tables`,
          mimeType: "application/json",
          text: JSON.stringify(schema, null, 2),
        },
      ],
    };
  }
);


server.tool(
  "executeQuery",
  {query: z.string().describe("The SQL query to execute"), database: z.string().describe("The database name to use")},
  async ({query, database}) => { // Destructure arguments here
      try {
        const results = await executeSQL(query, database);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          isError: false,
        };
      } catch (error: unknown) {
        if (error instanceof Error) {
          return {
            content: [{ type: "text", text: `Error executing query: ${error.message}` }],
            isError: true,
          };
        }
        // Handle non-Error objects
        return {
          content: [{ type: "text", text: `Error executing query: ${String(error)}` }],
          isError: true,
        };
      }
  }
);

// Start the MCP server using a stdio transport.
const transport = new StdioServerTransport();
await server.connect(transport);
  