import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

// Idempotent schema. A real rollout would use a migration tool; for this
// project the schema is small and applied at startup.
export async function migrate(): Promise<void> {
  // The advisory lock serializes concurrent replicas running migrations at
  // the same time. It is released when this implicit transaction commits.
  await pool.query(`
    SELECT pg_advisory_xact_lock(42);
    CREATE TABLE IF NOT EXISTS roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text UNIQUE NOT NULL,
      description text NOT NULL DEFAULT '',
      permissions text[] NOT NULL DEFAULT '{}',
      builtin boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      name text NOT NULL,
      role text,
      role_id uuid REFERENCES roles(id),
      password_hash text,
      disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label text NOT NULL,
      prefix text NOT NULL,
      key_hash text UNIQUE NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_enc text;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
      name text NOT NULL,
      url text NOT NULL,
      auth_header text,
      credential_enc text,
      enabled boolean NOT NULL DEFAULT true,
      is_system boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS chat_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'static' CHECK (auth_mode IN ('static', 'oauth'));
    CREATE TABLE IF NOT EXISTS user_oauth_tokens (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      access_enc text NOT NULL,
      scope text NOT NULL DEFAULT '',
      connected_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, server_id)
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id text PRIMARY KEY,
      client_name text NOT NULL,
      redirect_uris jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash text PRIMARY KEY,
      client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      code_challenge text NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash text PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
      client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz
    );
    ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tool_catalog jsonb NOT NULL DEFAULT '[]'::jsonb;
    CREATE TABLE IF NOT EXISTS user_tool_access (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      tool text NOT NULL,
      access text NOT NULL CHECK (access IN ('allow', 'deny')),
      PRIMARY KEY (user_id, server_id, tool)
    );
    CREATE TABLE IF NOT EXISTS oauth_providers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
      name text NOT NULL,
      authorize_url text NOT NULL,
      token_url text NOT NULL,
      scopes text NOT NULL DEFAULT '',
      scope_param text NOT NULL DEFAULT 'scope',
      pkce boolean NOT NULL DEFAULT true,
      token_path text NOT NULL DEFAULT 'access_token',
      client_id text NOT NULL DEFAULT '',
      client_secret_enc text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES oauth_providers(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL DEFAULT 'New chat',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id bigserial PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      content text NOT NULL DEFAULT '',
      meta jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_conv_idx ON chat_messages (conversation_id, id);
    CREATE TABLE IF NOT EXISTS user_server_access (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      access text NOT NULL CHECK (access IN ('read', 'write')),
      PRIMARY KEY (user_id, server_id)
    );
    CREATE TABLE IF NOT EXISTS tool_overrides (
      server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      tool text NOT NULL,
      access text NOT NULL CHECK (access IN ('read', 'write', 'blocked')),
      PRIMARY KEY (server_id, tool)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT now(),
      user_id uuid,
      user_email text NOT NULL,
      server_slug text NOT NULL,
      tool text NOT NULL,
      source text NOT NULL CHECK (source IN ('mcp', 'chat')),
      duration_ms integer NOT NULL,
      outcome text NOT NULL,
      error text
    );
    CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
    CREATE TABLE IF NOT EXISTS llm_settings (
      id integer PRIMARY KEY CHECK (id = 1),
      provider text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
      base_url text NOT NULL,
      model text NOT NULL,
      api_key_enc text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE llm_settings ADD COLUMN IF NOT EXISTS catalog jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE llm_settings ADD COLUMN IF NOT EXISTS catalog_at timestamptz;
    ALTER TABLE api_keys DROP COLUMN IF EXISTS key_enc;
    CREATE TABLE IF NOT EXISTS stores (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id uuid NOT NULL REFERENCES users(id),
      name text NOT NULL,
      slug text UNIQUE NOT NULL,
      namespace text NOT NULL,
      status text NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
      url text NOT NULL,
      error text,
      secrets_enc text,
      started_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    UPDATE roles SET permissions = array_append(permissions, 'stores.manage') WHERE name = 'Admin' AND NOT ('stores.manage' = ANY(permissions));
    INSERT INTO roles (name, description, permissions, builtin) VALUES
      ('Admin', 'Full control of the gateway. Cannot be edited or deleted.', ARRAY['members.manage','roles.manage','tools.manage','servers.manage','providers.manage','model.manage','servers.full_access','audit.view_all','chat.use','mcp.use'], true),
      ('Member', 'Uses the servers they are granted, through chat and MCP clients.', ARRAY['chat.use','mcp.use'], true)
    ON CONFLICT (name) DO NOTHING;
    -- On an existing database the CREATE TABLE above does nothing, so add the column here.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES roles(id);
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role') THEN
        UPDATE users SET role_id = (SELECT id FROM roles WHERE name = CASE WHEN users.role = 'admin' THEN 'Admin' ELSE 'Member' END) WHERE role_id IS NULL;
        ALTER TABLE users DROP COLUMN role;
      END IF;
    END $$;
    ALTER TABLE users ALTER COLUMN role_id SET NOT NULL;
  `);
}
