import { defineConfig } from 'drizzle-kit'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://becoming_me:becoming_me@localhost:5432/becoming_me'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL,
  },
})
