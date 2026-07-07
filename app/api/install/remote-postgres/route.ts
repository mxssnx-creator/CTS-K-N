import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    console.log('[v0] Remote PostgreSQL installation requested')
    
    const { host, port, username, password, dbName, dbUser, dbPassword } = await request.json()

    if (!host || !username || !password) {
      console.error('[v0] Missing required SSH credentials')
      return NextResponse.json({ error: "Missing required SSH credentials" }, { status: 400 })
    }

    const finalDbName = dbName || "cts-v3"
    const finalDbUser = dbUser || "cts"
    const finalDbPassword = dbPassword || "00998877"

    console.log('[v0] Generating installation script for:', host, finalDbName, finalDbUser)

    const installScript = `
#!/bin/bash
set -e

echo "[v0] Installing PostgreSQL..."
sudo apt-get update
sudo apt-get install -y postgresql postgresql-contrib

echo "[v0] Starting PostgreSQL..."
sudo systemctl start postgresql
sudo systemctl enable postgresql

echo "[v0] Creating database and user..."
sudo -u postgres psql <<EOF
CREATE DATABASE ${finalDbName};
CREATE USER ${finalDbUser} WITH ENCRYPTED PASSWORD '${finalDbPassword}';
GRANT ALL PRIVILEGES ON DATABASE ${finalDbName} TO ${finalDbUser};
\\c ${finalDbName}
GRANT ALL ON SCHEMA public TO ${finalDbUser};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${finalDbUser};
EOF

echo "[v0] Configuring remote access..."
PG_VERSION=$(psql --version | awk '{print $3}' | cut -d. -f1)
echo "listen_addresses = '*'" | sudo tee -a /etc/postgresql/$PG_VERSION/main/postgresql.conf
echo "host all all 0.0.0.0/0 md5" | sudo tee -a /etc/postgresql/$PG_VERSION/main/pg_hba.conf

echo "[v0] Restarting PostgreSQL..."
sudo systemctl restart postgresql

echo "[v0] Installation complete!"
echo "[v0] Connection string: postgresql://${finalDbUser}:${finalDbPassword}@${host}:5432/${finalDbName}"
`

    console.log('[v0] Installation script generated successfully')

    return NextResponse.json({
      success: true,
      message: "Installation script generated. Please run this on your remote server.",
      script: installScript,
      connectionString: `postgresql://${finalDbUser}:${finalDbPassword}@${host}:5432/${finalDbName}`,
      logs: [
        `Database name: ${finalDbName}`,
        `Database user: ${finalDbUser}`,
        `Target host: ${host}`,
        "Script generated successfully",
      ],
    })
  } catch (error) {
    console.error("[v0] Remote PostgreSQL installation failed:", error)
    return NextResponse.json({ error: error instanceof Error ? error.message : "Installation failed" }, { status: 500 })
  }
}
