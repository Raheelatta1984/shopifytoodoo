# Deploying on Neon (free tier)

Neon provides a serverless Postgres that fits the "free tier" constraint of
the engagement.  The application talks to it through the standard `pg` driver,
so no code change is needed.

## 1. Create the database

1. Create a Neon project (the free plan is enough for a test workload).
2. **Neon Console → Databases → Create database**, for example `shopifytoodoo`.
3. Copy the **pooled** connection string (the one that contains
   `-pooler`); it looks like:

```
postgresql://shopifytoodoo:xxxxxxxxxxxx@ep-cool-name-123456.us-east-2.aws.neon.tech/shopifytoodoo?sslmode=require
```

4. Keep the **direct** connection string as well: it is the one to use for
   `pg_dump`, `psql` and for the migrations when the pooler is not wanted.

## 2. Configure the service

```bash
export DATABASE_URL="postgresql://…-pooler…?sslmode=require"
export DB_SSL=require
export DB_POOL_MAX=5
```

The application detects a Neon host and:

* enables TLS (`sslmode=require`);
* sets `prepare: false` when the **transaction pooler** is used, because the
  pooler does not support prepared statements.

Using the **direct** endpoint instead is also supported: add `?sslmode=verify-full`
and set `DB_SSL=verify-full` when the certificate must be validated.

## 3. Apply the schema

```bash
npm run migrate
```

The migration runner creates the `schema_migrations` table, applies the
pending migrations and records them.  It is idempotent, so it is safe to run
on every deployment.

To review the schema first:

```bash
npm run schema:dump      # writes docs/schema.sql
psql "$DATABASE_URL" -f docs/schema.sql
```

## 4. Connection pool sizing

Neon suspends an idle compute after a few minutes and the pooled endpoint
multiplexes the connections.  A pool of `5` is enough for a single instance of
the service; raise it only if several instances are deployed.

## 5. Branches for the test data

Neon branches are ideal for a test environment:

```bash
# create a branch from the console or with the Neon CLI
neon branches create --name=test --parent=main
# use the branch connection string as DATABASE_URL for the test deployment
```

Because the schema is migrated automatically on start up, a fresh branch only
needs the connection string.

## 6. Backups

* Neon keeps point in time recovery and the branch history; that satisfies the
  "atomic persistence, backups, versioned changes" precaution of `CYB-06`.
* For an external copy, use the direct endpoint:

```bash
pg_dump "$DIRECT_DATABASE_URL" --format=custom --file=shopifytoodoo-$(date +%F).dump
```

## 7. Local development without Neon

When `DATABASE_URL` is empty the service starts an embedded PGlite database in
`$PGLITE_PATH` (default `./data/pglite`).  The SQL dialect is identical, so
the migrations and the queries behave the same way; only the connection
handling differs.
